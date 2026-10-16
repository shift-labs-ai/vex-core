import type { QueryBuilder, TableSchema } from "./types.js";

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
  getChangedTables(): string[];
  /**
   * Like `getChangedTables`, and also which of those tables some write
   * changed beyond the rows it names (raw SQL, a trigger, a foreign-key
   * action): invalidation cannot narrow a subscription over one by its
   * filters. Without it, every raw write counts as one, for every table.
   */
  takeChanges?(): { tables: string[]; unattributed: string[] };
  /**
   * The tables a raw statement reads, exactly, from how the database
   * would run it; undefined when the adapter cannot tell. Without it the
   * engine falls back to every registered table the statement names.
   */
  tablesRead?(
    sql: string,
  ): string[] | undefined | Promise<string[] | undefined>;
  getSchema(table: string): TableSchema | null;
  close(): Promise<void> | void;
}
