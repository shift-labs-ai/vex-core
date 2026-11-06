/**
 * Actions: work that cannot sit in a transaction. An action is decided
 * by middleware like any operation, runs outside any transaction, and
 * reaches the database only through the queries and mutations it
 * calls, each made as its caller and decided in turn.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import type { VexPluginAPI } from "../src/core/api.js";
import { Vex } from "../src/core/engine.js";
import type { MiddlewareInfo, VexUser } from "../src/core/types.js";

type Access = { permission: string };

const dana: VexUser = { id: "dana", name: "Dana", isAdmin: false };

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
  api.registerAction("import", {
    args: { texts: "json" },
    access: { permission: "notes.import" },
    async handler(ctx, args) {
      for (const text of args.texts as string[]) {
        if (text === "boom") throw new Error("import failed");
        await ctx.mutate("notes.add", { text });
      }
      return (await ctx.query("notes.list")).length;
    },
  });
  api.registerAction("relay", {
    args: { texts: "json" },
    access: { permission: "notes.import" },
    handler: (ctx, args) => ctx.action("notes.import", args),
  });
  api.registerAction("wait", {
    args: { ms: "number" },
    access: { permission: "notes.wait" },
    async handler(_ctx, args) {
      await Bun.sleep(args.ms);
      return "waited";
    },
  });
  api.registerAction("watch", {
    args: {},
    access: { permission: "notes.wait" },
    handler: (ctx) => ctx.signal ?? null,
  });
  api.registerAction("watchThrough", {
    args: {},
    access: { permission: "notes.wait" },
    handler: (ctx) => ctx.action("notes.watch"),
  });
  api.registerQuery("slow", {
    args: { ms: "number" },
    access: { permission: "notes.read" },
    async handler(_ctx, args) {
      await Bun.sleep(args.ms);
      return "read";
    },
  });
}

let vex: Vex<Access> | null = null;

afterEach(async () => {
  await vex?.close();
  vex = null;
});

/** An engine whose middleware records every call: its kind, name, declaration and caller. */
async function recording(handlerTimeoutMs?: number) {
  const seen: Array<
    [MiddlewareInfo<Access>["type"], string, unknown, unknown]
  > = [];
  vex = await Vex.create<Access>({
    storage: sqliteAdapter(":memory:"),
    ...(handlerTimeoutMs ? { handlerTimeoutMs } : {}),
    plugins: [
      notesPlugin,
      (api) => {
        api.setName("audit");
        api.use((ctx, info, next) => {
          seen.push([info.type, info.name, info.access, ctx.user?.id]);
          return next();
        });
      },
    ],
  });
  return { engine: vex, seen };
}

describe("actions", () => {
  test("middleware decides the action, and each call it makes as the same caller", async () => {
    const { engine, seen } = await recording();
    expect(
      await engine.action("notes.import", { texts: ["a"] }, { user: dana }),
    ).toBe(1);
    expect(seen).toEqual([
      ["action", "notes.import", { permission: "notes.import" }, "dana"],
      ["mutation", "notes.add", { permission: "notes.write" }, "dana"],
      ["query", "notes.list", { permission: "notes.read" }, "dana"],
    ]);
  });

  test("an action calls another as its caller, decided in turn", async () => {
    const { engine, seen } = await recording();
    await engine.action("notes.relay", { texts: ["a"] }, { user: dana });
    expect(seen.map(([type, name, , user]) => [type, name, user])).toEqual([
      ["action", "notes.relay", "dana"],
      ["action", "notes.import", "dana"],
      ["mutation", "notes.add", "dana"],
      ["query", "notes.list", "dana"],
    ]);
  });

  test("a refusal by middleware stops the action before its handler runs", async () => {
    vex = await Vex.create<Access>({
      storage: sqliteAdapter(":memory:"),
      plugins: [
        notesPlugin,
        (api) => {
          api.setName("gate");
          api.use((_ctx, info, next) => {
            if (info.access?.permission === "notes.import") {
              throw new Error("refused");
            }
            return next();
          });
        },
      ],
    });
    await expect(
      vex.action("notes.import", { texts: ["a"] }, { user: dana }),
    ).rejects.toThrow("refused");
    expect(await vex.query("notes.list")).toEqual([]);
  });

  test("it holds no transaction: what its mutations wrote stays when it fails after them", async () => {
    const { engine } = await recording();
    await expect(
      engine.action("notes.import", { texts: ["a", "b", "boom"] }),
    ).rejects.toThrow("import failed");
    expect(
      ((await engine.query("notes.list")) as Array<{ text: string }>).map(
        (note) => note.text,
      ),
    ).toEqual(["a", "b"]);
  });

  test("no handler timeout bounds an action; a query's still bounds it", async () => {
    const { engine } = await recording(20);
    expect(await engine.action("notes.wait", { ms: 60 })).toBe("waited");
    await expect(engine.query("notes.slow", { ms: 60 })).rejects.toThrow(
      "Handler timed out after 20ms",
    );
  });

  test("an action, and each action it calls, sees its caller's signal", async () => {
    const { engine } = await recording();
    const caller = new AbortController();
    const call = { user: dana, signal: caller.signal };
    expect(await engine.action("notes.watch", {}, call)).toBe(caller.signal);
    expect(await engine.action("notes.watchThrough", {}, call)).toBe(
      caller.signal,
    );
    expect(await engine.action("notes.watch", {}, { user: dana })).toBeNull();
  });

  test("a caller that has already stopped waiting starts nothing", async () => {
    const { engine, seen } = await recording();
    const caller = new AbortController();
    caller.abort(new Error("gone"));
    await expect(
      engine.action(
        "notes.import",
        { texts: ["a"] },
        { user: dana, signal: caller.signal },
      ),
    ).rejects.toThrow("gone");
    expect(seen).toEqual([]);
    expect(await engine.query("notes.list")).toEqual([]);
  });

  test("what middleware tells an action of its caller, the calls it makes carry", async () => {
    // A gate that resolves the caller's standing hands the handler and
    // every call it makes the same caller.
    const told: Array<[string, unknown]> = [];
    const elevated: VexUser = { ...dana, isAdmin: true };
    vex = await Vex.create<Access>({
      storage: sqliteAdapter(":memory:"),
      plugins: [
        notesPlugin,
        (api) => {
          api.setName("gate");
          api.use((ctx, info, next) => {
            if (info.type === "action") ctx.user = elevated;
            else told.push([info.name, ctx.user]);
            return next();
          });
        },
      ],
    });
    await vex.action("notes.import", { texts: ["a"] }, { user: dana });
    expect(told).toEqual([
      ["notes.add", elevated],
      ["notes.list", elevated],
    ]);
  });

  test("an unknown action is refused by name", async () => {
    const { engine } = await recording();
    await expect(engine.action("notes.nope")).rejects.toThrow(
      "Action not found: notes.nope",
    );
  });

  test("the engine lists and describes actions with their declarations", async () => {
    const { engine } = await recording();
    expect(engine.listActions().sort()).toEqual([
      "notes.import",
      "notes.relay",
      "notes.wait",
      "notes.watch",
      "notes.watchThrough",
    ]);
    expect(engine.describeAction("notes.import")).toEqual({
      plugin: "notes",
      args: { texts: "json" },
      access: { permission: "notes.import" },
    });
    expect(engine.describeAction("notes.list")).toBeNull();
    const { actions } = await engine.introspect();
    for (const { name, ...described } of actions) {
      expect([name, described]).toEqual([name, engine.describeAction(name)]);
    }
  });

  test("an action name is registered once", async () => {
    const ping = (api: VexPluginAPI<Access>) => {
      api.setName("ping");
      api.registerAction("send", {
        args: {},
        access: { permission: "ping.send" },
        handler: () => "pong",
      });
    };
    await expect(
      Vex.create<Access>({
        storage: sqliteAdapter(":memory:"),
        plugins: [ping, ping],
      }),
    ).rejects.toThrow("Duplicate action: ping.send");
  });
});
