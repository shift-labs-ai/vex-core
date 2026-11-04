/**
 * A handler calls the engine only through its context (frames.ts): a
 * captured engine called from inside a query, mutation or action is
 * refused; an action's ctx calls are its own.
 */

import { afterEach, expect, test } from "bun:test";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import type { VexPluginAPI } from "../src/core/api.js";
import { Vex } from "../src/core/engine.js";

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
        api.registerTable("items", { columns: { n: { type: "number" } } });
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
    "vex.mutate is refused inside mutation re.m",
  );
  await expect(vex.action("re.a")).rejects.toThrow(
    "vex.query is refused inside action re.a: call through the handler's context (ctx.query)",
  );
  expect(await vex.action("re.viaCtx")).toBe(1);
});
