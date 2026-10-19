/**
 * `readOnlyTables`, shared by every SQLite adapter: what one statement
 * reads when SQLite's compiled program shows it only reads, and why not
 * otherwise. `bun test` runs it against the Bun adapter
 * (tests/read-only.test.ts); vitest against the Durable Object adapter
 * (tests/workers/read-only.test.ts).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ReadOnlyRead, StorageAdapter } from "../src/core/storage.js";

export function readOnlySuite(
  name: string,
  create: () => Promise<StorageAdapter>,
): void {
  describe(`${name} readOnlyTables`, () => {
    let adapter: StorageAdapter;
    const read = async (sql: string): Promise<ReadOnlyRead> => {
      const answer = await adapter.readOnlyTables?.(sql);
      if (!answer) throw new Error("the adapter cannot tell");
      return answer;
    };
    const tables = async (sql: string) => {
      const answer = await read(sql);
      if ("refused" in answer) throw new Error(answer.refused);
      return [...answer.tables].sort();
    };
    const refusal = async (sql: string) => {
      const answer = await read(sql);
      return "refused" in answer ? answer.refused : null;
    };

    beforeEach(async () => {
      adapter = await create();
      await adapter.ensureTable("notes", {
        columns: { body: { type: "string" } },
      });
      await adapter.ensureTable("keys", {
        columns: { token: { type: "string", index: true } },
      });
      await adapter.rawExec(
        "CREATE VIEW IF NOT EXISTS key_view AS SELECT token FROM keys",
      );
    });

    afterEach(async () => {
      await adapter.close();
    });

    test("names every table a read opens, however it reaches it", async () => {
      expect(await tables("SELECT body FROM notes")).toEqual(["notes"]);
      expect(await tables("SELECT * FROM key_view")).toEqual(["keys"]);
      expect(
        await tables("WITH k AS (SELECT token FROM keys) SELECT * FROM k"),
      ).toEqual(["keys"]);
      expect(
        await tables("SELECT (SELECT token FROM keys) AS t, body FROM notes"),
      ).toEqual(["keys", "notes"]);
      expect(
        await tables(
          "SELECT * FROM notes WHERE EXISTS (SELECT 1 FROM keys WHERE token = ?)",
        ),
      ).toEqual(["keys", "notes"]);
      // An index answers it alone; the index's table is what it reads.
      expect(await tables("SELECT count(*) FROM keys WHERE token = ?")).toEqual(
        ["keys"],
      );
      expect(await tables('SELECT body FROM main."notes"')).toEqual(["notes"]);
      expect(await tables("SELECT 1 AS n")).toEqual([]);
      expect(await tables("VALUES (1), (2)")).toEqual([]);
      expect(
        await tables(
          "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c LIMIT 5) SELECT x FROM c",
        ),
      ).toEqual([]);
    });

    test("the schema itself is a table it reads", async () => {
      expect(await tables("SELECT name FROM sqlite_master")).toEqual([
        "sqlite_schema",
      ]);
    });

    test("refuses anything that writes, whatever its first word", async () => {
      for (const sql of [
        "DELETE FROM notes",
        "INSERT INTO notes (_id, body) SELECT _id, token FROM keys",
        "UPDATE notes SET body = 'x'",
        "CREATE TABLE more (x)",
        "PRAGMA table_info(keys)",
        "EXPLAIN SELECT * FROM notes",
        "ATTACH DATABASE ':memory:' AS other",
      ]) {
        expect(await refusal(sql)).toBe(
          "Only a SELECT, VALUES or WITH statement is allowed.",
        );
      }
      expect(
        await refusal(
          "WITH gone AS (SELECT _id FROM keys) DELETE FROM notes WHERE _id IN gone",
        ),
      ).toBe("The statement writes.");
    });

    test("refuses more than one statement, though each would read", async () => {
      expect(await refusal("SELECT 1; SELECT 2")).toBe(
        "Only one statement is allowed.",
      );
      expect(await refusal("SELECT 1; DELETE FROM notes")).toBe(
        "Only one statement is allowed.",
      );
      // A semicolon in a string ends nothing.
      expect(await tables("SELECT ';' AS semi FROM notes")).toEqual(["notes"]);
    });

    test("refuses virtual tables and SQL that does not compile", async () => {
      expect(await refusal("SELECT * FROM pragma_table_info('keys')")).toBe(
        "The statement reads a virtual table.",
      );
      expect(await refusal("SELECT FROM")).toMatch(/^Invalid SQL: /);
      expect(await refusal("SELECT * FROM nowhere")).toMatch(/^Invalid SQL: /);
    });

    test("answers again after the schema moves", async () => {
      expect(await tables("SELECT * FROM key_view")).toEqual(["keys"]);
      await adapter.rawExec("DROP VIEW key_view");
      await adapter.rawExec("CREATE VIEW key_view AS SELECT body FROM notes");
      expect(await tables("SELECT * FROM key_view")).toEqual(["notes"]);
    });
  });
}
