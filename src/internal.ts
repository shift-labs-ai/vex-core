/**
 * Raw access to an engine's storage, for tests and tooling only: SQL
 * past every policy and every tracked read, and the storage itself.
 * What it writes is announced, so subscriptions over it re-run. An
 * app's own code changes its schema through migrations and its data
 * through its operations (`VexOptions.migrations`).
 */

import type { Vex } from "./core/engine.js";
import { RAW, type RawAccess } from "./core/internal-access.js";
import type { StorageAdapter } from "./core/storage.js";

function raw(vex: Vex<any>): RawAccess {
  return (vex as unknown as { [RAW](): RawAccess })[RAW]();
}

/** Runs `sql` on the engine's storage as it is. */
export function rawSql<T = Record<string, any>>(
  vex: Vex<any>,
  sql: string,
  ...params: any[]
): Promise<T[]> {
  return raw(vex).sql<T>(sql, ...params);
}

/** The engine's storage, every write through it announced. */
export function rawStorage(vex: Vex<any>): StorageAdapter {
  return raw(vex).storage();
}

/** Inserts `rows` into `table` in bulk, announced. */
export function rawBulkInsert(
  vex: Vex<any>,
  table: string,
  rows: Record<string, any>[],
): Promise<void> {
  return raw(vex).bulkInsert(table, rows);
}
