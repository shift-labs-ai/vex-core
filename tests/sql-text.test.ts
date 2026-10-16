import { describe, expect, test } from "bun:test";
import {
  isReadOnlyStatement,
  leadingSqlKeyword,
  tablesRead,
} from "../src/core/sql-text.js";

describe("tablesRead", () => {
  const tables = ["items", "grants", "items_archive", "Users", "ünïcode"];
  const read = (sql: string, views = []) => tablesRead(sql, tables, views);

  test("finds every named table, in any quoting or case", () => {
    expect(read("SELECT * FROM docs, grants")).toEqual(["grants"]);
    expect(read("SELECT * FROM main.grants")).toEqual(["grants"]);
    expect(read('SELECT * FROM "grants"')).toEqual(["grants"]);
    expect(read("SELECT * FROM [grants]")).toEqual(["grants"]);
    expect(read("SELECT * FROM `grants`")).toEqual(["grants"]);
    expect(read("SELECT * FROM 'grants'")).toEqual(["grants"]);
    expect(read("select * from GRANTS")).toEqual(["grants"]);
    expect(read("SELECT * FROM users")).toEqual(["Users"]);
    expect(read('SELECT * FROM "ünïcode"')).toEqual(["ünïcode"]);
  });

  test("matches whole identifiers only", () => {
    expect(read("SELECT * FROM items_archive")).toEqual(["items_archive"]);
    expect(read("SELECT * FROM my_items")).toEqual([]);
    expect(read("SELECT itemsCount FROM x")).toEqual([]);
    expect(read("SELECT * FROM items$x")).toEqual([]);
  });

  test("over-approximates: a column or literal of a table's name counts", () => {
    expect(read("SELECT grants FROM x")).toEqual(["grants"]);
    expect(read("SELECT * FROM x WHERE kind = 'items'")).toEqual(["items"]);
    expect(read("SELECT 1 -- from grants")).toEqual(["grants"]);
  });

  test("names nothing when no known table appears", () => {
    expect(read("SELECT 1")).toEqual([]);
  });

  test("follows views, views of views, and survives a cycle of names", () => {
    const views = [
      { name: "v1", sql: "CREATE VIEW v1 AS SELECT * FROM v2" },
      { name: "v2", sql: "CREATE VIEW v2 AS SELECT * FROM grants, v1" },
      { name: "unused", sql: "CREATE VIEW unused AS SELECT * FROM items" },
    ];
    expect(tablesRead("SELECT * FROM V1", tables, views)).toEqual(["grants"]);
    expect(tablesRead("SELECT * FROM x", tables, views)).toEqual([]);
  });
});

describe("statement classification", () => {
  test("the leading keyword skips whitespace and comments", () => {
    expect(leadingSqlKeyword("  -- c\n /* c */ delete from x")).toBe("DELETE");
    expect(leadingSqlKeyword("-- only a comment")).toBe("");
  });

  test("only SELECT, VALUES and EXPLAIN are read-only; WITH may write", () => {
    expect(isReadOnlyStatement("SELECT 1")).toBe(true);
    expect(isReadOnlyStatement("/* x */ values (1)")).toBe(true);
    expect(isReadOnlyStatement("EXPLAIN DELETE FROM x")).toBe(true);
    expect(isReadOnlyStatement("WITH a AS (SELECT 1) SELECT * FROM a")).toBe(
      false,
    );
    for (const sql of [
      "INSERT INTO x VALUES (1)",
      "UPDATE x SET a = 1",
      "DELETE FROM x",
      "REPLACE INTO x VALUES (1)",
      "CREATE TABLE x (a)",
      "PRAGMA foreign_keys = ON",
      "",
    ]) {
      expect([sql, isReadOnlyStatement(sql)]).toEqual([sql, false]);
    }
  });
});
