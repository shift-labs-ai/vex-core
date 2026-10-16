import { afterAll } from "bun:test";
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
