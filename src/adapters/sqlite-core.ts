import { id as generateId } from "../core/id.js";
import { changesRows, splitStatements } from "../core/sql-text.js";
import type { TableSchema } from "../core/types.js";
import {
  buildInsertSql,
  buildUpdateSql,
  buildWhereClause,
  quoteIdent,
  serializeValue,
} from "./shared.js";

/**
 * The synchronous SQLite surface the schema migration and write paths
 * run on. `bun:sqlite` and a Durable Object's `ctx.storage.sql` both
 * provide it; each adapter adds its own concurrency around it.
 */
export interface SqliteDriver {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  /**
   * The rows the last statement changed itself; rows its triggers or
   * foreign-key actions wrote are not counted.
   */
  changes(): number;
  /**
   * Runs `fn` atomically: its writes commit together or roll back when
   * it throws. Inside an open transaction this nests as a savepoint.
   */
  atomically<T>(fn: () => T): T;
}

export interface SqliteStatement {
  all(...params: any[]): any[];
  get(...params: any[]): any | null;
  /**
   * Runs a write. Answers the rows it changed itself when the driver
   * knows that for free; anything else means ask `changes()`.
   */
  run(...params: any[]): unknown;
}

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

const SQLITE_INDEX_METADATA_TABLE = "__vex_sqlite_indexes";

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

function getIndexColumns(db: SqliteDriver, indexName: string): string[] {
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

// SQLite matches table names case-insensitively; this returns the stored
// spelling of the table a name refers to.
function existingTableName(db: SqliteDriver, name: string): string | undefined {
  const row = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND lower(name) = lower(?) LIMIT 1",
    )
    .get(name) as { name: string } | null;
  return row?.name;
}

function validateTableNameAvailability(db: SqliteDriver, name: string): void {
  const existing = existingTableName(db, name);
  if (existing !== undefined && existing !== name) {
    throw new Error(
      `table name already exists with different casing: ${quoteIdent(existing)}`,
    );
  }
}

function validateTableRenames(name: string, schema: TableSchema): void {
  for (const previous of schema.renamedFrom ?? []) {
    validateTableName(previous);
    if (previous.toLowerCase() === name.toLowerCase()) {
      throw new Error(
        `table ${quoteIdent(name)} cannot be renamed from itself`,
      );
    }
  }
}

// The rule shared by table and column renames. Returns the existing
// previous name to rename from, or undefined when nothing needs renaming.
// A previous name beside the current one, or two existing previous names,
// leave no single source, so the migration fails rather than guess.
function renameSource(
  kind: "table" | "column",
  name: string,
  previousNames: string[],
  find: (candidate: string) => string | undefined,
  location = "",
): string | undefined {
  const sources = [
    ...new Set(previousNames.map(find).filter((n) => n !== undefined)),
  ];
  if (sources.length === 0) return undefined;
  if (find(name) !== undefined) {
    throw new Error(
      `cannot rename ${kind} ${quoteIdent(sources[0])} to ${quoteIdent(name)}${location}: both exist. ` +
        `If a build older than the rename recreated ${quoteIdent(sources[0])}, merge its data and drop it.`,
    );
  }
  if (sources.length > 1) {
    throw new Error(
      `cannot rename ${kind} to ${quoteIdent(name)}${location}: several previous names exist (${sources.map(quoteIdent).join(", ")})`,
    );
  }
  return sources[0];
}

// Returns the name the table was renamed from, if it was.
function renameTableIfNeeded(
  db: SqliteDriver,
  name: string,
  schema: TableSchema,
): string | undefined {
  const source = renameSource("table", name, schema.renamedFrom ?? [], (n) =>
    existingTableName(db, n),
  );
  if (source === undefined) return undefined;
  db.exec(`ALTER TABLE ${quoteIdent(source)} RENAME TO ${quoteIdent(name)}`);
  // Index records follow the table, so the index step recognizes its
  // generated indexes as Vex-managed and recreates them under the new name.
  db.prepare(
    `UPDATE ${quoteIdent(SQLITE_INDEX_METADATA_TABLE)} SET "table" = ? WHERE "table" = ?`,
  ).run(name, source);
  return source;
}

// Renames columns in place and updates `existing` to match, so the
// migration steps after it work from one read of the table's columns.
function renameColumnsIfNeeded(
  db: SqliteDriver,
  name: string,
  schema: TableSchema,
  existing: ExistingColumn[],
): void {
  const column = (colName: string) =>
    existing.find((col) => col.name.toLowerCase() === colName.toLowerCase());
  const location = ` on table ${quoteIdent(name)}`;
  for (const [colName, colDef] of Object.entries(schema.columns)) {
    if (!colDef.renamedFrom?.length) continue;
    const source = renameSource(
      "column",
      colName,
      colDef.renamedFrom,
      (n) => column(n)?.name,
      location,
    );
    if (source === undefined) {
      if (column(colName) === undefined) {
        throw new Error(
          `cannot rename column to ${quoteIdent(colName)}${location}: neither it nor a previous name (${colDef.renamedFrom.map(quoteIdent).join(", ")}) exists`,
        );
      }
      continue;
    }
    db.exec(
      `ALTER TABLE ${quoteIdent(name)} RENAME COLUMN ${quoteIdent(source)} TO ${quoteIdent(colName)}`,
    );
    const renamed = column(source);
    if (renamed) renamed.name = colName;
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
  // Each previous name belongs to exactly one column and is not declared
  // itself; otherwise its data has more than one destination.
  const previousNames = new Set<string>();
  for (const [colName, colDef] of Object.entries(schema.columns)) {
    for (const previous of colDef.renamedFrom ?? []) {
      const normalized = previous.toLowerCase();
      if (normalized === "_id") {
        throw new Error(
          `reserved column name ${quoteIdent(previous)} cannot be renamed on table ${quoteIdent(name)}`,
        );
      }
      if (columnNames.has(normalized) || previousNames.has(normalized)) {
        throw new Error(
          `ambiguous rename of ${quoteIdent(previous)} to ${quoteIdent(colName)} on table ${quoteIdent(name)}`,
        );
      }
      previousNames.add(normalized);
    }
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
  db: SqliteDriver,
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

function sqliteObjectExists(db: SqliteDriver, name: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE lower(name) = lower(?) LIMIT 1")
    .get(name) as { 1: number } | null;
  return row !== null;
}

function rebuildTempTableName(db: SqliteDriver, name: string): string {
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
  db: SqliteDriver,
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

/**
 * Creates or migrates `name` to match `schema`, atomically. Returns the
 * table's previous name when `renamedFrom` renamed it.
 */
export function ensureSqliteTable(
  db: SqliteDriver,
  name: string,
  schema: TableSchema,
): string | undefined {
  validateTableName(name);
  validateTableNameAvailability(db, name);
  validateTableRenames(name, schema);
  validateColumns(name, schema);
  validateIndexColumns(name, schema);
  const expectedIndexes = expectedIndexDefinitions(name, schema);
  return db.atomically(() => {
    db.exec(
      'CREATE TABLE IF NOT EXISTS "__vex_sqlite_indexes" ("table" TEXT NOT NULL, "name" TEXT NOT NULL, PRIMARY KEY ("table", "name"))',
    );
    // Renames run first so every later step sees the new names. Until
    // the table is renamed, its explicit indexes count as another
    // table's, so index names are checked after it.
    const renamedFrom = renameTableIfNeeded(db, name, schema);
    validateIndexNameAvailability(db, name, expectedIndexes);
    db.exec(
      createTableSql(name, schema).replace(
        "CREATE TABLE",
        "CREATE TABLE IF NOT EXISTS",
      ),
    );
    let existing = db
      .prepare(`PRAGMA table_info(${quoteIdent(name)})`)
      .all() as ExistingColumn[];
    renameColumnsIfNeeded(db, name, schema, existing);
    let existingNames = new Set(existing.map((c) => c.name));
    const tableIsEmpty =
      (
        db
          .prepare(`SELECT COUNT(*) as count FROM ${quoteIdent(name)}`)
          .get() as { count: number }
      ).count === 0;

    // Migrate: add missing columns
    for (const [colName, colDef] of Object.entries(schema.columns)) {
      if (!existingNames.has(colName)) {
        if (!tableIsEmpty && !colDef.optional && colDef.default === undefined) {
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
      rebuildTable(db, name, schema, existing, requiresNonEmptyTableRebuild);
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
    const recordedIndexNames = new Set(recordedIndexes.map((idx) => idx.name));
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
    return renamedFrom;
  });
}

/** One instruction of a compiled statement, as `EXPLAIN` lists it. */
export interface ExplainRow {
  opcode: string;
  p1: number;
  p2: number;
  p3: number;
}

/**
 * How an adapter shows SQLite's compiled form of a statement. Neither
 * call runs the statement.
 */
export interface SqliteIntrospection {
  /** The program of one statement, as `EXPLAIN` lists it. */
  explain(statement: string): ExplainRow[];
  /** The root page of every table and index in the main database. */
  rootPages(): { rootpage: number; tbl_name: string }[];
}

// The cursors a program opens on stored tables. `Clear` is DELETE
// without WHERE (the truncate optimization); its root page is p1.
const WRITE_OPCODES = new Set(["OpenWrite", "Clear"]);
const READ_OPCODES = new Set(["OpenRead", "ReopenIdx", "OpenWrite", "Clear"]);
// A virtual table's reads and writes go through its module, not cursors
// the program opens: nothing exact can be said.
const VIRTUAL_OPCODES = new Set(["VOpen", "VUpdate"]);
const SCHEMA_ROOT_PAGE = 1;
const ANALYSIS_CACHE_SIZE = 512;

/** What a write statement writes, from its compiled program. */
export interface WriteAnalysis {
  /** The tables it writes; null when SQLite cannot say (every table). */
  tables: string[] | null;
  /**
   * No trigger or foreign-key action runs in it, so every row it changes
   * is its own.
   */
  direct: boolean;
  /** How many statements its text holds. */
  statements: number;
}

/** A Map that forgets its oldest entry past `capacity`. */
class BoundedMap<K, V> extends Map<K, V> {
  constructor(private readonly capacity: number) {
    super();
  }
  override set(key: K, value: V): this {
    super.set(key, value);
    if (this.size > this.capacity) {
      this.delete(this.keys().next().value as K);
    }
    return this;
  }
}

/**
 * What a SQLite adapter tracks beside its database: the schema each
 * table was last ensured with, and the tables changed since the engine
 * last asked.
 *
 * Which tables a statement reads or writes comes from SQLite: its
 * compiled program, as `EXPLAIN` lists it, opens a cursor on every table
 * it touches, including those its triggers and foreign-key actions
 * write. That depends on the statement's text and the schema, never on
 * its parameters, so each text is compiled once and remembered until
 * the schema changes. A write marks its tables when it changed any row.
 *
 * Each changed table is attributed while every write to it changed
 * only rows the write names: a query-builder statement no trigger or
 * foreign-key action runs in. Raw SQL, or a write that runs one, leaves
 * it unattributed: which of its rows changed is unknown.
 *
 * Writes inside a transaction wait in `pending` and join the changed
 * set at commit, so nothing reports a write that may yet roll back.
 */
export class SqliteAdapterState {
  readonly schemas = new Map<string, TableSchema>();
  // Table → attributed, for the changes since the engine last asked.
  private readonly changed = new Map<string, boolean>();
  // The open transaction's writes; one Map, reused.
  private readonly pendingTables = new Map<string, boolean>();
  private pending: Map<string, boolean> | null = null;
  // While a transaction is open, each schema it replaces, to put back on
  // rollback.
  private readonly schemaUndo: [string, TableSchema | undefined][] = [];
  private readonly writes = new BoundedMap<string, WriteAnalysis>(
    ANALYSIS_CACHE_SIZE,
  );
  private readonly reads = new BoundedMap<string, string[] | null>(
    ANALYSIS_CACHE_SIZE,
  );
  private roots: Map<number, string> | null = null;
  private dataVersion: number | undefined;
  private schemaEpoch = 0;

  /** Moves whenever the schema does: an analysis from an older epoch is
   *  stale. */
  get epoch(): number {
    return this.schemaEpoch;
  }

  registerSchema(
    name: string,
    schema: TableSchema,
    renamedFrom: string | undefined,
  ): void {
    if (this.pending !== null) {
      this.schemaUndo.push([name, this.schemas.get(name)]);
      if (renamedFrom !== undefined) {
        this.schemaUndo.push([renamedFrom, this.schemas.get(renamedFrom)]);
      }
    }
    if (renamedFrom !== undefined) this.schemas.delete(renamedFrom);
    this.schemas.set(name, schema);
    this.schemaChanged();
  }

  /** Forgets every compiled statement: the schema they depend on moved. */
  schemaChanged(): void {
    this.schemaEpoch++;
    this.writes.clear();
    this.reads.clear();
    this.roots = null;
  }

  /**
   * What `sql` writes. Compiling a statement resets SQLite's
   * `changes()`, so a caller that counts rows asks before running it.
   */
  written(introspection: SqliteIntrospection, sql: string): WriteAnalysis {
    let analysis = this.writes.get(sql);
    if (analysis === undefined) {
      const indirect = { found: false };
      const tables = this.analyze(introspection, sql, WRITE_OPCODES, indirect);
      analysis = {
        tables,
        direct: tables !== null && !indirect.found,
        statements: splitStatements(sql).length,
      };
      this.writes.set(sql, analysis);
    }
    return analysis;
  }

  /**
   * Marks `tables` (null: every table) as changed by a write. A write is
   * `attributed` when it changed only rows it names.
   */
  markChanged(tables: string[] | null, attributed: boolean): void {
    const target = this.pending ?? this.changed;
    if (tables === null) {
      for (const table of this.schemas.keys()) target.set(table, false);
      return;
    }
    for (let i = 0; i < tables.length; i++) {
      const table = tables[i];
      if (!attributed) target.set(table, false);
      else if (!target.has(table)) target.set(table, true);
    }
  }

  /**
   * The tables `sql` reads as last analyzed for this schema: null when
   * SQLite could not say, undefined when not analyzed yet.
   */
  cachedTablesRead(sql: string): string[] | null | undefined {
    return this.reads.get(sql);
  }

  /** The tables `sql` reads; undefined when SQLite cannot say. */
  tablesRead(
    introspection: SqliteIntrospection,
    sql: string,
  ): string[] | undefined {
    let tables = this.reads.get(sql);
    if (tables === undefined) {
      tables = this.analyze(introspection, sql, READ_OPCODES);
      this.reads.set(sql, tables);
    }
    return tables ?? undefined;
  }

  /**
   * The tables every cursor of `opcodes` in `sql`'s statements opens, or
   * null when one cannot be named: a statement that does not compile, a
   * virtual table, or a cursor on another database (TEMP, ATTACH).
   */
  private analyze(
    introspection: SqliteIntrospection,
    sql: string,
    opcodes: Set<string>,
    indirect?: { found: boolean },
  ): string[] | null {
    const tables = new Set<string>();
    for (const statement of splitStatements(sql)) {
      if (!changesRows(statement)) continue;
      let program: ExplainRow[];
      try {
        program = introspection.explain(statement);
      } catch {
        return null;
      }
      for (const { opcode, p1, p2, p3 } of program) {
        if (VIRTUAL_OPCODES.has(opcode)) return null;
        // A trigger's or foreign-key action's program.
        if (opcode === "Program" && indirect) indirect.found = true;
        if (!opcodes.has(opcode)) continue;
        const [root, database] = opcode === "Clear" ? [p1, p2] : [p2, p3];
        if (database !== 0) return null;
        if (root === SCHEMA_ROOT_PAGE) continue;
        const table = this.rootTable(introspection, root);
        if (table === undefined) return null;
        tables.add(table);
      }
    }
    return [...tables];
  }

  private rootTable(
    introspection: SqliteIntrospection,
    root: number,
  ): string | undefined {
    const known = this.roots?.get(root);
    if (known !== undefined) return known;
    this.roots = new Map(
      introspection.rootPages().map((row) => [row.rootpage, row.tbl_name]),
    );
    return this.roots.get(root);
  }

  /** Starts the outermost transaction: its writes wait for commit. */
  begin(): void {
    this.pendingTables.clear();
    this.pending = this.pendingTables;
  }

  /** Commits the outermost transaction: its writes count as changed. */
  commit(): void {
    this.pendingTables.forEach((attributed, table) => {
      this.changed.set(table, attributed && this.changed.get(table) !== false);
    });
    this.pendingTables.clear();
    this.pending = null;
    this.schemaUndo.length = 0;
  }

  /**
   * The tables changed since the last call. `dataVersion`, where other
   * connections can write, is SQLite's `PRAGMA data_version` on the
   * adapter's writing connection, which moves when another connection
   * commits: then what it wrote is unknown, so every table counts,
   * unattributed, and compiled statements are forgotten in case it
   * changed the schema.
   */
  takeChanged(dataVersion?: number): {
    tables: string[];
    unattributed: string[];
  } {
    if (
      dataVersion !== undefined &&
      this.dataVersion !== undefined &&
      dataVersion !== this.dataVersion
    ) {
      this.schemaChanged();
      for (const table of this.schemas.keys()) this.changed.set(table, false);
    }
    this.dataVersion = dataVersion;
    const tables: string[] = [];
    const unattributed: string[] = [];
    this.changed.forEach((attributed, table) => {
      tables.push(table);
      if (!attributed) unattributed.push(table);
    });
    this.changed.clear();
    return { tables, unattributed };
  }

  /**
   * Returns a function that restores the schemas and the pending writes
   * as they are now: a rollback undoes the migrations and writes they
   * describe. Taken before `begin()` (an outermost transaction) it ends
   * the transaction; taken inside one (a savepoint), it rolls back to
   * there.
   */
  snapshot(): () => void {
    const undo = this.schemaUndo.length;
    const pending = this.pending && new Map(this.pending);
    return () => {
      if (this.schemaUndo.length > undo) {
        while (this.schemaUndo.length > undo) {
          const [table, schema] = this.schemaUndo.pop()!;
          if (schema === undefined) this.schemas.delete(table);
          else this.schemas.set(table, schema);
        }
        this.schemaChanged();
      }
      this.pendingTables.clear();
      pending?.forEach((attributed, table) => {
        this.pendingTables.set(table, attributed);
      });
      this.pending = pending && this.pendingTables;
    };
  }
}

// ─── writes ──────────────────────────────────────────────────────────
// insertRow returns the new row's id; deleteRow the number of rows it
// deleted.

/** The rows a write changed itself: what its `run()` answered, or
 *  `changes()`. */
function ownChanges(db: SqliteDriver, ran: unknown): number {
  return typeof ran === "number" ? ran : db.changes();
}

/** Runs a write and answers the rows it changed itself. */
export function runCounted(
  db: SqliteDriver,
  sql: string,
  params: any[],
): number {
  return ownChanges(db, db.prepare(sql).run(...params));
}

export function insertRow(
  db: SqliteDriver,
  table: string,
  row: Record<string, any>,
): string {
  const id = row._id ?? generateId(12);
  const data: Record<string, any> = { ...row, _id: id };
  const keys = Object.keys(data);
  db.prepare(buildInsertSql(table, keys)).run(
    ...keys.map((k) => serializeValue(data[k])),
  );
  return id;
}

export function updateRow(
  db: SqliteDriver,
  table: string,
  id: string,
  data: Record<string, any>,
): void {
  if (Object.keys(data).length === 0) return;
  const { sql, values } = buildUpdateSql(table, data);
  db.prepare(sql).run(...values, id);
}

export function deleteRow(db: SqliteDriver, table: string, id: string): number {
  const sql = `DELETE FROM ${quoteIdent(table)} WHERE _id = ?`;
  return ownChanges(db, db.prepare(sql).run(id));
}

/** Updates the row matching `keys` with `data`, or inserts both. */
export function upsertRow(
  db: SqliteDriver,
  table: string,
  keys: Record<string, any>,
  data: Record<string, any>,
): void {
  const { sql: where, params } = buildWhereClause(
    Object.entries(keys).map(([column, value]) => ({
      column,
      operator: "=" as const,
      value,
    })),
  );
  const row = db
    .prepare(`SELECT _id FROM ${quoteIdent(table)} ${where} LIMIT 1`)
    .get(...params) as { _id: string } | null;
  if (row) updateRow(db, table, row._id, data);
  else insertRow(db, table, { ...keys, ...data });
}

/** Inserts `rows` atomically, over the union of their columns. */
export function bulkInsertRows(
  db: SqliteDriver,
  table: string,
  rows: Record<string, any>[],
): void {
  if (rows.length === 0) return;
  const keys = [
    "_id",
    ...new Set(
      rows.flatMap((row) => Object.keys(row)).filter((key) => key !== "_id"),
    ),
  ];
  const statement = db.prepare(buildInsertSql(table, keys));
  db.atomically(() => {
    for (const row of rows) {
      const data: Record<string, any> = {
        _id: row._id ?? generateId(12),
        ...row,
      };
      statement.run(...keys.map((k) => serializeValue(data[k])));
    }
  });
}
