/**
 * Functions scheduled from mutations and actions (ctx.scheduler): a
 * mutation's schedule is part of its transaction, each runs once, as
 * the caller who scheduled it, and one cut short by a stop is never
 * run again.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import type { VexPluginAPI } from "../src/core/api.js";
import { Vex } from "../src/core/engine.js";
import type { VexUser } from "../src/core/types.js";
import { rawSql } from "../src/internal.js";
import { Type } from "../src/portable.js";

let open: Vex[] = [];
afterEach(async () => {
  await Promise.all(open.map((v) => v.close()));
  open = [];
});

const effects: Array<{ note: string; as: string | null }> = [];
let failNext = false;

function plugin(api: VexPluginAPI) {
  api.setName("sch");
  api.registerTable("notes", { columns: { text: Type.String() } });
  api.registerMutation("note", {
    args: { text: Type.String(), delayMs: Type.Number(), fail: Type.Boolean() },
    async handler(ctx, args) {
      await ctx.db.table("notes").insert({ text: args.text });
      const id = await ctx.scheduler.runAfter(args.delayMs, "sch.send", {
        note: args.text,
      });
      if (args.fail) throw new Error("rolled back");
      return id;
    },
  });
  api.registerMutation("cancel", {
    args: { id: Type.String() },
    handler: async (ctx, args) => {
      await ctx.scheduler.cancel(args.id);
      return null;
    },
  });
  api.registerMutation("badSchedule", {
    args: {},
    handler: (ctx) => ctx.scheduler.runAfter(0, "sch.send", { wrong: 1 }),
  });
  api.registerQuery("list", {
    args: {},
    handler: (ctx) => ctx.db.table("notes").all(),
  });
  api.registerMutation("scheduleQuery", {
    args: {},
    handler: (ctx) => ctx.scheduler.runAfter(0, "sch.list"),
  });
  api.registerAction("send", {
    args: { note: Type.String() },
    handler: (ctx, args) => {
      if (failNext) {
        failNext = false;
        throw new Error("provider down");
      }
      effects.push({ note: args.note, as: ctx.user?.id ?? null });
      return null;
    },
  });
}

const alice: VexUser = { id: "alice", name: "Alice", isAdmin: false };

async function engine(options: Partial<Parameters<typeof Vex.create>[0]> = {}) {
  const vex = await Vex.create({
    storage: sqliteAdapter(":memory:"),
    plugins: [plugin],
    ...options,
  });
  open.push(vex);
  return vex;
}

const statuses = (vex: Vex) =>
  rawSql<{ name: string; status: string; error: string | null }>(
    vex,
    "SELECT name, status, error FROM _scheduled ORDER BY createdAt",
  );

async function until(check: () => boolean | Promise<boolean>, ms = 2000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
}

describe("a mutation's schedule is part of its transaction", () => {
  test("it runs after the mutation commits, once, as the caller who scheduled it", async () => {
    effects.length = 0;
    const vex = await engine();
    await vex.mutate(
      "sch.note",
      { text: "hi", delayMs: 0, fail: false },
      { user: alice },
    );
    await until(() => effects.length === 1);
    expect(effects).toEqual([{ note: "hi", as: "alice" }]);
    expect(await statuses(vex)).toEqual([
      { name: "sch.send", status: "done", error: null },
    ]);
  });

  test("a mutation that rolls back schedules nothing", async () => {
    effects.length = 0;
    const vex = await engine();
    await expect(
      vex.mutate("sch.note", { text: "no", delayMs: 0, fail: true }),
    ).rejects.toThrow("rolled back");
    await Bun.sleep(30);
    expect(effects).toEqual([]);
    expect(await statuses(vex)).toEqual([]);
  });

  test("it waits its delay, and a cancelled one never runs", async () => {
    effects.length = 0;
    const vex = await engine();
    const soon = await vex.mutate("sch.note", {
      text: "soon",
      delayMs: 80,
      fail: false,
    });
    const never = await vex.mutate("sch.note", {
      text: "never",
      delayMs: 80,
      fail: false,
    });
    await vex.mutate("sch.cancel", { id: never });
    await Bun.sleep(20);
    expect(effects).toEqual([]);
    await until(() => effects.length === 1);
    await Bun.sleep(40);
    expect(effects.map((e) => e.note)).toEqual(["soon"]);
    expect(soon).toBeString();
  });

  test("its args are checked when it is scheduled, failing the mutation", async () => {
    const vex = await engine();
    await expect(vex.mutate("sch.badSchedule")).rejects.toThrow(
      'takes no arg "wrong"',
    );
    expect(await statuses(vex)).toEqual([]);
  });

  test("a scheduled function that fails is recorded failed, with its error", async () => {
    effects.length = 0;
    failNext = true;
    const vex = await engine();
    await vex.mutate("sch.note", { text: "x", delayMs: 0, fail: false });
    await until(async () => (await statuses(vex))[0]?.status === "failed");
    expect((await statuses(vex))[0]).toEqual({
      name: "sch.send",
      status: "failed",
      error: "provider down",
    });
  });
});

describe("a scheduled function runs at most once", () => {
  test("one running when the engine stopped is failed at restart, never run again", async () => {
    effects.length = 0;
    const file = join(mkdtempSync(join(tmpdir(), "vex-sch-")), "db.sqlite");
    const first = await engine({ storage: sqliteAdapter(file) });
    const id = await first.mutate("sch.note", {
      text: "cut",
      delayMs: 60_000,
      fail: false,
    });
    // As a stop mid-run leaves it.
    await rawSql(
      first,
      "UPDATE _scheduled SET status = 'running' WHERE _id = ?",
      id,
    );
    await first.close();
    open = open.filter((v) => v !== first);
    const again = await engine({ storage: sqliteAdapter(file) });
    expect(await statuses(again)).toEqual([
      {
        name: "sch.send",
        status: "failed",
        error: "interrupted: the engine stopped while it ran",
      },
    ]);
    expect(effects).toEqual([]);
  });
});

describe("what is scheduled, and what is kept", () => {
  test("only a mutation or an action is scheduled: a query's answer would reach no one", async () => {
    const vex = await engine();
    await expect(vex.mutate("sch.scheduleQuery")).rejects.toThrow(
      "Cannot schedule sch.list: no mutation or action of that name",
    );
  });

  test("a finished one is kept a week, then deleted", async () => {
    effects.length = 0;
    const vex = await engine({ jobScheduler: "external" });
    await vex.mutate("sch.note", { text: "kept", delayMs: 0, fail: false });
    await vex.runDueJobs(Date.now());
    expect((await statuses(vex)).map((row) => row.status)).toEqual(["done"]);
    const day = 24 * 60 * 60 * 1000;
    await vex.runDueJobs(Date.now() + 6 * day);
    expect(await statuses(vex)).toHaveLength(1);
    await vex.runDueJobs(Date.now() + 8 * day);
    expect(await statuses(vex)).toEqual([]);
  });
});

describe("an external scheduler drives scheduled functions too", () => {
  test("nextJobRun names when one is due, and runDueJobs runs it", async () => {
    effects.length = 0;
    const vex = await engine({ jobScheduler: "external" });
    const before = Date.now();
    await vex.mutate("sch.note", { text: "ext", delayMs: 500, fail: false });
    const next = await vex.nextJobRun();
    expect(next).toBeGreaterThanOrEqual(before + 500);
    await vex.runDueJobs(Date.now());
    expect(effects).toEqual([]);
    await vex.runDueJobs(next! + 1);
    expect(effects.map((e) => e.note)).toEqual(["ext"]);
  });
});
