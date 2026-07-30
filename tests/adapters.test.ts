import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

setDefaultTimeout(15_000);

import { sqliteAdapter } from "../src/adapters/sqlite.js";
import type { StorageAdapter } from "../src/core/storage.js";
import type { TableSchema } from "../src/core/types.js";

const schema: TableSchema = {
  columns: {
    name: { type: "string" },
    age: { type: "number" },
    active: { type: "boolean", optional: true },
    meta: { type: "json", optional: true },
  },
};

const indexedSchema: TableSchema = {
  columns: {
    category: { type: "string", index: true },
    value: { type: "number" },
  },
  indexes: [["idx_cat_val", ["category", "value"]]],
  unique: [["category", "value"]],
};

function tempSqlitePath(name: string): string {
  return join(tmpdir(), `vex-core-${name}-${Date.now()}-${Math.random()}.db`);
}

function cleanupSqlitePath(path: string): void {
  rmSync(path, { force: true });
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
}

async function sqliteIndexNames(
  adapter: StorageAdapter,
  table: string,
): Promise<string[]> {
  const indexes = await adapter.rawQuery<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name",
    table,
  );
  return indexes.map((idx) => idx.name);
}

async function sqliteIndexColumns(
  adapter: StorageAdapter,
  indexName: string,
): Promise<string[]> {
  const rows = await adapter.rawQuery<{ seqno: number; name: string }>(
    `PRAGMA index_info("${indexName.replaceAll('"', '""')}")`,
  );
  return rows.sort((a, b) => a.seqno - b.seqno).map((row) => row.name);
}

async function sqliteManagedIndexNames(
  adapter: StorageAdapter,
  table: string,
): Promise<string[]> {
  const indexes = await adapter.rawQuery<{ name: string }>(
    'SELECT name FROM "__vex_sqlite_indexes" WHERE "table" = ? ORDER BY name',
    table,
  );
  return indexes.map((idx) => idx.name);
}

function adapterSuite(name: string, create: () => Promise<StorageAdapter>) {
  describe(name, () => {
    let adapter: StorageAdapter;

    beforeEach(async () => {
      adapter = await create();
      await adapter.ensureTable("users", schema);
    });

    afterEach(async () => {
      await adapter.close();
    });

    // --- insert / query ---

    test("insert returns id and row is queryable", async () => {
      const id = await adapter.insert("users", { name: "alice", age: 30 });
      expect(id).toBeString();
      expect(id.length).toBeGreaterThan(0);

      const row = await adapter.query("users").first<any>();
      expect(row).not.toBeNull();
      expect(row.name).toBe("alice");
      expect(row.age).toBe(30);
      expect(row._id).toBe(id);
    });

    test("insert with custom _id", async () => {
      const id = await adapter.insert("users", {
        _id: "custom-1",
        name: "bob",
        age: 25,
      });
      expect(id).toBe("custom-1");
      const row = await adapter
        .query("users")
        .where("_id", "=", "custom-1")
        .first<any>();
      expect(row.name).toBe("bob");
    });

    test("insert with boolean and json", async () => {
      await adapter.insert("users", {
        name: "carol",
        age: 28,
        active: true,
        meta: { role: "admin" },
      });
      const row = await adapter.query("users").first<any>();
      expect(row.active).toBe(true);
      expect(row.meta).toEqual({ role: "admin" });
    });

    // --- query builder ---

    test("select returns only requested columns", async () => {
      await adapter.insert("users", { name: "alice", age: 30, active: true });
      const row = await adapter.query("users").select("name").first<any>();
      expect(row).toEqual({ name: "alice" });
    });

    test("distinct returns unique values", async () => {
      await adapter.insert("users", { name: "alice", age: 30 });
      await adapter.insert("users", { name: "bob", age: 30 });
      await adapter.insert("users", { name: "carol", age: 35 });
      expect(await adapter.query("users").order("age").distinct("age")).toEqual(
        [30, 35],
      );
    });

    test("distinct deserializes schema-backed values", async () => {
      await adapter.insert("users", { name: "alice", age: 30, active: true });
      await adapter.insert("users", { name: "bob", age: 25, active: false });
      await adapter.insert("users", { name: "carol", age: 35, active: true });

      expect(
        await adapter.query("users").order("active", "desc").distinct("active"),
      ).toEqual([true, false]);
    });

    test("aggregate helpers return numeric results", async () => {
      await adapter.insert("users", { name: "alice", age: 30 });
      await adapter.insert("users", { name: "bob", age: 20 });
      await adapter.insert("users", { name: "alice", age: 40 });

      const query = adapter.query("users");
      expect(await query.countDistinct("name")).toBe(2);
      expect(await adapter.query("users").sum("age")).toBe(90);
      expect(await adapter.query("users").avg("age")).toBe(30);
      expect(await adapter.query("users").min("age")).toBe(20);
      expect(await adapter.query("users").max("age")).toBe(40);
    });

    test("groupBy supports aggregates, having, order, and limit", async () => {
      await adapter.insert("users", { name: "alice", age: 30 });
      await adapter.insert("users", { name: "alice", age: 40 });
      await adapter.insert("users", { name: "bob", age: 20 });
      await adapter.insert("users", { name: "carol", age: 50 });
      await adapter.insert("users", { name: "carol", age: 10 });

      const rows = await adapter
        .query("users")
        .groupBy("name", { n: "count", total: ["sum", "age"] })
        .having("n", ">", 1)
        .order("total", "desc")
        .limit(1);

      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe("alice");
      expect(Number(rows[0].n)).toBe(2);
      expect(Number(rows[0].total)).toBe(70);
    });

    test("groupBy deserializes grouped schema columns", async () => {
      await adapter.insert("users", { name: "alice", age: 30, active: true });
      await adapter.insert("users", { name: "bob", age: 20, active: true });
      await adapter.insert("users", { name: "carol", age: 40, active: false });

      const rows = await adapter
        .query("users")
        .groupBy("active", { n: "count" })
        .order("active", "desc");

      expect(rows.map((row: any) => row.active)).toEqual([true, false]);
      expect(rows.map((row: any) => Number(row.n))).toEqual([2, 1]);
    });

    test("groupBy having supports IN filters", async () => {
      await adapter.insert("users", { name: "alice", age: 30 });
      await adapter.insert("users", { name: "alice", age: 40 });
      await adapter.insert("users", { name: "bob", age: 20 });
      await adapter.insert("users", { name: "carol", age: 50 });

      const rows = await adapter
        .query("users")
        .groupBy("name", { n: "count" })
        .having("name", "IN", ["alice", "carol"])
        .order("name", "asc");

      expect(rows.map((row: any) => row.name)).toEqual(["alice", "carol"]);
    });

    test("where filters", async () => {
      await adapter.insert("users", { name: "alice", age: 30 });
      await adapter.insert("users", { name: "bob", age: 25 });
      await adapter.insert("users", { name: "carol", age: 35 });

      const young = await adapter
        .query("users")
        .where("age", "<", 30)
        .all<any>();
      expect(young).toHaveLength(1);
      expect(young[0].name).toBe("bob");

      const old = await adapter
        .query("users")
        .where("age", ">=", 30)
        .all<any>();
      expect(old).toHaveLength(2);
    });

    test("where with IN operator", async () => {
      await adapter.insert("users", { name: "alice", age: 30 });
      await adapter.insert("users", { name: "bob", age: 25 });
      await adapter.insert("users", { name: "carol", age: 35 });

      const result = await adapter
        .query("users")
        .where("name", "IN", ["alice", "carol"])
        .all<any>();
      expect(result).toHaveLength(2);
    });

    test("where IN includes null values", async () => {
      await adapter.insert("users", { name: "alice", age: 30, active: null });
      await adapter.insert("users", { name: "bob", age: 25, active: true });
      await adapter.insert("users", { name: "carol", age: 35, active: false });

      const result = await adapter
        .query("users")
        .where("active", "IN", [true, null])
        .order("name")
        .all<any>();

      expect(result.map((row: any) => row.name)).toEqual(["alice", "bob"]);
    });

    test("where supports null equality filters", async () => {
      await adapter.insert("users", { name: "alice", age: 30, active: null });
      await adapter.insert("users", { name: "bob", age: 25, active: true });

      const nullRows = await adapter
        .query("users")
        .where("active", "=", null)
        .all<any>();
      const notNullRows = await adapter
        .query("users")
        .where("active", "!=", null)
        .all<any>();

      expect(nullRows.map((row: any) => row.name)).toEqual(["alice"]);
      expect(notNullRows.map((row: any) => row.name)).toEqual(["bob"]);
    });

    test("chained where (AND)", async () => {
      await adapter.insert("users", { name: "alice", age: 30, active: true });
      await adapter.insert("users", { name: "bob", age: 30, active: false });

      const result = await adapter
        .query("users")
        .where("age", "=", 30)
        .where("active", "=", 1)
        .all<any>();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("alice");
    });

    test("order asc/desc", async () => {
      await adapter.insert("users", { name: "bob", age: 25 });
      await adapter.insert("users", { name: "alice", age: 30 });
      await adapter.insert("users", { name: "carol", age: 20 });

      const asc = await adapter.query("users").order("age", "asc").all<any>();
      expect(asc.map((r: any) => r.name)).toEqual(["carol", "bob", "alice"]);

      const desc = await adapter.query("users").order("age", "desc").all<any>();
      expect(desc.map((r: any) => r.name)).toEqual(["alice", "bob", "carol"]);
    });

    test("limit and offset", async () => {
      for (let i = 0; i < 10; i++) {
        await adapter.insert("users", { name: `user-${i}`, age: i });
      }

      const page1 = await adapter
        .query("users")
        .order("age")
        .limit(3)
        .all<any>();
      expect(page1).toHaveLength(3);
      expect(page1[0].age).toBe(0);

      const page2 = await adapter
        .query("users")
        .order("age")
        .limit(3)
        .offset(3)
        .all<any>();
      expect(page2).toHaveLength(3);
      expect(page2[0].age).toBe(3);
    });

    test("first returns null on empty", async () => {
      const row = await adapter.query("users").first();
      expect(row).toBeNull();
    });

    test("count", async () => {
      await adapter.insert("users", { name: "alice", age: 30 });
      await adapter.insert("users", { name: "bob", age: 25 });

      expect(await adapter.query("users").count()).toBe(2);
      expect(await adapter.query("users").where("age", ">", 28).count()).toBe(
        1,
      );
    });

    test("query builder delete with filters", async () => {
      await adapter.insert("users", { name: "alice", age: 30 });
      await adapter.insert("users", { name: "bob", age: 25 });
      await adapter.insert("users", { name: "carol", age: 35 });
      adapter.getChangedTables();

      const deleted = await adapter
        .query("users")
        .where("age", "<", 30)
        .delete();

      const remaining = await adapter.query("users").all<any>();
      expect(deleted).toBe(1);
      expect(remaining).toHaveLength(2);
      expect(remaining.every((r: any) => r.age >= 30)).toBe(true);
      expect(adapter.getChangedTables()).toEqual(["users"]);
    });

    test("query builder delete without matches does not mark table changed", async () => {
      await adapter.insert("users", { name: "alice", age: 30 });
      adapter.getChangedTables();

      const deleted = await adapter
        .query("users")
        .where("age", "<", 0)
        .delete();

      expect(deleted).toBe(0);
      expect(adapter.getChangedTables()).toEqual([]);
    });

    // --- update ---

    test("update modifies row", async () => {
      const id = await adapter.insert("users", { name: "alice", age: 30 });
      await adapter.update("users", id, { age: 31 });

      const row = await adapter
        .query("users")
        .where("_id", "=", id)
        .first<any>();
      expect(row.age).toBe(31);
      expect(row.name).toBe("alice");
    });

    test("update nonexistent id does not mark table changed", async () => {
      adapter.getChangedTables();
      await adapter.update("users", "missing", { age: 31 });
      expect(adapter.getChangedTables()).toEqual([]);
    });

    test("update with empty data is a no-op", async () => {
      const id = await adapter.insert("users", { name: "alice", age: 30 });
      adapter.getChangedTables();

      await adapter.update("users", id, {});

      expect(
        await adapter.query("users").where("_id", "=", id).first(),
      ).toMatchObject({
        name: "alice",
        age: 30,
      });
      expect(adapter.getChangedTables()).toEqual([]);
    });

    // --- delete ---

    test("delete by id", async () => {
      const id = await adapter.insert("users", { name: "alice", age: 30 });
      const deleted = await adapter.delete("users", id);
      expect(deleted).toBe(true);

      const row = await adapter.query("users").where("_id", "=", id).first();
      expect(row).toBeNull();
    });

    test("delete nonexistent returns false", async () => {
      adapter.getChangedTables();
      const deleted = await adapter.delete("users", "nope");
      expect(deleted).toBe(false);
      expect(adapter.getChangedTables()).toEqual([]);
    });

    // --- upsert ---

    test("upsert inserts when missing", async () => {
      await adapter.upsert("users", { name: "alice" }, { age: 30 });
      const row = await adapter
        .query("users")
        .where("name", "=", "alice")
        .first<any>();
      expect(row).not.toBeNull();
      expect(row.age).toBe(30);
    });

    test("upsert updates when existing", async () => {
      await adapter.insert("users", { name: "alice", age: 30 });
      await adapter.upsert("users", { name: "alice" }, { age: 31 });

      const rows = await adapter
        .query("users")
        .where("name", "=", "alice")
        .all<any>();
      expect(rows).toHaveLength(1);
      expect(rows[0].age).toBe(31);
    });

    test("upsert with empty data no-ops existing rows", async () => {
      await adapter.insert("users", { name: "alice", age: 30 });
      adapter.getChangedTables();

      await adapter.upsert("users", { name: "alice" }, {});

      const rows = await adapter
        .query("users")
        .where("name", "=", "alice")
        .all<any>();
      expect(rows).toHaveLength(1);
      expect(rows[0].age).toBe(30);
      expect(adapter.getChangedTables()).toEqual([]);
    });

    // --- transaction ---

    test("transaction commits", async () => {
      await adapter.transaction(async () => {
        await adapter.insert("users", { name: "alice", age: 30 });
        await adapter.insert("users", { name: "bob", age: 25 });
      });

      expect(await adapter.query("users").count()).toBe(2);
    });

    test("transaction rolls back on error", async () => {
      try {
        await adapter.transaction(async () => {
          await adapter.insert("users", { name: "alice", age: 30 });
          throw new Error("boom");
        });
      } catch {}

      expect(await adapter.query("users").count()).toBe(0);
    });

    test("nested transaction joins outer (no BEGIN error)", async () => {
      await adapter.transaction(async () => {
        await adapter.insert("users", { name: "alice", age: 30 });
        // Nested transaction should piggyback on the outer one
        await adapter.transaction(async () => {
          await adapter.insert("users", { name: "bob", age: 25 });
        });
      });

      expect(await adapter.query("users").count()).toBe(2);
    });

    test("nested transaction error propagates and outer rolls back", async () => {
      try {
        await adapter.transaction(async () => {
          await adapter.insert("users", { name: "alice", age: 30 });
          await adapter.transaction(async () => {
            throw new Error("inner boom");
          });
        });
      } catch {}

      expect(await adapter.query("users").count()).toBe(0);
    });

    // --- rawQuery / rawExec ---

    test("rawQuery returns results", async () => {
      await adapter.insert("users", { name: "alice", age: 30 });
      const rows = await adapter.rawQuery<any>('SELECT name FROM "users"');
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe("alice");
    });

    test("rawQuery preserves write-statement compatibility", async () => {
      await adapter.insert("users", { name: "alice", age: 30 });
      const rows = await adapter.rawQuery<{ age: number }>(
        'UPDATE "users" SET age = ? WHERE name = ? RETURNING age',
        31,
        "alice",
      );
      expect(rows).toEqual([{ age: 31 }]);
      expect((await adapter.query("users").first<any>()).age).toBe(31);
    });

    test("rawExec runs statements", async () => {
      await adapter.insert("users", { name: "alice", age: 30 });
      await adapter.rawExec('DELETE FROM "users" WHERE name = ?', "alice");
      expect(await adapter.query("users").count()).toBe(0);
    });

    // --- bulkInsert ---

    test("bulkInsert inserts all rows", async () => {
      const rows = Array.from({ length: 100 }, (_, i) => ({
        name: `user-${i}`,
        age: i,
      }));
      await adapter.bulkInsert("users", rows);
      expect(await adapter.query("users").count()).toBe(100);
    });

    test("bulkInsert assigns unique ids", async () => {
      await adapter.bulkInsert("users", [
        { name: "alice", age: 30 },
        { name: "bob", age: 25 },
      ]);
      const ids = (await adapter.query("users").all<any>()).map(
        (r: any) => r._id,
      );
      expect(ids[0]).not.toBe(ids[1]);
    });

    test("bulkInsert preserves custom ids", async () => {
      await adapter.bulkInsert("users", [
        { _id: "bulk-1", name: "alice", age: 30 },
        { _id: "bulk-2", name: "bob", age: 25 },
      ]);
      const rows = await adapter.query("users").order("_id").all<any>();
      expect(rows.map((row: any) => row._id)).toEqual(["bulk-1", "bulk-2"]);
    });

    test("bulkInsert empty is noop", async () => {
      await adapter.bulkInsert("users", []);
      expect(await adapter.query("users").count()).toBe(0);
    });

    // --- changedTables ---

    test("getChangedTables tracks mutations", async () => {
      adapter.getChangedTables(); // clear
      await adapter.insert("users", { name: "alice", age: 30 });
      const changed = adapter.getChangedTables();
      expect(changed).toContain("users");
    });

    test("getChangedTables clears after read", async () => {
      await adapter.insert("users", { name: "alice", age: 30 });
      adapter.getChangedTables();
      const second = adapter.getChangedTables();
      expect(second).toHaveLength(0);
    });

    // --- schema metadata ---

    test("getSchema returns registered schemas", async () => {
      expect(adapter.getSchema("users")).toEqual(schema);
      expect(adapter.getSchema("missing")).toBeNull();
    });

    // --- ensureTable idempotent ---

    test("ensureTable is idempotent", async () => {
      await adapter.ensureTable("users", schema);
      await adapter.ensureTable("users", schema);
      await adapter.insert("users", { name: "alice", age: 30 });
      expect(await adapter.query("users").count()).toBe(1);
    });

    // --- indexes / unique ---

    test("ensureTable with indexes", async () => {
      await adapter.ensureTable("items", indexedSchema);
      await adapter.insert("items", { category: "a", value: 1 });
      const row = await adapter
        .query("items")
        .where("category", "=", "a")
        .first<any>();
      expect(row.value).toBe(1);
    });
  });
}

adapterSuite("sqlite", async () => sqliteAdapter(":memory:"));

// --- sqlite-specific ---

describe("sqlite-specific", () => {
  test("column migration adds new columns", () => {
    const adapter = sqliteAdapter(":memory:");
    adapter.ensureTable("t", { columns: { a: { type: "string" } } });
    adapter.ensureTable("t", {
      columns: { a: { type: "string" }, b: { type: "number" } },
    });
    // Should not throw — b was added
    adapter.close();
  });

  test("unique constraint prevents duplicates", async () => {
    const adapter = sqliteAdapter(":memory:");
    await adapter.ensureTable("items", indexedSchema);
    await adapter.insert("items", { category: "a", value: 1 });
    expect(async () => {
      await adapter.insert("items", { category: "a", value: 1 });
    }).toThrow();
    adapter.close();
  });

  test("default values apply when columns are omitted", async () => {
    const adapter = sqliteAdapter(":memory:");
    await adapter.ensureTable("items", {
      columns: {
        name: { type: "string" },
        status: { type: "string", default: "new" },
        active: { type: "boolean", default: true },
      },
    });

    await adapter.insert("items", { name: "one" });
    const row = await adapter.query("items").first<any>();
    expect(row.status).toBe("new");
    expect(row.active).toBe(true);
    adapter.close();
  });

  test("column migration preserves defaults for existing and future rows", async () => {
    const adapter = sqliteAdapter(":memory:");
    await adapter.ensureTable("items", {
      columns: { name: { type: "string" } },
    });
    await adapter.insert("items", { name: "before" });

    await adapter.ensureTable("items", {
      columns: {
        name: { type: "string" },
        status: { type: "string", default: "new" },
        active: { type: "boolean", default: true },
      },
    });
    await adapter.insert("items", { name: "after" });

    const rows = await adapter.query("items").order("name").all<any>();
    expect(rows.map((row: any) => row.status)).toEqual(["new", "new"]);
    expect(rows.map((row: any) => row.active)).toEqual([true, true]);
    adapter.close();
  });

  test("column migration enforces new required columns on empty tables", async () => {
    const adapter = sqliteAdapter(":memory:");
    await adapter.ensureTable("items", {
      columns: { name: { type: "string" } },
    });

    await adapter.ensureTable("items", {
      columns: {
        name: { type: "string" },
        required: { type: "string" },
      },
    });

    expect(async () => {
      await adapter.insert("items", { name: "missing required" });
    }).toThrow();
    await adapter.insert("items", { name: "ok", required: "present" });
    expect(await adapter.query("items").count()).toBe(1);
    adapter.close();
  });

  test("column migration rejects new required columns on non-empty tables without defaults", async () => {
    const adapter = sqliteAdapter(":memory:");
    const priorSchema: TableSchema = {
      columns: { name: { type: "string" } },
    };
    await adapter.ensureTable("items", priorSchema);
    await adapter.insert("items", { name: "before" });

    expect(() =>
      adapter.ensureTable("items", {
        columns: {
          name: { type: "string" },
          required: { type: "string" },
        },
      }),
    ).toThrow("cannot add required column without default to non-empty table");

    const columns = await adapter.rawQuery<{ name: string }>(
      'PRAGMA table_info("items")',
    );
    expect(columns.map((col) => col.name)).toEqual(["_id", "name"]);
    expect(adapter.getSchema("items")).toEqual(priorSchema);
    adapter.close();
  });

  test("column migration enforces newly required existing columns on empty tables", async () => {
    const adapter = sqliteAdapter(":memory:");
    await adapter.ensureTable("items", {
      columns: { name: { type: "string", optional: true } },
    });

    await adapter.ensureTable("items", {
      columns: { name: { type: "string" } },
    });

    expect(async () => {
      await adapter.insert("items", {});
    }).toThrow();
    await adapter.insert("items", { name: "present" });
    expect(await adapter.query("items").count()).toBe(1);
    adapter.close();
  });

  test("column migration relaxes required existing columns on non-empty tables", async () => {
    const adapter = sqliteAdapter(":memory:");
    await adapter.ensureTable("items", {
      columns: { name: { type: "string" } },
    });
    await adapter.insert("items", { name: "before" });

    await adapter.ensureTable("items", {
      columns: { name: { type: "string", optional: true } },
    });
    await adapter.insert("items", {});

    const rows = await adapter.query("items").order("name").all<any>();
    expect(rows.map((row: any) => row.name)).toEqual([null, "before"]);
    adapter.close();
  });

  test("column migration enforces newly required existing columns on non-empty tables without nulls", async () => {
    const adapter = sqliteAdapter(":memory:");
    await adapter.ensureTable("items", {
      columns: { name: { type: "string", optional: true } },
    });
    await adapter.insert("items", { name: "before" });

    await adapter.ensureTable("items", {
      columns: { name: { type: "string" } },
    });

    expect(async () => {
      await adapter.insert("items", {});
    }).toThrow();
    await adapter.insert("items", { name: "after" });
    const rows = await adapter.query("items").order("name").all<any>();
    expect(rows.map((row: any) => row.name)).toEqual(["after", "before"]);
    adapter.close();
  });

  test("table rebuild avoids existing temporary table names", async () => {
    const adapter = sqliteAdapter(":memory:");
    await adapter.ensureTable("items", {
      columns: { name: { type: "string", optional: true } },
    });
    await adapter.insert("items", { name: "before" });
    await adapter.rawExec(
      'CREATE TABLE "__vex_rebuild_items_123" ("kept" TEXT)',
    );

    const originalDateNow = Date.now;
    Date.now = () => 123;
    try {
      await adapter.ensureTable("items", {
        columns: { name: { type: "string" } },
      });
    } finally {
      Date.now = originalDateNow;
    }

    expect(async () => {
      await adapter.insert("items", {});
    }).toThrow();
    expect(await adapter.query("items").count()).toBe(1);
    const collisionTable = await adapter.rawQuery<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      "__vex_rebuild_items_123",
    );
    expect(collisionTable).toEqual([{ name: "__vex_rebuild_items_123" }]);
    adapter.close();
  });

  test("table rebuild avoids existing temporary table names case-insensitively", async () => {
    const adapter = sqliteAdapter(":memory:");
    await adapter.ensureTable("items", {
      columns: { name: { type: "string", optional: true } },
    });
    await adapter.insert("items", { name: "before" });
    await adapter.rawExec(
      'CREATE TABLE "__VEX_rebuild_items_123" ("kept" TEXT)',
    );

    const originalDateNow = Date.now;
    Date.now = () => 123;
    try {
      await adapter.ensureTable("items", {
        columns: { name: { type: "string" } },
      });
    } finally {
      Date.now = originalDateNow;
    }

    expect(await adapter.query("items").count()).toBe(1);
    const collisionTable = await adapter.rawQuery<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      "__VEX_rebuild_items_123",
    );
    expect(collisionTable).toEqual([{ name: "__VEX_rebuild_items_123" }]);
    adapter.close();
  });

  test("column migration updates existing defaults on empty tables", async () => {
    const adapter = sqliteAdapter(":memory:");
    await adapter.ensureTable("items", {
      columns: { status: { type: "string", default: "old" } },
    });

    await adapter.ensureTable("items", {
      columns: { status: { type: "string", default: "new" } },
    });
    await adapter.insert("items", {});

    expect((await adapter.query("items").first<any>()).status).toBe("new");
    adapter.close();
  });

  test("column migration updates existing defaults on non-empty tables", async () => {
    const adapter = sqliteAdapter(":memory:");
    await adapter.ensureTable("items", {
      columns: {
        name: { type: "string" },
        status: { type: "string", default: "old" },
      },
    });
    await adapter.insert("items", { name: "before" });

    await adapter.ensureTable("items", {
      columns: {
        name: { type: "string" },
        status: { type: "string", default: "new" },
      },
    });
    await adapter.insert("items", { name: "after" });

    const rows = await adapter.query("items").order("name").all<any>();
    expect(rows.map((row: any) => row.status)).toEqual(["new", "old"]);
    adapter.close();
  });

  test("json defaults work on create and migration", async () => {
    const adapter = sqliteAdapter(":memory:");
    await adapter.ensureTable("items", {
      columns: {
        name: { type: "string" },
        meta: { type: "json", default: { created: true } },
      },
    });
    await adapter.insert("items", { name: "created" });
    expect((await adapter.query("items").first<any>()).meta).toEqual({
      created: true,
    });

    await adapter.ensureTable("migrated", {
      columns: { name: { type: "string" } },
    });
    await adapter.insert("migrated", { name: "before" });
    await adapter.ensureTable("migrated", {
      columns: {
        name: { type: "string" },
        meta: { type: "json", default: { migrated: true } },
      },
    });
    await adapter.insert("migrated", { name: "after" });
    const rows = await adapter.query("migrated").order("name").all<any>();
    expect(rows.map((row: any) => row.meta)).toEqual([
      { migrated: true },
      { migrated: true },
    ]);
    adapter.close();
  });

  test("changing a column type to json re-derives row deserialization", async () => {
    const adapter = sqliteAdapter(":memory:");
    await adapter.ensureTable("items", {
      columns: { body: { type: "string" } },
    });
    await adapter.insert("items", { body: '{"parsed":true}' });
    expect((await adapter.query("items").first<any>()).body).toBe(
      '{"parsed":true}',
    );

    await adapter.ensureTable("items", {
      columns: { body: { type: "json" } },
    });
    expect((await adapter.query("items").first<any>()).body).toEqual({
      parsed: true,
    });
    adapter.close();
  });

  test("bulkInsert includes columns that are absent from the first row", async () => {
    const adapter = sqliteAdapter(":memory:");
    await adapter.ensureTable("items", {
      columns: {
        name: { type: "string" },
        meta: { type: "json", optional: true },
      },
    });

    await adapter.bulkInsert("items", [
      { name: "first" },
      { name: "second", meta: { kept: true } },
    ]);

    const rows = await adapter.query("items").order("name").all<any>();
    expect(rows[0].meta).toBeNull();
    expect(rows[1].meta).toEqual({ kept: true });
    adapter.close();
  });

  test("json equality filters serialize values", async () => {
    const adapter = sqliteAdapter(":memory:");
    await adapter.ensureTable("items", {
      columns: { meta: { type: "json" } },
    });
    await adapter.insert("items", { meta: { a: 1 } });
    await adapter.insert("items", { meta: { a: 2 } });

    const rows = await adapter
      .query("items")
      .where("meta", "=", { a: 1 })
      .all<any>();

    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toEqual({ a: 1 });
    adapter.close();
  });

  test("offset works without limit", async () => {
    const adapter = sqliteAdapter(":memory:");
    await adapter.ensureTable("items", {
      columns: { name: { type: "string" }, value: { type: "number" } },
    });
    await adapter.insert("items", { name: "a", value: 1 });
    await adapter.insert("items", { name: "b", value: 2 });
    await adapter.insert("items", { name: "c", value: 3 });

    const rows = await adapter
      .query("items")
      .order("value")
      .offset(1)
      .all<any>();

    expect(rows.map((row: any) => row.name)).toEqual(["b", "c"]);
    adapter.close();
  });

  test("distinct honors offset", async () => {
    const adapter = sqliteAdapter(":memory:");
    await adapter.ensureTable("items", {
      columns: { name: { type: "string" }, value: { type: "number" } },
    });
    await adapter.insert("items", { name: "a", value: 1 });
    await adapter.insert("items", { name: "b", value: 2 });
    await adapter.insert("items", { name: "c", value: 3 });

    const values = await adapter
      .query("items")
      .order("value")
      .offset(1)
      .distinct("value");

    expect(values).toEqual([2, 3]);
    adapter.close();
  });

  test("rawQuery binds positional params", async () => {
    const adapter = sqliteAdapter(":memory:");
    await adapter.ensureTable("items", {
      columns: { name: { type: "string" }, value: { type: "number" } },
    });
    await adapter.insert("items", { name: "a", value: 1 });
    await adapter.insert("items", { name: "b", value: 2 });

    const rows = await adapter.rawQuery<{ name: string }>(
      'SELECT name FROM "items" WHERE value = ?',
      2,
    );
    expect(rows).toEqual([{ name: "b" }]);
    adapter.close();
  });

  test("empty IN filters return no rows", async () => {
    const adapter = sqliteAdapter(":memory:");
    await adapter.ensureTable("items", {
      columns: { name: { type: "string" } },
    });
    await adapter.insert("items", { name: "a" });

    expect(await adapter.query("items").where("name", "IN", []).all()).toEqual(
      [],
    );
    adapter.close();
  });

  test("reserved _id column is rejected before table creation", async () => {
    const adapter = sqliteAdapter(":memory:");

    expect(() =>
      adapter.ensureTable("items", {
        columns: { _id: { type: "string" }, name: { type: "string" } },
      }),
    ).toThrow("reserved column name");

    const rows = await adapter.rawQuery<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      "items",
    );
    expect(rows).toEqual([]);
    expect(adapter.getSchema("items")).toBeNull();
    adapter.close();
  });

  test("reserved _id column is rejected case-insensitively before table creation", async () => {
    const adapter = sqliteAdapter(":memory:");

    expect(() =>
      adapter.ensureTable("items", {
        columns: { _ID: { type: "string" }, name: { type: "string" } },
      }),
    ).toThrow("reserved column name");

    const rows = await adapter.rawQuery<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      "items",
    );
    expect(rows).toEqual([]);
    expect(adapter.getSchema("items")).toBeNull();
    adapter.close();
  });

  test("duplicate column names are rejected case-insensitively before table creation", async () => {
    const adapter = sqliteAdapter(":memory:");

    expect(() =>
      adapter.ensureTable("items", {
        columns: {
          name: { type: "string" },
          NAME: { type: "number" },
        },
      }),
    ).toThrow('duplicate column name "NAME" on table "items"');

    const rows = await adapter.rawQuery<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      "items",
    );
    expect(rows).toEqual([]);
    expect(adapter.getSchema("items")).toBeNull();
    adapter.close();
  });

  test("invalid index columns are rejected without creating a partial table", async () => {
    const adapter = sqliteAdapter(":memory:");

    expect(() =>
      adapter.ensureTable("items", {
        columns: { name: { type: "string" } },
        indexes: [["items_missing", ["missing"]]],
      }),
    ).toThrow("unknown index column");

    const rows = await adapter.rawQuery<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      "items",
    );
    expect(rows).toEqual([]);
    expect(adapter.getSchema("items")).toBeNull();
    adapter.close();
  });

  test("empty index definitions are rejected before table creation", async () => {
    const adapter = sqliteAdapter(":memory:");

    expect(() =>
      adapter.ensureTable("items", {
        columns: { name: { type: "string" } },
        indexes: [["items_empty", []]],
      }),
    ).toThrow("index must include at least one column");
    expect(() =>
      adapter.ensureTable("unique_items", {
        columns: { name: { type: "string" } },
        unique: [[]],
      }),
    ).toThrow("unique index must include at least one column");

    const rows = await adapter.rawQuery<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?) ORDER BY name",
      "items",
      "unique_items",
    );
    expect(rows).toEqual([]);
    expect(adapter.getSchema("items")).toBeNull();
    expect(adapter.getSchema("unique_items")).toBeNull();
    adapter.close();
  });

  test("generated unique index name collisions are rejected before table creation", async () => {
    const adapter = sqliteAdapter(":memory:");

    expect(() =>
      adapter.ensureTable("items", {
        columns: {
          a_b: { type: "string" },
          a: { type: "string" },
          b: { type: "string" },
        },
        unique: [["a_b"], ["a", "b"]],
      }),
    ).toThrow("duplicate generated unique index name");

    const rows = await adapter.rawQuery<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      "items",
    );
    expect(rows).toEqual([]);
    expect(adapter.getSchema("items")).toBeNull();
    adapter.close();
  });

  test("explicit indexes cannot collide with generated unique indexes", async () => {
    const adapter = sqliteAdapter(":memory:");

    expect(() =>
      adapter.ensureTable("items", {
        columns: {
          name: { type: "string" },
          value: { type: "number" },
        },
        indexes: [["uq_items_name", ["value"]]],
        unique: [["name"]],
      }),
    ).toThrow("explicit index name collides with generated unique index name");

    const rows = await adapter.rawQuery<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      "items",
    );
    expect(rows).toEqual([]);
    expect(adapter.getSchema("items")).toBeNull();
    adapter.close();
  });

  test("duplicate explicit index names are rejected before table creation", async () => {
    const adapter = sqliteAdapter(":memory:");

    expect(() =>
      adapter.ensureTable("items", {
        columns: {
          name: { type: "string" },
          value: { type: "number" },
        },
        indexes: [
          ["items_lookup", ["name"]],
          ["items_lookup", ["value"]],
        ],
      }),
    ).toThrow("duplicate explicit index name");

    const rows = await adapter.rawQuery<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      "items",
    );
    expect(rows).toEqual([]);
    expect(adapter.getSchema("items")).toBeNull();
    adapter.close();
  });

  test("duplicate explicit index names are rejected case-insensitively before table creation", async () => {
    const adapter = sqliteAdapter(":memory:");

    expect(() =>
      adapter.ensureTable("items", {
        columns: {
          name: { type: "string" },
          value: { type: "number" },
        },
        indexes: [
          ["items_lookup", ["name"]],
          ["ITEMS_LOOKUP", ["value"]],
        ],
      }),
    ).toThrow("duplicate explicit index name");

    const rows = await adapter.rawQuery<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      "items",
    );
    expect(rows).toEqual([]);
    expect(adapter.getSchema("items")).toBeNull();
    adapter.close();
  });

  test("sqlite internal explicit index names are rejected before table creation", async () => {
    const adapter = sqliteAdapter(":memory:");

    expect(() =>
      adapter.ensureTable("items", {
        columns: { name: { type: "string" } },
        indexes: [["sqlite_items_name", ["name"]]],
      }),
    ).toThrow("reserved SQLite internal index name");

    const rows = await adapter.rawQuery<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      "items",
    );
    expect(rows).toEqual([]);
    expect(adapter.getSchema("items")).toBeNull();
    adapter.close();
  });

  test("sqlite internal explicit index names are rejected case-insensitively", async () => {
    const adapter = sqliteAdapter(":memory:");

    expect(() =>
      adapter.ensureTable("items", {
        columns: { name: { type: "string" } },
        indexes: [["SQLite_items_name", ["name"]]],
      }),
    ).toThrow("reserved SQLite internal index name");

    const rows = await adapter.rawQuery<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      "items",
    );
    expect(rows).toEqual([]);
    expect(adapter.getSchema("items")).toBeNull();
    adapter.close();
  });

  test("reserved sqlite metadata table name is rejected without creating a user table", async () => {
    const adapter = sqliteAdapter(":memory:");

    expect(() =>
      adapter.ensureTable("__vex_sqlite_indexes", {
        columns: { name: { type: "string" } },
      }),
    ).toThrow("reserved SQLite metadata table name");

    const rows = await adapter.rawQuery<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      "__vex_sqlite_indexes",
    );
    expect(rows).toEqual([]);
    adapter.close();
  });

  test("reserved sqlite metadata table name is rejected case-insensitively", async () => {
    const adapter = sqliteAdapter(":memory:");

    expect(() =>
      adapter.ensureTable("__VEX_sqlite_indexes", {
        columns: { name: { type: "string" } },
      }),
    ).toThrow("reserved SQLite metadata table name");

    const rows = await adapter.rawQuery<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE lower(name) = lower(?)",
      "__vex_sqlite_indexes",
    );
    expect(rows).toEqual([]);
    expect(adapter.getSchema("__VEX_sqlite_indexes")).toBeNull();
    adapter.close();
  });

  test("sqlite internal table names are rejected before table creation", async () => {
    const adapter = sqliteAdapter(":memory:");

    expect(() =>
      adapter.ensureTable("sqlite_sequence", {
        columns: { name: { type: "string" } },
      }),
    ).toThrow("reserved SQLite internal table name");

    expect(adapter.getSchema("sqlite_sequence")).toBeNull();
    adapter.close();
  });

  test("sqlite internal table names are rejected case-insensitively", async () => {
    const adapter = sqliteAdapter(":memory:");

    expect(() =>
      adapter.ensureTable("SQLite_sequence", {
        columns: { name: { type: "string" } },
      }),
    ).toThrow("reserved SQLite internal table name");

    expect(adapter.getSchema("SQLite_sequence")).toBeNull();
    adapter.close();
  });

  test("case-insensitive table name aliases are rejected", async () => {
    const adapter = sqliteAdapter(":memory:");
    const priorSchema: TableSchema = {
      columns: { name: { type: "string" } },
    };
    await adapter.ensureTable("items", priorSchema);

    expect(() =>
      adapter.ensureTable("ITEMS", {
        columns: { value: { type: "number" } },
      }),
    ).toThrow('table name already exists with different casing: "items"');

    expect(adapter.getSchema("items")).toEqual(priorSchema);
    expect(adapter.getSchema("ITEMS")).toBeNull();
    adapter.close();
  });

  test("sqlite options apply busy timeout and cache size pragmas", async () => {
    const adapter = sqliteAdapter(":memory:", {
      busyTimeout: 1234,
      cacheSize: -2000,
    });
    const busyTimeout = await adapter.rawQuery<{ timeout: number }>(
      "PRAGMA busy_timeout",
    );
    const cacheSize = await adapter.rawQuery<{ cache_size: number }>(
      "PRAGMA cache_size",
    );

    expect(busyTimeout[0].timeout).toBe(1234);
    expect(cacheSize[0].cache_size).toBe(-2000);
    adapter.close();
  });

  test("sqlite options apply to every pooled read connection", async () => {
    const path = tempSqlitePath("pooled-options");
    let adapter: StorageAdapter | undefined;

    try {
      adapter = sqliteAdapter(path, {
        busyTimeout: 1234,
        cacheSize: -2000,
      });
      const pooledAdapter = adapter;
      const busyTimeouts = await Promise.all(
        Array.from({ length: 8 }, () =>
          pooledAdapter.rawQuery<{ timeout: number }>(
            "SELECT timeout FROM pragma_busy_timeout",
          ),
        ),
      );
      const cacheSizes = await Promise.all(
        Array.from({ length: 8 }, () =>
          pooledAdapter.rawQuery<{ cache_size: number }>(
            "SELECT cache_size FROM pragma_cache_size",
          ),
        ),
      );

      expect(busyTimeouts.every((rows) => rows[0].timeout === 1234)).toBe(true);
      expect(cacheSizes.every((rows) => rows[0].cache_size === -2000)).toBe(
        true,
      );
    } finally {
      await adapter?.close();
      cleanupSqlitePath(path);
    }
  });

  test("persistent sqlite files retain data across reopen", async () => {
    const path = tempSqlitePath("persistent-data");

    try {
      const first = sqliteAdapter(path);
      await first.ensureTable("items", {
        columns: { name: { type: "string" }, meta: { type: "json" } },
      });
      await first.insert("items", { name: "a", meta: { ok: true } });
      first.close();

      const second = sqliteAdapter(path);
      await second.ensureTable("items", {
        columns: { name: { type: "string" }, meta: { type: "json" } },
      });
      const row = await second.query("items").first<any>();
      expect(row.name).toBe("a");
      expect(row.meta).toEqual({ ok: true });
      second.close();
    } finally {
      cleanupSqlitePath(path);
    }
  });

  test("sqlite close is idempotent", () => {
    const adapter = sqliteAdapter(":memory:");
    adapter.close();
    adapter.close();
  });

  test("rolled back transactions do not report changed tables", async () => {
    const adapter = sqliteAdapter(":memory:");
    await adapter.ensureTable("items", {
      columns: { name: { type: "string" } },
    });
    adapter.getChangedTables();

    await expect(
      adapter.transaction(async () => {
        await adapter.insert("items", { name: "rolled-back" });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    expect(await adapter.query("items").count()).toBe(0);
    expect(adapter.getChangedTables()).toEqual([]);
    adapter.close();
  });

  test("rolled back transactions preserve prior changed tables", async () => {
    const adapter = sqliteAdapter(":memory:");
    await adapter.ensureTable("items", {
      columns: { name: { type: "string" } },
    });
    await adapter.insert("items", { name: "committed" });

    await expect(
      adapter.transaction(async () => {
        await adapter.insert("items", { name: "rolled-back" });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    expect(adapter.getChangedTables()).toEqual(["items"]);
    adapter.close();
  });

  test("rolled back transactions restore schema metadata", async () => {
    const adapter = sqliteAdapter(":memory:");

    await expect(
      adapter.transaction(async () => {
        await adapter.ensureTable("rolled_back", {
          columns: { name: { type: "string" } },
        });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    const rows = await adapter.rawQuery<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      "rolled_back",
    );
    expect(rows).toEqual([]);
    expect(adapter.getSchema("rolled_back")).toBeNull();
    adapter.close();
  });

  test("bulkInsert joins an existing sqlite transaction", async () => {
    const adapter = sqliteAdapter(":memory:");
    await adapter.ensureTable("items", {
      columns: { name: { type: "string" } },
    });

    await adapter.transaction(async () => {
      await adapter.bulkInsert("items", [{ name: "a" }, { name: "b" }]);
    });

    expect(await adapter.query("items").count()).toBe(2);
    expect(adapter.getChangedTables()).toEqual(["items"]);
    adapter.close();
  });

  test("failed unique migration leaves the physical table unchanged", async () => {
    const adapter = sqliteAdapter(":memory:");
    const priorSchema: TableSchema = {
      columns: { name: { type: "string" } },
    };
    const nextSchema: TableSchema = {
      columns: { name: { type: "string" }, active: { type: "boolean" } },
      unique: [["name"]],
    };
    await adapter.ensureTable("items", priorSchema);
    await adapter.insert("items", { name: "dup" });
    await adapter.insert("items", { name: "dup" });

    expect(() => adapter.ensureTable("items", nextSchema)).toThrow();

    const columns = await adapter.rawQuery<{ name: string }>(
      'PRAGMA table_info("items")',
    );
    expect(columns.map((col) => col.name)).toEqual(["_id", "name"]);
    expect(adapter.getSchema("items")).toEqual(priorSchema);
    expect(await sqliteManagedIndexNames(adapter, "items")).toEqual([]);
    adapter.close();
  });

  test("schema migration drops stale generated unique indexes", async () => {
    const path = tempSqlitePath("stale-unique-index");

    try {
      const first = sqliteAdapter(path);
      await first.ensureTable("secrets", {
        columns: {
          name: { type: "string" },
          workspaceId: { type: "string" },
        },
        unique: [["name"]],
      });
      await first.insert("secrets", { name: "gmail", workspaceId: "a" });
      await first.close();

      const second = sqliteAdapter(path);
      await second.ensureTable("secrets", {
        columns: {
          name: { type: "string" },
          workspaceId: { type: "string" },
        },
        unique: [["name", "workspaceId"]],
      });

      await second.insert("secrets", { name: "gmail", workspaceId: "b" });
      const indexes = await sqliteIndexNames(second, "secrets");
      expect(indexes).not.toContain("uq_secrets_name");
      expect(indexes).toContain("uq_secrets_name_workspaceId");
      expect(await sqliteManagedIndexNames(second, "secrets")).toEqual([
        "uq_secrets_name_workspaceId",
      ]);
      await second.close();
    } finally {
      cleanupSqlitePath(path);
    }
  });

  test("schema migration drops generated column indexes when removed", async () => {
    const adapter = sqliteAdapter(":memory:");
    await adapter.ensureTable("items", {
      columns: { category: { type: "string", index: true } },
    });
    expect(await sqliteIndexNames(adapter, "items")).toContain(
      "idx_items_category",
    );

    await adapter.ensureTable("items", {
      columns: { category: { type: "string" } },
    });
    expect(await sqliteIndexNames(adapter, "items")).not.toContain(
      "idx_items_category",
    );
    expect(await sqliteManagedIndexNames(adapter, "items")).toEqual([]);
    adapter.close();
  });

  test("schema migration drops unique indexes when removed", async () => {
    const adapter = sqliteAdapter(":memory:");
    await adapter.ensureTable("items", {
      columns: { name: { type: "string" } },
      unique: [["name"]],
    });
    expect(await sqliteIndexNames(adapter, "items")).toContain("uq_items_name");

    await adapter.ensureTable("items", {
      columns: { name: { type: "string" } },
    });
    expect(await sqliteIndexNames(adapter, "items")).not.toContain(
      "uq_items_name",
    );
    expect(await sqliteManagedIndexNames(adapter, "items")).toEqual([]);
    adapter.close();
  });

  test("schema migration rejects same-table manual index name conflicts", async () => {
    const adapter = sqliteAdapter(":memory:");
    const priorSchema: TableSchema = {
      columns: { name: { type: "string" }, value: { type: "number" } },
    };
    await adapter.ensureTable("items", priorSchema);
    await adapter.rawExec('CREATE INDEX "uq_items_name" ON "items" ("value")');

    expect(() =>
      adapter.ensureTable("items", {
        ...priorSchema,
        unique: [["name"]],
      }),
    ).toThrow("index name already exists with different definition");

    await adapter.insert("items", { name: "dup", value: 1 });
    await adapter.insert("items", { name: "dup", value: 2 });
    expect(await sqliteIndexColumns(adapter, "uq_items_name")).toEqual([
      "value",
    ]);
    expect(adapter.getSchema("items")).toEqual(priorSchema);
    adapter.close();
  });

  test("schema migration rejects same-table manual index name conflicts case-insensitively", async () => {
    const adapter = sqliteAdapter(":memory:");
    const priorSchema: TableSchema = {
      columns: { name: { type: "string" }, value: { type: "number" } },
    };
    await adapter.ensureTable("items", priorSchema);
    await adapter.rawExec('CREATE INDEX "items_lookup" ON "items" ("value")');

    expect(() =>
      adapter.ensureTable("items", {
        ...priorSchema,
        indexes: [["ITEMS_LOOKUP", ["name"]]],
      }),
    ).toThrow("index name already exists with different definition");

    expect(await sqliteIndexColumns(adapter, "items_lookup")).toEqual([
      "value",
    ]);
    expect(await sqliteManagedIndexNames(adapter, "items")).toEqual([]);
    expect(adapter.getSchema("items")).toEqual(priorSchema);
    adapter.close();
  });

  test("schema migration drops recorded explicit indexes when removed", async () => {
    const path = tempSqlitePath("explicit-index-removed");

    try {
      const first = sqliteAdapter(path);
      await first.ensureTable("items", {
        columns: {
          category: { type: "string" },
          value: { type: "number" },
        },
        indexes: [["items_category_value", ["category", "value"]]],
      });
      expect(await sqliteIndexNames(first, "items")).toContain(
        "items_category_value",
      );
      await first.close();

      const second = sqliteAdapter(path);
      await second.ensureTable("items", {
        columns: {
          category: { type: "string" },
          value: { type: "number" },
        },
      });
      expect(await sqliteIndexNames(second, "items")).not.toContain(
        "items_category_value",
      );
      expect(await sqliteManagedIndexNames(second, "items")).toEqual([]);
      await second.close();
    } finally {
      cleanupSqlitePath(path);
    }
  });

  test("explicit index names cannot be reused across sqlite tables", async () => {
    const adapter = sqliteAdapter(":memory:");
    await adapter.ensureTable("first_items", {
      columns: { category: { type: "string" } },
      indexes: [["shared_lookup", ["category"]]],
    });

    expect(() =>
      adapter.ensureTable("second_items", {
        columns: { value: { type: "number" } },
        indexes: [["shared_lookup", ["value"]]],
      }),
    ).toThrow("index name already exists on another table");

    expect(await sqliteIndexNames(adapter, "second_items")).toEqual([]);
    expect(await sqliteManagedIndexNames(adapter, "second_items")).toEqual([]);
    expect(adapter.getSchema("second_items")).toBeNull();
    adapter.close();
  });

  test("explicit index names cannot be reused across sqlite tables case-insensitively", async () => {
    const adapter = sqliteAdapter(":memory:");
    await adapter.ensureTable("first_items", {
      columns: { category: { type: "string" } },
      indexes: [["shared_lookup", ["category"]]],
    });

    expect(() =>
      adapter.ensureTable("second_items", {
        columns: { value: { type: "number" } },
        indexes: [["SHARED_LOOKUP", ["value"]]],
      }),
    ).toThrow("index name already exists on another table");

    expect(await sqliteIndexNames(adapter, "second_items")).toEqual([]);
    expect(await sqliteManagedIndexNames(adapter, "second_items")).toEqual([]);
    expect(adapter.getSchema("second_items")).toBeNull();
    adapter.close();
  });

  test("schema migration recreates explicit indexes when columns change", async () => {
    const adapter = sqliteAdapter(":memory:");
    await adapter.ensureTable("items", {
      columns: {
        category: { type: "string" },
        value: { type: "number" },
      },
      indexes: [["items_lookup", ["category"]]],
    });
    expect(await sqliteIndexColumns(adapter, "items_lookup")).toEqual([
      "category",
    ]);

    await adapter.ensureTable("items", {
      columns: {
        category: { type: "string" },
        value: { type: "number" },
      },
      indexes: [["items_lookup", ["value", "category"]]],
    });
    expect(await sqliteIndexColumns(adapter, "items_lookup")).toEqual([
      "value",
      "category",
    ]);
    expect(await sqliteManagedIndexNames(adapter, "items")).toEqual([
      "items_lookup",
    ]);
    adapter.close();
  });

  test("explicit indexes win name collisions with generated column indexes", async () => {
    const adapter = sqliteAdapter(":memory:");
    await adapter.ensureTable("items", {
      columns: {
        category: { type: "string", index: true },
        value: { type: "number" },
      },
      indexes: [["idx_items_category", ["value"]]],
    });

    expect(await sqliteIndexColumns(adapter, "idx_items_category")).toEqual([
      "value",
    ]);
    adapter.close();
  });

  test("case-insensitive generated column and explicit index name collisions are rejected", async () => {
    const adapter = sqliteAdapter(":memory:");

    expect(() =>
      adapter.ensureTable("items", {
        columns: {
          category: { type: "string", index: true },
          value: { type: "number" },
        },
        indexes: [["IDX_ITEMS_CATEGORY", ["value"]]],
      }),
    ).toThrow("index name collides with generated column index name");

    const rows = await adapter.rawQuery<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      "items",
    );
    expect(rows).toEqual([]);
    expect(adapter.getSchema("items")).toBeNull();
    adapter.close();
  });

  test("schema migration preserves unrelated manual indexes", async () => {
    const adapter = sqliteAdapter(":memory:");
    await adapter.ensureTable("items", {
      columns: { category: { type: "string" }, value: { type: "number" } },
      unique: [["category"]],
    });
    await adapter.rawExec(
      'CREATE INDEX "manual_items_value" ON "items" ("value")',
    );

    await adapter.ensureTable("items", {
      columns: { category: { type: "string" }, value: { type: "number" } },
      unique: [["value"]],
    });

    const indexes = await sqliteIndexNames(adapter, "items");
    expect(indexes).toContain("manual_items_value");
    expect(indexes).not.toContain("uq_items_category");
    expect(indexes).toContain("uq_items_value");
    adapter.close();
  });

  test("empty-table rebuild preserves unrelated manual indexes", async () => {
    const adapter = sqliteAdapter(":memory:");
    await adapter.ensureTable("items", {
      columns: {
        name: { type: "string", optional: true },
        value: { type: "number" },
      },
    });
    await adapter.rawExec(
      'CREATE INDEX "manual_items_value" ON "items" ("value")',
    );

    await adapter.ensureTable("items", {
      columns: {
        name: { type: "string" },
        value: { type: "number" },
      },
    });

    expect(await sqliteIndexNames(adapter, "items")).toContain(
      "manual_items_value",
    );
    adapter.close();
  });

  test("empty-table rebuild preserves manual indexes on columns omitted from new schema", async () => {
    const adapter = sqliteAdapter(":memory:");
    await adapter.ensureTable("items", {
      columns: {
        name: { type: "string", optional: true },
        legacy: { type: "string" },
      },
    });
    await adapter.rawExec(
      'CREATE INDEX "manual_items_legacy" ON "items" ("legacy")',
    );

    await adapter.ensureTable("items", {
      columns: { name: { type: "string" } },
    });

    expect(await sqliteIndexNames(adapter, "items")).toContain(
      "manual_items_legacy",
    );
    await adapter.insert("items", { name: "a", legacy: "kept" });
    const rows = await adapter.rawQuery<{ legacy: string }>(
      'SELECT legacy FROM "items"',
    );
    expect(rows).toEqual([{ legacy: "kept" }]);
    adapter.close();
  });

  test("schema migration preserves manual indexes with vex-like prefixes", async () => {
    const adapter = sqliteAdapter(":memory:");
    await adapter.ensureTable("items", {
      columns: { category: { type: "string" }, value: { type: "number" } },
      unique: [["category"]],
    });
    await adapter.rawExec(
      'CREATE INDEX "idx_items_manual_lookup" ON "items" ("value")',
    );
    await adapter.rawExec(
      'CREATE UNIQUE INDEX "uq_items_manual_lookup" ON "items" ("value")',
    );

    await adapter.ensureTable("items", {
      columns: { category: { type: "string" }, value: { type: "number" } },
      unique: [["value"]],
    });

    const indexes = await sqliteIndexNames(adapter, "items");
    expect(indexes).toContain("idx_items_manual_lookup");
    expect(indexes).toContain("uq_items_manual_lookup");
    expect(indexes).not.toContain("uq_items_category");
    expect(indexes).toContain("uq_items_value");
    adapter.close();
  });

  test("schema migration handles quoted identifiers in index names", async () => {
    const adapter = sqliteAdapter(":memory:");
    await adapter.ensureTable('odd " table', {
      columns: {
        'odd " col': { type: "string", index: true },
        other: { type: "string" },
      },
      unique: [['odd " col', "other"]],
    });
    await adapter.insert('odd " table', {
      'odd " col': "a",
      other: "b",
    });
    const row = await adapter
      .query('odd " table')
      .where('odd " col', "=", "a")
      .select("_id", 'odd " col')
      .first<any>();
    expect(row['odd " col']).toBe("a");
    await adapter.update('odd " table', row._id, { other: "c" });
    await adapter.delete('odd " table', row._id);

    expect(await sqliteIndexNames(adapter, 'odd " table')).toContain(
      'idx_odd " table_odd " col',
    );
    expect(await sqliteIndexNames(adapter, 'odd " table')).toContain(
      'uq_odd " table_odd " col_other',
    );

    await adapter.ensureTable('odd " table', {
      columns: {
        'odd " col': { type: "string" },
        other: { type: "string" },
      },
      unique: [["other"]],
    });
    const indexes = await sqliteIndexNames(adapter, 'odd " table');
    expect(indexes).not.toContain('idx_odd " table_odd " col');
    expect(indexes).not.toContain('uq_odd " table_odd " col_other');
    expect(indexes).toContain('uq_odd " table_other');
    adapter.close();
  });
});
