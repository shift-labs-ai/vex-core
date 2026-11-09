/**
 * The runner behind `afterCommit`, and the engine's `close()` around
 * it: every piece of work released before close starts once, in the
 * order released; `settled` waits for all of it; `close()` drains it
 * within its bound however it behaves (slow, hung, failing, releasing
 * more, writing through the engine); what is released after is dropped;
 * and nothing it holds keeps a process alive.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import { AfterCommitRunner } from "../src/core/after-commit.js";
import { Vex } from "../src/core/engine.js";
import { random, seeds } from "./after-commit-suite.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Kind = "sync" | "throw" | "resolve" | "reject" | "releases";

describe("the runner", () => {
  for (const seed of seeds(60, 0xc0de)) {
    test(`fuzz seed ${seed}: order, once, settled, drain`, async () => {
      const rng = random(seed);
      const started: number[] = [];
      const settledIds = new Set<number>();
      // Released by the test itself, not by a running piece.
      const topLevel = new Set<number>();
      let dropped = 0;
      const runner = new AfterCommitRunner(
        () => {},
        () => dropped++,
      );
      let next = 0;
      const released: number[] = [];
      const job = (depth: number): (() => unknown) => {
        const id = next++;
        released.push(id);
        const kind: Kind = rng.pick(
          depth > 2
            ? (["sync", "throw", "resolve", "reject"] as const)
            : (["sync", "throw", "resolve", "reject", "releases"] as const),
        );
        const ms = rng.int(4);
        return () => {
          started.push(id);
          switch (kind) {
            case "sync":
              settledIds.add(id);
              return;
            case "throw":
              settledIds.add(id);
              throw new Error("thrown on purpose");
            case "resolve":
              return sleep(ms).then(() => settledIds.add(id));
            case "reject":
              return sleep(ms).then(() => {
                settledIds.add(id);
                throw new Error("rejected on purpose");
              });
            case "releases":
              runner.release(job(depth + 1));
              settledIds.add(id);
              return;
          }
        };
      };

      for (let round = 0; round < 1 + rng.int(4); round++) {
        for (let i = 0; i < rng.int(6); i++) {
          const piece = job(0);
          topLevel.add(next - 1);
          runner.release(piece);
        }
        if (rng.chance(0.5)) await Promise.resolve();
        if (rng.chance(0.5)) {
          await runner.settled();
          // Everything released so far has run and settled.
          expect([...started].sort((a, b) => a - b)).toEqual(
            [...released].sort((a, b) => a - b),
          );
          expect(settledIds.size).toBe(released.length);
        }
      }
      await runner.settled();
      // Each once, and what the test released in the order released.
      expect(new Set(started).size).toBe(started.length);
      expect(started.length).toBe(released.length);
      const inOrder = started.filter((id) => topLevel.has(id));
      expect(inOrder).toEqual([...inOrder].sort((a, b) => a - b));

      // A hung piece holds drain to its bound, no longer.
      const withHang = rng.chance(0.5);
      if (withHang) {
        const id = next++;
        released.push(id);
        runner.release(() => {
          started.push(id);
          return new Promise(() => {});
        });
      }
      const bound = 10 + rng.int(40);
      const at = performance.now();
      const drained = await runner.drain(bound);
      const took = performance.now() - at;
      expect(drained).toBe(!withHang);
      expect(took).toBeLessThan(bound + 100);

      runner.release(() => {
        throw new Error("a dropped piece must never run");
      });
      await sleep(5);
      expect(dropped).toBe(1);
    });
  }

  test("work released in a batch starts in the order released", async () => {
    const order: number[] = [];
    const runner = new AfterCommitRunner(
      () => {},
      () => {},
    );
    for (let i = 0; i < 50; i++) runner.release(() => order.push(i));
    await runner.settled();
    expect(order).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });
});

describe("work after a commit, as it runs", () => {
  async function engineWith(
    handler: (ctx: import("../src/core/types.js").MutationContext) => void,
    tracer?: import("../src/core/tracer.js").Tracer,
  ) {
    return Vex.create({
      storage: sqliteAdapter(":memory:"),
      ...(tracer ? { tracer } : {}),
      plugins: [
        {
          name: "w",
          tables: {},
          queries: {},
          mutations: { run: { args: {}, handler: (ctx) => handler(ctx) } },
        },
      ],
    });
  }

  test("runs outside the async context of whoever made the change", async () => {
    const { AsyncLocalStorage } = await import("node:async_hooks");
    const caller = new AsyncLocalStorage<string>();
    let seen: string | undefined = "unset";
    const vex = await engineWith((ctx) =>
      ctx.afterCommit(() => {
        seen = caller.getStore();
      }),
    );
    await caller.run("the caller's", () => vex.mutate("w.run", {}));
    await vex.afterCommitSettled();
    expect(seen).toBeUndefined();
    await vex.close();
  });

  test("is called with nothing: no engine internals reach it", async () => {
    let received: unknown[] | null = null;
    const vex = await engineWith((ctx) =>
      ctx.afterCommit((...args: unknown[]) => {
        received = args;
      }),
    );
    await vex.mutate("w.run", {});
    await vex.afterCommitSettled();
    expect(received).toEqual([]);
    await vex.close();
  });

  test("is traced as a child of the change that asked for it", async () => {
    const spans: import("../src/core/tracer.js").Span[] = [];
    const vex = await engineWith((ctx) => ctx.afterCommit(() => {}), {
      onSpan: (span) => spans.push(span),
    });
    await vex.mutate("w.run", {});
    await vex.afterCommitSettled();
    const change = spans.find((s) => s.type === "mutation");
    const work = spans.find((s) => s.type === "afterCommit");
    expect(work).toMatchObject({
      name: "w.run",
      status: "ok",
      traceId: change?.traceId,
      parentSpanId: change?.spanId,
    });
    await vex.close();
  });
});

describe("close()", () => {
  for (const seed of seeds(30, 0xc105e)) {
    test(`fuzz seed ${seed}: drains within its bound, then drops`, async () => {
      const rng = random(seed);
      const drainMs = 20 + rng.int(60);
      const finished: string[] = [];
      const expected: string[] = [];
      let hangs = false;
      const vex = await Vex.create({
        storage: sqliteAdapter(":memory:"),
        afterCommitDrainMs: drainMs,
        plugins: [
          {
            name: "c",
            tables: { notes: { columns: { v: { type: "string" } } } },
            queries: {},
            mutations: {
              note: {
                args: { v: "string" },
                handler: (ctx, args) =>
                  ctx.db.table("notes").insert({ v: args.v }),
              },
              change: {
                args: { plan: "json" },
                handler(ctx, args) {
                  for (const piece of args.plan as Array<{
                    id: string;
                    kind: string;
                    ms: number;
                  }>) {
                    ctx.afterCommit(async () => {
                      if (piece.kind === "hang") return new Promise(() => {});
                      await sleep(piece.ms);
                      if (piece.kind === "fail") throw new Error("on purpose");
                      // Storage is still open while close() drains.
                      if (piece.kind === "write") {
                        await vex.mutate("c.note", { v: piece.id });
                      }
                      finished.push(piece.id);
                    });
                  }
                },
              },
            },
          },
        ],
      });
      for (let c = 0; c < 1 + rng.int(4); c++) {
        const plan = Array.from({ length: rng.int(5) }, (_, i) => {
          const kind = rng.pick(["quick", "write", "fail", "hang"] as const);
          const id = `${c}.${i}`;
          const ms = rng.int(Math.max(1, Math.floor(drainMs / 4)));
          if (kind === "hang") hangs = true;
          if (kind === "quick" || kind === "write") expected.push(id);
          return { id, kind, ms };
        });
        await vex.mutate("c.change", { plan });
      }
      const at = performance.now();
      await vex.close();
      const took = performance.now() - at;
      expect(took).toBeLessThan(drainMs + 250);
      if (!hangs) expect(finished.sort()).toEqual(expected.sort());
      else {
        // Within the bound, every quick piece still finished.
        for (const id of expected) expect(finished).toContain(id);
      }
    });
  }
});

describe("a process", () => {
  const engine = join(import.meta.dir, "../src/core/engine.ts");
  const adapter = join(import.meta.dir, "../src/adapters/sqlite.ts");
  async function exits(body: string): Promise<number> {
    const script = `
      import { Vex } from ${JSON.stringify(engine)};
      import { sqliteAdapter } from ${JSON.stringify(adapter)};
      const vex = await Vex.create({
        storage: sqliteAdapter(":memory:"),
        afterCommitDrainMs: 50,
        plugins: [{
          name: "p", tables: { t: { columns: { v: { type: "string" } } } },
          queries: {},
          mutations: {
            work: { args: { hang: "boolean" }, handler(ctx, args) {
              ctx.afterCommit(() => args.hang ? new Promise(() => {}) : undefined);
            } },
          },
        }],
      });
      ${body}
    `;
    const proc = Bun.spawn(["bun", "-e", script], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), 8000);
    const code = await proc.exited;
    clearTimeout(timer);
    if (code !== 0) console.error(await new Response(proc.stderr).text());
    return code;
  }

  test("exits on its own with the engine open and work done", async () => {
    expect(
      await exits(
        `await vex.mutate("p.work", {}); await vex.afterCommitSettled();`,
      ),
    ).toBe(0);
  });

  test("exits on its own with the engine open and work hung", async () => {
    expect(
      await exits(
        `await vex.mutate("p.work", { hang: true }); await new Promise((r) => setTimeout(r, 20));`,
      ),
    ).toBe(0);
  });

  test("exits after close() with work hung past its bound", async () => {
    expect(
      await exits(
        `await vex.mutate("p.work", { hang: true }); await vex.close();`,
      ),
    ).toBe(0);
  });
});
