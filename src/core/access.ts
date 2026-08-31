/**
 * Table access policies — row-level visibility as an engine contract.
 *
 * A table schema may declare who sees its rows:
 *
 *   access: {
 *     prepare(user, db)  → UNRESTRICTED | P     (I/O, once per operation)
 *     row(prepared, row) → boolean              (pure, per row)
 *   }
 *
 * The engine consults the policy on every query-context read of the
 * table and guarantees one invariant:
 *
 *   A governed table behaves IDENTICALLY for a restricted caller as
 *   an ungoverned table containing only the rows their policy
 *   accepts.
 *
 * So `.limit(n)` means "n rows this caller may see", `count()` counts
 * visible rows, aggregates aggregate visible rows. Handlers write
 * plain bounded queries and never call the predicate themselves —
 * which is the point: hand-wired row filtering is fail-open (one
 * forgotten call leaks every row), and per-handler filtering after an
 * unbounded fetch is what breaks LIMIT, COUNT, and pagination.
 *
 * Enforcement scope, deliberately:
 *   - Query contexts (queries, subscriptions, their invalidation
 *     re-runs): governed. Restricted terminal reads evaluate in JS
 *     over policy-accepted rows; unrestricted calls delegate to SQL
 *     untouched.
 *   - Raw SQL in a query context that mentions a governed table:
 *     refused for EVERY caller. A handler that works for admins and
 *     breaks for members is the bug class this module removes, and
 *     there is no escape hatch on purpose.
 *   - Mutation contexts (mutations, jobs, webhooks): the trusted
 *     tier. Writes carry their own guards; reads there are engine
 *     plumbing, not user-facing answers.
 *
 * The policy's `prepare` receives a read-only, dependency-tracked,
 * UNGUARDED table reader: its own reads (role tables, grant tables)
 * register as subscription dependencies — visibility changes re-run
 * live queries — and cannot recurse into the policy.
 */

import type { Filter, GroupByBuilder, QueryBuilder, VexUser } from "./types.js";

/**
 * Sentinel a policy's `prepare` returns for callers whose reads must
 * not be filtered: internal (userless) calls, admins — whatever the
 * policy decides. The engine then delegates straight to SQL.
 */
export const UNRESTRICTED: unique symbol = Symbol.for(
  "vex.access.unrestricted",
);

/** The read surface `prepare` receives: tracked, unguarded reads. */
export interface AccessReader {
  table(name: string): QueryBuilder;
}

export interface TableAccessPolicy<P = unknown> {
  /**
   * Resolve the caller's access context once per operation — load
   * whatever the row predicate needs (grants, bindings, membership).
   * Return {@link UNRESTRICTED} to bypass filtering for this caller.
   */
  prepare(
    user: VexUser | null | undefined,
    db: AccessReader,
  ): P | typeof UNRESTRICTED | Promise<P | typeof UNRESTRICTED>;
  /** Pure per-row verdict against the prepared context. */
  row(prepared: P, row: Record<string, any>): boolean;
}

type Prepared = unknown | typeof UNRESTRICTED;
type ResolvePrepared = () => Promise<Prepared>;

/** SQLite's "no limit" spelling — clears any earlier limit() on the
 *  shared underlying builder before an exhaustive fetch. */
const NO_LIMIT = -1;
/** First fetch size when a bounded read drives the refill loop. */
const MIN_FETCH = 64;

function projectRow(
  row: Record<string, any>,
  select: string[] | null,
): Record<string, any> {
  if (!select) return row;
  const out: Record<string, any> = {};
  for (const column of select) out[column] = row[column];
  return out;
}

/** Aggregate inputs: SQL aggregates skip NULLs. */
function aggregateValues(rows: Record<string, any>[], column: string): any[] {
  const values: any[] = [];
  for (const row of rows) {
    const value = row[column];
    if (value !== null && value !== undefined) values.push(value);
  }
  return values;
}

function sumOf(values: any[]): number | null {
  if (values.length === 0) return null;
  let total = 0;
  for (const value of values) total += Number(value);
  return total;
}

function minOf(values: any[]): any {
  if (values.length === 0) return null;
  return values.reduce((a, b) => (b < a ? b : a));
}

function maxOf(values: any[]): any {
  if (values.length === 0) return null;
  return values.reduce((a, b) => (b > a ? b : a));
}

/**
 * One filter applied to an in-memory value, matching the SQL the
 * adapters build: `=`/`!=` against NULL read as IS (NOT) NULL, other
 * comparisons against NULL never match, IN unions membership with an
 * explicit NULL check.
 */
function matchesFilter(value: any, filter: Filter): boolean {
  const target = filter.value;
  switch (filter.operator) {
    case "=":
      if (target === null || target === undefined) return value == null;
      return value != null && value === target;
    case "!=":
      if (target === null || target === undefined) return value != null;
      return value != null && value !== target;
    case "IN": {
      const targets = Array.isArray(target) ? target : [target];
      if (value == null) return targets.some((item) => item == null);
      return targets.includes(value);
    }
    case "<":
      return value != null && target != null && value < target;
    case ">":
      return value != null && target != null && value > target;
    case "<=":
      return value != null && target != null && value <= target;
    case ">=":
      return value != null && target != null && value >= target;
  }
}

/** ORDER BY semantics over in-memory values: NULLs first ascending. */
function compareValues(a: any, b: any): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

type AggSpec = Record<
  string,
  "count" | ["sum" | "avg" | "min" | "max", string] | ["countDistinct", string]
>;

/**
 * GROUP BY evaluated over policy-accepted rows, mirroring the SQL the
 * adapters build: NULLs group together, aggregates skip NULLs and
 * report NULL over an empty input, HAVING applies the filter grammar
 * to computed rows.
 */
function groupRows(
  rows: Record<string, any>[],
  columns: string | string[],
  aggs: AggSpec,
  having: Filter[],
  order: { column: string; dir: "asc" | "desc" } | null,
  limit: number | null,
): Record<string, any>[] {
  const cols = Array.isArray(columns) ? columns : [columns];
  const groups = new Map<string, Record<string, any>[]>();
  for (const row of rows) {
    const key = JSON.stringify(cols.map((col) => row[col] ?? null));
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  let out: Record<string, any>[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    const result: Record<string, any> = {};
    for (const col of cols) result[col] = first[col] ?? null;
    for (const [alias, def] of Object.entries(aggs)) {
      if (def === "count") {
        result[alias] = group.length;
        continue;
      }
      const [fn, column] = def;
      const values = aggregateValues(group, column);
      switch (fn) {
        case "sum":
          result[alias] = sumOf(values);
          break;
        case "avg": {
          const total = sumOf(values);
          result[alias] = total === null ? null : total / values.length;
          break;
        }
        case "min":
          result[alias] = minOf(values);
          break;
        case "max":
          result[alias] = maxOf(values);
          break;
        case "countDistinct":
          result[alias] = new Set(values).size;
          break;
      }
    }
    out.push(result);
  }

  out = out.filter((row) =>
    having.every((filter) => matchesFilter(row[filter.column], filter)),
  );
  if (order) {
    const sign = order.dir === "desc" ? -1 : 1;
    out.sort((a, b) => sign * compareValues(a[order.column], b[order.column]));
  }
  if (limit !== null) out = out.slice(0, limit);
  return out;
}

/**
 * Wrap a table's query builder with its access policy.
 *
 * Chained `where`/`order` forward to the underlying builder — they
 * narrow SQL identically for every caller. `select`/`limit`/`offset`
 * are held here: a restricted read needs full rows for the predicate
 * and applies the caller's window over the ACCEPTED stream, so none
 * of the three may reach SQL until the caller's standing is known.
 *
 * Restricted bounded reads drive a refill loop: fetch a prefix,
 * filter, and refetch a longer prefix until the window fills or the
 * table is exhausted. Every answer derives from the final single
 * fetch, so ordering ties across fetches cannot duplicate or drop
 * rows.
 */
export function guardQueryBuilder(
  table: string,
  underlying: QueryBuilder,
  policy: TableAccessPolicy<any>,
  resolvePrepared: ResolvePrepared,
): QueryBuilder {
  let select: string[] | null = null;
  let limit: number | null = null;
  let offset: number | null = null;

  async function fetchAccepted(
    prepared: unknown,
    needed: number | null,
  ): Promise<Record<string, any>[]> {
    let attempt = needed === null ? NO_LIMIT : Math.max(needed * 2, MIN_FETCH);
    for (;;) {
      underlying.limit(attempt);
      const fetched = await underlying.all<Record<string, any>>();
      const accepted = fetched.filter((row) => policy.row(prepared, row));
      const exhausted = attempt === NO_LIMIT || fetched.length < attempt;
      if (exhausted || (needed !== null && accepted.length >= needed)) {
        return accepted;
      }
      attempt = attempt * 4;
    }
  }

  async function restrictedWindow(
    prepared: unknown,
  ): Promise<Record<string, any>[]> {
    const start = offset ?? 0;
    const needed = limit === null ? null : start + limit;
    const accepted = await fetchAccepted(prepared, needed);
    const window =
      limit === null
        ? accepted.slice(start)
        : accepted.slice(start, start + limit);
    return window.map((row) => projectRow(row, select));
  }

  /** Unrestricted: hand the held window back to SQL and delegate. */
  function release(): QueryBuilder {
    if (select) underlying.select(...select);
    if (limit !== null) underlying.limit(limit);
    if (offset !== null) underlying.offset(offset);
    return underlying;
  }

  async function terminal<T>(
    unrestricted: () => Promise<T>,
    restricted: (prepared: unknown) => Promise<T>,
  ): Promise<T> {
    const prepared = await resolvePrepared();
    if (prepared === UNRESTRICTED) return unrestricted();
    return restricted(prepared);
  }

  const guarded: QueryBuilder = {
    where(column, operator, value) {
      underlying.where(column, operator, value);
      return guarded;
    },
    order(column, dir = "asc") {
      underlying.order(column, dir);
      return guarded;
    },
    select(...columns) {
      select = columns;
      return guarded;
    },
    limit(n) {
      limit = n;
      return guarded;
    },
    offset(n) {
      offset = n;
      return guarded;
    },
    all: <T>() =>
      terminal<T[]>(
        () => release().all<T>(),
        async (prepared) => (await restrictedWindow(prepared)) as T[],
      ),
    first: <T>() =>
      terminal<T | null>(
        () => release().first<T>(),
        async (prepared) => {
          const start = offset ?? 0;
          const accepted = await fetchAccepted(prepared, start + 1);
          const row = accepted[start];
          return row === undefined ? null : (projectRow(row, select) as T);
        },
      ),
    count: () =>
      terminal(
        () => release().count(),
        async (prepared) => (await fetchAccepted(prepared, null)).length,
      ),
    distinct: (column) =>
      terminal(
        () => release().distinct(column),
        async (prepared) => {
          const accepted = await fetchAccepted(prepared, null);
          const seen = new Set<string>();
          const values: any[] = [];
          for (const row of accepted) {
            const value = row[column] ?? null;
            const key = JSON.stringify(value);
            if (seen.has(key)) continue;
            seen.add(key);
            values.push(value);
          }
          const start = offset ?? 0;
          return limit === null
            ? values.slice(start)
            : values.slice(start, start + limit);
        },
      ),
    countDistinct: (column) =>
      terminal(
        () => release().countDistinct(column),
        async (prepared) => {
          const values = aggregateValues(
            await fetchAccepted(prepared, null),
            column,
          );
          return new Set(values.map((value) => JSON.stringify(value))).size;
        },
      ),
    // The scalar aggregates coerce like the adapters do: NULL over an
    // empty input reads back as 0 through `Number(v ?? 0)`.
    sum: (column) =>
      terminal(
        () => release().sum(column),
        async (prepared) =>
          Number(
            sumOf(
              aggregateValues(await fetchAccepted(prepared, null), column),
            ) ?? 0,
          ),
      ),
    avg: (column) =>
      terminal(
        () => release().avg(column),
        async (prepared) => {
          const values = aggregateValues(
            await fetchAccepted(prepared, null),
            column,
          );
          const total = sumOf(values);
          return Number(total === null ? 0 : total / values.length);
        },
      ),
    min: (column) =>
      terminal(
        () => release().min(column),
        async (prepared) =>
          Number(
            minOf(
              aggregateValues(await fetchAccepted(prepared, null), column),
            ) ?? 0,
          ),
      ),
    max: (column) =>
      terminal(
        () => release().max(column),
        async (prepared) =>
          Number(
            maxOf(
              aggregateValues(await fetchAccepted(prepared, null), column),
            ) ?? 0,
          ),
      ),
    groupBy(columns, aggs) {
      const having: Filter[] = [];
      let order: { column: string; dir: "asc" | "desc" } | null = null;
      let groupLimit: number | null = null;

      const execute = () =>
        terminal(
          () => {
            let chain = release().groupBy(columns, aggs);
            for (const filter of having) {
              chain = chain.having(
                filter.column,
                filter.operator,
                filter.value,
              );
            }
            if (order) chain = chain.order(order.column, order.dir);
            if (groupLimit !== null) chain = chain.limit(groupLimit);
            return Promise.resolve(chain);
          },
          async (prepared) =>
            groupRows(
              await fetchAccepted(prepared, null),
              columns,
              aggs as AggSpec,
              having,
              order,
              groupLimit,
            ),
        );

      const builder: GroupByBuilder = {
        having(column, operator, value) {
          having.push({ column, operator, value });
          return builder;
        },
        order(column, dir = "asc") {
          order = { column, dir };
          return builder;
        },
        limit(n) {
          groupLimit = n;
          return builder;
        },
        // biome-ignore lint/suspicious/noThenProperty: intentional — GroupByBuilder is awaitable
        then(resolve: any, reject: any) {
          return execute().then(resolve, reject);
        },
        catch(reject: any) {
          return execute().catch(reject);
        },
        finally(fn: any) {
          return execute().finally(fn);
        },
        [Symbol.toStringTag]: "GroupByBuilder",
      } as GroupByBuilder;
      return builder;
    },
    delete: () =>
      terminal(
        () => release().delete(),
        async () => {
          throw new Error(
            `Bulk delete on access-governed table "${table}" is not allowed for restricted callers in a query context`,
          );
        },
      ),
  };
  return guarded;
}

/** The refusal for raw SQL that mentions a governed table. */
export function governedRawSqlError(tables: string[]): Error {
  const list = tables.map((t) => `"${t}"`).join(", ");
  return new Error(
    `Raw SQL cannot read access-governed table${tables.length > 1 ? "s" : ""} ${list} from a query context — read through ctx.db.table() so the table's access policy applies`,
  );
}
