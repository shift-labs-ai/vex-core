import { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { id as generateId } from "../core/id.js";
import type { StorageAdapter } from "../core/storage.js";
import type { TableSchema } from "../core/types.js";
import {
  buildInsertSql,
  buildUpdateSql,
  createQueryBuilder,
  type DbExec,
  quoteIdent,
  serializeValue,
} from "./shared.js";

interface ExpectedIndex {
  columns: string[];
  unique: boolean;
}

interface ExistingColumn {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

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

const SQLITE_INDEX_METADATA_TABLE = "__vex_sqlite_indexes";
const SQLITE_READ_POOL_SIZE = 4;
const SQLITE_STATEMENT_CACHE_SIZE = 64;

function toSqlType(type: TableSchema["columns"][string]["type"]): string {
  switch (type) {
    case "number":
      return "REAL";
    case "boolean":
      return "INTEGER";
    default:
      return "TEXT";
  }
}

function getIndexColumns(db: Database, indexName: string): string[] {
  const rows = db
    .prepare(`PRAGMA index_info(${quoteIdent(indexName)})`)
    .all() as {
    seqno: number;
    name: string;
  }[];
  return rows.sort((a, b) => a.seqno - b.seqno).map((row) => row.name);
}

function sameColumns(left: string[], right: string[]): boolean {
  return (
    left.length === right.length && left.every((col, i) => col === right[i])
  );
}

function sqlLiteral(value: any): string {
  const serialized = serializeValue(value);
  if (serialized === null) return "NULL";
  if (typeof serialized === "number") return String(serialized);
  return `'${String(serialized).replaceAll("'", "''")}'`;
}

function defaultLiteral(colDef: TableSchema["columns"][string]): string | null {
  return colDef.default !== undefined ? sqlLiteral(colDef.default) : null;
}

function defaultSql(colDef: TableSchema["columns"][string]): string {
  const literal = defaultLiteral(colDef);
  return literal !== null ? ` DEFAULT ${literal}` : "";
}

function columnNeedsRebuild(
  col: ExistingColumn,
  colDef: TableSchema["columns"][string],
): boolean {
  const expectedType = toSqlType(colDef.type).toUpperCase();
  const actualType = (col.type || "TEXT").toUpperCase();
  const expectedRequired = !colDef.optional;
  const actualRequired = col.notnull === 1;
  return (
    actualType !== expectedType ||
    actualRequired !== expectedRequired ||
    col.dflt_value !== defaultLiteral(colDef)
  );
}

function columnSql(
  colName: string,
  colDef: TableSchema["columns"][string],
): string {
  const sqlType = toSqlType(colDef.type);
  const nullable = colDef.optional ? "" : " NOT NULL";
  return `${quoteIdent(colName)} ${sqlType}${nullable}${defaultSql(colDef)}`;
}

function migratedColumnSql(
  colName: string,
  colDef: TableSchema["columns"][string],
  enforceRequired: boolean,
): string {
  const sqlType = toSqlType(colDef.type);
  const nullable = !colDef.optional && enforceRequired ? " NOT NULL" : "";
  return `${quoteIdent(colName)} ${sqlType}${nullable}${defaultSql(colDef)}`;
}

function existingColumnSql(col: ExistingColumn): string {
  const sqlType = col.type || "TEXT";
  const nullable = col.notnull === 1 ? " NOT NULL" : "";
  const defaultValue =
    col.dflt_value !== null ? ` DEFAULT ${col.dflt_value}` : "";
  return `${quoteIdent(col.name)} ${sqlType}${nullable}${defaultValue}`;
}

function validateTableName(name: string): void {
  if (name.toLowerCase() === SQLITE_INDEX_METADATA_TABLE) {
    throw new Error(
      `reserved SQLite metadata table name: ${SQLITE_INDEX_METADATA_TABLE}`,
    );
  }
  if (name.toLowerCase().startsWith("sqlite_")) {
    throw new Error(`reserved SQLite internal table name: ${quoteIdent(name)}`);
  }
}

function validateTableNameAvailability(db: Database, name: string): void {
  const existing = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND lower(name) = lower(?) AND name != ? LIMIT 1",
    )
    .get(name, name) as { name: string } | null;
  if (existing) {
    throw new Error(
      `table name already exists with different casing: ${quoteIdent(existing.name)}`,
    );
  }
}

function validateColumns(name: string, schema: TableSchema): void {
  const columnNames = new Set<string>();
  for (const colName of Object.keys(schema.columns)) {
    const normalizedColName = colName.toLowerCase();
    if (normalizedColName === "_id") {
      throw new Error(
        `reserved column name ${quoteIdent(colName)} on table ${quoteIdent(name)}`,
      );
    }
    if (columnNames.has(normalizedColName)) {
      throw new Error(
        `duplicate column name ${quoteIdent(colName)} on table ${quoteIdent(name)}`,
      );
    }
    columnNames.add(normalizedColName);
  }
}

function validateIndexColumns(name: string, schema: TableSchema): void {
  const columnNames = new Set(["_id", ...Object.keys(schema.columns)]);
  const generatedColumnIndexNames = new Map<string, string>();
  for (const [colName, colDef] of Object.entries(schema.columns)) {
    if (colDef.index) {
      const idxName = `idx_${name}_${colName}`;
      generatedColumnIndexNames.set(idxName.toLowerCase(), idxName);
    }
  }
  const explicitIndexNames = new Set<string>();
  for (const [idxName, idxCols] of schema.indexes ?? []) {
    const normalizedIdxName = idxName.toLowerCase();
    if (explicitIndexNames.has(normalizedIdxName)) {
      throw new Error(
        `duplicate explicit index name ${quoteIdent(idxName)} on table ${quoteIdent(name)}`,
      );
    }
    explicitIndexNames.add(normalizedIdxName);
    const generatedColumnIdxName =
      generatedColumnIndexNames.get(normalizedIdxName);
    if (generatedColumnIdxName && generatedColumnIdxName !== idxName) {
      throw new Error(
        `explicit index name collides with generated column index name ${quoteIdent(generatedColumnIdxName)} on table ${quoteIdent(name)}`,
      );
    }
    if (idxName.toLowerCase().startsWith("sqlite_")) {
      throw new Error(
        `reserved SQLite internal index name ${quoteIdent(idxName)} on table ${quoteIdent(name)}`,
      );
    }
    if (idxCols.length === 0) {
      throw new Error(
        `index must include at least one column: ${quoteIdent(idxName)} on table ${quoteIdent(name)}`,
      );
    }
    for (const colName of idxCols) {
      if (!columnNames.has(colName)) {
        throw new Error(
          `unknown index column ${quoteIdent(colName)} for index ${quoteIdent(idxName)} on table ${quoteIdent(name)}`,
        );
      }
    }
  }
  const generatedUniqueNames = new Set<string>();
  for (const uniqueCols of schema.unique ?? []) {
    if (uniqueCols.length === 0) {
      throw new Error(
        `unique index must include at least one column on table ${quoteIdent(name)}`,
      );
    }
    for (const colName of uniqueCols) {
      if (!columnNames.has(colName)) {
        throw new Error(
          `unknown index column ${quoteIdent(colName)} for unique index on table ${quoteIdent(name)}`,
        );
      }
    }
    const idxName = `uq_${name}_${uniqueCols.join("_")}`;
    const normalizedIdxName = idxName.toLowerCase();
    if (generatedUniqueNames.has(normalizedIdxName)) {
      throw new Error(
        `duplicate generated unique index name ${quoteIdent(idxName)} on table ${quoteIdent(name)}`,
      );
    }
    if (explicitIndexNames.has(normalizedIdxName)) {
      throw new Error(
        `explicit index name collides with generated unique index name ${quoteIdent(idxName)} on table ${quoteIdent(name)}`,
      );
    }
    generatedUniqueNames.add(normalizedIdxName);
  }
}

function expectedIndexDefinitions(
  name: string,
  schema: TableSchema,
): Map<string, ExpectedIndex> {
  const expectedIndexes = new Map<string, ExpectedIndex>();
  for (const [colName, colDef] of Object.entries(schema.columns)) {
    if (colDef.index) {
      expectedIndexes.set(`idx_${name}_${colName}`, {
        columns: [colName],
        unique: false,
      });
    }
  }
  for (const [idxName, idxCols] of schema.indexes ?? []) {
    expectedIndexes.set(idxName, { columns: idxCols, unique: false });
  }
  for (const uniqueCols of schema.unique ?? []) {
    expectedIndexes.set(`uq_${name}_${uniqueCols.join("_")}`, {
      columns: uniqueCols,
      unique: true,
    });
  }
  return expectedIndexes;
}

function validateIndexNameAvailability(
  db: Database,
  name: string,
  expectedIndexes: Map<string, ExpectedIndex>,
): void {
  for (const idxName of expectedIndexes.keys()) {
    const existing = db
      .prepare(
        "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND lower(name) = lower(?)",
      )
      .get(idxName) as { name: string; tbl_name: string } | null;
    if (existing && existing.tbl_name !== name) {
      throw new Error(
        `index name already exists on another table: ${quoteIdent(existing.name)} on ${quoteIdent(existing.tbl_name)}`,
      );
    }
  }
}

function createTableSql(
  name: string,
  schema: TableSchema,
  extraColumns: ExistingColumn[] = [],
): string {
  const colDefs = ["_id TEXT PRIMARY KEY"];
  for (const [colName, colDef] of Object.entries(schema.columns)) {
    colDefs.push(columnSql(colName, colDef));
  }
  for (const col of extraColumns) {
    if (col.name !== "_id" && !(col.name in schema.columns)) {
      colDefs.push(existingColumnSql(col));
    }
  }
  return `CREATE TABLE ${quoteIdent(name)} (${colDefs.join(", ")})`;
}

function sqliteObjectExists(db: Database, name: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE lower(name) = lower(?) LIMIT 1")
    .get(name) as { 1: number } | null;
  return row !== null;
}

function rebuildTempTableName(db: Database, name: string): string {
  const base = `__vex_rebuild_${name}_${Date.now()}`;
  let candidate = base;
  let counter = 0;
  while (sqliteObjectExists(db, candidate)) {
    counter++;
    candidate = `${base}_${counter}`;
  }
  return candidate;
}

function rebuildTable(
  db: Database,
  name: string,
  schema: TableSchema,
  existingColumns: ExistingColumn[],
  copyData: boolean,
): void {
  const recordedIndexes = db
    .prepare('SELECT "name" FROM "__vex_sqlite_indexes" WHERE "table" = ?')
    .all(name) as { name: string }[];
  const recordedIndexNames = new Set(recordedIndexes.map((idx) => idx.name));
  const manualIndexes = db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL",
    )
    .all(name) as { name: string; sql: string }[];
  const manualIndexSql = manualIndexes
    .filter((idx) => !recordedIndexNames.has(idx.name))
    .map((idx) => idx.sql);

  const tmpName = rebuildTempTableName(db, name);
  db.exec(createTableSql(tmpName, schema, existingColumns));
  if (copyData) {
    const copyColumns = existingColumns.map((col) => quoteIdent(col.name));
    db.exec(
      `INSERT INTO ${quoteIdent(tmpName)} (${copyColumns.join(", ")}) SELECT ${copyColumns.join(", ")} FROM ${quoteIdent(name)}`,
    );
  }
  db.exec(`DROP TABLE ${quoteIdent(name)}`);
  db.exec(`ALTER TABLE ${quoteIdent(tmpName)} RENAME TO ${quoteIdent(name)}`);
  db.prepare('DELETE FROM "__vex_sqlite_indexes" WHERE "table" = ?').run(name);
  for (const sql of manualIndexSql) db.exec(sql);
}

function wrapSync(
  writer: SqliteConnection,
  changedTables: Set<string>,
  withConnectionLock: <T>(fn: () => Promise<T> | T) => Promise<T>,
  withReadConnection: <T>(
    fn: (connection: SqliteConnection) => T,
  ) => Promise<T>,
): DbExec {
  return {
    schemas: new Map(),
    markChanged(table, changes) {
      if (changes > 0) changedTables.add(table);
    },
    async all(sql, params) {
      return withReadConnection((connection) =>
        params.length > 0
          ? connection.statements.prepare(sql).all(...params)
          : connection.statements.prepare(sql).all(),
      );
    },
    async run(sql, params) {
      return withConnectionLock(() => {
        const statement = writer.statements.prepare(sql);
        const result =
          params.length > 0 ? statement.run(...params) : statement.run();
        return { changes: result.changes };
      });
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

function sqlAfterLeadingComments(sql: string): string {
  let offset = 0;
  while (offset < sql.length) {
    while (/\s/.test(sql[offset] ?? "")) offset++;
    if (sql.startsWith("--", offset)) {
      const newline = sql.indexOf("\n", offset + 2);
      if (newline === -1) return "";
      offset = newline + 1;
      continue;
    }
    if (sql.startsWith("/*", offset)) {
      const end = sql.indexOf("*/", offset + 2);
      if (end === -1) return "";
      offset = end + 2;
      continue;
    }
    break;
  }
  return sql.slice(offset);
}

function leadingSqlKeyword(sql: string): string {
  return (
    sqlAfterLeadingComments(sql)
      .match(/^[a-z]+/i)?.[0]
      .toUpperCase() ?? ""
  );
}

function isPooledRawRead(sql: string): boolean {
  return ["EXPLAIN", "SELECT", "VALUES", "WITH"].includes(
    leadingSqlKeyword(sql),
  );
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
  const changedTables = new Set<string>();
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

  async function withReadConnection<T>(
    fn: (connection: SqliteConnection) => T,
  ): Promise<T> {
    if (closed) throw closedError();
    const owner = transactionContext.getStore();
    // Transaction-owned reads must use the write handle to see uncommitted
    // changes. Connection-local state (TEMP tables, ATTACH, PRAGMAs) also pins
    // reads to that handle. In-memory databases have no shareable backing file.
    if (owner?.active || writerReadsRequired || readConnections.length === 0) {
      return withConnectionLock(() => fn(writer));
    }

    const connection = await acquireReadConnection();
    try {
      if (closed) throw closedError();
      return fn(connection);
    } finally {
      releaseReadConnection(connection);
    }
  }

  function insertUnlocked(table: string, row: Record<string, any>): string {
    const id = row._id ?? generateId(12);
    const data: Record<string, any> = { ...row, _id: id };
    const keys = Object.keys(data);
    const values = keys.map((k) => serializeValue(data[k]));
    writer.statements.prepare(buildInsertSql(table, keys)).run(...values);
    changedTables.add(table);
    return id;
  }

  const exec = wrapSync(
    writer,
    changedTables,
    withConnectionLock,
    withReadConnection,
  );

  return {
    name: "sqlite",

    ensureTable(name: string, schema: TableSchema) {
      validateTableName(name);
      validateTableNameAvailability(db, name);
      validateColumns(name, schema);
      validateIndexColumns(name, schema);
      const expectedIndexes = expectedIndexDefinitions(name, schema);
      validateIndexNameAvailability(db, name, expectedIndexes);
      db.exec("SAVEPOINT __vex_ensure_table");
      try {
        db.exec(
          createTableSql(name, schema).replace(
            "CREATE TABLE",
            "CREATE TABLE IF NOT EXISTS",
          ),
        );
        db.exec(
          'CREATE TABLE IF NOT EXISTS "__vex_sqlite_indexes" ("table" TEXT NOT NULL, "name" TEXT NOT NULL, PRIMARY KEY ("table", "name"))',
        );

        // Migrate: add missing columns
        let existing = db
          .prepare(`PRAGMA table_info(${quoteIdent(name)})`)
          .all() as ExistingColumn[];
        let existingNames = new Set(existing.map((c) => c.name));
        const tableIsEmpty =
          (
            db
              .prepare(`SELECT COUNT(*) as count FROM ${quoteIdent(name)}`)
              .get() as { count: number }
          ).count === 0;
        for (const [colName, colDef] of Object.entries(schema.columns)) {
          if (!existingNames.has(colName)) {
            if (
              !tableIsEmpty &&
              !colDef.optional &&
              colDef.default === undefined
            ) {
              throw new Error(
                `cannot add required column without default to non-empty table: ${quoteIdent(colName)} on table ${quoteIdent(name)}`,
              );
            }
            db.exec(
              `ALTER TABLE ${quoteIdent(name)} ADD COLUMN ${migratedColumnSql(
                colName,
                colDef,
                tableIsEmpty || colDef.default !== undefined,
              )}`,
            );
          }
        }

        const requiresEmptyTableRebuild =
          tableIsEmpty &&
          existing.some((col) => {
            const colDef = schema.columns[col.name];
            return colDef && columnNeedsRebuild(col, colDef);
          });
        const requiresNonEmptyTableRebuild =
          !tableIsEmpty &&
          existing.some((col) => {
            const colDef = schema.columns[col.name];
            return colDef && columnNeedsRebuild(col, colDef);
          });
        if (requiresEmptyTableRebuild || requiresNonEmptyTableRebuild) {
          rebuildTable(
            db,
            name,
            schema,
            existing,
            requiresNonEmptyTableRebuild,
          );
          existing = db
            .prepare(`PRAGMA table_info(${quoteIdent(name)})`)
            .all() as ExistingColumn[];
          existingNames = new Set(existing.map((c) => c.name));
        }

        const existingIndexes = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL",
          )
          .all(name) as { name: string }[];
        const indexList = db
          .prepare(`PRAGMA index_list(${quoteIdent(name)})`)
          .all() as {
          name: string;
          unique: number;
        }[];
        const uniqueByIndexName = new Map(
          indexList.map((idx) => [idx.name.toLowerCase(), idx.unique === 1]),
        );
        const expectedIndexesByName = new Map(
          [...expectedIndexes].map(([idxName, expected]) => [
            idxName.toLowerCase(),
            expected,
          ]),
        );
        const recordedIndexes = db
          .prepare('SELECT name FROM "__vex_sqlite_indexes" WHERE "table" = ?')
          .all(name) as { name: string }[];
        const recordedIndexNames = new Set(
          recordedIndexes.map((idx) => idx.name),
        );
        for (const { name: idxName } of existingIndexes) {
          const indexColumns = getIndexColumns(db, idxName);
          const idxPrefix = `idx_${name}_`;
          const uqPrefix = `uq_${name}_`;
          const generatedColumnIndex =
            idxName.startsWith(idxPrefix) &&
            existingNames.has(idxName.slice(idxPrefix.length)) &&
            sameColumns(indexColumns, [idxName.slice(idxPrefix.length)]);
          const generatedUniqueIndex =
            idxName.startsWith(uqPrefix) &&
            idxName.slice(uqPrefix.length) === indexColumns.join("_");
          const managedByVex =
            generatedColumnIndex ||
            generatedUniqueIndex ||
            recordedIndexNames.has(idxName);
          const expected = expectedIndexesByName.get(idxName.toLowerCase());
          const matchesExpected =
            expected &&
            uniqueByIndexName.get(idxName.toLowerCase()) === expected.unique &&
            sameColumns(indexColumns, expected.columns);
          if (managedByVex && !matchesExpected) {
            db.exec(`DROP INDEX ${quoteIdent(idxName)}`);
            db.prepare(
              'DELETE FROM "__vex_sqlite_indexes" WHERE "table" = ? AND "name" = ?',
            ).run(name, idxName);
          } else if (expected && !matchesExpected) {
            throw new Error(
              `index name already exists with different definition: ${quoteIdent(idxName)} on table ${quoteIdent(name)}`,
            );
          }
        }

        for (const [idxName, expected] of expectedIndexes) {
          const unique = expected.unique ? "UNIQUE " : "";
          db.exec(
            `CREATE ${unique}INDEX IF NOT EXISTS ${quoteIdent(idxName)} ON ${quoteIdent(name)} (${expected.columns.map((c) => quoteIdent(c)).join(", ")})`,
          );
        }
        for (const idxName of expectedIndexes.keys()) {
          db.prepare(
            'INSERT OR IGNORE INTO "__vex_sqlite_indexes" ("table", "name") VALUES (?, ?)',
          ).run(name, idxName);
        }
        clearStatementCaches();
        db.exec("RELEASE SAVEPOINT __vex_ensure_table");
        exec.schemas.set(name, schema);
      } catch (error) {
        db.exec("ROLLBACK TO SAVEPOINT __vex_ensure_table");
        db.exec("RELEASE SAVEPOINT __vex_ensure_table");
        throw error;
      }
    },

    async insert(table: string, row: Record<string, any>): Promise<string> {
      return withConnectionLock(() => insertUnlocked(table, row));
    },

    async upsert(
      table: string,
      keys: Record<string, any>,
      data: Record<string, any>,
    ): Promise<void> {
      await withConnectionLock(async () => {
        const qb = createQueryBuilder(exec, table);
        for (const [col, val] of Object.entries(keys)) qb.where(col, "=", val);
        const row = await qb.first<{ _id: string }>();

        if (row) {
          if (Object.keys(data).length === 0) return;
          const { sql, values } = buildUpdateSql(table, data);
          const result = writer.statements.prepare(sql).run(...values, row._id);
          if (result.changes > 0) changedTables.add(table);
        } else {
          insertUnlocked(table, { ...keys, ...data });
        }
      });
    },

    async update(
      table: string,
      id: string,
      data: Record<string, any>,
    ): Promise<void> {
      await withConnectionLock(() => {
        if (Object.keys(data).length === 0) return;
        const { sql, values } = buildUpdateSql(table, data);
        const result = writer.statements.prepare(sql).run(...values, id);
        if (result.changes > 0) changedTables.add(table);
      });
    },

    async delete(table: string, id: string): Promise<boolean> {
      return withConnectionLock(() => {
        const result = writer.statements
          .prepare(`DELETE FROM ${quoteIdent(table)} WHERE _id = ?`)
          .run(id);
        if (result.changes > 0) changedTables.add(table);
        return result.changes > 0;
      });
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
      const changedBefore = new Set(changedTables);
      const schemasBefore = new Map(exec.schemas);
      db.exec("BEGIN");
      try {
        const result = await transactionContext.run(context, () => fn());
        db.exec("COMMIT");
        return result;
      } catch (e) {
        db.exec("ROLLBACK");
        changedTables.clear();
        for (const table of changedBefore) changedTables.add(table);
        exec.schemas.clear();
        for (const [table, schema] of schemasBefore) {
          exec.schemas.set(table, schema);
        }
        throw e;
      } finally {
        context.active = false;
        releaseWriteLock();
      }
    },

    async rawQuery<T = Record<string, any>>(
      sql: string,
      ...params: any[]
    ): Promise<T[]> {
      if (isPooledRawRead(sql)) {
        try {
          return await withReadConnection(
            (connection) =>
              connection.statements.prepare(sql).all(...params) as T[],
          );
        } catch (error: unknown) {
          // A WITH statement can terminate in SELECT or in DML. Bun does not
          // expose sqlite3_stmt_readonly(), so let SQLite classify that one
          // ambiguous form and retry only its readonly failure on the writer.
          if (leadingSqlKeyword(sql) !== "WITH" || !isReadonlyError(error)) {
            throw error;
          }
        }
      }
      return withConnectionLock(() => {
        const rows = writer.statements.prepare(sql).all(...params) as T[];
        if (changesConnectionLocalState(sql)) writerReadsRequired = true;
        if (mayChangeSchema(sql)) clearStatementCaches();
        return rows;
      });
    },

    async rawExec(sql: string, ...params: any[]): Promise<void> {
      await withConnectionLock(() => {
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
      await withConnectionLock(() => {
        if (rows.length === 0) return;
        const keys = [
          "_id",
          ...new Set(
            rows
              .flatMap((row) => Object.keys(row))
              .filter((key) => key !== "_id"),
          ),
        ];
        const stmt = writer.statements.prepare(buildInsertSql(table, keys));

        const insertMany = db.transaction((items: Record<string, any>[]) => {
          for (const row of items) {
            const data: Record<string, any> = {
              _id: row._id ?? generateId(12),
              ...row,
            };
            stmt.run(...keys.map((k) => serializeValue(data[k])));
          }
        });

        insertMany(rows);
        changedTables.add(table);
      });
    },

    getChangedTables(): string[] {
      const tables = [...changedTables];
      changedTables.clear();
      return tables;
    },

    getSchema(table: string) {
      return exec.schemas.get(table) ?? null;
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
