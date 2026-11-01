/**
 * Planner statistics on a Durable Object (SHFT-2478): due as the
 * adapter opens and after every schema change, and gathered by the next
 * operation on rows outside a transaction. See
 * tests/sqlite-statistics.test.ts for why.
 */
import {
  type DurableObjectSqlStorage,
  durableObjectAdapter,
} from "../../src/adapters/durable-object.js";
import { GATHER_STATISTICS } from "../../src/adapters/sqlite-core.js";
import { describe, expect, objectStorage, test } from "./bun-test.js";

const LOOKUP =
  "EXPLAIN QUERY PLAN SELECT entryId FROM entries WHERE sessionId = ? AND entryId IN (?, ?)";

/** Entries in one large session and many small ones, by raw SQL. */
function seed(withEntryIndex: boolean): void {
  const { sql } = objectStorage();
  sql.exec(
    "CREATE TABLE entries (_id TEXT PRIMARY KEY, sessionId TEXT, entryId TEXT, seq INTEGER)",
  );
  sql.exec(
    "CREATE INDEX idx_entries_sessionId_seq ON entries (sessionId, seq)",
  );
  if (withEntryIndex) {
    sql.exec("CREATE INDEX idx_entries_entryId ON entries (entryId)");
  }
  for (let i = 0; i < 3000; i++) {
    sql.exec(
      "INSERT INTO entries VALUES (?, ?, ?, ?)",
      `r${i}`,
      i < 2700 ? "big" : `s${i % 30}`,
      `e${i}`,
      i,
    );
  }
}

/** The lookup's plan, as an operation of `adapter`. */
async function plan(
  adapter: ReturnType<typeof durableObjectAdapter>,
): Promise<string> {
  const rows = await adapter.rawQuery<{ detail: string }>(
    LOOKUP,
    "big",
    "e1",
    "e2",
  );
  return rows.map((row) => row.detail).join(" | ");
}

const statistics = () =>
  objectStorage()
    .sql.exec("SELECT idx FROM sqlite_stat1 WHERE tbl = 'entries'")
    .toArray()
    .map((row) => row.idx);

/** The object's storage, counting the statistics runs made on it. */
function counted(): { storage: DurableObjectSqlStorage; runs: () => number } {
  const storage = objectStorage();
  let runs = 0;
  const sql = {
    exec(query: string, ...bindings: any[]) {
      if (query === GATHER_STATISTICS) runs++;
      return storage.sql.exec(query, ...bindings);
    },
  };
  return {
    storage: {
      sql,
      transaction: (closure) => storage.transaction(closure),
      transactionSync: (closure) => storage.transactionSync(closure),
    },
    runs: () => runs,
  };
}

describe("Durable Object planner statistics", () => {
  test("an object without statistics gets them before its first operation", async () => {
    seed(true);
    const bare = objectStorage()
      .sql.exec(LOOKUP, "big", "e1", "e2")
      .toArray()
      .map((row) => row.detail)
      .join(" | ");
    expect(bare).toContain("idx_entries_sessionId_seq");
    expect(await plan(durableObjectAdapter(objectStorage()))).toContain(
      "idx_entries_entryId",
    );
  });

  test("a schema change gathers statistics for what it made", async () => {
    seed(false);
    const adapter = durableObjectAdapter(objectStorage());
    await adapter.rawExec(
      "CREATE INDEX idx_entries_entryId ON entries (entryId)",
    );
    expect(await plan(adapter)).toContain("idx_entries_entryId");
    expect(statistics()).toContain("idx_entries_entryId");
  });

  test("a schema change inside a transaction gets its statistics after it, not in it", async () => {
    seed(false);
    const adapter = durableObjectAdapter(objectStorage());
    await adapter.transaction(async () => {
      await adapter.rawExec(
        "CREATE INDEX idx_entries_entryId ON entries (entryId)",
      );
      await plan(adapter);
      expect(statistics()).not.toContain("idx_entries_entryId");
    });
    await plan(adapter);
    expect(statistics()).toContain("idx_entries_entryId");
  });

  test("a wake's migrations gather once, after them", async () => {
    const { storage, runs } = counted();
    const adapter = durableObjectAdapter(storage);
    for (const name of ["a", "b", "c", "d", "e"]) {
      adapter.ensureTable(name, {
        columns: { value: { type: "string", index: true } },
      });
    }
    expect(runs()).toBe(0);
    await adapter.insert("a", { value: "x" });
    await adapter.rawQuery("SELECT * FROM b");
    await adapter.query("c").all();
    expect(runs()).toBe(1);
  });
});
