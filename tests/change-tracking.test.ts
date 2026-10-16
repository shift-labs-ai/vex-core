import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import { Vex } from "../src/core/engine.js";
import { ANY_TABLE } from "../src/core/storage.js";
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
  test("count as changing any table, at the next invalidation", async () => {
    const file = join(dir, "shared.sqlite");
    const mine = sqliteAdapter(file);
    const theirs = sqliteAdapter(file);
    try {
      const columns = { v: { type: "string" as const } };
      await mine.ensureTable("a", { columns });
      await mine.ensureTable("b", { columns });
      mine.takeChanges().tables;
      await theirs.rawExec("INSERT INTO a (_id, v) VALUES ('1', 'x')");
      expect(mine.takeChanges()).toEqual({
        tables: [ANY_TABLE],
        unattributed: [ANY_TABLE],
      });
      // Nothing more until they write again.
      expect(mine.takeChanges().tables).toEqual([]);
    } finally {
      mine.close();
      theirs.close();
    }
  });
});

describe("sqlite (file): a subscription over a table created by raw SQL", () => {
  test("re-runs after another connection writes it", async () => {
    const file = join(dir, "raw-table.sqlite");
    let runs = 0;
    const vex = await Vex.create({
      storage: sqliteAdapter(file),
      plugins: [
        (api) => {
          api.setName("t");
          api.registerTable("items", { columns: { v: { type: "string" } } });
          api.registerQuery("loose", {
            args: {},
            async handler(ctx) {
              runs++;
              return ctx.db.sql("SELECT count(*) AS c FROM loose");
            },
          });
          api.registerMutation("touch", {
            args: {},
            handler: (ctx) => ctx.db.table("items").insert({ v: "x" }),
          });
        },
      ],
    });
    const theirs = sqliteAdapter(file);
    try {
      await vex.unsafeSql("CREATE TABLE loose (v TEXT)");
      await vex.subscribe("t.loose", {}, () => {});
      const before = runs;
      await theirs.rawExec("INSERT INTO loose VALUES ('x')");
      // Noticed at the next invalidation.
      await vex.mutate("t.touch", {});
      expect(runs).toBe(before + 1);
    } finally {
      theirs.close();
      await vex.close();
    }
  });
});
