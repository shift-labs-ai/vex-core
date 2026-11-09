import { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  leadingSqlKeyword,
  mayChangeSchema,
  sqlAfterLeadingComments,
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
  existingTableName,
  GATHER_STATISTICS,
  insertRow,
  runCounted,
  SqliteAdapterState,
  type SqliteDriver,
  type SqliteIntrospection,
  type SqliteStatement,
  updateRow,
  upsertRow,
  type WriteAnalysis,
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
  /**
   * Planner statistics changed since it opened. A connection reads
   * `sqlite_stat1` once, when it opens, so it is reopened before its
   * next use.
   */
  stale: boolean;
}

interface Waiter<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

const SQLITE_READ_POOL_SIZE = 4;
const SQLITE_STATEMENT_CACHE_SIZE = 64;
/** How often planner statistics are refreshed while the adapter is open. */
const SQLITE_STATISTICS_INTERVAL_MS = 60 * 60 * 1000;

function wrapSync(
  writer: SqliteDriver,
  state: SqliteAdapterState,
  withConnectionLock: <T>(fn: () => Promise<T> | T) => Promise<T>,
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
      return withConnectionLock(() => ({
        changes: runCounted(writer, sql, params),
      }));
    },
  };
}

export interface SqliteOptions {
  busyTimeout?: number;
  cacheSize?: number;
  /**
   * How often planner statistics are refreshed, in ms; an hour unless
   * set. They are also gathered at open and after every schema change.
   */
  statisticsIntervalMs?: number;
  /**
   * Open the database to read only: another adapter owns its writes
   * and its schema. `ensureTable` registers each table's schema and
   * refuses one the database lacks; every write refuses; planner
   * statistics are read, never gathered. What the other adapter
   * commits is visible to each read after it.
   */
  readonly?: boolean;
}

function isMemoryDatabase(path: string): boolean {
  return path === ":memory:" || path === "" || path.startsWith("file::memory:");
}

/** One read-only connection to `path`, with the adapter's pragmas. */
function openReadDatabase(
  path: string,
  opts: SqliteOptions | undefined,
): Database {
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
  return readDb;
}

function openReadConnections(
  path: string,
  opts: SqliteOptions | undefined,
): ReadConnection[] {
  if (isMemoryDatabase(path)) return [];

  const connections: ReadConnection[] = [];
  try {
    for (let i = 0; i < SQLITE_READ_POOL_SIZE; i++) {
      const readDb = openReadDatabase(path, opts);
      connections.push({
        db: readDb,
        statements: new StatementCache(readDb, SQLITE_STATEMENT_CACHE_SIZE),
        busy: false,
        stale: false,
      });
    }
    return connections;
  } catch (error) {
    for (const connection of connections) connection.db.close();
    throw error;
  }
}

/**
 * The planner statistics `db` holds: `sqlite_stat1`, which `ANALYZE`
 * creates, or nothing before the first.
 */
function plannerStatistics(db: Database): string {
  const analyzed = db
    .query("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_stat1'")
    .get();
  if (!analyzed) return "";
  return JSON.stringify(
    db.query("SELECT tbl, idx, stat FROM sqlite_stat1 ORDER BY tbl, idx").all(),
  );
}

/**
 * Gather the planner statistics `db` lacks or has let go stale
 * (`GATHER_STATISTICS`); answers whether they changed.
 */
function gatherStatistics(db: Database): boolean {
  const before = plannerStatistics(db);
  db.exec(GATHER_STATISTICS);
  return plannerStatistics(db) !== before;
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

export function sqliteAdapter(
  path: string = ":memory:",
  opts?: SqliteOptions,
): StorageAdapter {
  const readonly = opts?.readonly === true;
  const db = readonly ? openReadDatabase(path, opts) : new Database(path);
  let readConnections: ReadConnection[];
  try {
    if (!readonly) {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL");
      db.exec(`PRAGMA busy_timeout = ${opts?.busyTimeout ?? 5000}`);
      if (opts?.cacheSize) db.exec(`PRAGMA cache_size = ${opts.cacheSize}`);
      // Materialize a brand-new database's schema state before readonly handles
      // open it. Without this read, Bun can return SQLITE_CANTOPEN until the
      // writer executes its first schema-aware statement.
      db.exec("PRAGMA schema_version");
      // Before the read pool opens, so each of its connections starts
      // with them.
      gatherStatistics(db);
    }
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

  // A connection reads planner statistics only as it opens: one opened
  // before they changed is reopened before its next use.
  function current(connection: ReadConnection): ReadConnection {
    if (!connection.stale) return connection;
    connection.statements.clear();
    connection.db.close();
    connection.db = openReadDatabase(path, opts);
    connection.statements = new StatementCache(
      connection.db,
      SQLITE_STATEMENT_CACHE_SIZE,
    );
    connection.stale = false;
    return connection;
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

  // A read on the pool: on a connection reopened first when stale, and
  // released after, however the read or the reopen ends. A connection
  // that cannot reopen stays stale and tries again on its next read.
  async function onReadConnection<T>(
    fn: (connection: ReadConnection) => T,
  ): Promise<T> {
    const connection = await acquireReadConnection();
    try {
      if (closed) throw closedError();
      return fn(current(connection));
    } finally {
      releaseReadConnection(connection);
    }
  }

  // Planner statistics, kept current: gathered at open (above), after
  // each schema change, and every `statisticsIntervalMs`. A change
  // reopens the read pool's connections. Each run takes the write lock
  // outside any caller's transaction, so its ANALYZE commits alone.
  let statisticsDue: ReturnType<typeof setTimeout> | undefined;
  async function refreshStatistics(): Promise<void> {
    if (readonly) return;
    try {
      const changed = await withConnectionLock(() => gatherStatistics(db));
      if (changed) {
        for (const connection of readConnections) connection.stale = true;
      }
    } catch (error) {
      if (!closed) {
        console.error("[vex] gathering SQLite statistics failed:", error);
      }
    }
  }
  // Once the schema changes in this turn are done: a migration run
  // registers its tables one after another.
  function statisticsAfterSchemaChange(): void {
    if (statisticsDue || closed || readonly) return;
    statisticsDue = transactionContext.exit(() =>
      setTimeout(() => {
        statisticsDue = undefined;
        void refreshStatistics();
      }, 0),
    );
  }
  const statisticsTimer = transactionContext.exit(() =>
    setInterval(
      () => void refreshStatistics(),
      opts?.statisticsIntervalMs ?? SQLITE_STATISTICS_INTERVAL_MS,
    ),
  );
  // A timer of the adapter's own never keeps a process alive.
  statisticsTimer.unref?.();

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
    return onReadConnection(fn);
  }

  // Shows a statement's compiled program on `connection` without running
  // it, or caching the EXPLAIN among the connection's hot statements.
  function introspection(connection: Database): SqliteIntrospection {
    const all = (sql: string) => {
      const statement = connection.prepare(sql);
      try {
        return statement.all();
      } finally {
        statement.finalize();
      }
    };
    return {
      explain: (statement) => all(`EXPLAIN ${statement}`) as ExplainRow[],
      rootPages: () =>
        all(
          "SELECT rootpage, tbl_name FROM sqlite_master WHERE rootpage > 0",
        ) as { rootpage: number; tbl_name: string }[],
    };
  }
  const writerIntrospection = introspection(db);

  // Counters read around writes: prepared once, outside the LRU cache of
  // the connection's SQL. Bun's `run().changes` is the connection's
  // total-changes delta, which also counts rows triggers and foreign-key
  // actions wrote; SQLite's `changes()` counts the statement's own rows.
  const counters = {
    own: db.prepare("SELECT changes() AS value"),
    total: db.prepare("SELECT total_changes() AS value"),
    dataVersion: db.prepare("PRAGMA data_version"),
  };
  const ownChanges = () => (counters.own.get() as { value: number }).value;
  const totalChanges = () => (counters.total.get() as { value: number }).value;
  // Another connection can only commit to a database with a file, or a
  // shared-cache memory one; a private memory database has no other.
  const dataVersion = () =>
    path === ":memory:" || path === ""
      ? undefined
      : (counters.dataVersion.get() as { data_version: number }).data_version;

  // Migrations run on the writer, synchronously between awaits; their
  // bookkeeping writes are not changes anyone subscribes to.
  const migrationDriver: SqliteDriver = {
    prepare: (sql) => writer.statements.prepare(sql),
    changes: ownChanges,
    exec: (sql) => db.exec(sql),
    atomically: (fn) => db.transaction(fn)(),
  };
  // Row writes run on the writer under the connection lock. Each prepared
  // statement gets one tracked form, holding what it writes for the
  // current schema: a write that changed any row, or any its triggers
  // wrote, marks those tables.
  interface TrackedStatement extends SqliteStatement {
    /** Runs raw SQL that is one statement. */
    runRaw(...params: any[]): void;
    /** Runs raw SQL that is a single INSERT, UPDATE, DELETE or REPLACE,
     *  for its rows. */
    allWritten(...params: any[]): any[];
  }
  const tracked = new WeakMap<PreparedStatement, TrackedStatement>();
  function trackedStatement(
    sql: string,
    statement: PreparedStatement,
  ): TrackedStatement {
    let epoch = -1;
    let analysis: WriteAnalysis = {
      tables: null,
      direct: false,
      statements: 0,
    };
    const returnsRows = statement.columnNames.length > 0;
    // Before running: compiling for analysis resets `changes()`.
    const analyzed = () => {
      if (epoch !== state.epoch) {
        analysis = state.written(writerIntrospection, sql);
        epoch = state.epoch;
      }
      return analysis;
    };
    return {
      all: (...params) => statement.all(...params),
      get: (...params) => statement.get(...params),
      run: (...params) => {
        const { tables, direct } = analyzed();
        // The connection's total-changes delta: the statement's own rows
        // when no trigger or foreign-key action ran in it.
        const { changes } = statement.run(...params);
        if (changes > 0) state.markChanged(tables, direct);
        return direct ? changes : undefined;
      },
      runRaw: (...params) => {
        const { tables } = analyzed();
        if (statement.run(...params).changes > 0) {
          state.markChanged(tables, false);
        }
      },
      allWritten: (...params) => {
        const { tables } = analyzed();
        // Without RETURNING there are no rows to read, and `run()` counts
        // the changes for free.
        if (!returnsRows) {
          if (statement.run(...params).changes > 0) {
            state.markChanged(tables, false);
          }
          return [];
        }
        const rows = statement.all(...params);
        // Its triggers only run for rows it changed itself.
        if (ownChanges() > 0) state.markChanged(tables, false);
        return rows;
      },
    };
  }
  function trackedPrepare(sql: string): TrackedStatement {
    const statement = writer.statements.prepare(sql);
    let entry = tracked.get(statement);
    if (entry === undefined) {
      entry = trackedStatement(sql, statement);
      tracked.set(statement, entry);
    }
    return entry;
  }
  const writerDriver: SqliteDriver = {
    ...migrationDriver,
    prepare: trackedPrepare,
  };

  // Raw SQL on the writer: what it changed comes from the connection's
  // total changes, since a raw statement may run as several.
  function rawWrite<T>(sql: string, run: () => T): T {
    const before = totalChanges();
    try {
      return run();
    } finally {
      if (mayChangeSchema(sql)) {
        clearStatementCaches();
        state.schemaChanged();
        statisticsAfterSchemaChange();
      }
      if (totalChanges() > before) {
        state.markChanged(
          state.written(writerIntrospection, sql).tables,
          false,
        );
      }
    }
  }

  const exec = wrapSync(
    writerDriver,
    state,
    withConnectionLock,
    withReadConnection,
  );
  // The baseline other connections' commits are measured from.
  state.takeChanges(dataVersion());

  // Compiles a read on the connection it would run on.
  async function analyzeRead<T>(
    analyze: (on: SqliteIntrospection) => T,
  ): Promise<T> {
    if (readsUseWriter()) {
      return withConnectionLock(() => analyze(writerIntrospection));
    }
    return onReadConnection((connection) =>
      analyze(introspection(connection.db)),
    );
  }

  function readOnlyError(): Error {
    return new Error("SQLite adapter is read-only");
  }

  return {
    name: "sqlite",

    ensureTable(name: string, schema: TableSchema) {
      if (readonly) {
        if (existingTableName(migrationDriver, name) === undefined) {
          throw new Error(
            `table ${JSON.stringify(name)} does not exist: a read-only adapter migrates nothing`,
          );
        }
        state.registerSchema(name, schema, undefined);
        clearStatementCaches();
        return;
      }
      try {
        state.registerSchema(
          name,
          schema,
          ensureSqliteTable(migrationDriver, name, schema),
        );
      } finally {
        // Bun caches each statement's column list at prepare time.
        clearStatementCaches();
        statisticsAfterSchemaChange();
      }
    },

    async insert(table: string, row: Record<string, any>): Promise<string> {
      if (readonly) throw readOnlyError();
      return withConnectionLock(() => insertRow(writerDriver, table, row));
    },

    async upsert(
      table: string,
      keys: Record<string, any>,
      data: Record<string, any>,
      id?: string,
    ): Promise<void> {
      if (readonly) throw readOnlyError();
      await withConnectionLock(() =>
        upsertRow(writerDriver, table, keys, data, id),
      );
    },

    async update(
      table: string,
      id: string,
      data: Record<string, any>,
    ): Promise<void> {
      if (readonly) throw readOnlyError();
      await withConnectionLock(() => updateRow(writerDriver, table, id, data));
    },

    async delete(table: string, id: string): Promise<boolean> {
      if (readonly) throw readOnlyError();
      return withConnectionLock(() => deleteRow(writerDriver, table, id) > 0);
    },

    query(table: string) {
      return createQueryBuilder(exec, table);
    },

    async transaction<T>(fn: () => Promise<T> | T): Promise<T> {
      if (readonly) throw readOnlyError();
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
      state.begin();
      try {
        const result = await transactionContext.run(context, () => fn());
        db.exec("COMMIT");
        state.commit();
        return result;
      } catch (e) {
        db.exec("ROLLBACK");
        restore();
        throw e;
      } finally {
        context.active = false;
        releaseWriteLock();
      }
    },

    // Open on this call only while its owner is: a call that merely
    // inherits a settled owner's context, or none, writes in autocommit.
    afterCommit(release: () => void): void {
      if (transactionContext.getStore()?.active === true) {
        state.deferRelease(release);
      } else {
        release();
      }
    },

    async rawQuery<T = Record<string, any>>(
      sql: string,
      ...params: any[]
    ): Promise<T[]> {
      // A WITH statement can terminate in SELECT or in DML. Bun does not
      // expose sqlite3_stmt_readonly(), so a readonly pool connection
      // classifies it: its readonly failure retries as a write. Where reads
      // would run on the writer anyway, it runs as a write from the start,
      // so what it changes is tracked.
      const kind = statementKind(sql);
      const ambiguous = kind === "with";
      if (kind === "read" || (ambiguous && !readsUseWriter())) {
        try {
          return await withReadConnection(
            (connection) =>
              connection.statements.prepare(sql).all(...params) as T[],
          );
        } catch (error: unknown) {
          if (!ambiguous || !isReadonlyError(error)) throw error;
        }
      }
      return withConnectionLock(() => {
        if (changesConnectionLocalState(sql)) writerReadsRequired = true;
        // A prepared statement runs alone, so a row write here is one.
        if (kind === "write") {
          return trackedPrepare(sql).allWritten(...params) as T[];
        }
        return rawWrite(
          sql,
          () => writer.statements.prepare(sql).all(...params) as T[],
        );
      });
    },

    async rawExec(sql: string, ...params: any[]): Promise<void> {
      if (readonly) throw readOnlyError();
      await withConnectionLock(() => {
        if (
          leadingSqlKeyword(sql) === "PRAGMA" ||
          changesConnectionLocalState(sql)
        ) {
          writerReadsRequired = true;
        }
        // Bound, it runs as one prepared statement; unbound, as one when it
        // is a single row write.
        if (
          params.length > 0
            ? !mayChangeSchema(sql)
            : statementKind(sql) === "write" &&
              state.written(writerIntrospection, sql).statements === 1
        ) {
          trackedPrepare(sql).runRaw(...params);
        } else {
          rawWrite(sql, () =>
            params.length > 0
              ? writer.statements.prepare(sql).run(...params)
              : db.exec(sql),
          );
        }
      });
    },

    async bulkInsert(
      table: string,
      rows: Record<string, any>[],
    ): Promise<void> {
      if (readonly) throw readOnlyError();
      await withConnectionLock(() => bulkInsertRows(writerDriver, table, rows));
    },

    takeChanges() {
      return state.takeChanges(dataVersion());
    },

    writesPending() {
      return writeLocked || writeWaiters.length > 0;
    },

    tablesRead(sql: string) {
      const cached = state.cachedTablesRead(sql);
      if (cached !== undefined) return cached ?? undefined;
      return analyzeRead((on) => state.tablesRead(on, sql));
    },

    readOnlyTables(sql: string) {
      return analyzeRead((on) => state.readOnlyTables(on, sql));
    },

    getSchema(table: string) {
      return state.schemas.get(table) ?? null;
    },

    close() {
      if (closed) return;
      closed = true;
      clearInterval(statisticsTimer);
      clearTimeout(statisticsDue);
      rejectQueuedWork();
      writer.statements.clear();
      for (const counter of Object.values(counters)) counter.finalize();
      for (const connection of readConnections) {
        connection.statements.clear();
        connection.db.close();
      }
      db.close();
    },
  };
}
