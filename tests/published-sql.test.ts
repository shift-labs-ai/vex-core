/**
 * `ctx.db.publishedSql`: SQL someone other than the app wrote, read over
 * the published dataset only.
 *
 *   notes   published                       readable
 *   keys    not published                   refused, however it is reached
 *   docs    published, access-governed      readable only for callers its
 *                                           policy leaves unrestricted
 */

import { afterEach, describe, expect, test } from "bun:test";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import { UNRESTRICTED } from "../src/core/access.js";
import type { VexPluginAPI } from "../src/core/api.js";
import { Vex } from "../src/core/engine.js";
import type { StorageAdapter } from "../src/core/storage.js";
import type { VexUser } from "../src/core/types.js";

const alice: VexUser = { id: "alice", name: "Alice", isAdmin: false };
const admin: VexUser = { id: "root", name: "Root", isAdmin: true };

let open: Vex[] = [];
afterEach(async () => {
  await Promise.all(open.map((v) => v.close()));
  open = [];
});

function plugin(api: VexPluginAPI) {
  api.setName("ps");
  api.registerTable("notes", {
    columns: { body: { type: "string" } },
    published: true,
  });
  api.registerTable("keys", {
    columns: { token: { type: "string", index: true } },
  });
  api.registerTable("docs", {
    columns: { ownerId: { type: "string" }, title: { type: "string" } },
    published: true,
    access: {
      prepare: (user) => (!user || user.isAdmin ? UNRESTRICTED : user.id),
      row: (userId, row) => row.ownerId === userId,
    },
  });
  api.registerQuery("read", {
    args: { sql: "string", params: "json" },
    handler: (ctx, args) =>
      ctx.db.publishedSql(args.sql, ...((args.params as unknown[]) ?? [])),
  });
  api.registerQuery("tables", {
    args: {},
    handler: (ctx) => ctx.db.publishedTables(),
  });
  api.registerMutation("seed", {
    args: {},
    async handler(ctx) {
      await ctx.db.table("notes").insert({ body: "hello" });
      await ctx.db.table("keys").insert({ token: "secret" });
      await ctx.db.table("docs").insert({ ownerId: "alice", title: "mine" });
      await ctx.db.table("docs").insert({ ownerId: "bob", title: "his" });
      await ctx.db.sql(
        "CREATE VIEW IF NOT EXISTS key_view AS SELECT token FROM keys",
      );
    },
  });
  api.registerMutation("key", {
    args: { token: "string" },
    handler: (ctx, args) => ctx.db.table("keys").insert({ token: args.token }),
  });
  api.registerMutation("note", {
    args: { body: "string" },
    handler: (ctx, args) => ctx.db.table("notes").insert({ body: args.body }),
  });
}

async function boot(storage: StorageAdapter = sqliteAdapter(":memory:")) {
  const vex = await Vex.create({ plugins: [plugin], storage });
  open.push(vex);
  await vex.mutate("ps.seed", {});
  return vex;
}

const read = (vex: Vex, sql: string, user?: VexUser, params: unknown[] = []) =>
  vex.query("ps.read", { sql, params }, user ? { user } : undefined);

describe("publishedSql", () => {
  test("lists the published dataset: each table and every column a statement can read", async () => {
    const vex = await boot();
    expect(await vex.query("ps.tables", {})).toEqual([
      {
        name: "docs",
        columns: {
          _id: { type: "string" },
          ownerId: { type: "string" },
          title: { type: "string" },
        },
      },
      {
        name: "notes",
        columns: { _id: { type: "string" }, body: { type: "string" } },
      },
    ]);
  });

  test("reads a published table, with bound values", async () => {
    const vex = await boot();
    expect(
      await read(vex, "SELECT body FROM notes WHERE body = ?", alice, [
        "hello",
      ]),
    ).toEqual([{ body: "hello" }]);
  });

  test("refuses a table that is not published, however the SQL reaches it", async () => {
    const vex = await boot();
    for (const sql of [
      "SELECT token FROM keys",
      "SELECT * FROM key_view",
      "WITH k AS (SELECT token FROM keys) SELECT * FROM k",
      "SELECT body FROM notes WHERE EXISTS (SELECT 1 FROM keys)",
      "SELECT count(*) AS n FROM keys WHERE token = 'secret'",
    ]) {
      await expect(read(vex, sql, admin)).rejects.toThrow(
        'Table "keys" is not published',
      );
    }
    await expect(
      read(vex, "SELECT name FROM sqlite_master", admin),
    ).rejects.toThrow('Table "sqlite_schema" is not published');
  });

  test("refuses SQL that is not one plain read, for every caller", async () => {
    const vex = await boot();
    await expect(read(vex, "DELETE FROM notes", admin)).rejects.toThrow(
      "Only a SELECT, VALUES or WITH statement is allowed.",
    );
    await expect(
      read(vex, "WITH x AS (SELECT 1) DELETE FROM notes", admin),
    ).rejects.toThrow("The statement writes.");
    await expect(read(vex, "SELECT 1; SELECT 2", admin)).rejects.toThrow(
      "Only one statement is allowed.",
    );
    await expect(
      read(vex, "SELECT * FROM pragma_table_info('keys')", admin),
    ).rejects.toThrow("The statement reads a virtual table.");
    expect(await read(vex, "SELECT count(*) AS n FROM notes")).toEqual([
      { n: 1 },
    ]);
  });

  test("reads a governed published table only for callers its policy leaves unrestricted", async () => {
    const vex = await boot();
    await expect(read(vex, "SELECT title FROM docs", alice)).rejects.toThrow(
      'Published table "docs" is access-governed',
    );
    expect(
      await read(vex, "SELECT title FROM docs ORDER BY title", admin),
    ).toEqual([{ title: "his" }, { title: "mine" }]);
    expect(await read(vex, "SELECT count(*) AS n FROM docs")).toEqual([
      { n: 2 },
    ]);
  });

  test("a subscription re-runs when a table it read changes, and only then", async () => {
    const vex = await boot();
    const counts: number[] = [];
    const stop = await vex.subscribe(
      "ps.read",
      { sql: "SELECT count(*) AS n FROM notes", params: [] },
      (rows: Array<{ n: number }>) => counts.push(rows[0]?.n ?? -1),
    );
    expect(vex.describeSubscriptions().queries[0]?.tables).toEqual(["notes"]);
    // A mutation settles its invalidation before it returns.
    await vex.mutate("ps.key", { token: "another" });
    await vex.mutate("ps.note", { body: "again" });
    stop();
    expect(counts).toEqual([1, 2]);
  });

  test("refuses everything on storage that cannot show what a statement reads", async () => {
    const storage = sqliteAdapter(":memory:");
    const blind: StorageAdapter = Object.assign(Object.create(storage), {
      readOnlyTables: undefined,
    });
    const vex = await boot(blind);
    await expect(read(vex, "SELECT body FROM notes", admin)).rejects.toThrow(
      "This storage cannot show what a statement reads.",
    );
  });
});
