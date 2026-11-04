import type { TableAccessPolicy } from "./access.js";
import type { ExecContext } from "./tracer.js";
import type { ArgsOf, ArgsShape, Schema } from "./values.js";

/** How storage keeps a column: its storage type. */
export type ColumnType = "string" | "number" | "boolean" | "json";

/**
 * A column as an app declares it: a TypeBox schema (what values it
 * holds; `Type.Optional` lets it hold none), with what the table does
 * with it. `default` is the schema's: the value an insert that omits
 * the column gives it.
 */
export type ColumnDef = Schema & {
  default?: unknown;
  index?: boolean;
  /**
   * Every name this column has had before. When the table has a column
   * by one of them and none by this name, that column is renamed in
   * place, keeping its data. When the table has neither, the migration
   * fails: a new table is created under the current names, so a previous
   * name that matches nothing is a mistake.
   */
  renamedFrom?: string[];
};

/** A column as storage keeps it (`tables.ts` derives it). */
export interface StoredColumn {
  type: ColumnType;
  index?: boolean;
  optional?: boolean;
  default?: any;
  /** As {@link ColumnDef.renamedFrom}. */
  renamedFrom?: string[];
}

/** A table as storage keeps it: each column's storage type. */
export type StoredTableSchema = Omit<TableSchema, "columns"> & {
  columns: Record<string, StoredColumn>;
};

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
   * caller's prepared context accepts, `ctx.db.sql` reading the table is
   * refused in query contexts, `ctx.db.publishedSql` reads it only for
   * callers the policy leaves unrestricted, and mutation contexts stay
   * ungoverned.
   */
  access?: TableAccessPolicy<any>;
  /**
   * The table is part of the published dataset: what
   * `ctx.db.publishedSql` may read. Off unless set, so a table nobody
   * decided about is never readable that way.
   */
  published?: boolean;
}

export interface Filter {
  column: string;
  operator: "=" | "!=" | "<" | ">" | "<=" | ">=" | "IN";
  value: any;
}

/** One WHERE condition: a filter, or an OR of filter groups (`whereAny`). */
export type Condition = Filter | { any: Filter[][] };

export interface QueryBuilder {
  where(column: string, operator: Filter["operator"], value: any): QueryBuilder;
  /**
   * Keep the rows matching every filter of at least one group: an OR
   * of AND groups. No group matches nothing; an empty group, every row.
   */
  whereAny(groups: Filter[][]): QueryBuilder;
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
  /** {@link QueryBuilder.whereAny}. */
  whereAny(groups: Filter[][]): MutationTable;
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

/**
 * The app's settings (`VexOptions.env`): plain data every context and
 * every plugin's registration reads, the same on every thread. An app
 * declares its fields by augmenting this interface:
 *
 *   declare module "vex-core" {
 *     interface VexEnv { sessionRoot: string; publicUrl: string | null }
 *   }
 */
// biome-ignore lint/suspicious/noEmptyInterface: an app augments it.
export interface VexEnv {}

/**
 * The host's live capabilities (`VexOptions.services`): a process
 * fleet, a dispatcher, a network client. Actions alone hold them
 * (`ActionContext.services`), on the thread that owns them. An app
 * declares them by augmenting this interface, as it does `VexEnv`.
 */
// biome-ignore lint/suspicious/noEmptyInterface: an app augments it.
export interface VexServices {}

export interface CallContext {
  parent?: ExecContext;
  user?: VexUser | null;
  /** An action's caller stopping: the action sees it as
   *  `ActionContext.signal`. Queries and mutations ignore it. */
  signal?: AbortSignal;
}

/** How a subscription is made: as whom, and whom to tell of failures. */
export interface SubscribeContext extends CallContext {
  /**
   * The subscription's view could not be produced. `ended`: it is
   * over (its result outgrew its reactive budget) and hears nothing
   * more. Otherwise a run failed: the subscriber keeps the last
   * answer, and the next write that reaches the view runs it again.
   */
  onError?: (error: Error, ended: boolean) => void;
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

/** A column as a table declares it. */
export interface DescribedColumn {
  type: ColumnType;
  optional?: boolean;
}

/**
 * A published table, with every column a statement can read: its
 * declared columns and the `_id` every table has.
 */
export interface PublishedTable {
  name: string;
  columns: Record<string, DescribedColumn>;
}

/**
 * How a raw read is held to a table it reads (`QueryContext.db.sql`):
 * to the rows its filters match, and, when `reads` is given, to those
 * columns of them alone.
 */
export type Hold = Filter[] | { where: Filter[]; reads: string[] };

/**
 * What a raw read reads (`QueryContext.db.sql`): each table it reads,
 * held to rows (`Hold`), or read whole (`"all"`), every write to which
 * re-runs its subscriptions.
 */
export type Reads = Record<string, Hold | "all">;

export interface QueryContext {
  db: {
    table(name: string): QueryBuilder;
    /**
     * A raw read, of the tables `reads` names and no other: a table
     * read but not named is refused, so what a subscription depends on
     * is written down where it is read. A table held to rows (`Hold`)
     * is, inside the statement, those rows and nothing else, and only
     * the columns its `reads` name when given: a write to other rows,
     * or to other columns of them, does not re-run a subscription that
     * made it. A table read whole (`"all"`) re-runs it on every write.
     * The hold is the engine's, not the handler's word: a statement
     * cannot read past it, and one naming a held table under its
     * schema (`main.t`) is refused. A governed table is refused too,
     * as raw SQL cannot apply its policy.
     */
    sql<T = Record<string, any>>(
      reads: Reads,
      sql: string,
      ...params: any[]
    ): Promise<T[]>;
    /**
     * Runs SQL someone other than the app wrote: one statement that
     * SQLite's compiled program shows writes nothing and opens only
     * published tables (`TableSchema.published`), directly or through a
     * view, subquery or index. A published table with an access policy
     * is read only for callers the policy leaves unrestricted, since
     * raw SQL cannot apply its row filter. Anything else is refused, and
     * so is every statement on storage that cannot show its program.
     */
    publishedSql<T = Record<string, any>>(
      sql: string,
      ...params: any[]
    ): Promise<T[]>;
    /** The published dataset: every table `publishedSql` may read. */
    publishedTables(): PublishedTable[];
  };
  /**
   * Query `name`, called by name: a call of its own (its args
   * checked, decided by middleware, its answer checked) as this
   * query's caller, unless `as` names another. What it reads counts as
   * read by this query, so a subscription re-runs when it changes. A
   * query not registered rejects with `Query not found: name`. Within a
   * plugin a plain function over `ctx` composes as well, and costs
   * less; this composes queries other plugins own.
   */
  query<T = any>(
    name: string,
    args?: Record<string, any>,
    as?: { user: VexUser | null },
  ): Promise<T>;
  /** The app's settings (`VexEnv`). */
  env: Readonly<VexEnv>;
  /**
   * The time, to `resolutionMs` (a whole number, at least 1000): the
   * start of the current interval of that length. The query depends
   * on it: a subscription re-runs when the next interval begins. A
   * query reading the clock any other way (`Date.now`) depends on it
   * untracked: its subscriptions go stale, and `purityCheck` says so.
   */
  now(resolutionMs: number): number;
  user?: VexUser | null;
}

/**
 * Functions to run later, as the caller who scheduled them: a mutation
 * or action by name, with its args, checked when scheduled. In a
 * mutation a schedule is part of its transaction (it happens only if
 * the mutation commits); in an action it happens when called. Each
 * runs once; a finished one is kept a week.
 */
export interface Scheduler {
  /** Runs `name` after `ms` milliseconds; its scheduled id. */
  runAfter(
    ms: number,
    name: string,
    args?: Record<string, any>,
  ): Promise<string>;
  /** Runs `name` at `time` (ms since the epoch); its scheduled id. */
  runAt(
    time: number,
    name: string,
    args?: Record<string, any>,
  ): Promise<string>;
  /** Cancels a scheduled function not yet started. */
  cancel(id: string): Promise<void>;
}

export interface MutationContext {
  db: {
    table(name: string): MutationTable;
    /**
     * Raw SQL in the mutation's transaction: statements that read or
     * change rows. A schema change, a PRAGMA, an attached database or
     * a transaction statement is refused (schema changes are
     * migrations), and so is a write to a table the engine keeps.
     */
    sql<T = Record<string, any>>(sql: string, ...params: any[]): Promise<T[]>;
  };
  /** The time this call began: one value for every write it makes. */
  now(): number;
  /** A new id, as rows are given. */
  id(): string;
  /** A uniform float in [0, 1). */
  random(): number;
  /** Functions to run after this mutation commits (`Scheduler`). */
  scheduler: Scheduler;
  /** The app's settings (`VexEnv`). */
  env: Readonly<VexEnv>;
  user?: VexUser | null;
}

/**
 * What an action runs with: no database. It reads and writes through
 * the queries and mutations it calls, each a call of its own made as
 * the action's caller: decided by middleware, traced, and in its own
 * transaction. Nothing it does is held open while it waits.
 */
export interface ActionContext {
  /** As the action's caller, unless `as` names another (the app's to
   *  decide, by its middleware). */
  query<T = any>(
    name: string,
    args?: Record<string, any>,
    as?: { user: VexUser | null },
  ): Promise<T>;
  mutate<T = any>(
    name: string,
    args?: Record<string, any>,
    as?: { user: VexUser | null },
  ): Promise<T>;
  /** Another action, as the same caller (or `as`), stopped when this
   *  one is. */
  action<T = any>(
    name: string,
    args?: Record<string, any>,
    as?: { user: VexUser | null },
  ): Promise<T>;
  runtime: VexRuntime;
  /** Functions to run later (`Scheduler`). */
  scheduler: Scheduler;
  /** The app's settings (`VexEnv`). */
  env: Readonly<VexEnv>;
  /** The host's live capabilities (`VexServices`), as the app gave them. */
  services: VexServices;
  user?: VexUser | null;
  /** Aborted when the caller stops waiting (`/action`'s request
   *  closing): work that outlives its answer stops with it. */
  signal?: AbortSignal;
}

/**
 * What a migration runs with: SQL of any kind, the schema included,
 * and the engine's operations as the system. It runs in a transaction
 * of its own, before the engine serves anything.
 */
export interface MigrationContext {
  sql<T = Record<string, any>>(sql: string, ...params: any[]): Promise<T[]>;
  /** The app's settings (`VexEnv`). */
  env: Readonly<VexEnv>;
  /** As the caller `call` names: the system when it names none. */
  query<T = any>(
    name: string,
    args?: Record<string, any>,
    call?: CallContext,
  ): Promise<T>;
  /** As the caller `call` names: the system when it names none. */
  mutate<T = any>(
    name: string,
    args?: Record<string, any>,
    call?: CallContext,
  ): Promise<T>;
}

/** A change to the stored data or schema, applied once, by `id`. */
export interface Migration {
  id: string;
  up(m: MigrationContext): Promise<void> | void;
}

export interface ReactiveBudget {
  maxRows?: number;
  maxBytes?: number;
}

/**
 * What a query, mutation or action declares about who may run it. Its
 * shape is the app's, chosen as `Vex.create<A>`: then every operation
 * must declare one, and leaving it out does not compile. The engine
 * decides nothing with it; it hands it to middleware with every call
 * (`MiddlewareInfo.access`) and answers it in `describeQuery`,
 * `describeMutation` and `describeAction`, so the app's own gate
 * decides, and can list what every operation needs. An app that
 * chooses none (`undefined`, the default) declares none.
 */
export type OperationAccess<A> = undefined extends A
  ? { access?: A }
  : { access: A };

/**
 * A query: what it takes (`args`, a schema per arg, from which its
 * handler's args are typed), what it answers when it says (`returns`),
 * and its handler.
 */
export type QueryDef<A = undefined, S extends ArgsShape = any> = {
  args: S;
  returns?: Schema;
  reactive?: false | ReactiveBudget;
  handler: (ctx: QueryContext, args: ArgsOf<S>) => Promise<any> | any;
} & OperationAccess<A>;

export type MutationDef<A = undefined, S extends ArgsShape = any> = {
  args: S;
  returns?: Schema;
  handler: (ctx: MutationContext, args: ArgsOf<S>) => Promise<any> | any;
} & OperationAccess<A>;

/**
 * Work that cannot sit in a transaction: it waits (on a person, on
 * another process), spawns, or reaches outside the engine. It holds
 * no read and no transaction while it runs, so no handler timeout
 * bounds it; its own work does.
 */
export type ActionDef<A = undefined, S extends ArgsShape = any> = {
  args: S;
  returns?: Schema;
  handler: (ctx: ActionContext, args: ArgsOf<S>) => Promise<any> | any;
} & OperationAccess<A>;

/**
 * A scheduled action, run as the system: it may wait and reach outside
 * the engine; what it reads and writes goes through ctx.query and
 * ctx.mutate.
 */
export interface JobDef {
  schedule: string;
  handler: (ctx: ActionContext) => Promise<void> | void;
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
  /** An action reached over HTTP, as the system: it writes through
   *  ctx.mutate. */
  handler: (
    ctx: ActionContext,
    req: WebhookRequest,
  ) => Promise<WebhookResponse | any> | WebhookResponse | any;
}

/**
 * The call middleware runs around. A query's, mutation's or action's
 * `access` is the one its definition declares; it is `undefined` when
 * that definition has none, which the types allow only by default, but
 * a gate must still refuse it: a cast reaches here too. A webhook
 * declares none; its `verify` decides who may call it.
 */
export type MiddlewareInfo<A = undefined> =
  | {
      type: "query" | "mutation" | "action";
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
  ctx: QueryContext | MutationContext | ActionContext,
  info: MiddlewareInfo<A>,
  next: () => Promise<any> | any,
) => Promise<any> | any;

export interface PluginDef<A = undefined> {
  name: string;
  version?: string;
  tables: Record<string, TableSchema>;
  queries: Record<string, QueryDef<A>>;
  mutations: Record<string, MutationDef<A>>;
  actions?: Record<string, ActionDef<A>>;
  jobs?: Record<string, JobDef>;
  webhooks?: Record<string, WebhookDef>;
  middleware?: MiddlewareFn<A>[];
}
