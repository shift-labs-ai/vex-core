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

import type { StorageAdapter } from "../core/storage.js";
import type { TableSchema } from "../core/types.js";
import { createQueryBuilder, type DbExec } from "./shared.js";
import {
  bulkInsertRows,
  deleteRow,
  ensureSqliteTable,
  insertRow,
  type SqliteDriver,
  snapshotAdapterState,
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
  // `cursor.rowsWritten` also counts index rows, so changes come from
  // SQLite itself.
  const changes = (): number => run("SELECT changes() AS c", [])[0].c;

  const driver: SqliteDriver = {
    prepare: (query) => ({
      all: (...params) => run(query, params),
      get: (...params) => run(query, params)[0] ?? null,
      run: (...params) => {
        run(query, params);
        return { changes: changes() };
      },
    }),
    exec: (query) => {
      run(query, []);
    },
    atomically: (fn) => storage.transactionSync(fn),
  };

  const changedTables = new Set<string>();
  function markChanged(table: string, count: number): void {
    if (count > 0) changedTables.add(table);
  }

  const exec: DbExec = {
    schemas: new Map<string, TableSchema>(),
    markChanged,
    async all(query, params) {
      open();
      return driver.prepare(query).all(...params);
    },
    async run(query, params) {
      open();
      return driver.prepare(query).run(...params);
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
      const renamedFrom = ensureSqliteTable(driver, name, schema);
      if (renamedFrom !== undefined) exec.schemas.delete(renamedFrom);
      exec.schemas.set(name, schema);
    },

    async insert(table, row) {
      open();
      const id = insertRow(driver, table, row);
      markChanged(table, 1);
      return id;
    },

    async upsert(table, keys, data) {
      open();
      markChanged(table, upsertRow(driver, table, keys, data));
    },

    async update(table, id, data) {
      open();
      markChanged(table, updateRow(driver, table, id, data));
    },

    async delete(table, id) {
      open();
      const count = deleteRow(driver, table, id);
      markChanged(table, count);
      return count > 0;
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
        const restore = snapshotAdapterState(changedTables, exec.schemas);
        try {
          return await fn();
        } catch (error) {
          restore();
          throw error;
        }
      });
    },

    async rawQuery<T = Record<string, any>>(
      query: string,
      ...params: any[]
    ): Promise<T[]> {
      open();
      return run(query, params) as T[];
    },

    async rawExec(query: string, ...params: any[]): Promise<void> {
      open();
      run(query, params);
    },

    async bulkInsert(table, rows) {
      open();
      markChanged(table, bulkInsertRows(driver, table, rows));
    },

    getChangedTables() {
      const tables = [...changedTables];
      changedTables.clear();
      return tables;
    },

    getSchema(table) {
      return exec.schemas.get(table) ?? null;
    },

    close() {
      closed = true;
    },
  };
}
