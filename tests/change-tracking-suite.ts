/**
 * Change tracking and raw-SQL table sets, run on every SQLite adapter
 * (Bun in memory and on a file, and a Durable Object in workerd).
 *
 * Writes: the adapters' triggers record every table a write changes,
 * however it is made — query builder, raw SQL of any shape, a trigger,
 * a foreign-key cascade — and only once the write is final: at commit,
 * never for a rolled-back transaction.
 *
 * Reads: a raw read depends on, and is refused for, every registered
 * table it names in any spelling, and every table a view it names
 * reads.
 */

import { describe, expect, test } from "bun:test";
import { UNRESTRICTED } from "../src/core/access.js";
import type { VexPluginAPI } from "../src/core/api.js";
import { Vex } from "../src/core/engine.js";
import type { StorageAdapter } from "../src/core/storage.js";

type CreateStorage = () => Promise<StorageAdapter> | StorageAdapter;

const columns = {
  scope: { type: "string" as const, index: true },
  name: { type: "string" as const },
  n: { type: "number" as const, optional: true },
};

/** Runs `write` and answers the tables the adapter reports it changed. */
async function changedBy(
  adapter: StorageAdapter,
  write: () => Promise<unknown>,
): Promise<string[]> {
  adapter.getChangedTables();
  await write();
  return adapter.getChangedTables().sort();
}

async function triggerRows(adapter: StorageAdapter, table: string) {
  return adapter.rawQuery<{ rowid: number; name: string }>(
    "SELECT rowid, name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? ORDER BY name",
    table,
  );
}

export function changeTrackingSuite(name: string, create: CreateStorage) {
  describe(`${name}: change tracking`, () => {
    async function adapterWith(...tables: string[]) {
      const adapter = await create();
      for (const table of tables) await adapter.ensureTable(table, { columns });
      return adapter;
    }

    test("every raw write shape reports exactly the table it changed", async () => {
      const adapter = await adapterWith("a", "b");
      await adapter.insert("a", { _id: "1", scope: "s", name: "x" });
      await adapter.insert("b", { _id: "1", scope: "s", name: "y" });
      const shapes: [string, string[]][] = [
        ["INSERT INTO a (_id, scope, name) VALUES ('2', 's', 'z')", ["a"]],
        ["UPDATE a SET n = 1 WHERE _id = '1'", ["a"]],
        ["REPLACE INTO a (_id, scope, name) VALUES ('2', 's', 'r')", ["a"]],
        [
          "INSERT INTO a (_id, scope, name) VALUES ('2', 's', 'u') ON CONFLICT (_id) DO UPDATE SET name = excluded.name",
          ["a"],
        ],
        [
          "INSERT INTO a (_id, scope, name) SELECT 'c' || _id, scope, name FROM b",
          ["a"],
        ],
        ["UPDATE a SET n = 2 FROM b WHERE a._id = b._id", ["a"]],
        ['UPDATE "b" SET n = 3', ["b"]],
        ["DELETE FROM a WHERE _id = '2'", ["a"]],
        ["DELETE FROM b", ["b"]],
      ];
      for (const [sql, expected] of shapes) {
        expect([
          sql,
          await changedBy(adapter, () => adapter.rawExec(sql)),
        ]).toEqual([sql, expected]);
      }
      expect(
        await changedBy(adapter, () =>
          adapter.rawQuery("DELETE FROM a WHERE _id = 'c1' RETURNING _id"),
        ),
      ).toEqual(["a"]);
      expect(
        await changedBy(adapter, () =>
          adapter.rawQuery(
            "WITH gone AS (SELECT _id FROM a) DELETE FROM a WHERE _id IN (SELECT _id FROM gone)",
          ),
        ),
      ).toEqual(["a"]);
    });

    test("a write that changes no row, and a read, report nothing", async () => {
      const adapter = await adapterWith("a");
      expect(
        await changedBy(adapter, () =>
          adapter.rawExec("UPDATE a SET n = 1 WHERE 0"),
        ),
      ).toEqual([]);
      expect(
        await changedBy(adapter, () => adapter.rawQuery("SELECT * FROM a")),
      ).toEqual([]);
      expect(
        await changedBy(adapter, () =>
          adapter.update("a", "missing", { n: 1 }),
        ),
      ).toEqual([]);
    });

    test("builder writes report their table, and count only their own rows", async () => {
      const adapter = await adapterWith("a");
      expect(
        await changedBy(adapter, () =>
          adapter.bulkInsert("a", [
            { _id: "1", scope: "s", name: "x" },
            { _id: "2", scope: "s", name: "y" },
          ]),
        ),
      ).toEqual(["a"]);
      adapter.getChangedTables();
      // The change trigger's own write is not one of the statement's rows.
      expect(await adapter.query("a").where("scope", "=", "s").delete()).toBe(
        2,
      );
      expect(adapter.getChangedTables()).toEqual(["a"]);
    });

    test("writes in a transaction are reported at commit; a rolled-back one reports nothing", async () => {
      const adapter = await adapterWith("a", "b");
      adapter.getChangedTables();
      await adapter.transaction(async () => {
        await adapter.insert("a", { scope: "s", name: "x" });
        await adapter.rawExec(
          "INSERT INTO b (_id, scope, name) VALUES ('1', 's', 'y')",
        );
        expect(adapter.getChangedTables()).toEqual([]);
      });
      expect(adapter.getChangedTables().sort()).toEqual(["a", "b"]);

      await expect(
        adapter.transaction(async () => {
          await adapter.rawExec("DELETE FROM a");
          throw new Error("roll back");
        }),
      ).rejects.toThrow("roll back");
      expect(adapter.getChangedTables()).toEqual([]);
      expect(await adapter.query("a").count()).toBe(1);
      // The rolled-back flag is gone, not waiting for the next commit.
      await adapter.transaction(async () => {
        await adapter.insert("b", { scope: "s", name: "z" });
      });
      expect(adapter.getChangedTables()).toEqual(["b"]);
    });

    test("a write made by a trigger reports the table it wrote", async () => {
      const adapter = await adapterWith("a", "b");
      await adapter.rawExec(
        "CREATE TRIGGER copy_a AFTER INSERT ON a BEGIN INSERT INTO b (_id, scope, name) VALUES (NEW._id, NEW.scope, NEW.name); END",
      );
      expect(
        await changedBy(adapter, () =>
          adapter.insert("a", { scope: "s", name: "x" }),
        ),
      ).toEqual(["a", "b"]);
    });

    test("a foreign-key cascade reports the table it deleted from", async () => {
      const adapter = await create();
      await adapter.ensureTable("parents", { columns: { name: columns.name } });
      await adapter.rawExec(
        "CREATE TABLE children (_id TEXT PRIMARY KEY, parentId TEXT NOT NULL REFERENCES parents(_id) ON DELETE CASCADE)",
      );
      await adapter.ensureTable("children", {
        columns: { parentId: { type: "string" } },
      });
      // Bun's SQLite leaves foreign keys off; a Durable Object enforces
      // them and refuses the pragma.
      await adapter.rawExec("PRAGMA foreign_keys = ON").catch(() => {});
      await adapter.insert("parents", { _id: "p", name: "p" });
      await adapter.insert("children", { _id: "c", parentId: "p" });
      expect(
        await changedBy(adapter, () => adapter.delete("parents", "p")),
      ).toEqual(["children", "parents"]);
      expect(await adapter.query("children").count()).toBe(0);
    });

    test("a renamed table is tracked under its new name only", async () => {
      const adapter = await adapterWith("old_items");
      await adapter.ensureTable("items", {
        columns,
        renamedFrom: ["old_items"],
      });
      expect((await triggerRows(adapter, "items")).map((t) => t.name)).toEqual([
        "__vex_changes_items_delete",
        "__vex_changes_items_insert",
        "__vex_changes_items_update",
      ]);
      expect(
        await changedBy(adapter, () =>
          adapter.rawExec(
            "INSERT INTO items (_id, scope, name) VALUES ('1', 's', 'x')",
          ),
        ),
      ).toEqual(["items"]);
      expect(
        await adapter.rawQuery(
          'SELECT "table" FROM __vex_changes ORDER BY "table"',
        ),
      ).toEqual([{ table: "items" }]);
    });

    test("ensuring an unchanged table leaves its triggers as they are", async () => {
      const adapter = await adapterWith("a");
      const before = await triggerRows(adapter, "a");
      await adapter.ensureTable("a", { columns });
      expect(await triggerRows(adapter, "a")).toEqual(before);
    });

    test("a table rebuilt by a migration is still tracked", async () => {
      const adapter = await adapterWith("a");
      await adapter.insert("a", { _id: "1", scope: "s", name: "x" });
      await adapter.ensureTable("a", {
        columns: { ...columns, n: { type: "string", optional: true } },
      });
      expect((await triggerRows(adapter, "a")).length).toBe(3);
      expect(
        await changedBy(adapter, () => adapter.rawExec("UPDATE a SET n = 'x'")),
      ).toEqual(["a"]);
    });

    test("a write to a table Vex does not manage reports nothing and does not fail", async () => {
      const adapter = await adapterWith("a");
      await adapter.rawExec("CREATE TABLE loose (v TEXT)");
      expect(
        await changedBy(adapter, () =>
          adapter.rawExec("INSERT INTO loose VALUES ('x')"),
        ),
      ).toEqual([]);
    });

    test("the change table's name is reserved", async () => {
      const adapter = await create();
      expect(() => adapter.ensureTable("__vex_changes", { columns })).toThrow(
        "reserved",
      );
    });
  });

  describe(`${name}: raw SQL and subscriptions`, () => {
    interface Fixture {
      vex: Vex;
      runs: Record<string, number>;
    }

    async function fixture(): Promise<Fixture> {
      const runs: Record<string, number> = {};
      const count = (key: string) => {
        runs[key] = (runs[key] ?? 0) + 1;
      };
      function plugin(api: VexPluginAPI) {
        api.setName("ct");
        api.registerTable("items", { columns });
        api.registerTable("other", { columns: { v: { type: "string" } } });
        api.registerTable("secrets", {
          columns: { v: { type: "string" } },
          access: { prepare: () => UNRESTRICTED, row: () => true },
        });
        api.registerQuery("scope", {
          args: { scope: "string" },
          async handler(ctx, args) {
            count(`scope:${args.scope}`);
            return ctx.db.table("items").where("scope", "=", args.scope).all();
          },
        });
        api.registerQuery("byId", {
          args: { id: "string" },
          async handler(ctx, args) {
            count(`id:${args.id}`);
            return ctx.db.table("items").where("_id", "=", args.id).first();
          },
        });
        api.registerQuery("raw", {
          args: { sql: "string" },
          async handler(ctx, args) {
            count(`raw:${args.sql}`);
            return ctx.db.sql(args.sql);
          },
        });
        api.registerMutation("raw", {
          args: { sql: "string" },
          handler: (ctx, args) => ctx.db.sql(args.sql),
        });
        api.registerMutation("rawThenFail", {
          args: { sql: "string" },
          async handler(ctx, args) {
            await ctx.db.sql(args.sql);
            throw new Error("after the raw write");
          },
        });
        api.registerMutation("add", {
          args: { scope: "string", name: "string" },
          handler: (ctx, args) => ctx.db.table("items").insert(args),
        });
        api.registerMutation("move", {
          args: { id: "string", scope: "string" },
          handler: (ctx, args) =>
            ctx.db.table("items").update(args.id, { scope: args.scope }),
        });
        api.registerMutation("upsertScope", {
          args: { name: "string", scope: "string" },
          handler: (ctx, args) =>
            ctx.db
              .table("items")
              .upsert({ name: args.name }, { scope: args.scope }),
        });
        api.registerMutation("remove", {
          args: { id: "string" },
          handler: (ctx, args) => ctx.db.table("items").delete(args.id),
        });
        api.registerMutation("addOther", {
          args: {},
          handler: (ctx) => ctx.db.table("other").insert({ v: "x" }),
        });
        api.registerMutation("addBAndTouchA", {
          args: {},
          async handler(ctx) {
            await ctx.db.table("items").insert({ scope: "b", name: "b1" });
            await ctx.db.sql("UPDATE items SET n = 7 WHERE scope = 'a'");
          },
        });
        api.registerWebhook("raw", {
          path: "/ct/raw",
          async handler(ctx, req) {
            await ctx.db.sql(req.body.sql);
            return { ok: true };
          },
        });
      }
      const vex = await Vex.create({
        storage: await create(),
        plugins: [plugin],
      });
      await vex.mutate("ct.add", { scope: "a", name: "a1" });
      return { vex, runs };
    }

    async function withFixture(fn: (f: Fixture) => Promise<void>) {
      const f = await fixture();
      try {
        await fn(f);
      } finally {
        await f.vex.close();
      }
    }

    test("a raw write of every shape re-runs a subscription over its table", async () => {
      await withFixture(async ({ vex, runs }) => {
        await vex.subscribe("ct.scope", { scope: "a" }, () => {});
        const writes = [
          "UPDATE items SET n = 1 WHERE scope = 'a'",
          "INSERT INTO items (_id, scope, name) SELECT 'x', 'a', 'x'",
          "REPLACE INTO items (_id, scope, name) VALUES ('x', 'a', 'y')",
          "INSERT INTO items (_id, scope, name) VALUES ('x', 'a', 'z') ON CONFLICT (_id) DO UPDATE SET name = excluded.name",
          "DELETE FROM items WHERE _id = 'x'",
        ];
        let expected = runs["scope:a"];
        for (const sql of writes) {
          await vex.mutate("ct.raw", { sql });
          expected++;
          expect([sql, runs["scope:a"]]).toEqual([sql, expected]);
        }
      });
    });

    test("a raw write to another table re-runs nothing over this one", async () => {
      await withFixture(async ({ vex, runs }) => {
        await vex.subscribe("ct.scope", { scope: "a" }, () => {});
        const before = runs["scope:a"];
        await vex.mutate("ct.raw", {
          sql: "INSERT INTO other (_id, v) VALUES ('1', 'x')",
        });
        await vex.mutate("ct.raw", { sql: "SELECT * FROM items" });
        expect(runs["scope:a"]).toBe(before);
      });
    });

    test("a raw write is never narrowed away by a builder write's values", async () => {
      await withFixture(async ({ vex, runs }) => {
        await vex.subscribe("ct.scope", { scope: "a" }, () => {});
        await vex.subscribe("ct.scope", { scope: "c" }, () => {});
        const before = runs["scope:a"];
        // The builder insert is scope "b"; the raw UPDATE changes scope "a".
        await vex.mutate("ct.addBAndTouchA", {});
        expect(runs["scope:a"]).toBe(before + 1);
        // Without a raw write, narrowing still skips unrelated scopes.
        const c = runs["scope:c"];
        await vex.mutate("ct.add", { scope: "b", name: "b2" });
        expect(runs["scope:c"]).toBe(c);
      });
    });

    test("an update or upsert that moves a row out of a filtered set re-runs that set", async () => {
      await withFixture(async ({ vex, runs }) => {
        const [row] = await vex.query("ct.scope", { scope: "a" });
        let seen: unknown[] = [];
        await vex.subscribe("ct.scope", { scope: "a" }, (rows) => {
          seen = rows;
        });
        expect(seen).toHaveLength(1);
        // The new value is "b": only the row's id holds before and after.
        await vex.mutate("ct.move", { id: row._id, scope: "b" });
        expect(seen).toEqual([]);

        await vex.mutate("ct.move", { id: row._id, scope: "a" });
        expect(seen).toHaveLength(1);
        const before = runs["scope:a"];
        // Matched by name, it leaves scope "a" by its data, not its keys.
        await vex.mutate("ct.upsertScope", { name: "a1", scope: "c" });
        expect(runs["scope:a"]).toBe(before + 1);
        expect(seen).toEqual([]);
      });
    });

    test("writes addressed by id narrow on the id", async () => {
      await withFixture(async ({ vex, runs }) => {
        const [row] = await vex.query("ct.scope", { scope: "a" });
        await vex.mutate("ct.add", { scope: "a", name: "a2" });
        const rows = await vex.query("ct.scope", { scope: "a" });
        const other = rows.find((r: { _id: string }) => r._id !== row._id);
        await vex.subscribe("ct.byId", { id: row._id }, () => {});
        await vex.subscribe("ct.byId", { id: other._id }, () => {});
        const mine = runs[`id:${row._id}`];
        const theirs = runs[`id:${other._id}`];
        await vex.mutate("ct.move", { id: other._id, scope: "b" });
        await vex.mutate("ct.remove", { id: other._id });
        expect(runs[`id:${row._id}`]).toBe(mine);
        expect(runs[`id:${other._id}`]).toBe(theirs + 2);
      });
    });

    test("a rolled-back raw write re-runs nothing", async () => {
      await withFixture(async ({ vex, runs }) => {
        await vex.subscribe("ct.scope", { scope: "a" }, () => {});
        const before = runs["scope:a"];
        await expect(
          vex.mutate("ct.rawThenFail", { sql: "DELETE FROM items" }),
        ).rejects.toThrow("after the raw write");
        expect(runs["scope:a"]).toBe(before);
        expect(await vex.query("ct.scope", { scope: "a" })).toHaveLength(1);
      });
    });

    test("a webhook's raw write re-runs subscriptions over its table", async () => {
      await withFixture(async ({ vex, runs }) => {
        await vex.subscribe("ct.scope", { scope: "a" }, () => {});
        const before = runs["scope:a"];
        await vex.handleWebhook({
          body: { sql: "UPDATE items SET n = 5" },
          rawBody: "",
          headers: {},
          method: "POST",
          path: "/ct/raw",
          query: {},
        });
        expect(runs["scope:a"]).toBe(before + 1);
      });
    });

    const readShapes = [
      "SELECT * FROM other, items",
      "SELECT * FROM main.items",
      'SELECT * FROM "items"',
      "SELECT * FROM [items]",
      "SELECT * FROM `items`",
      "SELECT * FROM ITEMS",
      "SELECT * FROM other WHERE EXISTS (SELECT 1 FROM items)",
      "WITH x AS (SELECT * FROM items) SELECT * FROM x",
    ];

    test("a raw read of every shape depends on the table it reads", async () => {
      await withFixture(async ({ vex, runs }) => {
        for (const sql of readShapes) {
          await vex.subscribe("ct.raw", { sql }, () => {});
        }
        const before = { ...runs };
        await vex.mutate("ct.add", { scope: "z", name: "z1" });
        for (const sql of readShapes) {
          expect([sql, runs[`raw:${sql}`]]).toEqual([
            sql,
            before[`raw:${sql}`] + 1,
          ]);
        }
      });
    });

    test("a raw read depends on the tables a view reads, through views of views", async () => {
      await withFixture(async ({ vex, runs }) => {
        await vex.unsafeSql("CREATE VIEW item_names AS SELECT name FROM items");
        await vex.unsafeSql(
          "CREATE VIEW item_names_2 AS SELECT * FROM item_names",
        );
        const sql = "SELECT * FROM item_names_2";
        await vex.subscribe("ct.raw", { sql }, () => {});
        const before = runs[`raw:${sql}`];
        await vex.mutate("ct.addOther", {});
        expect(runs[`raw:${sql}`]).toBe(before);
        await vex.mutate("ct.add", { scope: "z", name: "z1" });
        expect(runs[`raw:${sql}`]).toBe(before + 1);
      });
    });

    test("raw SQL naming a governed table is refused in every spelling and through views", async () => {
      await withFixture(async ({ vex }) => {
        await vex.unsafeSql("CREATE VIEW leak AS SELECT v FROM secrets");
        await vex.unsafeSql("CREATE VIEW leak_2 AS SELECT * FROM leak");
        for (const sql of [
          "SELECT * FROM items, secrets",
          "SELECT * FROM main.secrets",
          "SELECT * FROM [secrets]",
          "SELECT * FROM 'secrets'",
          "SELECT * FROM Secrets",
          "SELECT * FROM leak_2",
        ]) {
          await expect(vex.query("ct.raw", { sql })).rejects.toThrow(
            /access-governed table "secrets"/,
          );
        }
        expect(
          await vex.query("ct.raw", { sql: "SELECT COUNT(*) AS c FROM items" }),
        ).toEqual([{ c: 1 }]);
      });
    });

    test("a raw read naming no registered table re-runs on any change", async () => {
      await withFixture(async ({ vex, runs }) => {
        const sql = "SELECT 1 AS one";
        await vex.subscribe("ct.raw", { sql }, () => {});
        const before = runs[`raw:${sql}`];
        await vex.mutate("ct.addOther", {});
        expect(runs[`raw:${sql}`]).toBe(before + 1);
      });
    });
  });
}
