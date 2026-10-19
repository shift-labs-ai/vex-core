import type { TableAccessPolicy } from "./access.js";
import type { ExecContext } from "./tracer.js";

export type ColumnType = "string" | "number" | "boolean" | "json" | "any";

export interface ColumnDef {
  type: ColumnType;
  index?: boolean;
  optional?: boolean;
  default?: any;
  /**
   * Every name this column has had before. When the table has a column
   * by one of them and none by this name, that column is renamed in
   * place, keeping its data. When the table has neither, the migration
   * fails: a new table is created under the current names, so a previous
   * name that matches nothing is a mistake.
   */
  renamedFrom?: string[];
}

export interface TableSchema {
  columns: Record<string, ColumnDef>;
  indexes?: [name: string, columns: string[]][];
  unique?: string[][];
  /**
   * Every name this table has had before. When a table by one of them
   * exists and none by this name, it is renamed in place, keeping its
   * rows. When neither exists, the table is created as usual.
   */
  renamedFrom?: string[];
  /**
   * Row-level access policy (see core/access.ts). When present, every
   * query-context read of this table is filtered to the rows the
   * caller's prepared context accepts, raw SQL naming the table is
   * refused in query contexts, and mutation contexts stay ungoverned.
   */
  access?: TableAccessPolicy<any>;
}

export interface Filter {
  column: string;
  operator: "=" | "!=" | "<" | ">" | "<=" | ">=" | "IN";
  value: any;
}

export interface QueryBuilder {
  where(column: string, operator: Filter["operator"], value: any): QueryBuilder;
  select(...columns: string[]): QueryBuilder;
  order(column: string, dir?: "asc" | "desc"): QueryBuilder;
  limit(n: number): QueryBuilder;
  offset(n: number): QueryBuilder;
  all<T = Record<string, any>>(): Promise<T[]>;
  first<T = Record<string, any>>(): Promise<T | null>;
  distinct(column: string): Promise<any[]>;
  count(): Promise<number>;
  countDistinct(column: string): Promise<number>;
  sum(column: string): Promise<number>;
  avg(column: string): Promise<number>;
  min(column: string): Promise<number>;
  max(column: string): Promise<number>;
  groupBy(
    column: string | string[],
    aggs: Record<string, AggDef>,
  ): GroupByBuilder;
  delete(): Promise<number>;
}

export type AggDef =
  | "count"
  | ["sum" | "avg" | "min" | "max", string]
  | ["countDistinct", string];

export interface GroupByBuilder extends Promise<Record<string, any>[]> {
  having(
    column: string,
    operator: Filter["operator"],
    value: any,
  ): GroupByBuilder;
  order(column: string, dir?: "asc" | "desc"): GroupByBuilder;
  limit(n: number): GroupByBuilder;
}

export interface MutationTable {
  // Read (chainable — returns MutationTable so writes survive chaining)
  where(
    column: string,
    operator: Filter["operator"],
    value: any,
  ): MutationTable;
  select(...columns: string[]): MutationTable;
  order(column: string, dir?: "asc" | "desc"): MutationTable;
  limit(n: number): MutationTable;
  offset(n: number): MutationTable;
  all<T = Record<string, any>>(): Promise<T[]>;
  first<T = Record<string, any>>(): Promise<T | null>;
  distinct(column: string): Promise<any[]>;
  count(): Promise<number>;
  countDistinct(column: string): Promise<number>;
  sum(column: string): Promise<number>;
  avg(column: string): Promise<number>;
  min(column: string): Promise<number>;
  max(column: string): Promise<number>;
  groupBy(
    column: string | string[],
    aggs: Record<string, AggDef>,
  ): GroupByBuilder;

  // Write
  insert(row: Record<string, any>): Promise<string>;
  upsert(keys: Record<string, any>, data: Record<string, any>): Promise<void>;
  /** Updates one row; an id that is not a non-empty string throws. */
  update(id: string, data: Record<string, any>): Promise<void>;

  /**
   * `delete(id)` deletes one row; `delete()` deletes every row the
   * filters match. An id that is not a non-empty string throws rather
   * than reading as `delete()`.
   */
  delete(id?: string): Promise<boolean | number>;
}

export interface VexUser {
  id: string;
  name: string;
  isAdmin: boolean;
}

export interface CallContext {
  parent?: ExecContext;
  user?: VexUser | null;
}

export interface SubscriptionSummary {
  total: number;
  unique: number;
  queries: {
    name: string;
    args: string;
    count: number;
    tables: string[];
  }[];
}

export interface VexRuntime {
  triggerJob(name: string): Promise<{
    status: string | null | undefined;
    error: string | null | undefined;
    durationMs: number | null | undefined;
  }>;
  setJobEnabled(name: string, enabled: boolean): Promise<void>;
  describeSubscriptions(): SubscriptionSummary;
}

export interface QueryContext {
  db: {
    table(name: string): QueryBuilder;
    sql<T = Record<string, any>>(sql: string, ...params: any[]): Promise<T[]>;
  };
  runtime: VexRuntime;
  user?: VexUser | null;
}

export interface MutationContext {
  db: {
    table(name: string): MutationTable;
    sql<T = Record<string, any>>(sql: string, ...params: any[]): Promise<T[]>;
  };
  runtime: VexRuntime;
  user?: VexUser | null;
}

export interface ReactiveBudget {
  maxRows?: number;
  maxBytes?: number;
}

/**
 * What a query or mutation declares about who may run it. Its shape is
 * the app's, chosen as `Vex.create<A>`: then every query and mutation
 * must declare one, and leaving it out does not compile. The engine
 * decides nothing with it; it hands it to middleware with every call
 * (`MiddlewareInfo.access`) and answers it in `describeQuery` and
 * `describeMutation`, so the app's own gate decides, and can list what
 * every operation needs. An app that chooses none (`undefined`, the
 * default) declares none.
 */
export type OperationAccess<A> = undefined extends A
  ? { access?: A }
  : { access: A };

export type QueryDef<A = undefined> = {
  args: Record<string, string>;
  reactive?: false | ReactiveBudget;
  handler: (ctx: QueryContext, args: Record<string, any>) => Promise<any> | any;
} & OperationAccess<A>;

export type MutationDef<A = undefined> = {
  args: Record<string, string>;
  handler: (
    ctx: MutationContext,
    args: Record<string, any>,
  ) => Promise<any> | any;
} & OperationAccess<A>;

export interface JobDef {
  schedule: string;
  handler: (ctx: MutationContext) => Promise<void> | void;
  description?: string;
  enabled?: boolean;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
}

export interface WebhookRequest {
  body: any;
  rawBody: string;
  headers: Record<string, string>;
  method: string;
  path: string;
  query: Record<string, string>;
}

export interface WebhookResponse {
  status?: number;
  body?: any;
  headers?: Record<string, string>;
}

export interface WebhookDef {
  path: string;
  method?: "POST" | "GET" | "PUT" | "DELETE";
  verify?: (req: WebhookRequest) => boolean;
  handler: (
    ctx: MutationContext,
    req: WebhookRequest,
  ) => Promise<WebhookResponse | any> | WebhookResponse | any;
}

/**
 * The call middleware runs around. A query's or mutation's `access` is
 * the one its definition declares; it is `undefined` when that
 * definition has none, which the types allow only by default, but a
 * gate must still refuse it: a cast reaches here too. A webhook
 * declares none; its `verify` decides who may call it.
 */
export type MiddlewareInfo<A = undefined> =
  | {
      type: "query" | "mutation";
      name: string;
      args: Record<string, any>;
      access: A | undefined;
    }
  | {
      type: "webhook";
      name: string;
      args: Record<string, any>;
      access?: undefined;
    };

export type MiddlewareFn<A = undefined> = (
  ctx: QueryContext | MutationContext,
  info: MiddlewareInfo<A>,
  next: () => Promise<any> | any,
) => Promise<any> | any;

export interface PluginDef<A = undefined> {
  name: string;
  version?: string;
  tables: Record<string, TableSchema>;
  queries: Record<string, QueryDef<A>>;
  mutations: Record<string, MutationDef<A>>;
  jobs?: Record<string, JobDef>;
  webhooks?: Record<string, WebhookDef>;
  middleware?: MiddlewareFn<A>[];
}
