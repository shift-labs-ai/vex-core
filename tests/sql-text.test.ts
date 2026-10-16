import { describe, expect, test } from "bun:test";
import {
  leadingSqlKeyword,
  parameterCount,
  splitStatements,
  statementKind,
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
    expect(leadingSqlKeyword("/* unterminated")).toBe("");
  });

  test("reads, row writes, WITH, and everything else", () => {
    const kinds: [string, string][] = [
      ["SELECT 1", "read"],
      ["/* x */ values (1)", "read"],
      ["EXPLAIN DELETE FROM x", "read"],
      ["INSERT INTO x VALUES (1)", "write"],
      ["update x set a = 1", "write"],
      ["DELETE FROM x", "write"],
      ["REPLACE INTO x VALUES (1)", "write"],
      ["WITH a AS (SELECT 1) SELECT * FROM a", "with"],
      ["CREATE TABLE x (a)", "other"],
      ["PRAGMA foreign_keys = ON", "other"],
      ["", "other"],
    ];
    for (const [sql, kind] of kinds) {
      expect([sql, statementKind(sql)]).toEqual([sql, kind]);
    }
  });
});

describe("splitStatements", () => {
  test("splits at semicolons outside strings, identifiers and comments", () => {
    expect(
      splitStatements(
        "INSERT INTO a VALUES ('x;y'); -- a ; comment\nUPDATE \"b;c\" SET [d;e] = `f;g` /* ; */;",
      ),
    ).toEqual([
      "INSERT INTO a VALUES ('x;y')",
      '-- a ; comment\nUPDATE "b;c" SET [d;e] = `f;g` /* ; */',
    ]);
  });

  test("keeps a trigger body, CASE ... END included, in one statement", () => {
    const trigger =
      "CREATE TEMP TRIGGER t AFTER INSERT ON a BEGIN UPDATE b SET v = CASE WHEN NEW.x THEN 1 ELSE 2 END; DELETE FROM c; END;";
    expect(splitStatements(`${trigger} INSERT INTO a VALUES (1);`)).toEqual([
      trigger.slice(0, -1),
      "INSERT INTO a VALUES (1)",
    ]);
    expect(
      splitStatements(
        "EXPLAIN CREATE TRIGGER t AFTER DELETE ON a BEGIN SELECT 1; END;",
      ),
    ).toHaveLength(1);
  });

  test("keeps a last statement without a semicolon and drops empty ones", () => {
    expect(splitStatements(";; SELECT 1 ;  ; SELECT 2  ")).toEqual([
      "SELECT 1",
      "SELECT 2",
    ]);
    expect(splitStatements("  -- nothing\n ;")).toEqual([]);
  });
});

describe("parameterCount", () => {
  test("counts parameters as SQLite numbers them", () => {
    expect(parameterCount("SELECT ?, ?, ?")).toBe(3);
    expect(parameterCount("SELECT ?3, ?")).toBe(4);
    expect(parameterCount("SELECT :a, @b, $c, :a")).toBe(3);
    expect(parameterCount("SELECT '?', \"?\", [?] -- ?\n, ?")).toBe(1);
    expect(parameterCount("SELECT 1")).toBe(0);
  });
});
