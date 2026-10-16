import { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  isReadOnlyStatement,
  leadingSqlKeyword,
  sqlAfterLeadingComments,
} from "../core/sql-text.js";
import type { StorageAdapter } from "../core/storage.js";
import type { TableSchema } from "../core/types.js";
import { createQueryBuilder, type DbExec } from "./shared.js";
import {
  bulkInsertRows,
  deleteRow,
  ensureSqliteTable,
  insertRow,
  runCounted,
  SqliteAdapterState,
  type SqliteDriver,
  updateRow,
  upsertRow,
} from "./sqlite-core.js";

type PreparedStatement = ReturnType<Database["prepare"]>;

class StatementCache {
  private readonly statements = new Map<string, PreparedStatement>();

  constructor(
    private readonly db: Database,
    private readonly capacity: number,
  ) {}

  prepare(sql: string): PreparedStatement {
    const cached = this.statements.get(sql);
    if (cached) {
      // Map insertion order is the LRU order. Reinsert a hit at the tail.
      this.statements.delete(sql);
      this.statements.set(sql, cached);
      return cached;
    }

    const statement = this.db.prepare(sql);
    this.statements.set(sql, statement);
    if (this.statements.size > this.capacity) {
      const oldestSql = this.statements.keys().next().value;
      if (oldestSql !== undefined) {
        this.statements.get(oldestSql)?.finalize();
        this.statements.delete(oldestSql);
      }
    }
    return statement;
  }

  clear(): void {
    for (const statement of this.statements.values()) statement.finalize();
    this.statements.clear();
  }
}

interface SqliteConnection {
  statements: StatementCache;
}

interface ReadConnection extends SqliteConnection {
  db: Database;
  busy: boolean;
}

interface Waiter<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

const SQLITE_READ_POOL_SIZE = 4;
const SQLITE_STATEMENT_CACHE_SIZE = 64;

function wrapSync(
  writer: SqliteDriver,
  state: SqliteAdapterState,
  write: <T>(fn: () => T) => Promise<T>,
  withReadConnection: <T>(
    fn: (connection: SqliteConnection) => T,
  ) => Promise<T>,
): DbExec {
  return {
    schemas: state.schemas,
    async all(sql, params) {
      return withReadConnection((connection) =>
        params.length > 0
          ? connection.statements.prepare(sql).all(...params)
          : connection.statements.prepare(sql).all(),
      );
    },
    async run(sql, params) {
      return write(() => ({ changes: runCounted(writer, sql, params) }));
    },
  };
}

export interface SqliteOptions {
  busyTimeout?: number;
  cacheSize?: number;
}

function isMemoryDatabase(path: string): boolean {
  return path === ":memory:" || path === "" || path.startsWith("file::memory:");
}

function openReadConnections(
  path: string,
  opts: SqliteOptions | undefined,
): ReadConnection[] {
  if (isMemoryDatabase(path)) return [];

  const connections: ReadConnection[] = [];
  try {
    for (let i = 0; i < SQLITE_READ_POOL_SIZE; i++) {
      const readDb = new Database(path, { readonly: true });
      try {
        readDb.exec(`PRAGMA busy_timeout = ${opts?.busyTimeout ?? 5000}`);
        if (opts?.cacheSize) {
          readDb.exec(`PRAGMA cache_size = ${opts.cacheSize}`);
        }
      } catch (error) {
        readDb.close();
        throw error;
      }
      connections.push({
        db: readDb,
        statements: new StatementCache(readDb, SQLITE_STATEMENT_CACHE_SIZE),
        busy: false,
      });
    }
    return connections;
  } catch (error) {
    for (const connection of connections) connection.db.close();
    throw error;
  }
}

function isReadonlyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "SQLITE_READONLY"
  );
}

function changesConnectionLocalState(sql: string): boolean {
  const statement = sqlAfterLeadingComments(sql);
  return (
    /(?:^|;)\s*(?:ATTACH|DETACH)\b/i.test(statement) ||
    /(?:^|;)\s*CREATE\s+(?:TEMP|TEMPORARY)\b/i.test(statement) ||
    /\btemp\s*\./i.test(statement) ||
    /(?:^|;)\s*PRAGMA\b[^;]*=/i.test(statement)
  );
}

function mayChangeSchema(sql: string): boolean {
  return /(?:^|;)\s*(?:CREATE|ALTER|DROP|REINDEX|VACUUM|ATTACH|DETACH)\b/i.test(
    sqlAfterLeadingComments(sql),
  );
}

export function sqliteAdapter(
  path: string = ":memory:",
  opts?: SqliteOptions,
): StorageAdapter {
  const db = new Database(path);
  let readConnections: ReadConnection[];
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec(`PRAGMA busy_timeout = ${opts?.busyTimeout ?? 5000}`);
    if (opts?.cacheSize) db.exec(`PRAGMA cache_size = ${opts.cacheSize}`);
    // Materialize a brand-new database's schema state before readonly handles
    // open it. Without this read, Bun can return SQLITE_CANTOPEN until the
    // writer executes its first schema-aware statement.
    db.exec("PRAGMA schema_version");
    readConnections = openReadConnections(path, opts);
  } catch (error) {
    db.close();
    throw error;
  }

  const writer: SqliteConnection = {
    statements: new StatementCache(db, SQLITE_STATEMENT_CACHE_SIZE),
  };
  const state = new SqliteAdapterState();
  // The write handle is a single connection. While it has an open
  // BEGIN, every statement on that connection participates in
  // that transaction. Track the async owner so same-call nesting can
  // reuse the connection, while unrelated concurrent calls queue
  // instead of accidentally sharing each other's COMMIT/ROLLBACK.
  const transactionContext = new AsyncLocalStorage<{ active: boolean }>();
  let writeLocked = false;
  const writeWaiters: Array<Waiter<void>> = [];
  const readWaiters: Array<Waiter<ReadConnection>> = [];
  let nextReadConnection = 0;
  let writerReadsRequired = false;
  // True between the writer's BEGIN and its COMMIT or ROLLBACK: a write
  // then belongs to the transaction, whose commit collects its changes.
  let transactionOpen = false;
  let closed = false;

  function closedError(): Error {
    return new Error("SQLite adapter is closed");
  }

  function clearStatementCaches(): void {
    writer.statements.clear();
    for (const connection of readConnections) connection.statements.clear();
  }

  async function acquireWriteLock(): Promise<void> {
    if (closed) throw closedError();
    if (!writeLocked) {
      writeLocked = true;
      return;
    }
    await new Promise<void>((resolve, reject) =>
      writeWaiters.push({ resolve, reject }),
    );
    if (closed) throw closedError();
  }

  function releaseWriteLock(): void {
    if (closed) {
      writeLocked = false;
      return;
    }
    const next = writeWaiters.shift();
    if (next) next.resolve();
    else writeLocked = false;
  }

  function rejectQueuedWork(): void {
    const error = closedError();
    for (const waiter of writeWaiters.splice(0)) waiter.reject(error);
    for (const waiter of readWaiters.splice(0)) waiter.reject(error);
  }

  function acquireReadConnection(): ReadConnection | Promise<ReadConnection> {
    if (closed) throw closedError();
    for (let offset = 0; offset < readConnections.length; offset++) {
      const index = (nextReadConnection + offset) % readConnections.length;
      const connection = readConnections[index];
      if (!connection.busy) {
        connection.busy = true;
        nextReadConnection = (index + 1) % readConnections.length;
        return connection;
      }
    }
    return new Promise((resolve, reject) => {
      readWaiters.push({ resolve, reject });
    });
  }

  function releaseReadConnection(connection: ReadConnection): void {
    if (closed) {
      connection.busy = false;
      return;
    }
    const next = readWaiters.shift();
    if (next) next.resolve(connection);
    else connection.busy = false;
  }

  async function withConnectionLock<T>(fn: () => Promise<T> | T): Promise<T> {
    if (closed) throw closedError();
    const owner = transactionContext.getStore();
    // Genuine same-call nesting: an active transaction owner means
    // we're still inside the BEGIN/COMMIT bracket on this async
    // chain, so we run in-place and ride the existing lock.
    if (owner?.active) return fn();
    // No owner, or an owner whose transaction has already settled
    // (commit or rollback) but whose AsyncLocalStorage context
    // happens to still be visible via setImmediate/detached promise
    // inheritance. Treat as a fresh top-level call: acquire the
    // lock and start our own owner context.
    await acquireWriteLock();
    const context = { active: true };
    try {
      return await transactionContext.run(context, () => fn());
    } finally {
      context.active = false;
      releaseWriteLock();
    }
  }

  // Transaction-owned reads must use the write handle to see uncommitted
  // changes. Connection-local state (TEMP tables, ATTACH, PRAGMAs) also pins
  // reads to that handle. In-memory databases have no shareable backing file.
  function readsUseWriter(): boolean {
    return (
      transactionContext.getStore()?.active === true ||
      writerReadsRequired ||
      readConnections.length === 0
    );
  }

  async function withReadConnection<T>(
    fn: (connection: SqliteConnection) => T,
  ): Promise<T> {
    if (closed) throw closedError();
    if (readsUseWriter()) return withConnectionLock(() => fn(writer));

    const connection = await acquireReadConnection();
    try {
      if (closed) throw closedError();
      return fn(connection);
    } finally {
      releaseReadConnection(connection);
    }
  }

  // Writes and migrations run on the writer, under the connection lock
  // or, for ensureTable, synchronously between awaits.
  const writerDriver: SqliteDriver = {
    prepare: (sql) => writer.statements.prepare(sql),
    // Bun's `run().changes` is the connection's total-changes delta, which
    // also counts rows triggers wrote; SQLite's `changes()` does not.
    changes: () =>
      (
        writer.statements.prepare("SELECT changes() AS c").get() as {
          c: number;
        }
      ).c,
    exec: (sql) => db.exec(sql),
    atomically: (fn) => db.transaction(fn)(),
  };

  // A write on the writer, under the lock. Its triggers' flags are
  // collected where it is final: by the open transaction at commit, or
  // here, after it ran alone. A failed statement may still leave earlier
  // statements of a multi-statement exec applied, so collect regardless.
  function write<T>(fn: () => T): Promise<T> {
    return withConnectionLock(() => {
      try {
        return fn();
      } finally {
        if (!transactionOpen) state.collectChanges(writerDriver);
      }
    });
  }

  const exec = wrapSync(writerDriver, state, write, withReadConnection);

  return {
    name: "sqlite",

    ensureTable(name: string, schema: TableSchema) {
      try {
        state.registerSchema(
          name,
          schema,
          ensureSqliteTable(writerDriver, name, schema),
        );
      } finally {
        // Bun caches each statement's column list at prepare time.
        clearStatementCaches();
      }
    },

    async insert(table: string, row: Record<string, any>): Promise<string> {
      return write(() => insertRow(writerDriver, table, row));
    },

    async upsert(
      table: string,
      keys: Record<string, any>,
      data: Record<string, any>,
    ): Promise<void> {
      await write(() => upsertRow(writerDriver, table, keys, data));
    },

    async update(
      table: string,
      id: string,
      data: Record<string, any>,
    ): Promise<void> {
      await write(() => updateRow(writerDriver, table, id, data));
    },

    async delete(table: string, id: string): Promise<boolean> {
      return write(() => deleteRow(writerDriver, table, id) > 0);
    },

    query(table: string) {
      return createQueryBuilder(exec, table);
    },

    async transaction<T>(fn: () => Promise<T> | T): Promise<T> {
      if (closed) throw closedError();
      const owner = transactionContext.getStore();
      // Same rule as withConnectionLock: only join the outer BEGIN
      // when the owner is still active. A stale owner (parent
      // already committed/rolled back) falls through and opens its
      // own top-level transaction.
      if (owner?.active) return fn();

      await acquireWriteLock();
      const context = { active: true };
      const restore = state.snapshot();
      db.exec("BEGIN");
      transactionOpen = true;
      try {
        const result = await transactionContext.run(context, () => fn());
        // Inside the transaction, so the cleared flags commit with the
        // writes that set them.
        state.collectChanges(writerDriver);
        db.exec("COMMIT");
        return result;
      } catch (e) {
        db.exec("ROLLBACK");
        restore();
        throw e;
      } finally {
        transactionOpen = false;
        context.active = false;
        releaseWriteLock();
      }
    },

    async rawQuery<T = Record<string, any>>(
      sql: string,
      ...params: any[]
    ): Promise<T[]> {
      // A WITH statement can terminate in SELECT or in DML. Bun does not
      // expose sqlite3_stmt_readonly(), so a readonly pool connection
      // classifies it: its readonly failure retries as a write. Where reads
      // would run on the writer anyway, it is a write from the start, so
      // its changes are collected.
      const ambiguous = leadingSqlKeyword(sql) === "WITH";
      if (isReadOnlyStatement(sql) || (ambiguous && !readsUseWriter())) {
        try {
          return await withReadConnection(
            (connection) =>
              connection.statements.prepare(sql).all(...params) as T[],
          );
        } catch (error: unknown) {
          if (!ambiguous || !isReadonlyError(error)) throw error;
        }
      }
      return write(() => {
        const rows = writer.statements.prepare(sql).all(...params) as T[];
        if (changesConnectionLocalState(sql)) writerReadsRequired = true;
        if (mayChangeSchema(sql)) clearStatementCaches();
        return rows;
      });
    },

    async rawExec(sql: string, ...params: any[]): Promise<void> {
      await write(() => {
        if (params.length > 0) {
          writer.statements.prepare(sql).run(...params);
        } else {
          db.exec(sql);
        }
        if (
          leadingSqlKeyword(sql) === "PRAGMA" ||
          changesConnectionLocalState(sql)
        ) {
          writerReadsRequired = true;
        }
        if (mayChangeSchema(sql)) clearStatementCaches();
      });
    },

    async bulkInsert(
      table: string,
      rows: Record<string, any>[],
    ): Promise<void> {
      await write(() => bulkInsertRows(writerDriver, table, rows));
    },

    getChangedTables(): string[] {
      return state.takeChanged();
    },

    getSchema(table: string) {
      return state.schemas.get(table) ?? null;
    },

    close() {
      if (closed) return;
      closed = true;
      rejectQueuedWork();
      writer.statements.clear();
      for (const connection of readConnections) {
        connection.statements.clear();
        connection.db.close();
      }
      db.close();
    },
  };
}
