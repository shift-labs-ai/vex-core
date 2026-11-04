/**
 * Subscriptions evaluated off the main thread (`EvaluationPool`): a
 * worker runs the query over a read-only engine on the same database
 * and answers with the result and what it read; the main thread keeps
 * judging, single-flight runs and delivery, so what a subscriber sees
 * is what it sees on the main thread.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import { Vex } from "../src/core/engine.js";
import type { Span } from "../src/core/tracer.js";
import type { VexUser } from "../src/core/types.js";
import { evaluationPlugin } from "./fixtures/evaluation-plugin.js";

const SETUP = new URL("./fixtures/evaluation-setup.ts", import.meta.url);

let open: Vex[] = [];
let dirs: string[] = [];
const spans: Span[] = [];

afterEach(async () => {
  await Promise.all(open.map((v) => v.close()));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  open = [];
  dirs = [];
  spans.length = 0;
});

async function create(workers = 2) {
  const dir = mkdtempSync(join(tmpdir(), "vex-eval-"));
  dirs.push(dir);
  const path = join(dir, "db.sqlite");
  const vex = await Vex.create({
    plugins: [evaluationPlugin],
    storage: sqliteAdapter(path),
    evaluation: { workers, module: SETUP, setup: { path } },
    tracer: { onSpan: (span) => spans.push(span) },
  });
  open.push(vex);
  return vex;
}

const meta = (type: string) =>
  spans.filter((s) => s.type === type).map((s) => JSON.parse(s.meta ?? "{}"));

const alice: VexUser = { id: "alice", name: "Alice", isAdmin: false };

describe("evaluation workers", () => {
  test("a subscription's runs happen in a worker and deliver as on the main thread", async () => {
    const vex = await create();
    await vex.mutate("ev.add", { scope: "a", name: "one" });
    const seen: unknown[] = [];
    await vex.subscribe("ev.names", { scope: "a" }, (r: unknown) =>
      seen.push(r),
    );
    expect(meta("subscribe").at(-1)).toEqual(
      expect.objectContaining({
        offThread: true,
        tables: ["items"],
        dependencies: [
          expect.objectContaining({
            table: "items",
            filters: [{ column: "scope", operator: "=" }],
            reads: ["name", "when"],
          }),
        ],
      }),
    );
    await vex.mutate("ev.add", { scope: "a", name: "two" });
    expect(seen).toEqual([
      [{ name: "one", when: null }],
      [
        { name: "one", when: null },
        { name: "two", when: null },
      ],
    ]);
    expect(meta("invalidation").at(-1)).toEqual(
      expect.objectContaining({ offThread: 1, reEvaluated: ["ev.names"] }),
    );
  });

  test("a run in a worker is heard as the main thread's would be: as its JSON reading", async () => {
    const vex = await create();
    const seen: Array<Record<string, unknown>> = [];
    await vex.subscribe("ev.sparse", { scope: "a" }, (r: any) => seen.push(r));
    await vex.mutate("ev.add", { scope: "a", name: "one" });
    expect(meta("subscribe").at(-1)?.offThread).toBe(true);
    expect(seen).toEqual([{ n: 0 }, { n: 1 }]);
    for (const answer of seen) expect("missing" in answer).toBe(false);
  });

  test("a run in a worker that read the time is re-run by the main thread's clock", async () => {
    const vex = await create();
    const heard: number[] = [];
    await vex.subscribe("ev.second", {}, (r: any) => heard.push(r.at));
    expect(meta("subscribe").at(-1)?.offThread).toBe(true);
    await Bun.sleep(1100);
    expect(heard.length).toBeGreaterThanOrEqual(2);
    expect(heard[1]! - heard[0]!).toBeGreaterThanOrEqual(1000);
  });

  test("the worker's dependencies narrow the next write like the main thread's", async () => {
    const vex = await create();
    let runs = 0;
    const seen: unknown[] = [];
    await vex.subscribe("ev.names", { scope: "a" }, (r: unknown) => {
      runs++;
      seen.push(r);
    });
    spans.length = 0;
    await vex.mutate("ev.add", { scope: "b", name: "elsewhere" });
    expect(meta("invalidation").at(-1)?.reEvaluated).toEqual([]);
    expect(runs).toBe(1);
  });

  test("a governed read's policy runs in the worker for the subscriber's caller", async () => {
    const vex = await create();
    const mine = await vex.mutate("ev.add", { scope: "a", name: "mine" });
    await vex.mutate("ev.add", { scope: "a", name: "other" });
    await vex.mutate("ev.grant", { userId: "alice", itemId: mine });
    const seen: any[] = [];
    await vex.subscribe("ev.list", { scope: "a" }, (r: any) => seen.push(r), {
      user: alice,
    });
    expect(seen.at(-1).map((r: any) => r.name)).toEqual(["mine"]);
    expect(await vex.query("ev.whoami", {}, { user: alice })).toBe("alice");
    await vex.mutate("ev.rename", { id: mine, name: "mine!" });
    expect(seen.at(-1).map((r: any) => r.name)).toEqual(["mine!"]);
  });

  test("a write landing during a worker run is seen, and runs stay single-flight", async () => {
    const vex = await create(1);
    const id = await vex.mutate("ev.add", { scope: "a", name: "one" });
    const seen: any[] = [];
    await vex.subscribe("ev.names", { scope: "a" }, (r: any) => seen.push(r));
    await Promise.all([
      vex.mutate("ev.rename", { id, name: "two" }),
      new Promise<void>((resolve) =>
        setTimeout(
          () =>
            vex
              .mutate("ev.rename", { id, name: "three" })
              .then(() => resolve()),
          0,
        ),
      ),
    ]);
    expect(seen.at(-1)).toEqual([{ name: "three", when: null }]);
    const names = seen.map((rows) => rows[0].name);
    // Never a stale name after a fresh one.
    expect(names.indexOf("three")).toBe(names.length - 1);
  });

  test("a caller that cannot cross to a worker evaluates on the main thread", async () => {
    const vex = await create();
    const seen: unknown[] = [];
    const user = { ...alice, decide: () => true } as unknown as VexUser;
    await vex.subscribe("ev.whoami", {}, (r: unknown) => seen.push(r), {
      user,
    });
    expect(meta("subscribe").at(-1)?.offThread).toBe(false);
    expect(seen).toEqual(["alice"]);
  });

  test("a handler error in the worker fails the subscribe as on the main thread", async () => {
    const vex = await create();
    await expect(vex.subscribe("ev.failing", {}, () => {})).rejects.toThrow(
      "handler failed",
    );
    expect(vex.activeSubscriptionCount()).toBe(0);
  });

  test("the reactive budget is judged on the main thread from the worker's measurement", async () => {
    const vex = await create();
    for (const name of ["a", "b", "c"]) {
      await vex.mutate("ev.add", { scope: "a", name });
    }
    await expect(vex.subscribe("ev.huge", {}, () => {})).rejects.toThrow(
      "Reactive query budget exceeded",
    );
  });

  test("many subscriptions re-run across the pool and every one is delivered", async () => {
    const vex = await create(3);
    const seen = new Map<string, unknown[]>();
    for (let i = 0; i < 12; i++) {
      const scope = `s${i % 4}`;
      const key = `${scope}#${i}`;
      seen.set(key, []);
      await vex.subscribe("ev.names", { scope }, (r: unknown) =>
        seen.get(key)!.push(r),
      );
    }
    await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        vex.mutate("ev.add", { scope: `s${i}`, name: `n${i}` }),
      ),
    );
    for (const [key, deliveries] of seen) {
      const scope = key.split("#")[0];
      expect(deliveries.at(-1)).toEqual([
        { name: `n${scope.slice(1)}`, when: null },
      ]);
    }
  });

  test("close terminates the workers", async () => {
    const vex = await create();
    await vex.subscribe("ev.names", { scope: "a" }, () => {});
    await vex.close();
    open = [];
    expect(vex.activeSubscriptionCount()).toBe(0);
  });
});
