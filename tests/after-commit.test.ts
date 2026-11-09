import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import type { StorageAdapter } from "../src/core/storage.js";
import { afterCommitSuite } from "./after-commit-suite.js";

const dir = mkdtempSync(join(tmpdir(), "vex-after-commit-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let files = 0;
const onFile = () => sqliteAdapter(join(dir, `db-${files++}.sqlite`));
const inMemory = () => sqliteAdapter(":memory:");

/** A storage adapter written before `afterCommit`: every member but it. */
function withoutAfterCommit(adapter: StorageAdapter): StorageAdapter {
  const { afterCommit: _, ...rest } = adapter;
  return rest;
}

afterCommitSuite("sqlite file", onFile, { seesNesting: true });
afterCommitSuite("sqlite memory", inMemory, { seesNesting: true });
afterCommitSuite(
  "sqlite file, adapter without afterCommit",
  () => withoutAfterCommit(onFile()),
  { seesNesting: false },
);
afterCommitSuite(
  "sqlite memory, adapter without afterCommit",
  () => withoutAfterCommit(inMemory()),
  { seesNesting: false, runs: 20 },
);
