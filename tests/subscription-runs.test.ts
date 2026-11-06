/**
 * A subscription sees every write committed after a read of its query,
 * and results arrive in the order they were read (SHFT-2545). It is
 * registered before its first run, and every run of it is single-
 * flight: an invalidation that lands while a run is open marks it
 * stale rather than opening another, and the run repeats until none
 * lands during it; a write landing as the run closes runs it afresh
 * (SHFT-2591).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import type { VexPluginAPI } from "../src/core/api.js";
import { Vex } from "../src/core/engine.js";

let open: Vex[] = [];
/** Runs after the list query's read, before it answers. */
let afterRead: (() => Promise<void>) | null = null;
let runs = 0;

afterEach(async () => {
  await Promise.all(open.map((v) => v.close()));
  open = [];
  afterRead = null;
  runs = 0;
});

function plugin(api: VexPluginAPI) {
  api.setName("ch");
  api.registerTable("channels", {
    columns: { name: { type: "string" }, started: { type: "boolean" } },
  });
  api.registerQuery("list", {
    args: {},
    async handler(ctx) {
      runs++;
      const rows = await ctx.db.table("channels").order("name", "asc").all();
      const hook = afterRead;
      afterRead = null;
      if (hook) await hook();
      return rows.map((r: any) => `${r.name}:${r.started}`);
    },
  });
  api.registerMutation("create", {
    args: { name: "string" },
    handler: (ctx, args) =>
      ctx.db.table("channels").insert({ name: args.name, started: false }),
  });
  api.registerMutation("start", {
    args: { id: "string" },
    handler: (ctx, args) =>
      ctx.db.table("channels").update(args.id, { started: true }),
  });
}

async function create() {
  const vex = await Vex.create({
    plugins: [plugin],
    storage: sqliteAdapter(":memory:"),
  });
  open.push(vex);
  return vex;
}

describe("subscriptions see writes landing during a run (SHFT-2545)", () => {
  test("a write committed between the first read and registration reaches the subscriber", async () => {
    const vex = await create();
    const id = await vex.mutate("ch.create", { name: "a" });
    afterRead = () => vex.mutate("ch.start", { id });

    const seen: string[][] = [];
    await vex.subscribe("ch.list", {}, (rows: string[]) => seen.push(rows));

    expect(seen.at(-1)).toEqual(["a:true"]);
    expect(runs).toBe(2);
  });

  test("writes landing during each repeated run are seen too", async () => {
    const vex = await create();
    const id = await vex.mutate("ch.create", { name: "a" });
    afterRead = async () => {
      await vex.mutate("ch.create", { name: "b" });
      afterRead = () => vex.mutate("ch.start", { id });
    };

    const seen: string[][] = [];
    await vex.subscribe("ch.list", {}, (rows: string[]) => seen.push(rows));

    expect(seen).toEqual([["a:true", "b:false"]]);
    expect(runs).toBe(3);
  });

  test("a write to another table during the first run does not repeat it", async () => {
    const vex = await Vex.create({
      plugins: [
        plugin,
        (api: VexPluginAPI) => {
          api.setName("other");
          api.registerTable("notes", { columns: { text: { type: "string" } } });
          api.registerMutation("add", {
            args: { text: "string" },
            handler: (ctx, args) => ctx.db.table("notes").insert(args),
          });
        },
      ],
      storage: sqliteAdapter(":memory:"),
    });
    open.push(vex);
    await vex.mutate("ch.create", { name: "a" });
    afterRead = () => vex.mutate("other.add", { text: "n" });

    const seen: string[][] = [];
    await vex.subscribe("ch.list", {}, (rows: string[]) => seen.push(rows));
    expect(seen).toEqual([["a:false"]]);
    expect(runs).toBe(1);
  });

  test("a write committed during a re-run reaches the subscriber, in order", async () => {
    const vex = await create();
    const id = await vex.mutate("ch.create", { name: "a" });
    const seen: string[][] = [];
    await vex.subscribe("ch.list", {}, (rows: string[]) => seen.push(rows));
    expect(seen).toEqual([["a:false"]]);

    // The re-run that `create b` causes reads; then a second write
    // commits, and its invalidation lands while that re-run is open.
    afterRead = () => vex.mutate("ch.start", { id });
    await vex.mutate("ch.create", { name: "b" });

    // Delivered in the order the results were read: never a stale
    // result after a fresh one.
    expect(seen).toEqual([["a:false"], ["a:true", "b:false"]]);
  });

  test("a subscriber that unsubscribes while a re-run is open hears nothing more", async () => {
    const vex = await create();
    await vex.mutate("ch.create", { name: "a" });
    const seen: string[][] = [];
    const unsubscribe = await vex.subscribe("ch.list", {}, (rows: string[]) =>
      seen.push(rows),
    );
    afterRead = async () => unsubscribe();
    await vex.mutate("ch.create", { name: "b" });
    expect(seen).toEqual([["a:false"]]);
    expect(vex.activeSubscriptionCount()).toBe(0);
  });

  test("a subscription whose first run fails is not left registered", async () => {
    const vex = await create();
    afterRead = async () => {
      throw new Error("boom");
    };
    await expect(vex.subscribe("ch.list", {}, () => {})).rejects.toThrow(
      "boom",
    );
    expect(vex.activeSubscriptionCount()).toBe(0);
  });
});

describe("a write landing as a run finishes is seen (SHFT-2591)", () => {
  /**
   * A query of two reads, a list and another table's count: on its
   * next run it starts a write (`start`, not awaited) before its
   * second read, then awaits `tail` times before it answers.
   */
  let start: (() => Promise<void>) | null = null;
  let tail = 0;
  afterEach(() => {
    start = null;
    tail = 0;
  });
  function twoReads(api: VexPluginAPI) {
    api.setName("tr");
    api.registerTable("channels", {
      columns: { name: { type: "string" }, on: { type: "boolean" } },
    });
    api.registerTable("sessions", { columns: { n: { type: "number" } } });
    api.registerQuery("list", {
      args: {},
      async handler(ctx) {
        const rows = await ctx.db.table("channels").order("name", "asc").all();
        const write = start;
        start = null;
        void write?.();
        const sessions = await ctx.db.table("sessions").count();
        for (let i = 0; i < tail; i++) await null;
        return rows.map((r: any) => `${r.name}:${r.on}:${sessions}`);
      },
    });
    api.registerMutation("add", {
      args: { name: "string" },
      handler: (ctx, args) =>
        ctx.db.table("channels").insert({ name: args.name, on: false }),
    });
    api.registerMutation("enable", {
      args: { id: "string" },
      handler: (ctx, args) =>
        ctx.db.table("channels").update(args.id, { on: true }),
    });
  }

  // Every offset of the write against the run's end, by `delay`
  // microtasks before the write and `tail` after the second read,
  // covers the one at which the write's invalidation resumes as the
  // run closes, wherever the engine's own awaits put it.
  test("whenever the write commits against the end of a run, the subscriber ends on what a fresh read answers", async () => {
    const lost: string[] = [];
    for (tail = 0; tail <= 12; tail++) {
      for (let delay = 0; delay <= 40; delay++) {
        const vex = await Vex.create({
          plugins: [twoReads],
          storage: sqliteAdapter(":memory:"),
        });
        open.push(vex);
        const id = await vex.mutate("tr.add", { name: "a" });
        const seen: string[][] = [];
        await vex.subscribe("tr.list", {}, (rows: string[]) => seen.push(rows));
        let committed = () => {};
        const enabled = new Promise<void>((resolve) => {
          committed = resolve;
        });
        start = async () => {
          for (let i = 0; i < delay; i++) await null;
          await vex.mutate("tr.enable", { id });
          committed();
        };
        await vex.mutate("tr.add", { name: "b" });
        await enabled;
        // Delivery follows the last write within a few turns; a lost
        // change never arrives.
        let truth: unknown;
        for (let turn = 0; turn < 20; turn++) {
          truth = await vex.query("tr.list");
          if (JSON.stringify(seen.at(-1)) === JSON.stringify(truth)) break;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        if (JSON.stringify(seen.at(-1)) !== JSON.stringify(truth)) {
          lost.push(`delay ${delay}, tail ${tail}`);
        }
        // Closed as it goes, so the sweep holds one engine at a time.
        await vex.close();
      }
    }
    expect(lost).toEqual([]);
  }, 60_000);
});
