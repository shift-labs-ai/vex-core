import type {
  AggDef,
  Filter,
  GroupByBuilder,
  QueryBuilder,
  TableSchema,
} from "../core/types.js";

export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export function serializeValue(v: any): any {
  if (v === undefined || v === null) return null;
  if (typeof v === "object") return JSON.stringify(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

interface RowTransform {
  column: string;
  kind: "json" | "boolean";
}

// Deserialization plans are cached per schema object: only json/any and
// boolean columns need per-row work, and most tables have none. ensureTable
// registers a fresh schema object on every (re)registration, so migrations
// invalidate naturally and the WeakMap cannot outlive the schemas it keys.
const rowTransformPlans = new WeakMap<TableSchema, RowTransform[]>();

function rowTransforms(schema: TableSchema): RowTransform[] {
  let plan = rowTransformPlans.get(schema);
  if (!plan) {
    plan = [];
    for (const [column, def] of Object.entries(schema.columns)) {
      if (def.type === "json" || def.type === "any") {
        plan.push({ column, kind: "json" });
      } else if (def.type === "boolean") {
        plan.push({ column, kind: "boolean" });
      }
    }
    rowTransformPlans.set(schema, plan);
  }
  return plan;
}

export function deserializeRow(
  row: Record<string, any>,
  schema: TableSchema | undefined,
): Record<string, any> {
  if (!schema) return row;
  for (const { column, kind } of rowTransforms(schema)) {
    if (!(column in row) || row[column] === null) continue;
    if (kind === "json") {
      if (typeof row[column] === "string") {
        try {
          row[column] = JSON.parse(row[column]);
        } catch {}
      }
    } else {
      row[column] = row[column] === 1 || row[column] === true;
    }
  }
  return row;
}

export function buildWhereClause(filters: Filter[]): {
  sql: string;
  params: any[];
} {
  if (filters.length === 0) return { sql: "", params: [] };
  const parts: string[] = [];
  const params: any[] = [];
  for (const f of filters) {
    const value = serializeValue(f.value);
    if (f.operator === "IN") {
      const arr = Array.isArray(f.value) ? f.value : [f.value];
      const values = arr.map(serializeValue);
      const nonNullValues = values.filter((item) => item !== null);
      const clauses: string[] = [];
      if (nonNullValues.length > 0) {
        clauses.push(
          `${quoteIdent(f.column)} IN (${nonNullValues.map(() => "?").join(", ")})`,
        );
        params.push(...nonNullValues);
      }
      if (values.some((item) => item === null)) {
        clauses.push(`${quoteIdent(f.column)} IS NULL`);
      }
      parts.push(clauses.length > 0 ? `(${clauses.join(" OR ")})` : "0 = 1");
    } else if (value === null && f.operator === "=") {
      parts.push(`${quoteIdent(f.column)} IS NULL`);
    } else if (value === null && f.operator === "!=") {
      parts.push(`${quoteIdent(f.column)} IS NOT NULL`);
    } else {
      parts.push(`${quoteIdent(f.column)} ${f.operator} ?`);
      params.push(value);
    }
  }
  return { sql: `WHERE ${parts.join(" AND ")}`, params };
}

export interface DbExec {
  all(sql: string, params: any[]): Promise<any[]>;
  run(sql: string, params: any[]): Promise<{ changes: number }>;
  schemas: Map<string, TableSchema>;
  markChanged?: (table: string, changes: number) => void;
}

export function createQueryBuilder(exec: DbExec, table: string): QueryBuilder {
  const filters: Filter[] = [];
  let selectCols: string[] | null = null;
  let orderCol: string | null = null;
  let orderDir: "asc" | "desc" = "asc";
  let limitN: number | null = null;
  let offsetN: number | null = null;

  function buildSql(countOnly = false): { sql: string; params: any[] } {
    const { sql: where, params } = buildWhereClause(filters);
    const select = countOnly
      ? "COUNT(*) as c"
      : selectCols
        ? selectCols.map((c) => quoteIdent(c)).join(", ")
        : "*";
    let sql = `SELECT ${select} FROM ${quoteIdent(table)} ${where}`;
    if (!countOnly && orderCol) {
      sql += ` ORDER BY ${quoteIdent(orderCol)} ${orderDir}`;
    }
    if (!countOnly && limitN !== null) sql += ` LIMIT ${limitN}`;
    if (!countOnly && limitN === null && offsetN !== null) sql += " LIMIT -1";
    if (!countOnly && offsetN !== null) sql += ` OFFSET ${offsetN}`;
    return { sql, params };
  }

  const builder: QueryBuilder = {
    where(column, operator, value) {
      filters.push({ column, operator, value });
      return builder;
    },
    select(...columns: string[]) {
      selectCols = columns;
      return builder;
    },
    order(column, dir = "asc") {
      orderCol = column;
      orderDir = dir;
      return builder;
    },
    limit(n) {
      limitN = n;
      return builder;
    },
    offset(n) {
      offsetN = n;
      return builder;
    },
    async all<T>(): Promise<T[]> {
      const { sql, params } = buildSql();
      const rows = await exec.all(sql, params);
      const schema = exec.schemas.get(table);
      return rows.map((r) => deserializeRow(r, schema)) as T[];
    },
    async first<T>(): Promise<T | null> {
      const saved = limitN;
      limitN = 1;
      const { sql, params } = buildSql();
      limitN = saved;
      const rows = await exec.all(sql, params);
      if (!rows[0]) return null;
      return deserializeRow(rows[0], exec.schemas.get(table)) as T;
    },
    async distinct(column: string): Promise<any[]> {
      const { sql: where, params } = buildWhereClause(filters);
      let sql = `SELECT DISTINCT ${quoteIdent(column)} FROM ${quoteIdent(table)} ${where}`;
      if (orderCol) sql += ` ORDER BY ${quoteIdent(orderCol)} ${orderDir}`;
      if (limitN !== null) sql += ` LIMIT ${limitN}`;
      if (limitN === null && offsetN !== null) sql += " LIMIT -1";
      if (offsetN !== null) sql += ` OFFSET ${offsetN}`;
      const rows = await exec.all(sql, params);
      return rows.map(
        (r) => deserializeRow(r, exec.schemas.get(table))[column],
      );
    },
    async count(): Promise<number> {
      const { sql, params } = buildSql(true);
      const rows = await exec.all(sql, params);
      return Number((rows[0] as any)?.c ?? 0);
    },
    async countDistinct(column: string): Promise<number> {
      const { sql: where, params } = buildWhereClause(filters);
      const rows = await exec.all(
        `SELECT COUNT(DISTINCT ${quoteIdent(column)}) as v FROM ${quoteIdent(table)} ${where}`,
        params,
      );
      return Number((rows[0] as any)?.v ?? 0);
    },
    async sum(column: string): Promise<number> {
      const { sql: where, params } = buildWhereClause(filters);
      const rows = await exec.all(
        `SELECT SUM(${quoteIdent(column)}) as v FROM ${quoteIdent(table)} ${where}`,
        params,
      );
      return Number((rows[0] as any)?.v ?? 0);
    },
    async avg(column: string): Promise<number> {
      const { sql: where, params } = buildWhereClause(filters);
      const rows = await exec.all(
        `SELECT AVG(${quoteIdent(column)}) as v FROM ${quoteIdent(table)} ${where}`,
        params,
      );
      return Number((rows[0] as any)?.v ?? 0);
    },
    async min(column: string): Promise<number> {
      const { sql: where, params } = buildWhereClause(filters);
      const rows = await exec.all(
        `SELECT MIN(${quoteIdent(column)}) as v FROM ${quoteIdent(table)} ${where}`,
        params,
      );
      return Number((rows[0] as any)?.v ?? 0);
    },
    async max(column: string): Promise<number> {
      const { sql: where, params } = buildWhereClause(filters);
      const rows = await exec.all(
        `SELECT MAX(${quoteIdent(column)}) as v FROM ${quoteIdent(table)} ${where}`,
        params,
      );
      return Number((rows[0] as any)?.v ?? 0);
    },
    groupBy(columns, aggs) {
      return createGroupByBuilder(exec, table, filters, columns, aggs);
    },
    async delete(): Promise<number> {
      const { sql: where, params } = buildWhereClause(filters);
      const result = await exec.run(
        `DELETE FROM ${quoteIdent(table)} ${where}`,
        params,
      );
      exec.markChanged?.(table, result.changes);
      return result.changes;
    },
  };
  return builder;
}

function buildAggSelect(aggs: Record<string, AggDef>): string[] {
  const selects: string[] = [];
  for (const [alias, def] of Object.entries(aggs)) {
    if (def === "count") {
      selects.push(`COUNT(*) as ${quoteIdent(alias)}`);
    } else {
      const [fn, col] = def;
      if (fn === "countDistinct") {
        selects.push(
          `COUNT(DISTINCT ${quoteIdent(col)}) as ${quoteIdent(alias)}`,
        );
      } else {
        selects.push(
          `${fn.toUpperCase()}(${quoteIdent(col)}) as ${quoteIdent(alias)}`,
        );
      }
    }
  }
  return selects;
}

function createGroupByBuilder(
  exec: DbExec,
  table: string,
  filters: Filter[],
  columns: string | string[],
  aggs: Record<string, AggDef>,
): GroupByBuilder {
  const cols = Array.isArray(columns) ? columns : [columns];
  const havingFilters: Filter[] = [];
  let orderCol: string | null = null;
  let orderDir: "asc" | "desc" = "asc";
  let limitN: number | null = null;

  function execute(): Promise<Record<string, any>[]> {
    const { sql: where, params } = buildWhereClause(filters);
    const groupCols = cols.map((c) => quoteIdent(c)).join(", ");
    const selects = [
      ...cols.map((c) => quoteIdent(c)),
      ...buildAggSelect(aggs),
    ];
    let sql = `SELECT ${selects.join(", ")} FROM ${quoteIdent(table)} ${where} GROUP BY ${groupCols}`;
    if (havingFilters.length > 0) {
      const { sql: having, params: havingParams } =
        buildWhereClause(havingFilters);
      sql += ` HAVING ${having.slice("WHERE ".length)}`;
      params.push(...havingParams);
    }
    if (orderCol) sql += ` ORDER BY ${quoteIdent(orderCol)} ${orderDir}`;
    if (limitN !== null) sql += ` LIMIT ${limitN}`;
    return exec
      .all(sql, params)
      .then((rows) =>
        rows.map((row) => deserializeRow(row, exec.schemas.get(table))),
      );
  }

  const builder: GroupByBuilder = {
    having(column: string, operator: Filter["operator"], value: any) {
      havingFilters.push({ column, operator, value });
      return builder;
    },
    order(column: string, dir: "asc" | "desc" = "asc") {
      orderCol = column;
      orderDir = dir;
      return builder;
    },
    limit(n: number) {
      limitN = n;
      return builder;
    },
    // biome-ignore lint/suspicious/noThenProperty: intentional — makes GroupByBuilder awaitable
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
  } as any;

  return builder;
}

export function buildInsertSql(table: string, keys: string[]): string {
  const cols = keys.map((k) => quoteIdent(k)).join(", ");
  const placeholders = keys.map(() => "?").join(", ");
  return `INSERT INTO ${quoteIdent(table)} (${cols}) VALUES (${placeholders})`;
}

export function buildUpdateSql(
  table: string,
  data: Record<string, any>,
): { sql: string; values: any[] } {
  const setClauses = Object.keys(data)
    .map((k) => `${quoteIdent(k)} = ?`)
    .join(", ");
  const values = Object.values(data).map(serializeValue);
  return {
    sql: `UPDATE ${quoteIdent(table)} SET ${setClauses} WHERE _id = ?`,
    values,
  };
}
