import type { Filter } from "./types.js";

export interface QueryDependency {
  table: string;
  filters?: Filter[];
  /** Each `whereAny`: an OR of AND groups, every one of which must hold. */
  any?: Filter[][][];
  /**
   * The columns the result is computed from, besides the filters': a
   * selection, an aggregate's column, a grouping. Absent when the
   * read returns whole rows.
   */
  reads?: string[];
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
  /**
   * Present when every row the write touched exists both before and
   * after it (an update): the columns whose value it changed. Empty
   * when it changed nothing.
   */
  changed?: string[];
  /**
   * For each changed column, what the rows held before and after: a
   * filter rejecting both never saw them.
   */
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  raw?: boolean;
}

type TraceFilter = Pick<Filter, "column" | "operator">;

interface TraceQueryDependency {
  table: string;
  filters?: TraceFilter[];
  any?: TraceFilter[][][];
  reads?: string[];
  select?: string[];
  order?: { column: string; dir: "asc" | "desc" };
  limit?: number;
  offset?: number;
  raw?: true;
}

interface TraceWrite {
  table: string;
  columns?: string[];
  changed?: string[];
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
    ...(dependency.any
      ? {
          any: dependency.any.map((groups) =>
            groups.map((group) =>
              group.map(({ column, operator }) => ({ column, operator })),
            ),
          ),
        }
      : {}),
    ...(dependency.reads ? { reads: [...dependency.reads].sort() } : {}),
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
    ...(write.changed ? { changed: [...write.changed].sort() } : {}),
    ...(write.raw ? { raw: true as const } : {}),
  }));
}
