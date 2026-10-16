/**
 * Storage on a SQLite-backed Cloudflare Durable Object.
 *
 *   export class App extends DurableObject {
 *     vex = Vex.create({
 *       storage: durableObjectAdapter(this.ctx.storage),
 *       plugins: [...],
 *     });
 *   }
 *
 * The object's SQL API is synchronous and in-process. Each transaction
 * runs in `ctx.storage.transaction()`, which holds the object's input
 * gate until it settles: other requests, and other transactions of the
 * same request, wait for it instead of interleaving. The adapter
 * therefore needs none of the Bun adapter's locking or read pool. A
 * transaction nested in another runs as a savepoint, so an inner
 * failure the outer one catches rolls back only the inner writes.
 *
 * The SQL API refuses `BEGIN`, `SAVEPOINT`, TEMP tables and most
 * PRAGMAs; `rawQuery`/`rawExec` surface those refusals as errors.
 */

import { isReadOnlyStatement } from "../core/sql-text.js";
import type { StorageAdapter } from "../core/storage.js";
import type { TableSchema } from "../core/types.js";
import { createQueryBuilder, type DbExec } from "./shared.js";
import {
  bulkInsertRows,
  deleteRow,
  ensureSqliteTable,
  insertRow,
  SqliteAdapterState,
  type SqliteDriver,
  updateRow,
  upsertRow,
} from "./sqlite-core.js";

/**
 * The part of a Durable Object's `ctx.storage` the adapter uses. A
 * SQLite-backed object's `DurableObjectStorage` satisfies it.
 */
export interface DurableObjectSqlStorage {
  readonly sql: {
    exec(query: string, ...bindings: any[]): { toArray(): any[] };
  };
  transaction<T>(closure: () => Promise<T>): Promise<T>;
  transactionSync<T>(closure: () => T): T;
}

export function durableObjectAdapter(
  storage: DurableObjectSqlStorage,
): StorageAdapter {
  const { sql } = storage;
  const run = (query: string, params: any[]): any[] =>
    sql.exec(query, ...params).toArray();
  const driver: SqliteDriver = {
    prepare: (query) => ({
      all: (...params) => run(query, params),
      get: (...params) => run(query, params)[0] ?? null,
      run: (...params) => run(query, params),
    }),
    // `cursor.rowsWritten` also counts index rows and trigger writes, so
    // changes come from SQLite itself.
    changes: () => run("SELECT changes() AS c", [])[0].c,
    exec: (query) => {
      run(query, []);
    },
    atomically: (fn) => storage.transactionSync(fn),
  };

  const state = new SqliteAdapterState();
  // Open transactions, outermost first; inner ones are savepoints. Only
  // the outermost collects the change triggers' flags, at its end.
  let transactionDepth = 0;

  // A write. Inside a transaction its flags wait for that transaction's
  // commit; alone, they are final once it ran, so collect them now. A
  // failed statement may still leave earlier statements of a
  // multi-statement exec applied, so collect regardless.
  function write<T>(fn: () => T): T {
    open();
    try {
      return fn();
    } finally {
      if (transactionDepth === 0) state.collectChanges(driver);
    }
  }

  const exec: DbExec = {
    schemas: state.schemas,
    async all(query, params) {
      open();
      return driver.prepare(query).all(...params);
    },
    async run(query, params) {
      return write(() => {
        driver.prepare(query).run(...params);
        return { changes: driver.changes() };
      });
    },
  };

  let closed = false;
  // The object's storage outlives the adapter; closing only stops this
  // adapter from using it.
  function open(): void {
    if (closed) throw new Error("Durable Object adapter is closed");
  }

  return {
    name: "durable-object",

    ensureTable(name: string, schema: TableSchema) {
      open();
      state.registerSchema(
        name,
        schema,
        ensureSqliteTable(driver, name, schema),
      );
    },

    async insert(table, row) {
      return write(() => insertRow(driver, table, row));
    },

    async upsert(table, keys, data) {
      write(() => upsertRow(driver, table, keys, data));
    },

    async update(table, id, data) {
      write(() => updateRow(driver, table, id, data));
    },

    async delete(table, id) {
      return write(() => deleteRow(driver, table, id) > 0);
    },

    query(table) {
      return createQueryBuilder(exec, table);
    },

    async transaction<T>(fn: () => Promise<T> | T): Promise<T> {
      open();
      return storage.transaction(async () => {
        // Snapshot and restore inside the transaction: it may wait for
        // another one to commit first, and the next may start as soon
        // as this one settles.
        const restore = state.snapshot();
        transactionDepth++;
        try {
          const result = await fn();
          // Inside the outermost transaction, so the cleared flags
          // commit with the writes that set them.
          if (transactionDepth === 1) state.collectChanges(driver);
          return result;
        } catch (error) {
          restore();
          throw error;
        } finally {
          transactionDepth--;
        }
      });
    },

    async rawQuery<T = Record<string, any>>(
      query: string,
      ...params: any[]
    ): Promise<T[]> {
      if (isReadOnlyStatement(query)) {
        open();
        return run(query, params) as T[];
      }
      return write(() => run(query, params) as T[]);
    },

    async rawExec(query: string, ...params: any[]): Promise<void> {
      write(() => run(query, params));
    },

    async bulkInsert(table, rows) {
      write(() => bulkInsertRows(driver, table, rows));
    },

    getChangedTables() {
      return state.takeChanged();
    },

    getSchema(table) {
      return state.schemas.get(table) ?? null;
    },

    close() {
      closed = true;
    },
  };
}
