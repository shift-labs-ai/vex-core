import type { ExecContext } from "./tracer.js";

export type ColumnType = "string" | "number" | "boolean" | "json" | "any";

export interface ColumnDef {
  type: ColumnType;
  index?: boolean;
  optional?: boolean;
  default?: any;
}

export interface TableSchema {
  columns: Record<string, ColumnDef>;
  indexes?: [name: string, columns: string[]][];
  unique?: string[][];
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
  update(id: string, data: Record<string, any>): Promise<void>;

  // Overloaded: delete(id) for single row, delete() for bulk with filters
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

export interface QueryDef {
  args: Record<string, string>;
  reactive?: false | ReactiveBudget;
  handler: (ctx: QueryContext, args: Record<string, any>) => Promise<any> | any;
}

export interface MutationDef {
  args: Record<string, string>;
  handler: (
    ctx: MutationContext,
    args: Record<string, any>,
  ) => Promise<any> | any;
}

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

export interface MiddlewareInfo {
  type: "query" | "mutation" | "webhook";
  name: string;
  args: Record<string, any>;
}

export type MiddlewareFn = (
  ctx: QueryContext | MutationContext,
  info: MiddlewareInfo,
  next: () => Promise<any> | any,
) => Promise<any> | any;

export interface PluginDef {
  name: string;
  version?: string;
  tables: Record<string, TableSchema>;
  queries: Record<string, QueryDef>;
  mutations: Record<string, MutationDef>;
  jobs?: Record<string, JobDef>;
  webhooks?: Record<string, WebhookDef>;
  middleware?: MiddlewareFn[];
}
