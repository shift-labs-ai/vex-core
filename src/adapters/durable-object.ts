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

import {
  mayChangeSchema,
  parameterCount,
  statementKind,
} from "../core/sql-text.js";
import type { StorageAdapter } from "../core/storage.js";
import type { TableSchema } from "../core/types.js";
import { createQueryBuilder, type DbExec } from "./shared.js";
import {
  bulkInsertRows,
  deleteRow,
  type ExplainRow,
  ensureSqliteTable,
  insertRow,
  runCounted,
  SqliteAdapterState,
  type SqliteDriver,
  type SqliteIntrospection,
  updateRow,
  upsertRow,
} from "./sqlite-core.js";

/**
 * The part of a Durable Object's `ctx.storage` the adapter uses. A
 * SQLite-backed object's `DurableObjectStorage` satisfies it.
 */
export interface DurableObjectSqlStorage {
  readonly sql: {
    exec(
      query: string,
      ...bindings: any[]
    ): { toArray(): any[]; readonly rowsWritten: number };
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
  const value = (query: string): number =>
    Object.values(run(query, [])[0] as Record<string, number>)[0];
  // Each EXPLAIN gets text never used before: workerd caches statements
  // by text, and re-running a cached EXPLAIN after its table was dropped
  // and recreated crashes the runtime. The SQL API also wants every
  // parameter bound, even to compile.
  let explained = 0;
  const introspection: SqliteIntrospection = {
    explain: (statement) =>
      run(
        `EXPLAIN ${statement}\n/* vex ${++explained} */`,
        new Array(parameterCount(statement)).fill(null),
      ) as ExplainRow[],
    rootPages: () =>
      run(
        "SELECT rootpage, tbl_name FROM sqlite_master WHERE rootpage > 0",
        [],
      ),
  };
  const state = new SqliteAdapterState();

  // Migrations' bookkeeping writes are not changes anyone subscribes to.
  const migrationDriver: SqliteDriver = {
    prepare: (query) => ({
      all: (...params) => run(query, params),
      get: (...params) => run(query, params)[0] ?? null,
      run: (...params) => run(query, params),
    }),
    // `cursor.rowsWritten` also counts index rows and trigger writes, so
    // changes come from SQLite itself.
    changes: () => value("SELECT changes()"),
    exec: (query) => {
      run(query, []);
    },
    atomically: (fn) => storage.transactionSync(fn),
  };
  // A row write that wrote anything, its triggers' rows included, marks
  // the tables it writes.
  const driver: SqliteDriver = {
    ...migrationDriver,
    prepare: (query) => ({
      ...migrationDriver.prepare(query),
      run: (...params) => {
        const { tables, direct } = state.written(introspection, query);
        const cursor = sql.exec(query, ...params);
        cursor.toArray();
        if (cursor.rowsWritten > 0) state.markChanged(tables, direct);
      },
    }),
  };

  // Raw SQL. A single row write is counted by its cursor; text that may
  // hold several statements, whose cursor counts only the last one's
  // rows, by the connection's total changes.
  function rawWrite<T>(query: string, params: any[]): T[] {
    if (statementKind(query) === "write") {
      const { tables, statements } = state.written(introspection, query);
      if (statements === 1) {
        const cursor = sql.exec(query, ...params);
        const rows = cursor.toArray();
        if (cursor.rowsWritten > 0) state.markChanged(tables, false);
        return rows as T[];
      }
    }
    const before = value("SELECT total_changes()");
    try {
      return run(query, params) as T[];
    } finally {
      if (mayChangeSchema(query)) state.schemaChanged();
      if (value("SELECT total_changes()") > before) {
        state.markChanged(state.written(introspection, query).tables, false);
      }
    }
  }

  // Open transactions, outermost first; inner ones are savepoints. The
  // outermost one's writes wait in the adapter state until it commits.
  let transactionDepth = 0;

  const exec: DbExec = {
    schemas: state.schemas,
    async all(query, params) {
      open();
      return driver.prepare(query).all(...params);
    },
    async run(query, params) {
      open();
      return { changes: runCounted(driver, query, params) };
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
        ensureSqliteTable(migrationDriver, name, schema),
      );
    },

    async insert(table, row) {
      open();
      return insertRow(driver, table, row);
    },

    async upsert(table, keys, data) {
      open();
      upsertRow(driver, table, keys, data);
    },

    async update(table, id, data) {
      open();
      updateRow(driver, table, id, data);
    },

    async delete(table, id) {
      open();
      return deleteRow(driver, table, id) > 0;
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
        if (++transactionDepth === 1) state.begin();
        try {
          const result = await fn();
          if (transactionDepth === 1) state.commit();
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
      open();
      if (statementKind(query) === "read") return run(query, params) as T[];
      return rawWrite<T>(query, params);
    },

    async rawExec(query: string, ...params: any[]): Promise<void> {
      open();
      rawWrite(query, params);
    },

    async bulkInsert(table, rows) {
      open();
      bulkInsertRows(driver, table, rows);
    },

    // The object is its database's only writer.
    getChangedTables() {
      return state.takeChanged().tables;
    },

    takeChanges() {
      return state.takeChanged();
    },

    tablesRead(query: string) {
      open();
      return state.tablesRead(introspection, query);
    },

    getSchema(table) {
      return state.schemas.get(table) ?? null;
    },

    close() {
      closed = true;
    },
  };
}
