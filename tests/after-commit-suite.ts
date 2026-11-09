/**
 * Work that follows a commit (`MutationContext.afterCommit`), shared by
 * every adapter: `bun test` runs it against the Bun SQLite adapter
 * (tests/after-commit.test.ts); vitest runs it in workerd against the
 * Durable Object adapter (tests/workers/).
 *
 * The fuzzed contract, checked against the database itself: every
 * change writes a mark and asks for work; afterwards, the work that ran
 * is exactly the work of the changes whose mark survived, each piece
 * once, each seeing its mark committed, each change's in the order
 * asked. Programs nest changes, fail them at random points, catch some
 * failures, wait inside transactions, run concurrently, and run as
 * jobs. A failing seed is printed with its program, and replays with
 * `FUZZ_SEED`.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { Vex } from "../src/core/engine.js";
import type { StorageAdapter } from "../src/core/storage.js";
import type { MutationContext } from "../src/core/types.js";

/** A small, seedable PRNG (mulberry32): the same seed, the same program. */
export function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    chance: (p: number) => next() < p,
    pick: <T>(items: readonly T[]) => items[Math.floor(next() * items.length)],
  };
}
type Random = ReturnType<typeof random>;

/** The seeds a run fuzzes: `FUZZ_SEED` alone, or `runs` from a base. */
export function seeds(runs: number, base = 0x2629): number[] {
  const fixed = Number(
    (globalThis as { process?: { env?: Record<string, string> } }).process?.env
      ?.FUZZ_SEED,
  );
  if (Number.isFinite(fixed) && fixed > 0) return [fixed];
  return Array.from({ length: runs }, (_, i) => base + i * 7919);
}

type Throw = "none" | "before" | "afterAsk" | "afterChildren";
type Wait = "none" | "micro" | "sleep";

/** One change: what it asks for, where it fails, what it nests. */
interface Op {
  id: string;
  asks: number;
  throwAt: Throw;
  wait: Wait;
  catchChildren: boolean;
  children: Op[];
}

function program(
  rng: Random,
  opts: { depth: number; prefix: string },
  counter = { n: 0 },
  level = 0,
): Op {
  const id = `${opts.prefix}${counter.n++}`;
  const children: Op[] = [];
  if (level < opts.depth) {
    const count = rng.int(3);
    for (let i = 0; i < count; i++) {
      children.push(program(rng, opts, counter, level + 1));
    }
  }
  return {
    id,
    asks: rng.int(3),
    throwAt: rng.chance(0.6)
      ? "none"
      : rng.pick(["before", "afterAsk", "afterChildren"] as const),
    wait: rng.pick(["none", "micro", "sleep"] as const),
    catchChildren: rng.chance(0.5),
    children,
  };
}

function* each(op: Op): Generator<Op> {
  yield op;
  for (const child of op.children) yield* each(child);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A piece of work as it ran. */
interface Ran {
  token: string;
  sawMark: boolean;
}

/**
 * An engine whose `fz.run` mutation (and `fz.job` job) carries out an
 * `Op`: it writes its mark, asks for its work, waits, runs its
 * children as mutations of their own, and fails where told to.
 */
async function fuzzEngine(
  storage: StorageAdapter,
  options: { ask: boolean; handlerTimeoutMs?: number } = { ask: true },
) {
  const ran: Ran[] = [];
  let nextJob: Op | null = null;
  let vex!: Vex;

  async function carryOut(ctx: MutationContext, op: Op): Promise<void> {
    await ctx.db.table("marks").insert({ token: op.id });
    if (op.throwAt === "before") throw new Error(`${op.id} failed`);
    if (options.ask) {
      for (let k = 0; k < op.asks; k++) {
        const token = `${op.id}:${k}`;
        ctx.afterCommit(async () => {
          const rows = await vex.unsafeSql(
            "SELECT _id FROM marks WHERE token = ?",
            op.id,
          );
          ran.push({ token, sawMark: rows.length === 1 });
        });
      }
    }
    if (op.throwAt === "afterAsk") throw new Error(`${op.id} failed`);
    if (op.wait === "micro") await Promise.resolve();
    if (op.wait === "sleep") await sleep(1);
    for (const child of op.children) {
      try {
        await vex.mutate("fz.run", { op: child });
      } catch (error) {
        if (!op.catchChildren) throw error;
      }
    }
    if (op.throwAt === "afterChildren") throw new Error(`${op.id} failed`);
  }

  vex = await Vex.create({
    storage,
    jobScheduler: "external",
    ...(options.handlerTimeoutMs
      ? { handlerTimeoutMs: options.handlerTimeoutMs }
      : {}),
    plugins: [
      {
        name: "fz",
        tables: {
          marks: { columns: { token: { type: "string", index: true } } },
        },
        queries: {},
        mutations: {
          run: {
            args: { op: "json" },
            handler: (ctx, args) => carryOut(ctx, args.op as Op),
          },
        },
        jobs: {
          job: {
            schedule: "every 1h",
            handler: async (ctx) => {
              const op = nextJob;
              nextJob = null;
              if (op) await carryOut(ctx, op);
            },
          },
        },
      },
    ],
  });

  return {
    vex,
    ran,
    runAsJob: async (op: Op) => {
      nextJob = op;
      await vex.triggerJob("fz.job");
    },
    marks: async () =>
      new Set(
        (await vex.unsafeSql<{ token: string }>("SELECT token FROM marks")).map(
          (r) => r.token,
        ),
      ),
  };
}

/** The contract, read off the database: see the header. */
async function expectContract(
  engine: Awaited<ReturnType<typeof fuzzEngine>>,
  ops: Op[],
  replay: () => string,
) {
  await engine.vex.afterCommitSettled();
  const marks = await engine.marks();
  const expected: string[] = [];
  for (const root of ops) {
    for (const op of each(root)) {
      // One that failed before asking owes nothing, whatever survived.
      if (!marks.has(op.id) || op.throwAt === "before") continue;
      for (let k = 0; k < op.asks; k++) expected.push(`${op.id}:${k}`);
    }
  }
  const tokens = engine.ran.map((r) => r.token);
  const failures: string[] = [];
  if (new Set(tokens).size !== tokens.length) failures.push("work ran twice");
  if ([...tokens].sort().join() !== [...expected].sort().join()) {
    failures.push(
      `ran ${JSON.stringify([...tokens].sort())}, committed ${JSON.stringify([...expected].sort())}`,
    );
  }
  const blind = engine.ran.filter((r) => !r.sawMark).map((r) => r.token);
  if (blind.length > 0) {
    failures.push(`work ran before its change committed: ${blind}`);
  }
  // Each change's work in the order it was asked.
  const last = new Map<string, number>();
  for (const token of tokens) {
    const [op, k] = token.split(":");
    if ((last.get(op) ?? -1) > Number(k)) failures.push(`out of order: ${op}`);
    last.set(op, Number(k));
  }
  if (failures.length > 0) {
    throw new Error(`${failures.join("\n")}\nreplay: ${replay()}`);
  }
}

export function afterCommitSuite(
  name: string,
  makeStorage: () => StorageAdapter,
  options: {
    /** Whether the storage sees nested transactions (`afterCommit`). */
    seesNesting: boolean;
    runs?: number;
  },
) {
  const runs = options.runs ?? 40;
  // Without the adapter member, the engine cannot see a change opened
  // inside another: only programs that nest none are held to the
  // contract, and the gap is pinned below.
  const depth = options.seesNesting ? 3 : 0;

  describe(`${name}: work after a commit`, () => {
    const opened: Vex[] = [];
    afterEach(async () => {
      for (const vex of opened.splice(0)) await vex.close();
    });
    const open = async (
      opts?: Parameters<typeof fuzzEngine>[1],
    ): ReturnType<typeof fuzzEngine> => {
      const engine = await fuzzEngine(makeStorage(), opts);
      opened.push(engine.vex);
      return engine;
    };

    test("runs once the change commits, on a later turn, and sees what it committed", async () => {
      const engine = await open();
      const op: Op = {
        id: "a",
        asks: 2,
        throwAt: "none",
        wait: "sleep",
        catchChildren: false,
        children: [],
      };
      await engine.vex.mutate("fz.run", { op });
      await engine.vex.afterCommitSettled();
      expect(engine.ran).toEqual([
        { token: "a:0", sawMark: true },
        { token: "a:1", sawMark: true },
      ]);
    });

    test("never runs for a change that rolled back", async () => {
      const engine = await open();
      const op: Op = {
        id: "a",
        asks: 2,
        throwAt: "afterChildren",
        wait: "sleep",
        catchChildren: false,
        children: [],
      };
      await expect(engine.vex.mutate("fz.run", { op })).rejects.toThrow();
      await engine.vex.afterCommitSettled();
      expect(engine.ran).toEqual([]);
    });

    test("asked for after the change ended, it throws and never runs", async () => {
      let late: unknown = null;
      const vex = await Vex.create({
        storage: makeStorage(),
        handlerTimeoutMs: 5,
        plugins: [
          {
            name: "late",
            tables: {},
            queries: {},
            mutations: {
              run: {
                args: {},
                async handler(ctx) {
                  await sleep(30);
                  try {
                    ctx.afterCommit(() => {
                      late = "ran";
                    });
                  } catch (error) {
                    late = error;
                  }
                },
              },
            },
          },
        ],
      });
      opened.push(vex);
      await expect(vex.mutate("late.run", {})).rejects.toThrow(/timed out/);
      await sleep(50);
      await vex.afterCommitSettled();
      expect(late).toBeInstanceOf(Error);
      expect(String(late)).toContain("after late.run ended");
    });

    test("a webhook's work follows its commit, and never its rollback", async () => {
      const told: string[] = [];
      const vex = await Vex.create({
        storage: makeStorage(),
        plugins: [
          {
            name: "hook",
            tables: { pings: { columns: { v: { type: "string" } } } },
            queries: {},
            mutations: {},
            webhooks: {
              ping: {
                path: "/ping",
                async handler(ctx, req) {
                  const v = String(req.body.v);
                  await ctx.db.table("pings").insert({ v });
                  ctx.afterCommit(() => told.push(v));
                  if (req.body.fail) throw new Error("rolled back");
                  return { ok: true };
                },
              },
            },
          },
        ],
      });
      opened.push(vex);
      const ping = (body: Record<string, unknown>) =>
        vex
          .handleWebhook({
            body,
            rawBody: JSON.stringify(body),
            headers: {},
            method: "POST",
            path: "/ping",
            query: {},
          })
          .catch(() => null);
      await ping({ v: "kept" });
      await ping({ v: "lost", fail: true });
      await vex.afterCommitSettled();
      expect(told).toEqual(["kept"]);
    });

    test("a throwing or rejecting piece stops none after it", async () => {
      const order: string[] = [];
      const vex = await Vex.create({
        storage: makeStorage(),
        plugins: [
          {
            name: "e",
            tables: {},
            queries: {},
            mutations: {
              run: {
                args: {},
                handler(ctx) {
                  ctx.afterCommit(() => order.push("first"));
                  ctx.afterCommit(() => {
                    throw new Error("thrown on purpose");
                  });
                  ctx.afterCommit(() =>
                    Promise.reject(new Error("rejected on purpose")),
                  );
                  ctx.afterCommit(() => order.push("last"));
                },
              },
            },
          },
        ],
      });
      opened.push(vex);
      await vex.mutate("e.run", {});
      await vex.afterCommitSettled();
      expect(order).toEqual(["first", "last"]);
    });

    if (!options.seesNesting) {
      test("without the adapter member, a nested change's work follows its own call, not the outermost commit", async () => {
        const engine = await open();
        const op: Op = {
          id: "outer",
          asks: 0,
          throwAt: "afterChildren",
          wait: "none",
          catchChildren: false,
          children: [
            {
              id: "inner",
              asks: 1,
              throwAt: "none",
              wait: "none",
              catchChildren: false,
              children: [],
            },
          ],
        };
        await expect(engine.vex.mutate("fz.run", { op })).rejects.toThrow();
        await engine.vex.afterCommitSettled();
        expect(engine.ran.map((r) => r.token)).toEqual(["inner:0"]);
      });
    }

    for (const seed of seeds(runs)) {
      test(`fuzz seed ${seed}: concurrent, nested, failing changes and jobs`, async () => {
        const rng = random(seed);
        const engine = await open();
        const concurrent = Array.from({ length: 1 + rng.int(4) }, (_, i) =>
          program(rng, { depth, prefix: `c${i}.` }),
        );
        const sequential = Array.from({ length: rng.int(3) }, (_, i) =>
          program(rng, { depth, prefix: `s${i}.` }),
        );
        const jobs = Array.from({ length: rng.int(3) }, (_, i) =>
          program(rng, { depth, prefix: `j${i}.` }),
        );
        await Promise.all(
          concurrent.map((op) =>
            engine.vex.mutate("fz.run", { op }).catch(() => {}),
          ),
        );
        for (const op of sequential) {
          await engine.vex.mutate("fz.run", { op }).catch(() => {});
        }
        for (const op of jobs) await engine.runAsJob(op);
        await expectContract(
          engine,
          [...concurrent, ...sequential, ...jobs],
          () =>
            `FUZZ_SEED=${seed} ${JSON.stringify({ concurrent, sequential, jobs })}`,
        );
      });
    }

    for (const seed of seeds(Math.ceil(runs / 2), 0x5eed)) {
      test(`fuzz seed ${seed}: asking for work changes nothing the change writes`, async () => {
        const make = () => {
          const rng = random(seed);
          return Array.from({ length: 1 + rng.int(4) }, (_, i) =>
            program(rng, { depth, prefix: `p${i}.` }),
          );
        };
        const outcome = async (ask: boolean) => {
          const engine = await open({ ask });
          // A Durable Object's test has one database for both runs.
          await engine.vex.unsafeSql("DELETE FROM marks");
          const answers: string[] = [];
          for (const op of make()) {
            answers.push(
              await engine.vex.mutate("fz.run", { op }).then(
                () => "ok",
                (error: Error) => error.message,
              ),
            );
          }
          await engine.vex.afterCommitSettled();
          return { answers, marks: [...(await engine.marks())].sort() };
        };
        expect(await outcome(true)).toEqual(await outcome(false));
      });
    }
  });
}
