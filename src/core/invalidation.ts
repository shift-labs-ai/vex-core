import { serializeValue } from "./sql-value.js";
import type { QueryDependency, WriteDependency } from "./trace-metadata.js";
import type { ColumnType, Filter } from "./types.js";

/**
 * Whether a write can have changed what a filtered read of its table
 * sees, judged from the values every row the write touched holds both
 * before and after it (WriteDependency.values).
 *
 * A row that holds a value a filter rejects, before and after the
 * write, was never in the filtered set and did not enter it: a read
 * narrowed by that filter cannot have seen the write. One such filter
 * is enough to rule the write out; a filter on a column the write does
 * not know, or whose comparison the engine cannot reproduce as SQL
 * would, keeps the write in ("may be affected").
 *
 * An update (`changed` present) that touched no column the read
 * filters on, orders by or computes from (`reads`) left its result
 * as it was; one that changed nothing at all left every result as it
 * was. A read returning whole rows (no `reads`) sees every column.
 *
 * `columns` gives the declared type of each column the filters may
 * name (`_id` is a string). The adapters store each type under an SQL
 * affinity — `number` REAL, `boolean` INTEGER, the rest TEXT — and the
 * affinity converts bound values before comparing them: `'5'` in a
 * REAL column is 5, `5` in a TEXT column is `'5'`. Without the type
 * the judgment assumes nothing about the column and rules out less.
 */
export function writeMayAffect(
  dep: Pick<QueryDependency, "filters" | "any" | "reads" | "order">,
  write: Pick<WriteDependency, "values" | "changed" | "before" | "after">,
  columns?: Record<string, ColumnType>,
): boolean {
  const values = write.values ?? {};
  const before = write.before ?? {};
  const after = write.after ?? {};
  const excludes = (filter: Filter) => {
    // Nothing is in an empty list.
    if (
      filter.operator === "IN" &&
      Array.isArray(filter.value) &&
      filter.value.length === 0
    )
      return true;
    const type = columns?.[filter.column];
    if (filter.column in values)
      return filterExcludes(filter, values[filter.column], type);
    // A changed column: the row was outside before and stays outside.
    return (
      filter.column in before &&
      filter.column in after &&
      filterExcludes(filter, before[filter.column], type) &&
      filterExcludes(filter, after[filter.column], type)
    );
  };
  for (const filter of dep.filters ?? []) {
    if (excludes(filter)) return false;
  }
  for (const groups of dep.any ?? []) {
    // No group matches nothing; an empty group matches every row.
    if (groups.every((group) => group.some(excludes))) return false;
  }
  if (write.changed) {
    if (write.changed.length === 0) return false;
    if (!dep.reads) return true;
    const read = new Set<string>(dep.reads);
    for (const filter of dep.filters ?? []) read.add(filter.column);
    for (const groups of dep.any ?? [])
      for (const group of groups)
        for (const filter of group) read.add(filter.column);
    if (dep.order) read.add(dep.order.column);
    if (!write.changed.some((column) => read.has(column))) return false;
  }
  return true;
}

/**
 * Whether a column of `type` holds the same under `a` as under `b`:
 * what an update compares to tell a column it changes from one it
 * leaves. Certain equality only: a doubt counts as a change.
 */
export function sameValue(a: unknown, b: unknown, type?: ColumnType): boolean {
  const affinity = affinityOf(type);
  return certainlyEqual(bound(a, affinity), bound(b, affinity), affinity);
}

/**
 * The key two values share when SQL `=` may hold between them under
 * any affinity: numbers and numeric text under the number they name,
 * other text under itself, NULL under its own. Over-inclusive where
 * the column's affinity would keep `'5.0'` and `5` apart, never
 * exclusive where it would not.
 */
export function equalityKey(v: unknown): string {
  const value = bound(v, "unknown");
  if (value === null) return "null";
  if (typeof value === "number") return `n:${value}`;
  return numeric(value) ? `n:${Number(value)}` : `s:${value}`;
}

/**
 * Whether a row holding `value` in the filter's column is certainly
 * outside the filter. False means "may match": this never claims a
 * miss it cannot prove, so a doubt re-runs the subscription rather
 * than skipping it.
 *
 * Values are compared as the adapters' SQL would (`serializeValue`,
 * then the column's affinity): null, undefined and NaN are NULL; a
 * boolean is 1 or 0; an object is its JSON text. `=`/`!=` against NULL
 * read as IS (NOT) NULL; `IN` unions membership with an explicit NULL
 * check; any other comparison with NULL never matches. Ordering
 * operators are reproduced for numbers in a numeric column only: text
 * ordering follows SQL collation, which this does not model.
 */
export function filterExcludes(
  filter: Filter,
  value: unknown,
  type?: ColumnType,
): boolean {
  const affinity = affinityOf(type);
  const held = bound(value, affinity);
  switch (filter.operator) {
    case "=":
      return !possiblyEqual(held, bound(filter.value, affinity), affinity);
    case "!=": {
      const target = bound(filter.value, affinity);
      if (target === null) return held === null;
      if (held === null) return true;
      return certainlyEqual(held, target, affinity);
    }
    case "IN": {
      const targets = (
        Array.isArray(filter.value) ? filter.value : [filter.value]
      ).map((item) => bound(item, affinity));
      return !targets.some((target) => possiblyEqual(held, target, affinity));
    }
    case "<":
    case ">":
    case "<=":
    case ">=": {
      const target = bound(filter.value, affinity);
      if (held === null || target === null) return true;
      if (affinity !== "numeric") return false;
      if (typeof held !== "number" || typeof target !== "number") return false;
      return !ordered(held, filter.operator, target);
    }
  }
}

function ordered(a: number, operator: "<" | ">" | "<=" | ">=", b: number) {
  switch (operator) {
    case "<":
      return a < b;
    case ">":
      return a > b;
    case "<=":
      return a <= b;
    case ">=":
      return a >= b;
  }
}

type Affinity = "numeric" | "text" | "unknown";

function affinityOf(type: ColumnType | undefined): Affinity {
  switch (type) {
    case "number":
    case "boolean":
      return "numeric";
    case "string":
    case "json":
      return "text";
    default:
      return "unknown";
  }
}

type Bound = string | number | null;

/**
 * A value as the column holds it: bound as `serializeValue` binds it
 * (the drivers bind NaN as NULL), then the affinity's conversion of
 * text that looks numeric into a number. A TEXT column converts
 * numbers to text instead, but SQL's formatting of a real is not
 * reproduced here; the number is kept and compared with that in mind.
 */
function bound(v: unknown, affinity: Affinity): Bound {
  const serialized = serializeValue(v);
  let value: Bound;
  if (typeof serialized === "number")
    value = Number.isNaN(serialized) ? null : serialized;
  else if (typeof serialized === "bigint") value = Number(serialized);
  else if (typeof serialized === "string" || serialized === null)
    value = serialized;
  else value = String(serialized);
  if (affinity === "numeric" && typeof value === "string" && numeric(value))
    return Number(value);
  return value;
}

/** Text SQLite's affinity would convert to a number. */
function numeric(s: string): boolean {
  return /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(s);
}

/** SQL `=` may hold between the two bound values. */
function possiblyEqual(a: Bound, b: Bound, affinity: Affinity): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a === "string" && typeof b === "string") {
    if (a === b) return true;
    // A column of unknown type may be numeric, which would convert
    // both texts to numbers.
    return affinity === "unknown" && numeric(a) && numeric(b)
      ? Number(a) === Number(b)
      : false;
  }
  if (typeof a === typeof b) return a === b;
  const [num, str] =
    typeof a === "number" ? [a, b as string] : [b, a as string];
  // Numeric affinity converted every numeric-looking text already: the
  // rest is text against a number, never equal. A TEXT column converts
  // the number to text; with no type known, either may apply.
  if (affinity === "numeric") return false;
  return numeric(str) && Number(str) === num;
}

/** SQL `=` certainly holds between the two bound values. */
function certainlyEqual(a: Bound, b: Bound, affinity: Affinity): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a === typeof b) return a === b;
  if (affinity !== "text") return false;
  const [num, str] =
    typeof a === "number" ? [a, b as string] : [b, a as string];
  // An integer's text is unambiguous; a real's formatting is SQL's.
  return Number.isInteger(num) && `${num}` === str;
}
