/**
 * A raw read held to rows (`ctx.db.sql`) is held by the statement the
 * engine runs, not by the handler's word: inside it, a held table is
 * the rows its filters match and nothing else.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import type { VexPluginAPI } from "../src/core/api.js";
import { Vex } from "../src/core/engine.js";
import { holdStatement } from "../src/core/held-read.js";
import { rawSql } from "../src/internal.js";

let open: Vex[] = [];
afterEach(async () => {
  await Promise.all(open.map((v) => v.close()));
  open = [];
});

function plugin(api: VexPluginAPI) {
  api.setName("h");
  api.registerTable("messages", {
    columns: {
      sessionId: { type: "string", index: true },
      text: { type: "string" },
      at: { type: "number" },
    },
    indexes: [["idx_messages_sessionId_at", ["sessionId", "at"]]],
  });
  api.registerTable("sessions", { columns: { title: { type: "string" } } });
  // Reads the whole table, held to one session: hears only that one.
  api.registerQuery("count", {
    args: { sessionId: "string" },
    handler: (ctx, args) =>
      ctx.db.sql(
        {
          messages: [
            { column: "sessionId", operator: "=", value: args.sessionId },
          ],
        },
        "SELECT COUNT(*) AS n FROM messages",
      ),
  });
  // The sidebar's shape: a UNION ALL of per-session branches.
  api.registerQuery("latest", {
    args: { sessionIds: "json" },
    handler: (ctx, args) => {
      const ids = args.sessionIds as string[];
      return ctx.db.sql(
        { messages: [{ column: "sessionId", operator: "IN", value: ids }] },
        ids
          .map(
            () =>
              "SELECT * FROM (SELECT sessionId, text FROM messages WHERE sessionId = ? ORDER BY at DESC LIMIT 1)",
          )
          .join(" UNION ALL "),
        ...ids,
      );
    },
  });
  api.registerQuery("withOwnCte", {
    args: { sessionId: "string" },
    handler: (ctx, args) =>
      ctx.db.sql(
        {
          messages: [
            { column: "sessionId", operator: "=", value: args.sessionId },
          ],
        },
        "WITH latest AS (SELECT text FROM messages ORDER BY at DESC LIMIT 1) SELECT text FROM latest",
      ),
  });
  api.registerQuery("bypass", {
    args: { sessionId: "string" },
    handler: (ctx, args) =>
      ctx.db.sql(
        {
          messages: [
            { column: "sessionId", operator: "=", value: args.sessionId },
          ],
        },
        "SELECT COUNT(*) AS n FROM main.messages",
      ),
  });
  // Held to a session's rows and to two columns of them.
  api.registerQuery("texts", {
    args: { sessionId: "string" },
    handler: (ctx, args) =>
      ctx.db.sql(
        {
          messages: {
            where: [
              { column: "sessionId", operator: "=", value: args.sessionId },
            ],
            reads: ["text"],
          },
        },
        "SELECT text FROM messages ORDER BY text",
      ),
  });
  api.registerQuery("pastColumns", {
    args: { sessionId: "string" },
    handler: (ctx, args) =>
      ctx.db.sql(
        {
          messages: {
            where: [
              { column: "sessionId", operator: "=", value: args.sessionId },
            ],
            reads: ["text"],
          },
        },
        "SELECT at FROM messages",
      ),
  });
  api.registerMutation("retime", {
    args: { id: "string", at: "number" },
    handler: (ctx, args) =>
      ctx.db.table("messages").update(args.id, { at: args.at }),
  });
  api.registerQuery("twoTables", {
    args: { sessionId: "string" },
    handler: (ctx, args) =>
      ctx.db.sql(
        {
          messages: [
            { column: "sessionId", operator: "=", value: args.sessionId },
          ],
          sessions: [{ column: "_id", operator: "=", value: args.sessionId }],
        },
        "SELECT (SELECT COUNT(*) FROM messages) AS n, (SELECT title FROM sessions) AS title",
      ),
  });
  api.registerMutation("say", {
    args: { sessionId: "string", text: "string", at: "number" },
    handler: (ctx, args) => ctx.db.table("messages").insert(args),
  });
  api.registerMutation("open", {
    args: { id: "string", title: "string" },
    handler: (ctx, args) =>
      ctx.db.table("sessions").insert({ _id: args.id, title: args.title }),
  });
}

async function create() {
  const vex = await Vex.create({
    plugins: [plugin],
    storage: sqliteAdapter(":memory:"),
  });
  open.push(vex);
  for (const [sessionId, text, at] of [
    ["a", "a1", 1],
    ["a", "a2", 2],
    ["b", "b1", 3],
    ["c", "c1", 4],
  ] as const) {
    await vex.mutate("h.say", { sessionId, text, at });
  }
  return vex;
}

describe("a raw read held to rows", () => {
  test("a statement reading the whole table sees only the held rows", async () => {
    const vex = await create();
    expect(await vex.query("h.count", { sessionId: "a" })).toEqual([{ n: 2 }]);
    expect(await vex.query("h.count", { sessionId: "zz" })).toEqual([{ n: 0 }]);
  });

  test("batched point lookups keep their rows, and their index", async () => {
    const vex = await create();
    expect(await vex.query("h.latest", { sessionIds: ["a", "b"] })).toEqual([
      { sessionId: "a", text: "a2" },
      { sessionId: "b", text: "b1" },
    ]);
    const held = holdStatement(
      "SELECT * FROM (SELECT sessionId, text FROM messages WHERE sessionId = ? ORDER BY at DESC LIMIT 1) UNION ALL SELECT * FROM (SELECT sessionId, text FROM messages WHERE sessionId = ? ORDER BY at DESC LIMIT 1)",
      {
        messages: [{ column: "sessionId", operator: "IN", value: ["a", "b"] }],
      },
      ["a", "b"],
    );
    const plan = (
      (await rawSql(
        vex,
        `EXPLAIN QUERY PLAN ${held.sql}`,
        ...held.params,
      )) as Array<{
        detail: string;
      }>
    ).map((row) => row.detail);
    expect(plan.filter((d) => d.includes("MATERIALIZE"))).toEqual([]);
    expect(
      plan.filter((d) => d.includes("USING INDEX idx_messages_sessionId_at")),
    ).toHaveLength(2);
  });

  test("a statement with its own WITH composes", async () => {
    const vex = await create();
    expect(await vex.query("h.withOwnCte", { sessionId: "a" })).toEqual([
      { text: "a2" },
    ]);
  });

  test("two tables held at once", async () => {
    const vex = await create();
    await vex.mutate("h.open", { id: "a", title: "Alpha" });
    await vex.mutate("h.open", { id: "b", title: "Beta" });
    expect(await vex.query("h.twoTables", { sessionId: "a" })).toEqual([
      { n: 2, title: "Alpha" },
    ]);
  });

  test("naming a held table under its schema is refused, in every spelling", async () => {
    const vex = await create();
    await expect(vex.query("h.bypass", { sessionId: "a" })).rejects.toThrow(
      'ctx.db.sql cannot hold "messages"',
    );
    for (const spelling of [
      "main.messages",
      "MAIN . MESSAGES",
      '"main"."messages"',
      "[main].[messages]",
      "`main`.`messages`",
    ]) {
      expect(() =>
        holdStatement(`SELECT * FROM ${spelling}`, { messages: [] }, []),
      ).toThrow("names it under its schema");
    }
  });

  test("the hold shadows the table however it is spelled, and a statement's own expression of the name is refused", async () => {
    const vex = await create();
    const held = (sql: string) =>
      holdStatement(
        sql,
        { messages: [{ column: "sessionId", operator: "=", value: "a" }] },
        [],
      );
    const upper = held("SELECT COUNT(*) AS n FROM MESSAGES");
    expect(await rawSql(vex, upper.sql, ...upper.params)).toEqual([{ n: 2 }]);
    const own = held(
      "WITH messages AS (SELECT 1) SELECT COUNT(*) AS n FROM messages",
    );
    await expect(rawSql(vex, own.sql, ...own.params)).rejects.toThrow(
      "duplicate WITH table name",
    );
  });

  test("a hold on columns: the statement sees those alone, and a write to others is skipped", async () => {
    const vex = await create();
    expect(await vex.query("h.texts", { sessionId: "a" })).toEqual([
      { text: "a1" },
      { text: "a2" },
    ]);
    await expect(
      vex.query("h.pastColumns", { sessionId: "a" }),
    ).rejects.toThrow("no such column: at");
    let runs = 0;
    await vex.subscribe("h.texts", { sessionId: "a" }, () => {
      runs++;
    });
    const ids = (await rawSql(
      vex,
      "SELECT _id FROM messages WHERE sessionId = 'a'",
    )) as Array<{
      _id: string;
    }>;
    await vex.mutate("h.retime", { id: ids[0]._id, at: 99 });
    expect(runs).toBe(1);
    await vex.mutate("h.say", { sessionId: "a", text: "a0", at: 100 });
    expect(runs).toBe(2);
  });

  test("only a read is held", () => {
    for (const sql of ["DELETE FROM messages", "VALUES (1)", ""]) {
      expect(() => holdStatement(sql, { messages: [] }, [])).toThrow(
        "ctx.db.sql holds a read",
      );
    }
  });

  test("the hold is what the subscription depends on: a write past it is skipped", async () => {
    const vex = await create();
    let runs = 0;
    const seen: unknown[] = [];
    await vex.subscribe("h.count", { sessionId: "a" }, (r: unknown) => {
      runs++;
      seen.push(r);
    });
    await vex.mutate("h.say", { sessionId: "b", text: "b2", at: 5 });
    expect(runs).toBe(1);
    await vex.mutate("h.say", { sessionId: "a", text: "a3", at: 6 });
    expect(runs).toBe(2);
    expect(seen.at(-1)).toEqual([{ n: 3 }]);
  });
});
