import type { QueryBuilder, TableSchema } from "./types.js";

/**
 * A table name that stands for any table: a raw read that reads no table
 * depends on it, and a change to it (a write SQLite cannot attribute to
 * tables, or one by another connection) affects every subscription.
 */
export const ANY_TABLE = "*";

/** What changed since the engine last asked. */
export interface Changes {
  /** The tables changed; `ANY_TABLE` among them when any may have. */
  tables: string[];
  /**
   * Of those, the ones some write changed beyond the rows it names (raw
   * SQL, a trigger, a foreign-key action): invalidation cannot narrow a
   * subscription over one by its filters. An adapter that cannot tell
   * lists them all.
   */
  unattributed: string[];
}

/** What a statement reads, or why it is not a plain read. */
export type ReadOnlyRead =
  | { readonly tables: readonly string[] }
  | { readonly refused: string };

export interface StorageAdapter {
  readonly name: string;
  ensureTable(name: string, schema: TableSchema): Promise<void> | void;
  insert(table: string, row: Record<string, any>): Promise<string>;
  upsert(
    table: string,
    keys: Record<string, any>,
    data: Record<string, any>,
  ): Promise<void>;
  update(table: string, id: string, data: Record<string, any>): Promise<void>;
  delete(table: string, id: string): Promise<boolean>;
  query(table: string): QueryBuilder;
  transaction<T>(fn: () => Promise<T> | T): Promise<T>;
  rawQuery<T = Record<string, any>>(
    sql: string,
    ...params: any[]
  ): Promise<T[]>;
  rawExec(sql: string, ...params: any[]): Promise<void>;
  bulkInsert(table: string, rows: Record<string, any>[]): Promise<void>;
  /** What changed since the last call; committed writes only. */
  takeChanges(): Changes;
  /**
   * The tables a raw statement reads, exactly, from how the database
   * would run it; undefined when the adapter cannot tell. Without it the
   * engine falls back to every registered table the statement names.
   */
  tablesRead?(
    sql: string,
  ): string[] | undefined | Promise<string[] | undefined>;
  /**
   * The tables `sql` reads when it is one statement that SQLite's
   * compiled program shows writes nothing and opens only main-database
   * tables it can name; otherwise why not. Without it the engine
   * refuses `publishedSql` outright.
   */
  readOnlyTables?(sql: string): ReadOnlyRead | Promise<ReadOnlyRead>;
  getSchema(table: string): TableSchema | null;
  close(): Promise<void> | void;
}
