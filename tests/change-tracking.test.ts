import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import { changeTrackingSuite } from "./change-tracking-suite.js";

changeTrackingSuite("sqlite (memory)", () => sqliteAdapter(":memory:"));

// A file database adds the read pool: raw reads, and the view lookup,
// run on read connections; writes and their change collection on the
// writer.
const dir = mkdtempSync(join(tmpdir(), "vex-change-tracking-"));
let files = 0;
afterAll(() => rmSync(dir, { recursive: true, force: true }));
changeTrackingSuite("sqlite (file)", () =>
  sqliteAdapter(join(dir, `db-${files++}.sqlite`)),
);

describe("sqlite (file): writes by another connection", () => {
  test("count as changing every table, at the next invalidation", async () => {
    const file = join(dir, "shared.sqlite");
    const mine = sqliteAdapter(file);
    const theirs = sqliteAdapter(file);
    try {
      const columns = { v: { type: "string" as const } };
      await mine.ensureTable("a", { columns });
      await mine.ensureTable("b", { columns });
      mine.getChangedTables();
      await theirs.rawExec("INSERT INTO a (_id, v) VALUES ('1', 'x')");
      expect(mine.getChangedTables().sort()).toEqual(["a", "b"]);
      // Nothing more until they write again.
      expect(mine.getChangedTables()).toEqual([]);
    } finally {
      mine.close();
      theirs.close();
    }
  });
});
