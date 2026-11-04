/**
 * Reads off the main thread (`EvaluationPool`): a worker builds its
 * read-only engine from the app's own plugin modules, env and storage,
 * runs the query and answers with the result and what it read; the
 * main thread keeps judging, single-flight runs and delivery, so what
 * a reader sees is what it sees on the main thread. The pool takes a
 * query's runs once they cost more than `offloadAboveMs`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import { Vex, type VexOptions } from "../src/core/engine.js";
import type { Span } from "../src/core/tracer.js";
import type { VexUser } from "../src/core/types.js";
import { isHttpError } from "../src/http/error.js";
import { createRouter } from "../src/http/router.js";
import { vexHandler } from "../src/http/vex-handler.js";

const PLUGIN = new URL("./fixtures/evaluation-plugin.ts", import.meta.url);

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

function databasePath() {
  const dir = mkdtempSync(join(tmpdir(), "vex-eval-"));
  dirs.push(dir);
  return join(dir, "db.sqlite");
}

async function create(
  workers = 2,
  options: Partial<VexOptions> & { offloadAboveMs?: number } = {},
) {
  const { offloadAboveMs = 0, ...rest } = options;
  const vex = await Vex.create({
    plugins: [PLUGIN],
    storage: sqliteAdapter(databasePath()),
    evaluation: { workers, offloadAboveMs },
    tracer: { onSpan: (span) => spans.push(span) },
    ...rest,
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

  test("a worker reads the app's env, as the main thread does", async () => {
    const vex = await create(1, { env: { place: "everywhere" } as never });
    const heard: unknown[] = [];
    await vex.subscribe("ev.env", {}, (r) => heard.push(r));
    expect(meta("subscribe").at(-1)?.offThread).toBe(true);
    expect(heard).toEqual([{ place: "everywhere" }]);
  });

  test("a one-shot query runs in the pool too, answering and tracing as here", async () => {
    const vex = await create(1);
    await vex.mutate("ev.add", { scope: "a", name: "one" });
    expect(await vex.query("ev.names", { scope: "a" })).toEqual([
      { name: "one", when: null },
    ]);
    expect(meta("query").at(-1)).toEqual(
      expect.objectContaining({ offThread: true, tables: ["items"] }),
    );
    // Its answer is its JSON reading, as every caller is handed.
    const sparse = await vex.query("ev.sparse", { scope: "a" });
    expect(sparse).toEqual({ n: 1 });
    expect("missing" in sparse).toBe(false);
    // As the caller, through the policy.
    expect(await vex.query("ev.whoami", {}, { user: alice })).toBe("alice");
  });

  test("a refusal in a worker answers with its HTTP status and body, as one here would", async () => {
    const vex = await create(1);
    const error = await vex.query("ev.forbidden").catch((e: unknown) => e);
    expect(isHttpError(error)).toBe(true);
    expect(error).toMatchObject({
      status: 403,
      message: "not yours",
      body: { code: "NOT_YOURS" },
    });
    const app = createRouter().mount("/vex", vexHandler(vex));
    const res = await app.handle(
      new Request("http://x/vex/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "ev.forbidden" }),
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: "NOT_YOURS" });
    // Its body crosses as HTTP would send it, its JSON reading, even
    // when it holds what a thread boundary cannot copy.
    expect(
      await vex.query("ev.forbiddenOddly").catch((e: unknown) => e),
    ).toMatchObject({ status: 403, body: { code: "NOT_YOURS" } });
    // An args refusal stays a 400 wherever the args are checked.
    await expect(vex.query("ev.names", { scope: 1 })).rejects.toMatchObject({
      status: 400,
    });
  });

  test("the pool takes a query once its runs cost past offloadAboveMs, and hands it back once they cost under half", async () => {
    const vex = await create(1, { offloadAboveMs: 5 });
    const ran = () => meta("query").at(-1)?.offThread === true;
    // Cheap: here, always.
    for (let i = 0; i < 3; i++) await vex.query("ev.names", { scope: "a" });
    expect(ran()).toBe(false);
    // Costly: its first run here measures it; the next goes to the pool.
    await vex.query("ev.slow", { ms: 20 });
    expect(ran()).toBe(false);
    await vex.query("ev.slow", { ms: 20 });
    expect(ran()).toBe(true);
    // Cheap again: its average falls a third of the way each run, and
    // under 2.5 ms it returns here.
    let back = 0;
    for (let i = 0; i < 12 && ran(); i++) {
      await vex.query("ev.slow", { ms: 0 });
      back = i + 1;
    }
    expect(ran()).toBe(false);
    expect(back).toBeGreaterThan(1);
  });

  test("a subscription's runs follow the same rule", async () => {
    const vex = await create(1, { offloadAboveMs: 5 });
    await vex.subscribe("ev.slow", { ms: 20 }, () => {});
    expect(meta("subscribe").at(-1)?.offThread).toBe(false);
    await vex.mutate("ev.add", { scope: "a", name: "one" });
    expect(meta("invalidation").at(-1)?.offThread).toBe(1);
  });

  test("under purityCheck every read runs here, where the check repeats it", async () => {
    const vex = await create(1, { purityCheck: "always" });
    await vex.query("ev.names", { scope: "a" });
    expect(meta("query").at(-1)?.offThread).toBeUndefined();
    await vex.subscribe("ev.names", { scope: "a" }, () => {});
    expect(meta("subscribe").at(-1)?.offThread).toBe(false);
  });

  test("a file-based app is a plugin module too, and its reads run in the pool", async () => {
    const vex = await Vex.create({
      plugins: [new URL("./fixtures/refs/scanned.ts", import.meta.url)],
      storage: sqliteAdapter(databasePath()),
      evaluation: { workers: 1, offloadAboveMs: 0 },
      tracer: { onSpan: (span) => spans.push(span) },
    });
    open.push(vex);
    await vex.mutate("todos.add", { text: "b" });
    await vex.mutate("todos.add", { text: "a" });
    expect(await vex.query("todos.list")).toEqual(["a", "b"]);
    expect(meta("query").at(-1)?.offThread).toBe(true);
  });
});

describe("what a worker needs, or the engine refuses to start", () => {
  test("a plugin given by value is refused: a worker could not import it", async () => {
    const { default: plugin } = await import("./fixtures/evaluation-plugin.js");
    await expect(
      Vex.create({
        plugins: [plugin],
        storage: sqliteAdapter(databasePath()),
        evaluation: { workers: 1 },
      }),
    ).rejects.toThrow(
      "evaluation workers build their engine from the app's plugins, so each is given by module (PluginModule): 1 given by value",
    );
  });

  test("a storage no other thread can open is refused", async () => {
    await expect(
      Vex.create({
        plugins: [PLUGIN],
        storage: sqliteAdapter(":memory:"),
        evaluation: { workers: 1 },
      }),
    ).rejects.toThrow(
      "evaluation workers open the storage from another thread, which this one cannot be",
    );
  });

  test("offloadAboveMs is a run time, 0 or more", async () => {
    await expect(create(1, { offloadAboveMs: -1 })).rejects.toThrow(
      "evaluation.offloadAboveMs: a run time in ms, 0 or more",
    );
  });

  test("a file database says how another thread reads it; one in memory cannot be", () => {
    const path = databasePath();
    const file = sqliteAdapter(path, { busyTimeout: 1234 });
    expect(file.reader?.()).toEqual({
      adapter: "sqlite",
      path,
      busyTimeout: 1234,
    });
    expect(sqliteAdapter(":memory:").reader?.()).toBeNull();
    file.close();
  });
});
