// The closed surface on a Durable Object, from the built package as a
// Worker imports it: checked args, env and services, the scheduler on
// the object's alarm, handler frames, purityCheck, composed queries;
// and reads off the main thread refused, the object having one thread.

import { durableObjectAdapter, Vex, type VexPluginAPI } from "vex-core";
import { Type } from "../../src/portable.js";
import { describe, expect, objectStorage, test } from "./bun-test.js";

const holder: { vex?: Vex } = {};
let counter = 0;

function plugin(api: VexPluginAPI) {
  api.setName("cs");
  api.registerTable("notes", { columns: { text: Type.String() } });
  api.registerQuery("count", {
    args: {},
    handler: (ctx) => ctx.db.table("notes").count(),
  });
  api.registerQuery("summary", {
    args: {},
    handler: async (ctx) => ({
      n: await ctx.query("cs.count"),
      place: (ctx.env as { place?: string }).place ?? null,
      services: "services" in ctx,
    }),
  });
  api.registerQuery("counted", { args: {}, handler: () => ++counter });
  api.registerQuery("reentrant", {
    args: {},
    handler: () => holder.vex!.query("cs.count"),
  });
  api.registerMutation("add", {
    args: { text: Type.String() },
    handler: (ctx, args) => ctx.db.table("notes").insert(args),
  });
  api.registerMutation("later", {
    args: { text: Type.String() },
    handler: (ctx, args) => ctx.scheduler.runAfter(0, "cs.add", args),
  });
  api.registerMutation("laterWrong", {
    args: {},
    handler: (ctx) => ctx.scheduler.runAfter(0, "cs.add", { text: 1 }),
  });
  api.registerAction("clock", {
    args: {},
    returns: Type.Number(),
    handler: (ctx) =>
      (ctx.services as { clock: { now(): number } }).clock.now(),
  });
}

// Options past the defaults, as an app would pass them.
const create = (options: Record<string, unknown> = {}) =>
  Vex.create({
    plugins: [plugin],
    storage: durableObjectAdapter(objectStorage()),
    jobScheduler: "external",
    ...options,
  });

describe("the closed surface on a Durable Object", () => {
  test("args are checked against their TypeBox schema", async () => {
    const vex = await create();
    await expect(vex.mutate("cs.add", { text: 1 })).rejects.toMatchObject({
      name: "ArgsError",
      status: 400,
    });
    await vex.close();
  });

  test("env reaches every handler, services only actions, and a query composes another", async () => {
    const vex = await create({
      env: { place: "object" } as never,
      services: { clock: { now: () => 42 } } as never,
    });
    await vex.mutate("cs.add", { text: "a" });
    expect(await vex.query("cs.summary")).toEqual({
      n: 1,
      place: "object",
      services: false,
    });
    expect(await vex.action("cs.clock")).toBe(42);
    await vex.close();
  });

  test("a scheduled function is a row the object's alarm runs", async () => {
    const vex = await create();
    await vex.mutate("cs.later", { text: "b" });
    const next = await vex.nextJobRun();
    expect(typeof next).toBe("number");
    expect(await vex.query("cs.count")).toBe(0);
    await vex.runDueJobs(next! + 1);
    expect(await vex.query("cs.count")).toBe(1);
    expect(await vex.nextJobRun()).toBeNull();
    // Its args are checked when it is scheduled.
    await expect(vex.mutate("cs.laterWrong")).rejects.toMatchObject({
      name: "ArgsError",
    });
    await vex.close();
  });

  test("a handler calling the engine past its context is refused", async () => {
    const vex = await create();
    holder.vex = vex;
    await expect(vex.query("cs.reentrant")).rejects.toThrow(
      "vex.query is refused inside query cs.reentrant: call through the handler's context (ctx.query)",
    );
    await vex.close();
  });

  test("under purityCheck a query answering two ways is refused", async () => {
    const vex = await create({ purityCheck: "always" });
    await expect(vex.query("cs.counted")).rejects.toThrow(
      "query cs.counted answered two ways on the same data",
    );
    expect(await vex.query("cs.count")).toBe(0);
    await vex.close();
  });

  test("evaluation workers are refused: no other thread reads the object", async () => {
    await expect(create({ evaluation: { workers: 1 } })).rejects.toThrow(
      "evaluation workers",
    );
  });
});
