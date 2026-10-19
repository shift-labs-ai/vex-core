import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import { readOnlySuite } from "./read-only-suite.js";

const dir = mkdtempSync(join(tmpdir(), "vex-read-only-"));
let n = 0;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

readOnlySuite("sqlite (memory)", async () => sqliteAdapter(":memory:"));
// A file database reads through its pool of read-only connections.
readOnlySuite("sqlite (file)", async () =>
  sqliteAdapter(join(dir, `db-${++n}.sqlite`)),
);

describe("sqlite readOnlyTables on one connection", () => {
  test("refuses a read of another database: a TEMP table", async () => {
    const adapter = sqliteAdapter(":memory:");
    try {
      await adapter.rawExec("CREATE TEMP TABLE scratch (x)");
      expect(
        await adapter.readOnlyTables?.("SELECT x FROM temp.scratch"),
      ).toEqual({
        refused: "The statement reads another database.",
      });
    } finally {
      await adapter.close();
    }
  });
});
