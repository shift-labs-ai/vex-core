/**
 * Operation access: what a query or mutation declares about who may
 * run it reaches middleware with every call (subscription re-runs
 * included) and the engine's descriptions, unchanged. The engine
 * decides nothing with it. That a missing declaration does not compile
 * is pinned by the type tests (tests/types).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import type { VexPluginAPI } from "../src/core/api.js";
import { Vex } from "../src/core/engine.js";
import type { MiddlewareInfo } from "../src/core/types.js";

/** An app's declaration: the permission an operation needs. */
type Access = { permission: string } | "system";

function notesPlugin(api: VexPluginAPI<Access>) {
  api.setName("notes");
  api.registerTable("notes", { columns: { text: { type: "string" } } });
  api.registerQuery("list", {
    args: {},
    access: { permission: "notes.read" },
    handler: (ctx) => ctx.db.table("notes").all(),
  });
  api.registerMutation("add", {
    args: { text: "string" },
    access: { permission: "notes.write" },
    handler: (ctx, args) => ctx.db.table("notes").insert({ text: args.text }),
  });
  api.registerMutation("compact", {
    args: {},
    access: "system",
    handler: () => null,
  });
  api.registerWebhook("inbound", {
    path: "/hooks/notes",
    handler: () => ({ status: 204 }),
  });
}

let vex: Vex<Access> | null = null;

afterEach(async () => {
  await vex?.close();
  vex = null;
});

/** An engine that records what its middleware is told. */
async function recording() {
  const seen: MiddlewareInfo<Access>[] = [];
  vex = await Vex.create<Access>({
    storage: sqliteAdapter(":memory:"),
    plugins: [
      notesPlugin,
      (api) => {
        api.setName("audit");
        api.use((_ctx, info, next) => {
          seen.push(info);
          return next();
        });
      },
    ],
  });
  return { engine: vex, seen };
}

describe("operation access", () => {
  test("middleware is told what each query and mutation declares", async () => {
    const { engine, seen } = await recording();
    await engine.query("notes.list");
    await engine.mutate("notes.add", { text: "hi" });
    await engine.mutate("notes.compact");
    expect(seen.map((info) => [info.type, info.name, info.access])).toEqual([
      ["query", "notes.list", { permission: "notes.read" }],
      ["mutation", "notes.add", { permission: "notes.write" }],
      ["mutation", "notes.compact", "system"],
    ]);
  });

  test("a subscription's first run and every re-run carry its query's", async () => {
    const { engine, seen } = await recording();
    const unsubscribe = await engine.subscribe("notes.list", {}, () => {});
    await engine.mutate("notes.add", { text: "hi" });
    unsubscribe();
    expect(
      seen
        .filter((info) => info.name === "notes.list")
        .map((info) => info.access),
    ).toEqual([{ permission: "notes.read" }, { permission: "notes.read" }]);
  });

  test("a webhook declares none: its verify decides", async () => {
    const { engine, seen } = await recording();
    await engine.handleWebhook({
      body: {},
      rawBody: "",
      headers: {},
      method: "POST",
      path: "/hooks/notes",
      query: {},
    });
    expect(seen.map((info) => [info.type, info.access])).toEqual([
      ["webhook", undefined],
    ]);
  });

  test("the engine describes each operation with its declaration, one by one and all together", async () => {
    const { engine } = await recording();
    expect(engine.describeQuery("notes.list")?.access).toEqual({
      permission: "notes.read",
    });
    expect(engine.describeMutation("notes.compact")?.access).toBe("system");
    const { queries, mutations } = await engine.introspect();
    for (const { name, ...described } of queries) {
      expect([name, described]).toEqual([name, engine.describeQuery(name)]);
    }
    for (const { name, ...described } of mutations) {
      expect([name, described]).toEqual([name, engine.describeMutation(name)]);
    }
    expect(queries.map((q) => [q.name, q.access])).toEqual([
      ["notes.list", { permission: "notes.read" }],
    ]);
  });

  test("a declaration a cast left out reaches middleware as undefined, for the app's gate to refuse", async () => {
    const seen: MiddlewareInfo<Access>[] = [];
    vex = await Vex.create<Access>({
      storage: sqliteAdapter(":memory:"),
      plugins: [
        (api) => {
          api.setName("loose");
          api.registerQuery("open", {
            args: {},
            handler: () => "data",
          } as never);
          api.use((_ctx, info, next) => {
            seen.push(info);
            return next();
          });
        },
      ],
    });
    await vex.query("loose.open");
    expect(seen.map((info) => info.access)).toEqual([undefined]);
  });

  test("an app that chooses no declaration has none to give", async () => {
    const plain = await Vex.create({
      storage: sqliteAdapter(":memory:"),
      plugins: [
        (api) => {
          api.setName("plain");
          api.registerQuery("hello", { args: {}, handler: () => "hi" });
        },
      ],
    });
    try {
      expect(plain.describeQuery("plain.hello")?.access).toBeUndefined();
    } finally {
      await plain.close();
    }
  });
});
