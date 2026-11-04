import type { StorageAdapter } from "./storage.js";

/**
 * The engine's raw access, for tests and tooling (`vex-core/internal`):
 * reached through this symbol, which the public entry points never
 * export, so an app's code holds no way to it.
 */
export const RAW = Symbol("vex.raw");

export interface RawAccess {
  sql<T = Record<string, any>>(sql: string, ...params: any[]): Promise<T[]>;
  storage(): StorageAdapter;
  bulkInsert(table: string, rows: Record<string, any>[]): Promise<void>;
}
