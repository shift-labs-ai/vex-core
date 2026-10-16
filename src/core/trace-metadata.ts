import type { Filter } from "./types.js";

export interface QueryDependency {
  table: string;
  filters?: Filter[];
  select?: string[] | null;
  order?: { column: string; dir: "asc" | "desc" } | null;
  limit?: number | null;
  offset?: number | null;
  raw?: boolean;
}

export interface WriteDependency {
  table: string;
  /**
   * Column values every row the write touched holds both before and
   * after it: what invalidation may narrow on. A subscription filtered on
   * another value of one of these columns cannot have seen the write.
   * Absent when no such values are known.
   */
  values?: Record<string, unknown>;
  /** The columns the write set, for traces. */
  columns?: string[];
  raw?: boolean;
}

type TraceFilter = Pick<Filter, "column" | "operator">;

interface TraceQueryDependency {
  table: string;
  filters?: TraceFilter[];
  select?: string[];
  order?: { column: string; dir: "asc" | "desc" };
  limit?: number;
  offset?: number;
  raw?: true;
}

interface TraceWrite {
  table: string;
  columns?: string[];
  raw?: true;
}

/**
 * Project runtime query dependencies into bounded operational metadata.
 * Filter values stay private; table, column, and operation names are enough
 * to explain the query shape without turning traces into a request archive.
 */
export function describeQueryDependencies(
  dependencies: QueryDependency[],
): TraceQueryDependency[] {
  return dependencies.map((dependency) => ({
    table: dependency.table,
    ...(dependency.filters
      ? {
          filters: dependency.filters.map(({ column, operator }) => ({
            column,
            operator,
          })),
        }
      : {}),
    ...(dependency.select ? { select: dependency.select } : {}),
    ...(dependency.order ? { order: dependency.order } : {}),
    ...(typeof dependency.limit === "number"
      ? { limit: dependency.limit }
      : {}),
    ...(typeof dependency.offset === "number"
      ? { offset: dependency.offset }
      : {}),
    ...(dependency.raw ? { raw: true as const } : {}),
  }));
}

/**
 * Project runtime writes into bounded operational metadata. Values remain
 * available to invalidation internally but never cross the tracing boundary.
 */
export function describeWrites(writes: WriteDependency[]): TraceWrite[] {
  return writes.map((write) => ({
    table: write.table,
    ...(write.columns ? { columns: [...write.columns].sort() } : {}),
    ...(write.raw ? { raw: true as const } : {}),
  }));
}
