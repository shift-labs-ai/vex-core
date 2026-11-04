/**
 * Planner statistics (SHFT-2478).
 *
 * SQLite chooses between indexes by how selective each is, which it
 * reads from `sqlite_stat1`; it never gathers those statistics by
 * itself. Without them, a lookup by `(sessionId, entryId)` takes the
 * `(sessionId, seq)` index and walks the whole session instead of
 * finding the one entry by `entryId`.
 *
 * The adapter gathers them at open, after schema changes and on an
 * interval. A connection reads them once, as it opens, so the read
 * pool's connections are reopened whenever they change.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import * as ambient from "../src/core/ambient.js";
import type { StorageAdapter } from "../src/core/storage.js";

let tmp = "";
let dbPath = "";
let storage: StorageAdapter | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "vex-core-statistics-"));
  dbPath = join(tmp, "data.db");
});

afterEach(async () => {
  await storage?.close();
  storage = undefined;
  rmSync(tmp, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const LOOKUP =
  "EXPLAIN QUERY PLAN SELECT entryId FROM entries WHERE sessionId = ? AND entryId IN (?, ?)";

/**
 * The index each read connection plans the lookup with. The pool hands
 * connections out in turn, so eight reads cover its four connections
 * twice.
 */
async function readerPlans(adapter: StorageAdapter): Promise<string[]> {
  const plans: string[] = [];
  for (let i = 0; i < 8; i++) {
    const rows = await adapter.rawQuery<{ detail: string }>(
      LOOKUP,
      "big",
      "e1",
      "e2",
    );
    plans.push(rows.map((row) => row.detail).join(" | "));
  }
  return plans;
}

const usesEntryIndex = (plan: string) =>
  plan.includes("USING INDEX idx_entries_entryId");

/**
 * A database written by something other than the adapter: entries in
 * the sessions `session` names (one large session and many small ones
 * unless told otherwise), both indexes, and no statistics.
 */
function seedWithoutStatistics(
  rows: number,
  session: (i: number) => string = (i) =>
    i < rows * 0.9 ? "big" : `s${i % 50}`,
): void {
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(
    "CREATE TABLE entries (_id TEXT PRIMARY KEY, sessionId TEXT, entryId TEXT, seq INTEGER)",
  );
  db.exec("CREATE INDEX idx_entries_sessionId_seq ON entries (sessionId, seq)");
  db.exec("CREATE INDEX idx_entries_entryId ON entries (entryId)");
  insertEntries(db, 0, rows, session);
  db.close();
}

function insertEntries(
  db: Database,
  from: number,
  to: number,
  session: (i: number) => string,
): void {
  const insert = db.prepare("INSERT INTO entries VALUES (?, ?, ?, ?)");
  db.transaction(() => {
    for (let i = from; i < to; i++) insert.run(`r${i}`, session(i), `e${i}`, i);
  })();
}

describe("SQLite planner statistics", () => {
  test("a database without statistics gets them at open, and every read connection plans by them", async () => {
    seedWithoutStatistics(20_000);
    // Without them, a connection walks the large session.
    const bare = new Database(dbPath, { readonly: true });
    const before = (
      bare.prepare(LOOKUP).all("big", "e1", "e2") as Array<{ detail: string }>
    )
      .map((row) => row.detail)
      .join(" | ");
    bare.close();
    expect(before).toContain("idx_entries_sessionId_seq");

    storage = sqliteAdapter(dbPath);
    const plans = await readerPlans(storage);
    expect(plans.every(usesEntryIndex)).toBe(true);
  });

  test("statistics gathered later reach read connections that were already open", async () => {
    // Small and even when the adapter opens: its readers load
    // statistics saying a session holds one entry.
    seedWithoutStatistics(200, (i) => `s${i}`);
    storage = sqliteAdapter(dbPath, { statisticsIntervalMs: 50 });
    await readerPlans(storage);

    // The large session grows tenfold behind the readers' backs.
    const writer = new Database(dbPath);
    insertEntries(writer, 200, 20_200, () => "big");
    writer.close();
    const stale = await readerPlans(storage);
    expect(stale.some(usesEntryIndex)).toBe(false);

    // The interval's run re-analyzes the grown table, and every reader
    // reopens to plan by what it found.
    await sleep(150);
    const fresh = await readerPlans(storage);
    expect(fresh.every(usesEntryIndex)).toBe(true);
  });

  test("a read connection that cannot reopen is released, and retries on its next read", async () => {
    seedWithoutStatistics(200, (i) => `s${i}`);
    storage = sqliteAdapter(dbPath, { statisticsIntervalMs: 20 });
    const adapter = storage;
    const writer = new Database(dbPath);
    insertEntries(writer, 200, 20_200, () => "big");
    writer.close();
    // The refresh marks every reader stale; none can reopen while the
    // file is away. (A permission change would not do: SQLite reuses the
    // process's open descriptor for the file.)
    await sleep(80);
    const away = `${dbPath}.away`;
    renameSync(dbPath, away);
    try {
      for (let i = 0; i < 4; i++) {
        await expect(adapter.rawQuery("SELECT 1")).rejects.toThrow();
      }
    } finally {
      renameSync(away, dbPath);
    }
    // Every connection is free again, and reopens now.
    expect((await readerPlans(adapter)).every(usesEntryIndex)).toBe(true);
  });

  test("a schema change gathers statistics once its turn is done", async () => {
    // In memory, so the writer is the one connection.
    storage = sqliteAdapter(":memory:");
    await storage.ensureTable("entries", {
      columns: {
        sessionId: { type: "string" },
        entryId: { type: "string", index: true },
        seq: { type: "number" },
      },
      indexes: [["idx_entries_sessionId_seq", ["sessionId", "seq"]]],
    });
    await storage.bulkInsert(
      "entries",
      Array.from({ length: 20_000 }, (_, i) => ({
        sessionId: i < 18_000 ? "big" : `s${i % 50}`,
        entryId: `e${i}`,
        seq: i,
      })),
    );
    await sleep(10);
    expect((await readerPlans(storage)).every(usesEntryIndex)).toBe(true);
  });

  test("a schema change inside a transaction gets its statistics after the commit, not in it", async () => {
    seedWithoutStatistics(20_000);
    storage = sqliteAdapter(dbPath);
    const adapter = storage;
    const statistics = () =>
      adapter.rawQuery<{ idx: string }>(
        "SELECT idx FROM sqlite_stat1 WHERE tbl = 'entries'",
      );
    await adapter.transaction(async () => {
      await adapter.rawExec("DROP INDEX idx_entries_entryId");
      await adapter.rawExec(
        "CREATE INDEX idx_entries_entryId ON entries (entryId)",
      );
      // The scheduled run waits for this transaction's lock: nothing is
      // gathered inside it, where a rollback would undo it.
      await sleep(20);
      expect((await statistics()).map((row) => row.idx)).not.toContain(
        "idx_entries_entryId",
      );
    });
    await sleep(10);
    expect((await statistics()).map((row) => row.idx)).toContain(
      "idx_entries_entryId",
    );
    expect((await readerPlans(adapter)).every(usesEntryIndex)).toBe(true);
  });

  test("closing stops the refresh", async () => {
    // The adapter schedules through the engine's own timers.
    const intervals = spyOn(ambient, "setInterval");
    const timeouts = spyOn(ambient, "setTimeout");
    const clearedIntervals = spyOn(globalThis, "clearInterval");
    const clearedTimeouts = spyOn(globalThis, "clearTimeout");
    try {
      seedWithoutStatistics(200);
      const adapter = sqliteAdapter(dbPath, { statisticsIntervalMs: 5 });
      // A refresh is due on the next turn, and another on the interval.
      await adapter.rawExec("CREATE INDEX idx_entries_seq ON entries (seq)");
      const interval = intervals.mock.results.at(-1)?.value;
      const due = timeouts.mock.results.at(-1)?.value;
      adapter.close();
      expect(clearedIntervals).toHaveBeenCalledWith(interval);
      expect(clearedTimeouts).toHaveBeenCalledWith(due);
    } finally {
      intervals.mockRestore();
      timeouts.mockRestore();
      clearedIntervals.mockRestore();
      clearedTimeouts.mockRestore();
    }
  });
});
