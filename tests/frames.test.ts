/**
 * A handler calls the engine only through its context (frames.ts): a
 * captured engine called from inside a query, mutation or action is
 * refused; an action's ctx calls are its own.
 */

import { afterEach, expect, test } from "bun:test";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import type { VexPluginAPI } from "../src/core/api.js";
import { Vex } from "../src/core/engine.js";
import { Type } from "../src/portable.js";

let open: Vex[] = [];
afterEach(async () => {
  await Promise.all(open.map((v) => v.close()));
  open = [];
});

test("a handler calling a captured engine is refused; an action's ctx calls are its own", async () => {
  const holder: { vex?: Vex } = {};
  const vex = await Vex.create({
    storage: sqliteAdapter(":memory:"),
    plugins: [
      (api: VexPluginAPI) => {
        api.setName("re");
        api.registerTable("items", { columns: { n: Type.Number() } });
        api.registerQuery("count", {
          args: {},
          handler: (ctx) => ctx.db.table("items").count(),
        });
        api.registerMutation("add", {
          args: {},
          handler: (ctx) => ctx.db.table("items").insert({ n: 1 }),
        });
        api.registerQuery("q", {
          args: {},
          handler: () => holder.vex!.query("re.count"),
        });
        api.registerMutation("m", {
          args: {},
          handler: () => holder.vex!.mutate("re.add"),
        });
        api.registerAction("a", {
          args: {},
          handler: () => holder.vex!.query("re.count"),
        });
        api.registerAction("sub", {
          args: {},
          handler: () => holder.vex!.subscribe("re.count", {}, () => {}),
        });
        api.registerAction("viaCtx", {
          args: {},
          handler: async (ctx) => {
            await ctx.mutate("re.add");
            return ctx.query("re.count");
          },
        });
      },
    ],
  });
  open.push(vex);
  holder.vex = vex;
  await expect(vex.query("re.q")).rejects.toThrow(
    "vex.query is refused inside query re.q",
  );
  await expect(vex.mutate("re.m")).rejects.toThrow(
    "vex.mutate is refused inside mutation re.m: call through the handler's context (ctx.db)",
  );
  await expect(vex.action("re.a")).rejects.toThrow(
    "vex.query is refused inside action re.a: call through the handler's context (ctx.query)",
  );
  await expect(vex.action("re.sub")).rejects.toThrow(
    "vex.subscribe is refused inside action re.sub: a handler subscribes to nothing",
  );
  expect(await vex.action("re.viaCtx")).toBe(1);
});

test("middleware may ask the engine how to decide; the handler it lets through may not", async () => {
  const holder: { vex?: Vex } = {};
  const vex = await Vex.create({
    storage: sqliteAdapter(":memory:"),
    plugins: [
      (api: VexPluginAPI) => {
        api.setName("gate");
        api.registerQuery("allowed", {
          args: {},
          handler: () => true,
        });
        api.registerQuery("open", { args: {}, handler: () => "opened" });
        api.registerQuery("reentrant", {
          args: {},
          handler: () => holder.vex!.query("gate.allowed"),
        });
        api.registerQuery("composed", {
          args: {},
          handler: (ctx) => ctx.query("gate.open"),
        });
        api.use(async (_ctx, info, next) => {
          if (info.name === "gate.allowed") return next();
          if (!(await holder.vex!.query("gate.allowed"))) throw new Error("no");
          return next();
        });
      },
    ],
  });
  open.push(vex);
  holder.vex = vex;
  expect(await vex.query("gate.open")).toBe("opened");
  // A query composed through ctx.query is decided by the same
  // middleware, outside the calling handler's frame.
  expect(await vex.query("gate.composed")).toBe("opened");
  await expect(vex.query("gate.reentrant")).rejects.toThrow(
    "vex.query is refused inside query gate.reentrant: call through the handler's context (ctx.query)",
  );
});
