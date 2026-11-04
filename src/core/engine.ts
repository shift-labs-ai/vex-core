import type { TableAccessPolicy } from "./access.js";
import {
  governedRawSqlError,
  guardQueryBuilder,
  publishedGovernedError,
  UNRESTRICTED,
} from "./access.js";
import type { PluginFunction } from "./api.js";
import { resolvePlugin } from "./api.js";
import {
  type Evaluation,
  type EvaluationOptions,
  EvaluationPool,
  type EvaluationRequest,
  workersAvailable,
} from "./evaluation.js";
import {
  type FrameKind,
  inFrame,
  outsideFrame,
  refuseReentry,
} from "./frames.js";
import { holdStatement } from "./held-read.js";
import { id as generateId } from "./id.js";
import { INTERNAL_TABLES } from "./internal.js";
import { RAW, type RawAccess } from "./internal-access.js";
import { equalityKey, sameValue, writeMayAffect } from "./invalidation.js";
import { hashResult, utf8ByteLength } from "./result-measure.js";
import {
  splitStatements,
  statementKind,
  tablesRead,
  type ViewDefinition,
} from "./sql-text.js";
import { ANY_TABLE, CLOCK, type StorageAdapter } from "./storage.js";
import {
  describeQueryDependencies,
  describeWrites,
  type QueryDependency,
  type WriteDependency,
} from "./trace-metadata.js";
import type { ExecContext, Tracer } from "./tracer.js";
import { createRootSpan, isTraceRecording, noopExecCtx } from "./tracer.js";
import type {
  ActionContext,
  ActionDef,
  CallContext,
  ColumnType,
  DescribedColumn,
  JobDef,
  MiddlewareFn,
  MiddlewareInfo,
  Migration,
  MigrationContext,
  MutationContext,
  MutationDef,
  MutationTable,
  PluginDef,
  QueryBuilder,
  QueryContext,
  QueryDef,
  ReactiveBudget,
  Reads,
  SubscribeContext,
  TableSchema,
  VexRuntime,
  VexUser,
  WebhookRequest,
  WebhookResponse,
} from "./types.js";
import {
  type ArgsCheck,
  type ArgsShape,
  compileArgs,
  compileReturns,
  serializeJson,
} from "./values.js";

type SubscriptionCallback = (data: any) => void;
type SerializedSubscriptionCallback = (data: any, serialized?: string) => void;

const serializedSubscriptionCallbacks = new WeakSet<SubscriptionCallback>();

/** @internal Marks a transport callback that can consume measured JSON. */
export function withSerializedSubscriptionResult<
  T extends SerializedSubscriptionCallback,
>(callback: T): T {
  serializedSubscriptionCallbacks.add(callback);
  return callback;
}

function deliverSubscriptionResult(
  callback: SubscriptionCallback,
  result: any,
  serialized: string | undefined,
): void {
  if (serializedSubscriptionCallbacks.has(callback)) {
    (callback as SerializedSubscriptionCallback)(result, serialized);
  } else {
    callback(result);
  }
}

// Trace metadata is operational telemetry, not a request archive.
// The engine records stable execution facts (plugin, touched tables,
// row counts, status, duration) and leaves domain-specific payload
// summaries to explicit call-site metadata. Handler args/results can
// contain arbitrarily large files, imports, prompts, messages, or
// credentials, so they are never captured here by default.

/**
 * One query, with one set of args, for one caller, held live: what a
 * run computes once for every subscriber holding it. The group is
 * what a pass judges, what the index files, and what runs; its
 * members hear the result, each against what it last heard.
 */
interface SubscriptionGroup {
  key: string;
  queryName: string;
  args: Record<string, any>;
  user?: VexUser | null;
  members: Set<Subscription>;
  tables: Set<string>;
  dependencies: QueryDependency[];
  /** Its last run's answer, measured, which a member joining hears
   *  at once, as serialized. */
  last: ReactiveMeasurement | null;
  /**
   * While a run is open (`runGroup`): an invalidation that affects
   * the group marks it `stale` for that run to repeat, rather than
   * opening another; `run` is that run, for a joiner to await.
   */
  run: Promise<{ result: unknown; measurement: ReactiveMeasurement }> | null;
  stale: boolean;
  /** Its runs go to the evaluation pool: there is one, and its caller
   *  can cross to a worker. */
  offThread: boolean;
  /** Its query and args (`Vex.families`). */
  family: string;
  /**
   * The caller's fields its last run read; null before a run ends.
   * Every member is alike in these (`callerSeen`).
   */
  reads: Set<string> | null;
  /** When its last run's answer stops holding (`QueryContext.now`). */
  clockUntil?: number;
  /** Filed in the index by its dependencies (`indexGroup`). */
  filed: boolean;
}

interface Subscription {
  id: string;
  group: SubscriptionGroup;
  callback: SubscriptionCallback;
  lastHash: number;
  onError?: SubscribeContext["onError"];
  /** The caller it was made for. */
  user: VexUser | null | undefined;
}

/**
 * A value as JSON with every object's keys sorted, so two values with
 * the same data spell alike; null when it holds anything JSON cannot
 * say (a function, a symbol, a cycle).
 */
function canonical(value: unknown, seen = new Set<object>()): string | null {
  if (value === null || typeof value !== "object") {
    if (
      typeof value === "function" ||
      typeof value === "symbol" ||
      typeof value === "bigint"
    )
      return null;
    return value === undefined ? "null" : JSON.stringify(value);
  }
  if (seen.has(value)) return null;
  seen.add(value);
  try {
    if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
      return canonical((value as { toJSON(): unknown }).toJSON(), seen);
    }
    if (Array.isArray(value)) {
      const items = value.map((item) => canonical(item, seen));
      return items.includes(null) ? null : `[${items.join(",")}]`;
    }
    const entries: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) continue;
      const spelled = canonical(item, seen);
      if (spelled === null) return null;
      entries.push(`${JSON.stringify(key)}:${spelled}`);
    }
    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

/**
 * The fields of `user` that `reads` names, spelled canonically: what a
 * group's runs saw of their caller. Unknown reads (no run yet) are the
 * whole caller.
 */
function callerSeen(
  user: VexUser | null | undefined,
  reads: ReadonlySet<string> | null,
): string {
  if (user == null) return "none";
  if (reads === null) return canonical(user) ?? "";
  const seen: Record<string, unknown> = {};
  for (const key of reads) {
    if (Object.hasOwn(user, key)) seen[key] = (user as any)[key];
  }
  return canonical(seen) ?? "";
}

/**
 * `user` as a handler sees it, each field it reads recorded in
 * `reads`: a spread or a listing of its keys reads every field.
 */
function trackedCaller(user: VexUser, reads: Set<string>): VexUser {
  return new Proxy(user, {
    get(target, prop, receiver) {
      if (typeof prop === "string") reads.add(prop);
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      if (typeof prop === "string") reads.add(prop);
      return Reflect.has(target, prop);
    },
    ownKeys(target) {
      for (const key of Object.keys(target)) reads.add(key);
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop === "string") reads.add(prop);
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });
}

/** A measured result as a joiner hears it: its serialized form, read. */
function parsed(measurement: ReactiveMeasurement): unknown {
  return measurement.serialized === undefined
    ? undefined
    : JSON.parse(measurement.serialized);
}

/**
 * A raw write in a mutation, as its trace records it: it names no rows,
 * and which tables it changed the adapter reports (`takeChanges`).
 */
const RAW_WRITE: WriteDependency = { table: ANY_TABLE, raw: true };

/**
 * How many rows a filtered delete reads back to record one by one;
 * past that, the delete is recorded by its `=` filters alone.
 */
const DELETE_ROWS_RECORDED = 200;

const columnTypesBySchema = new WeakMap<
  TableSchema,
  Record<string, ColumnType>
>();

/**
 * Where a group is found when a table changes: by shape (the columns
 * a dependency holds equal to values, `=` or `IN`), under each
 * combination of those values' keys; or under `wide` when a
 * dependency on the table holds no column so. A write that knows a
 * row's value of every column of a shape judges the groups filed
 * under that combination (and, for a column it changes, under the
 * combinations with the value it leaves too) and the wide ones; a
 * write that does not know one, every group of the shape.
 */
interface TableIndex {
  wide: Set<SubscriptionGroup>;
  byShape: Map<string, Shape>;
  all: Set<SubscriptionGroup>;
}

/** The groups under one key: one, as it is, or a set from the second. */
type Slot = SubscriptionGroup | Set<SubscriptionGroup>;

interface Shape {
  columns: string[];
  byKeys: Map<string, Slot>;
}

function slotAdd(
  byKeys: Map<string, Slot>,
  key: string,
  group: SubscriptionGroup,
) {
  const slot = byKeys.get(key);
  if (slot === undefined) byKeys.set(key, group);
  else if (slot instanceof Set) slot.add(group);
  else if (slot !== group) byKeys.set(key, new Set([slot, group]));
}

function slotDelete(
  byKeys: Map<string, Slot>,
  key: string,
  group: SubscriptionGroup,
) {
  const slot = byKeys.get(key);
  if (slot === undefined) return;
  if (slot instanceof Set) {
    slot.delete(group);
    if (slot.size === 1) byKeys.set(key, slot.values().next().value!);
  } else if (slot === group) byKeys.delete(key);
}

function slotEach(slot: Slot, into: Set<SubscriptionGroup>) {
  if (slot instanceof Set) for (const group of slot) into.add(group);
  else into.add(slot);
}

/**
 * The columns a dependency holds equal to values (`=`, `IN`), sorted,
 * each with the keys of those values; a column held twice keeps the
 * keys both allow. Empty for a raw read or one holding none so.
 */
function equalitiesOf(dep: QueryDependency): Map<string, Set<string>> {
  const equalities = new Map<string, Set<string>>();
  if (dep.raw) return equalities;
  for (const filter of dep.filters ?? []) {
    const values =
      filter.operator === "="
        ? [filter.value]
        : filter.operator === "IN" && Array.isArray(filter.value)
          ? filter.value
          : null;
    if (!values) continue;
    const keys = new Set(values.map(equalityKey));
    const held = equalities.get(filter.column);
    equalities.set(
      filter.column,
      held ? new Set([...held].filter((key) => keys.has(key))) : keys,
    );
  }
  return new Map([...equalities].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** Every combination of one key per column, joined; empty for none. */
function combinations(keysByColumn: Iterable<Iterable<string>>): string[] {
  let combos = [""];
  for (const keys of keysByColumn) {
    const next: string[] = [];
    for (const combo of combos) {
      for (const key of keys) next.push(combo ? `${combo}\0${key}` : key);
    }
    combos = next;
  }
  return combos;
}

/**
 * The keys a write's rows may hold under a shape's columns: one per
 * column it holds, both the value left and taken for one it changes;
 * null when it does not know a column.
 */
function writeKeys(write: WriteDependency, columns: string[]): string[] | null {
  const values = write.values ?? {};
  const keysByColumn: string[][] = [];
  for (const column of columns) {
    if (column in values) keysByColumn.push([equalityKey(values[column])]);
    else if (write.before && column in write.before && write.after) {
      keysByColumn.push([
        equalityKey(write.before[column]),
        equalityKey(write.after[column]),
      ]);
    } else return null;
  }
  return combinations(keysByColumn);
}

/** How many value combinations a dependency may file under; past it, wide. */
const FILING_KEYS = 1000;

/**
 * Where a dependency files its group: under a shape, the columns it
 * holds equal to values (sorted, joined), at each combination of
 * those values' keys; or wide, under no shape, when it holds none so
 * or the combinations are too many.
 */
function filingOf(
  dep: QueryDependency,
): { shape: string; keys: string[] } | null {
  const equalities = equalitiesOf(dep);
  if (equalities.size === 0) return null;
  const keys = combinations(equalities.values());
  if (keys.length > FILING_KEYS) return null;
  return { shape: [...equalities.keys()].join(","), keys };
}

function groupWritesByTable(
  writes: WriteDependency[] | undefined,
): Map<string, WriteDependency[]> | undefined {
  if (!writes) return undefined;
  const byTable = new Map<string, WriteDependency[]>();
  for (const write of writes) {
    const group = byTable.get(write.table);
    if (group) group.push(write);
    else byTable.set(write.table, [write]);
  }
  return byTable;
}

// The registries carry each declaration from its definition to
// middleware without reading it, so they hold it erased (`any`): `A`
// types what an app sees (`use`, the descriptions), and that is what
// lets a bare `Vex` hold an engine of any declaration.
/** An operation as registered: its definition, and its checks compiled. */
interface Registered<D> {
  plugin: string;
  def: D;
  args: ArgsCheck;
  returns: ((value: unknown) => void) | undefined;
}
type RegisteredQuery = Registered<QueryDef<any>>;
type RegisteredMutation = Registered<MutationDef<any>>;
type RegisteredAction = Registered<ActionDef<any>>;

/**
 * How the engine describes an operation, wherever it does: its
 * plugin, its args, and the access it declares (`OperationAccess`),
 * `undefined` when it declares none.
 */
export interface OperationDescription<A> {
  plugin: string;
  args: ArgsShape;
  access: A | undefined;
}

function describeOperation<A>(
  registered: RegisteredQuery | RegisteredMutation | RegisteredAction,
): OperationDescription<A> {
  return {
    plugin: registered.plugin,
    args: registered.def.args,
    access: registered.def.access,
  };
}

/** A reactive result as subscriptions compare and budget it. */
interface ReactiveMeasurement {
  hash: number;
  resultRows: number | undefined;
  resultBytes: number;
  serialized: string | undefined;
  /** Whether the result is its own JSON reading (`serializeJson`). */
  exact: boolean;
}

/**
 * An invalidation pass not yet begun, which every write committing
 * before it begins joins: their recorded writes together, or nothing
 * when one of them recorded none.
 */
interface PendingInvalidation {
  writes: WriteDependency[] | undefined;
  commits: number;
  pass: Promise<void>;
}

/** Resolves once the current turn's microtasks have drained. */
const nextTurn: () => Promise<void> =
  typeof setImmediate === "function"
    ? () => new Promise((resolve) => setImmediate(resolve))
    : () => new Promise((resolve) => setTimeout(resolve, 0));

interface JobRunResult {
  status: "ok" | "error";
  error: string | null;
  durationMs: number;
}

/**
 * `A` is the app's access declaration (`OperationAccess`): what every
 * query, mutation and action of every plugin must declare. Unchosen,
 * there is none to declare.
 */
export interface VexOptions<A = undefined> {
  plugins: Array<PluginFunction<A> | PluginDef<A>>;
  storage: StorageAdapter;
  tracer?: Tracer;
  appId?: string;
  handlerTimeoutMs?: number;
  reactive?: ReactiveBudget;
  /**
   * What runs jobs when they come due. "timers" (default): the engine,
   * on in-process timers. "external": the host calls `runDueJobs()` at
   * `nextJobRun()`, e.g. from a Durable Object alarm, and the engine
   * starts no timers. "none": the engine takes no job on, storing and
   * running none: an engine that only reads, as an evaluation
   * worker's.
   */
  jobScheduler?: "timers" | "external" | "none";
  /**
   * Changes to the stored data or schema, applied once each, in order,
   * each in a transaction, after every table is ensured and before the
   * engine serves anything or runs a job. The one place SQL may change
   * the schema.
   */
  migrations?: readonly Migration[];
  /**
   * Whether to check that queries answer from their context alone:
   * a run is repeated on the same data and the answers compared, and
   * a subscription a write skipped is run again and compared with its
   * last answer. A query whose answers differ is refused (a run) or
   * ended (a subscription), naming it: its answer depends on state no
   * context tracks, such as a module's variables. "always", a share of
   * runs (0 to 1), or "off" (the default). It runs each checked query
   * twice.
   */
  purityCheck?: "always" | "off" | number;
  /**
   * Evaluate subscriptions off the main thread, in workers each running
   * a read-only engine over the same database (`EvaluationOptions`).
   * Where the runtime has no workers, or for a caller that cannot
   * cross to one, evaluation stays on the main thread.
   */
  evaluation?: EvaluationOptions;
}

/**
 * The engine. `A` is the access declaration its operations carry
 * (`Vex.create<A>`). A bare `Vex` is an engine whose declarations its
 * holder does not read, so it holds an engine of any declaration;
 * code that reads them names the type (`Vex<Access>`).
 */
export class Vex<A = unknown> {
  private storage: StorageAdapter;
  // Erased as the registries are (RegisteredQuery).
  private plugins: PluginDef<any>[] = [];
  private queries: Map<string, RegisteredQuery> = new Map();
  private mutations: Map<string, RegisteredMutation> = new Map();
  private actions: Map<string, RegisteredAction> = new Map();
  private subscriptions: Map<string, Subscription> = new Map();
  private groups: Map<string, SubscriptionGroup> = new Map();
  // Each group by the tables and values its last run read
  // (`indexGroup`); a group with a run open is judged regardless.
  private groupIndex: Map<string, TableIndex> = new Map();
  private anyTableGroups: Set<SubscriptionGroup> = new Set();
  private runningGroups: Set<SubscriptionGroup> = new Set();
  private tables: Set<string> = new Set();
  private middleware: MiddlewareFn<any>[] = [];
  // Row-level access policies by table (core/access.ts). Applied to
  // every query-context read; mutation contexts are the trusted tier.
  private accessPolicies: Map<string, TableAccessPolicy<any>> = new Map();
  private cronTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private jobHandlers: Map<string, JobDef> = new Map();
  private jobIntervalMs: Map<string, number> = new Map();
  private runningJobs: Map<string, Promise<JobRunResult>> = new Map();
  // Each job's registration, removal and enabling, in call order per
  // name: the last call for a name decides its row and its timer.
  private jobChanges: Map<string, Promise<void>> = new Map();
  private jobScheduler: "timers" | "external" | "none" = "timers";
  // Set by close(): a closed engine refuses job changes, job runs and
  // subscriptions.
  private closing: Promise<void> | null = null;
  // The invalidation pass the commits of this turn of the event loop
  // share (`invalidateAfter`).
  private pendingInvalidation: PendingInvalidation | null = null;
  private evaluation: EvaluationPool | null = null;
  private announcingStorage: StorageAdapter | null = null;
  // Groups whose answers hold until a time (`clockUntil`), and the one
  // timer that wakes at the soonest.
  private readonly clockGroups = new Set<SubscriptionGroup>();
  private clockTimer: ReturnType<typeof setTimeout> | null = null;
  private clockAt = Number.POSITIVE_INFINITY;
  // Each query with one set of args: its groups, one per set of
  // callers alike in every field its runs read.
  private readonly families = new Map<string, Set<SubscriptionGroup>>();
  private groupSerial = 0;
  // The share of runs `purityCheck` repeats.
  private purity = 0;
  private subIdCounter = 0;
  private tracer: Tracer | null = null;
  private appId: string = "unknown";
  private handlerTimeoutMs: number = 0;
  private reactiveDefaults: Required<ReactiveBudget> = {
    maxRows: 1000,
    maxBytes: 1024 * 1024,
  };

  private constructor(storage: StorageAdapter) {
    this.storage = storage;
  }

  setTracer(tracer: Tracer | null) {
    this.tracer = tracer;
  }
  setAppId(appId: string) {
    this.appId = appId;
  }
  setHandlerTimeout(ms: number) {
    this.handlerTimeoutMs = ms;
  }

  // ─── Core execution ───
  //
  // trace(type, name, parent?, fn)
  //   parent given  → child span (continues existing trace)
  //   parent absent → root span (starts new trace)
  //
  // Every engine operation goes through trace(). Nothing skips it.

  private async trace<T>(
    type: string,
    name: string,
    parent: ExecContext | undefined | null,
    fn: (ectx: ExecContext, meta: Record<string, any>) => Promise<T> | T,
  ): Promise<T> {
    const ectx = parent
      ? { traceId: parent.traceId, span: parent.span.child(type, name) }
      : createRootSpan(this.tracer, this.appId, type, name);
    const meta: Record<string, any> = {};
    try {
      const result = await fn(ectx, meta);
      ectx.span.end("ok", { meta });
      return result;
    } catch (e: any) {
      if (isTraceRecording(ectx)) meta.stack = e.stack ?? null;
      ectx.span.end("error", { error: e.message, meta });
      throw e;
    }
  }

  // ─── Factory ───

  /**
   * `A` is never inferred, from the plugins or from where the engine
   * goes: an app names its access declaration (`Vex.create<Access>`)
   * or has none.
   */
  static async create<A = undefined>(
    options: VexOptions<NoInfer<A>>,
  ): Promise<Vex<NoInfer<A>>> {
    const vex = new Vex<A>(options.storage);
    if (options.tracer) vex.tracer = options.tracer;
    if (options.appId) vex.appId = options.appId;
    if (options.jobScheduler) vex.jobScheduler = options.jobScheduler;
    const purity = options.purityCheck ?? "off";
    if (
      purity !== "off" &&
      purity !== "always" &&
      !(purity >= 0 && purity <= 1)
    ) {
      throw new TypeError(
        'purityCheck: "always", "off", or a share of runs from 0 to 1',
      );
    }
    vex.purity = purity === "always" ? 1 : purity === "off" ? 0 : purity;
    if (options.handlerTimeoutMs)
      vex.handlerTimeoutMs = options.handlerTimeoutMs;
    if (options.reactive) {
      vex.reactiveDefaults = {
        maxRows: options.reactive.maxRows ?? vex.reactiveDefaults.maxRows,
        maxBytes: options.reactive.maxBytes ?? vex.reactiveDefaults.maxBytes,
      };
    }

    const plugins = options.plugins.map(resolvePlugin);
    claimTableNames(plugins);

    // Register internal tables
    for (const [name, schema] of Object.entries(INTERNAL_TABLES)) {
      vex.tables.add(name);
      await vex.storage.ensureTable(name, schema);
    }

    for (const plugin of plugins) {
      vex.plugins.push(plugin);
      await vex.registerPlugin(plugin);
    }
    await vex.migrate(options.migrations ?? []);
    // Jobs arm last: none runs against data a migration has yet to
    // change.
    for (const plugin of plugins) await vex.registerJobs(plugin);

    // After every table is ensured: a worker's read-only engine
    // registers the tables it finds, and refuses one it does not.
    if (
      options.evaluation &&
      options.evaluation.workers > 0 &&
      workersAvailable()
    ) {
      vex.evaluation = new EvaluationPool(
        new URL("./evaluation-worker.js", import.meta.url),
        options.evaluation.workers,
        {
          module: String(options.evaluation.module),
          setup: options.evaluation.setup,
          handlerTimeoutMs: vex.handlerTimeoutMs,
          reactive: vex.reactiveDefaults,
        },
      );
    }

    return vex;
  }

  // ─── Internal ───

  private async registerPlugin(plugin: PluginDef<any>): Promise<void> {
    if (plugin.middleware) this.middleware.push(...plugin.middleware);

    for (const [tableName, schema] of Object.entries(plugin.tables)) {
      this.tables.add(tableName);
      if (schema.access) this.accessPolicies.set(tableName, schema.access);
      await this.storage.ensureTable(tableName, schema);
    }

    for (const [name, def] of Object.entries(plugin.queries)) {
      const key = `${plugin.name}.${name}`;
      if (this.queries.has(key)) throw new Error(`Duplicate query: ${key}`);
      this.queries.set(key, {
        plugin: plugin.name,
        def,
        args: compileArgs("query", key, def.args),
        returns: compileReturns("query", key, def.returns),
      });
    }

    for (const [name, def] of Object.entries(plugin.mutations)) {
      const key = `${plugin.name}.${name}`;
      if (this.mutations.has(key))
        throw new Error(`Duplicate mutation: ${key}`);
      this.mutations.set(key, {
        plugin: plugin.name,
        def,
        args: compileArgs("mutation", key, def.args),
        returns: compileReturns("mutation", key, def.returns),
      });
    }

    for (const [name, def] of Object.entries(plugin.actions ?? {})) {
      const key = `${plugin.name}.${name}`;
      if (this.actions.has(key)) throw new Error(`Duplicate action: ${key}`);
      this.actions.set(key, {
        plugin: plugin.name,
        def,
        args: compileArgs("action", key, def.args),
        returns: compileReturns("action", key, def.returns),
      });
    }
  }

  private async registerJobs(plugin: PluginDef<any>): Promise<void> {
    if (this.jobScheduler === "none") return;
    for (const [name, job] of Object.entries(plugin.jobs ?? {})) {
      const cronName = `${plugin.name}.${name}`;
      await this.addJob(cronName, job, plugin.name);
    }
  }

  /** Applies each migration not yet applied, in order (`migrations`). */
  private async migrate(migrations: readonly Migration[]): Promise<void> {
    const ids = new Set<string>();
    for (const { id } of migrations) {
      if (ids.has(id)) throw new Error(`Duplicate migration: ${id}`);
      ids.add(id);
    }
    // A read-only engine (a worker's) changes nothing.
    if (this.jobScheduler === "none" || migrations.length === 0) return;
    const applied = new Set(
      (
        await this.storage.rawQuery<{ migrationId: string }>(
          "SELECT migrationId FROM _migrations",
        )
      ).map((row) => row.migrationId),
    );
    const context: MigrationContext = {
      // The adapter forgets what it compiled when the schema moves.
      sql: <T>(sql: string, ...params: any[]) =>
        this.storage.rawQuery<T>(sql, ...params),
      query: (name, args = {}, call) => this.query(name, args, call),
      mutate: (name, args = {}, call) => this.mutate(name, args, call),
    };
    for (const migration of migrations) {
      if (applied.has(migration.id)) continue;
      await this.trace("migration", migration.id, null, () =>
        this.storage.transaction(async () => {
          await migration.up(context);
          await this.storage.insert("_migrations", {
            _id: generateId(12),
            migrationId: migration.id,
            appliedAt: Date.now(),
          });
        }),
      );
      await this.announceWrites();
    }
  }

  private assertOpen(): void {
    if (this.closing) throw new Error("Vex engine is closed");
  }

  /**
   * Runs `change` after every earlier change to job `name` has settled.
   * A change awaits storage before it arms a timer; one at a time, in
   * call order, a later call never lands inside an earlier one's awaits,
   * so the last call decides the job's row and its timer.
   */
  private changeJob(name: string, change: () => Promise<void>): Promise<void> {
    const previous = this.jobChanges.get(name) ?? Promise.resolve();
    const result = previous.then(change);
    const settled = result.catch(() => {});
    this.jobChanges.set(name, settled);
    settled.then(() => {
      if (this.jobChanges.get(name) === settled) this.jobChanges.delete(name);
    });
    return result;
  }

  /** True while `job` is the one registered as `name` on an open engine. */
  private isCurrentJob(name: string, job: JobDef): boolean {
    return !this.closing && this.jobHandlers.get(name) === job;
  }

  // Runs the job at `firstRun`, then every `ms`. Under an external
  // scheduler the host runs due jobs instead.
  private startJobTimer(
    cronName: string,
    job: JobDef,
    ms: number,
    firstRun: number,
  ) {
    if (this.jobScheduler !== "timers" || this.cronTimers.has(cronName)) return;
    const run = () => this.executeJob(cronName, job);
    const first = setTimeout(
      () => {
        this.cronTimers.set(cronName, setInterval(run, ms));
        run();
      },
      Math.max(0, firstRun - Date.now()),
    );
    this.cronTimers.set(cronName, first);
  }

  private stopJobTimer(cronName: string) {
    const timer = this.cronTimers.get(cronName);
    if (timer) {
      // Clears a pending first run and a running interval alike.
      clearTimeout(timer);
      this.cronTimers.delete(cronName);
    }
  }

  async addJob(name: string, job: JobDef, plugin = "_dynamic") {
    this.assertOpen();
    if (this.jobScheduler === "none") {
      throw new Error(`Job ${name} cannot be added: this engine runs no jobs`);
    }
    const ms = parseSchedule(job.schedule);
    if (ms <= 0) throw new Error(`Invalid schedule: ${job.schedule}`);

    this.stopJobTimer(name);
    this.jobHandlers.set(name, job);
    this.jobIntervalMs.set(name, ms);
    return this.changeJob(name, () => this.storeJob(name, job, ms, plugin));
  }

  // Writes the job's row and arms its timer, unless a later call for
  // the name, or close(), has taken over.
  private async storeJob(
    name: string,
    job: JobDef,
    ms: number,
    plugin: string,
  ): Promise<void> {
    if (!this.isCurrentJob(name, job)) return;
    const existing = await this.storage
      .rawQuery<any>("SELECT _id, nextRun FROM _jobs WHERE name = ?", name)
      .then((r) => r[0]);
    const enabled = job.enabled !== false;
    // A pending run survives a restart: the job runs when it was due, or
    // one interval from now if that is sooner.
    const nextRun = enabled
      ? Math.min(existing?.nextRun ?? Number.POSITIVE_INFINITY, Date.now() + ms)
      : null;
    const row = {
      plugin,
      schedule: job.schedule,
      description: job.description ?? null,
      enabled: enabled ? 1 : 0,
      timeoutMs: job.timeoutMs ?? null,
      retries: job.retries ?? 0,
      retryDelayMs: job.retryDelayMs ?? null,
      nextRun,
    };
    if (existing) await this.storage.update("_jobs", existing._id, row);
    else await this.storage.insert("_jobs", { name, ...row, runs: 0 });

    if (nextRun !== null && this.isCurrentJob(name, job)) {
      this.startJobTimer(name, job, ms, nextRun);
    }
  }

  async removeJob(name: string) {
    this.assertOpen();
    this.stopJobTimer(name);
    this.jobHandlers.delete(name);
    this.jobIntervalMs.delete(name);
    return this.changeJob(name, async () => {
      // A later addJob for the name writes its own row.
      if (this.jobHandlers.has(name)) return;
      const row = await this.storage
        .rawQuery<any>("SELECT _id FROM _jobs WHERE name = ?", name)
        .then((r) => r[0]);
      if (row) await this.storage.delete("_jobs", row._id);
    });
  }

  async setJobEnabled(name: string, enabled: boolean) {
    this.assertOpen();
    const handler = this.jobHandlers.get(name);
    if (!handler) throw new Error(`Job not found: ${name}`);
    const ms = this.jobIntervalMs.get(name) ?? 0;

    return this.changeJob(name, async () => {
      if (!this.isCurrentJob(name, handler)) return;
      const row = await this.storage
        .rawQuery<any>("SELECT _id FROM _jobs WHERE name = ?", name)
        .then((r) => r[0]);
      if (!row) throw new Error(`Job not found in DB: ${name}`);

      if (enabled && ms > 0) {
        const nextRun = Date.now() + ms;
        await this.storage.update("_jobs", row._id, { enabled: 1, nextRun });
        if (this.isCurrentJob(name, handler)) {
          this.startJobTimer(name, handler, ms, nextRun);
        }
      } else {
        this.stopJobTimer(name);
        await this.storage.update("_jobs", row._id, {
          enabled: 0,
          nextRun: null,
        });
      }
    });
  }

  // Jobs are single-flight per name: while a run (including retries and
  // still-settling timed-out handlers) is active, scheduled ticks and
  // manual triggers join the in-flight promise instead of starting a
  // second concurrent execution. Missed ticks are coalesced, not queued.
  private async executeJob(
    cronName: string,
    job: JobDef,
  ): Promise<JobRunResult> {
    const existing = this.runningJobs.get(cronName);
    if (existing) return existing;

    const running = this.executeJobLocked(cronName, job);
    this.runningJobs.set(cronName, running);
    try {
      return await running;
    } finally {
      if (this.runningJobs.get(cronName) === running) {
        this.runningJobs.delete(cronName);
      }
    }
  }

  private async executeJobLocked(
    cronName: string,
    job: JobDef,
  ): Promise<JobRunResult> {
    const startTime = Date.now();
    const timeoutMs = job.timeoutMs ?? 0;
    const maxRetries = job.retries ?? 0;
    const retryDelay = job.retryDelayMs ?? 1000;

    const ms = this.jobIntervalMs.get(cronName) ?? 0;

    // Increment runs counter + set nextRun
    const row = await this.storage
      .rawQuery<any>("SELECT _id, runs FROM _jobs WHERE name = ?", cronName)
      .then((r) => r[0]);
    if (row) {
      await this.storage.update("_jobs", row._id, {
        lastRun: startTime,
        runs: (row.runs ?? 0) + 1,
        ...(ms > 0 ? { nextRun: startTime + ms } : {}),
      });
    }

    let lastResult: JobRunResult = {
      status: "error",
      error: "Job did not run",
      durationMs: 0,
    };

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let handlerPromise: Promise<void> | null = null;
      try {
        handlerPromise = this.trace(
          "cron",
          cronName,
          null,
          async (ectx, meta) => {
            meta.schedule = job.schedule;
            meta.attempt = attempt;
            // A scheduled action, as the system: what it writes goes
            // through ctx.mutate, each a transaction of its own.
            const ctx = this.buildActionContext(undefined, ectx, undefined);
            await inFrame("action", cronName, () => job.handler(ctx));
          },
        );

        if (timeoutMs > 0) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(`Job ${cronName} timed out after ${timeoutMs}ms`),
                ),
              timeoutMs,
            );
          });
          try {
            await Promise.race([handlerPromise, timeout]);
          } finally {
            clearTimeout(timer);
          }
        } else {
          await handlerPromise;
        }

        const result: JobRunResult = {
          status: "ok",
          error: null,
          durationMs: Date.now() - startTime,
        };
        if (row) {
          await this.storage.update("_jobs", row._id, {
            lastStatus: result.status,
            lastError: result.error,
            lastDurationMs: result.durationMs,
          });
        }
        return result;
      } catch (err: any) {
        const errMsg = err?.message ?? String(err);
        console.error(
          `[vex] cron ${cronName} failed (attempt ${attempt + 1}/${maxRetries + 1}):`,
          errMsg,
        );

        lastResult = {
          status: "error",
          error: errMsg,
          durationMs: Date.now() - startTime,
        };
        if (row) {
          await this.storage.update("_jobs", row._id, {
            lastStatus: lastResult.status,
            lastError: lastResult.error,
            lastDurationMs: lastResult.durationMs,
          });
        }

        // A timed-out handler cannot be cancelled — wait for it to settle
        // so retries and future ticks never overlap a live handler.
        if (handlerPromise) await handlerPromise.catch(() => {});

        // A closed engine starts no further attempt.
        if (attempt < maxRetries && !this.closing) {
          await new Promise((r) => setTimeout(r, retryDelay));
        }
        if (this.closing) break;
      }
    }

    return lastResult;
  }

  async triggerJob(name: string) {
    this.assertOpen();
    const handler = this.jobHandlers.get(name);
    if (!handler) throw new Error(`Job not found: ${name}`);
    return this.executeJob(name, handler);
  }

  /** When the next enabled job comes due (epoch ms), or null if none will. */
  async nextJobRun(): Promise<number | null> {
    const jobs = await this.scheduledJobs();
    return jobs.find((job) => this.jobHandlers.has(job.name))?.nextRun ?? null;
  }

  /**
   * Runs, one after another, every enabled job due by `now`. Each run
   * sets the job's next run one interval later; missed runs coalesce
   * into one.
   */
  async runDueJobs(
    now = Date.now(),
  ): Promise<Array<JobRunResult & { name: string }>> {
    this.assertOpen();
    const results: Array<JobRunResult & { name: string }> = [];
    for (const { name, nextRun } of await this.scheduledJobs()) {
      // A close() during an earlier run starts no further one.
      if (this.closing) break;
      const handler = this.jobHandlers.get(name);
      if (!handler || nextRun > now) continue;
      results.push({ name, ...(await this.executeJob(name, handler)) });
    }
    return results;
  }

  // Enabled jobs with a pending run, soonest first.
  private scheduledJobs(): Promise<{ name: string; nextRun: number }[]> {
    return this.storage.rawQuery(
      "SELECT name, nextRun FROM _jobs WHERE enabled = 1 AND nextRun IS NOT NULL ORDER BY nextRun",
    );
  }

  private runtime(): VexRuntime {
    return {
      triggerJob: (name) => this.triggerJob(name),
      setJobEnabled: (name, enabled) => this.setJobEnabled(name, enabled),
      describeSubscriptions: () => this.describeSubscriptions(),
    };
  }

  /**
   * An action's context: each call it makes is a child of the action's
   * span, made as the context's caller as middleware left it, so the
   * handler and what it calls see one caller; an action it calls stops
   * with it (`signal`).
   */
  private buildActionContext(
    user: VexUser | null | undefined,
    parent: ExecContext,
    signal: AbortSignal | undefined,
  ): ActionContext {
    // Read at call time: middleware may have told the context more.
    const as = (): CallContext => ({ parent, user: ctx.user });
    const ctx: ActionContext = {
      // Each call is the action's own, through its context.
      query: (name, args = {}, caller) =>
        outsideFrame(() => this.query(name, args, { ...as(), ...caller })),
      mutate: (name, args = {}, caller) =>
        outsideFrame(() => this.mutate(name, args, { ...as(), ...caller })),
      action: (name, args = {}, caller) =>
        outsideFrame(() =>
          this.action(name, args, { ...as(), ...caller, signal }),
        ),
      runtime: this.runtime(),
      user: user ?? undefined,
      signal,
    };
    return ctx;
  }

  private buildQueryContext(
    touchedTables?: Set<string>,
    user?: VexUser | null,
    dependencies?: QueryDependency[],
    callerReads?: Set<string>,
  ): QueryContext {
    const self = this;
    if (user && callerReads) user = trackedCaller(user, callerReads);
    // One prepared access context per governed table per operation:
    // a handler reading `sessions` through three chains resolves the
    // caller's standing once. Subscription re-runs rebuild the whole
    // context, so revocations apply on the next invalidation.
    const preparedAccess = new Map<string, Promise<unknown>>();
    // The caller a policy prepares for is the context's own, as the
    // middleware before the first read left it: what middleware
    // learns about the caller, handlers and policies see alike.
    let ctx: QueryContext;
    function baseBuilder(name: string) {
      const query = self.storage.query(name);
      if (!touchedTables && !dependencies) return query;
      touchedTables?.add(name);
      return self.trackQueryBuilder(query, name, dependencies);
    }
    // The policy's own reads: tracked (grant-table writes must
    // invalidate subscriptions on governed tables) but unguarded (a
    // policy consulting its own table must not recurse).
    const accessReader = { table: baseBuilder };
    function resolvePrepared(
      name: string,
      policy: TableAccessPolicy<any>,
    ): Promise<unknown> {
      let prepared = preparedAccess.get(name);
      if (!prepared) {
        prepared = Promise.resolve(policy.prepare(ctx.user, accessReader));
        preparedAccess.set(name, prepared);
      }
      return prepared;
    }
    // A raw read depends on each table it reads as `reads` says: held
    // to rows, narrowed like a builder read's; whole, on any change to
    // it. One that reads no table depends on any change at all.
    function trackRaw(tables: readonly string[], reads?: Reads): void {
      if (!touchedTables && !dependencies) return;
      for (const table of tables) {
        touchedTables?.add(table);
        const hold = reads?.[table];
        dependencies?.push(
          hold === undefined || hold === "all"
            ? { table, raw: true }
            : Array.isArray(hold)
              ? { table, filters: hold }
              : { table, filters: hold.where, reads: hold.reads },
        );
      }
      if (tables.length === 0)
        dependencies?.push({ table: ANY_TABLE, raw: true });
    }
    // A raw read as the caller, of the tables `reads` names, each held
    // by the statement itself (`holdStatement`) or read whole; refused
    // over a governed table or one it does not name.
    function rawRead<T>(
      reads: Reads,
      sql: string,
      params: any[],
    ): Promise<T[]> {
      if (typeof reads !== "object" || reads === null) {
        return Promise.reject(
          new Error(
            'ctx.db.sql(reads, sql, ...params): name each table the statement reads, held to rows ({ t: filters }) or whole ({ t: "all" })',
          ),
        );
      }
      let statement: { sql: string; params: any[] };
      try {
        statement = holdStatement(sql, reads, params);
      } catch (error) {
        return Promise.reject(error);
      }
      const held = Object.keys(reads).filter((t) => reads[t] !== "all");
      const read = (tables: string[], views: string[]): Promise<T[]> => {
        const governed = tables.filter((table) =>
          self.accessPolicies.has(table),
        );
        if (governed.length > 0) {
          return Promise.reject(governedRawSqlError(governed));
        }
        // A view reads its base tables by their own names, past the
        // expressions that hold them: a held read names no view.
        const named = held.length > 0 ? namesIn(sql, views) : NO_VIEWS;
        if (named.length > 0) {
          return Promise.reject(
            new Error(
              `ctx.db.sql cannot hold ${held.map((t) => JSON.stringify(t)).join(", ")} through a view (${named.join(", ")}): read the table itself`,
            ),
          );
        }
        const unnamed = tables.filter((table) => !(table in reads));
        if (unnamed.length > 0) {
          return Promise.reject(
            new Error(
              `ctx.db.sql reads ${unnamed.map((t) => JSON.stringify(t)).join(", ")} without naming ${unnamed.length > 1 ? "them" : "it"}: hold ${unnamed.length > 1 ? "each" : "it"} to rows ({ ${unnamed[0]}: filters }) or read ${unnamed.length > 1 ? "each" : "it"} whole ({ ${unnamed[0]}: "all" })`,
            ),
          );
        }
        trackRaw(tables, reads);
        return self.storage.rawQuery<T>(statement.sql, ...statement.params);
      };
      // Known tables and views are answered at once, without a
      // microtask hop.
      const tables = self.rawReadTables(statement.sql);
      const views = held.length > 0 ? self.viewNames() : NO_VIEWS;
      if (Array.isArray(tables) && Array.isArray(views)) {
        return read(tables, views);
      }
      return Promise.all([tables, views]).then(([t, v]) => read(t, v));
    }
    ctx = {
      db: {
        table(name: string) {
          const policy = self.accessPolicies.get(name);
          if (!policy) return baseBuilder(name);
          return guardQueryBuilder(name, baseBuilder(name), policy, () =>
            resolvePrepared(name, policy),
          );
        },
        sql: <T = Record<string, any>>(
          reads: Reads,
          sql: string,
          ...params: any[]
        ) => rawRead<T>(reads, sql, params),
        async publishedSql<T = Record<string, any>>(
          sql: string,
          ...params: any[]
        ): Promise<T[]> {
          const read = (await self.storage.readOnlyTables?.(sql)) ?? {
            refused: "This storage cannot show what a statement reads.",
          };
          if ("refused" in read) throw new Error(read.refused);
          const unpublished = read.tables.filter(
            (table) => !self.storage.getSchema(table)?.published,
          );
          if (unpublished.length > 0) {
            const list = unpublished.map((t) => `"${t}"`).join(", ");
            throw new Error(
              unpublished.length > 1
                ? `Tables ${list} are not published`
                : `Table ${list} is not published`,
            );
          }
          for (const table of read.tables) {
            const policy = self.accessPolicies.get(table);
            if (
              policy &&
              (await resolvePrepared(table, policy)) !== UNRESTRICTED
            ) {
              throw publishedGovernedError(table);
            }
          }
          trackRaw(read.tables);
          return self.storage.rawQuery<T>(sql, ...params);
        },
        publishedTables() {
          return [...self.tables].sort().flatMap((name) => {
            const schema = self.storage.getSchema(name);
            return schema?.published
              ? [
                  {
                    name,
                    columns: {
                      _id: { type: "string" },
                      ...declaredColumns(schema),
                    },
                  },
                ]
              : [];
          });
        },
      },
      now(resolutionMs: number): number {
        if (!Number.isInteger(resolutionMs) || resolutionMs < 1000) {
          throw new TypeError(
            "ctx.now(resolutionMs): a whole number of milliseconds, at least 1000",
          );
        }
        const at = Math.floor(Date.now() / resolutionMs) * resolutionMs;
        dependencies?.push({ table: CLOCK, until: at + resolutionMs });
        return at;
      },
      user: user ?? undefined,
    };
    return ctx;
  }

  private trackQueryBuilder(
    builder: QueryBuilder,
    table: string,
    dependencies?: QueryDependency[],
  ): QueryBuilder {
    // One wrapper per db.table() call, descriptor accumulated in place and
    // snapshotted at each terminal read. The underlying builder is
    // mutable-shared (chained calls return the same builder), so a shared
    // wrapper keeps the recorded descriptor consistent with the SQL that
    // actually executes — even when callers hold intermediate references.
    let current = builder;
    const descriptor: Omit<QueryDependency, "table"> = {};
    // `reads`: the columns a terminal computes its result from, besides
    // the filters'; absent for whole rows.
    const record = (reads?: string[]) =>
      dependencies?.push({
        table,
        ...descriptor,
        ...(reads ? { reads } : {}),
      });
    const tracked: QueryBuilder = {
      where(column, operator, value) {
        current = current.where(column, operator, value);
        descriptor.filters = [
          ...(descriptor.filters ?? []),
          { column, operator, value },
        ];
        return tracked;
      },
      // A single group is an AND of filters like any other; an OR of
      // several is recorded apart, every group of which a write must
      // miss to be ruled out.
      whereAny(groups) {
        current = current.whereAny(groups);
        if (groups.length === 1) {
          descriptor.filters = [...(descriptor.filters ?? []), ...groups[0]];
        } else {
          descriptor.any = [
            ...(descriptor.any ?? []),
            groups.map((group) => [...group]),
          ];
        }
        return tracked;
      },
      select(...columns) {
        current = current.select(...columns);
        if (columns.length > 0) descriptor.select = columns;
        else delete descriptor.select;
        return tracked;
      },
      order(column, dir = "asc") {
        current = current.order(column, dir);
        descriptor.order = { column, dir };
        return tracked;
      },
      limit(n) {
        current = current.limit(n);
        descriptor.limit = n;
        return tracked;
      },
      offset(n) {
        current = current.offset(n);
        descriptor.offset = n;
        return tracked;
      },
      all: async () => {
        record(descriptor.select ?? undefined);
        return current.all();
      },
      first: async () => {
        record(descriptor.select ?? undefined);
        return current.first();
      },
      distinct: async (col) => {
        record([col]);
        return current.distinct(col);
      },
      count: async () => {
        record([]);
        return current.count();
      },
      countDistinct: async (col) => {
        record([col]);
        return current.countDistinct(col);
      },
      sum: async (col) => {
        record([col]);
        return current.sum(col);
      },
      avg: async (col) => {
        record([col]);
        return current.avg(col);
      },
      min: async (col) => {
        record([col]);
        return current.min(col);
      },
      max: async (col) => {
        record([col]);
        return current.max(col);
      },
      groupBy: (col, aggs) => {
        const reads = new Set(Array.isArray(col) ? col : [col]);
        for (const agg of Object.values(aggs)) {
          if (Array.isArray(agg)) reads.add(agg[1]);
        }
        record([...reads]);
        return current.groupBy(col, aggs);
      },
      delete: () => current.delete(),
    };
    return tracked;
  }

  /** Every view, from the adapter's per-schema list where it keeps one. */
  private viewNames(): string[] | Promise<string[]> {
    return (
      this.storage.viewNames?.() ??
      this.storage
        .rawQuery<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'view'",
        )
        .then((rows) => rows.map(({ name }) => name))
    );
  }

  /**
   * The tables a raw statement reads: exactly, when the adapter can
   * compile it (views and subqueries included); otherwise each registered
   * table it names, and each one a view it names reads (sql-text.ts).
   */
  private rawReadTables(sql: string): string[] | Promise<string[]> {
    const exact = this.storage.tablesRead?.(sql);
    if (Array.isArray(exact)) return exact;
    return Promise.resolve(exact).then(async (tables) => {
      if (tables) return tables;
      const views = await this.storage.rawQuery<ViewDefinition>(
        "SELECT name, sql FROM sqlite_master WHERE type = 'view'",
      );
      return tablesRead(sql, this.tables, views);
    });
  }

  /**
   * A mutation's context. With `writes`, each write the handler makes
   * is recorded there for invalidation to narrow on, with the values
   * its rows hold; the rows are read first, which is consistent only
   * inside the transaction the handler runs in, so a caller recording
   * writes runs the handler in one.
   */
  private buildMutationContext(
    user?: VexUser | null,
    writes?: WriteDependency[],
  ): MutationContext {
    const self = this;
    const began = Date.now();
    return {
      now: () => began,
      id: () => generateId(),
      random: () => {
        const bytes = crypto.getRandomValues(new Uint8Array(7));
        // 53 random bits over 2^53.
        let n = bytes[0]! & 0x1f;
        for (let i = 1; i < 7; i++) n = n * 256 + bytes[i]!;
        return n / 2 ** 53;
      },
      db: {
        sql<T = Record<string, any>>(
          sql: string,
          ...params: any[]
        ): Promise<T[]> {
          const refused = rawWriteRefusal(sql);
          if (refused) return Promise.reject(new Error(refused));
          if (statementKind(sql) !== "read" && !writes?.includes(RAW_WRITE))
            writes?.push(RAW_WRITE);
          return self.storage.rawQuery<T>(sql, ...params);
        },
        table(name: string): MutationTable {
          const adapter = self.storage;
          const recording = writes !== undefined;
          const held = (id: string) =>
            recording
              ? adapter.query(name).where("_id", "=", id).first()
              : Promise.resolve(null);
          /**
           * An update's write: the row's columns `data` leaves as they
           * were (its id among them) as `values`, the columns whose
           * value it changes as `changed`. Without the row, only the id.
           */
          const updateWrite = (
            id: string,
            row: Record<string, any> | null,
            data: Record<string, any>,
          ): WriteDependency => {
            const columns = Object.keys(data);
            if (!row) return { table: name, values: { _id: id }, columns };
            const types = self.columnTypes(name);
            const changed = columns.filter(
              (column) =>
                !sameValue(data[column], row[column], types?.[column]),
            );
            const values: Record<string, unknown> = {};
            const before: Record<string, unknown> = {};
            const after: Record<string, unknown> = {};
            for (const [column, value] of Object.entries(row)) {
              if (changed.includes(column)) {
                before[column] = value;
                after[column] = data[column];
              } else values[column] = value;
            }
            return { table: name, values, before, after, columns, changed };
          };
          function build(
            qb: QueryBuilder,
            eq: Record<string, unknown>,
          ): MutationTable {
            return {
              where: (col, op, val) =>
                build(
                  qb.where(col, op, val),
                  op === "=" ? { ...eq, [col]: val } : eq,
                ),
              whereAny: (groups) => build(qb.whereAny(groups), eq),
              select: (...cols) => build(qb.select(...cols), eq),
              order: (col, dir) => build(qb.order(col, dir), eq),
              limit: (n) => build(qb.limit(n), eq),
              offset: (n) => build(qb.offset(n), eq),
              all: () => qb.all(),
              first: () => qb.first(),
              distinct: (col) => qb.distinct(col),
              count: () => qb.count(),
              countDistinct: (col) => qb.countDistinct(col),
              sum: (col) => qb.sum(col),
              avg: (col) => qb.avg(col),
              min: (col) => qb.min(col),
              max: (col) => qb.max(col),
              groupBy: (col, aggs) => qb.groupBy(col, aggs),
              // Each write records the values its rows hold before and
              // after it (WriteDependency.values): an insert's whole row
              // with the id it is given here, an update's or upsert's
              // columns left as they were, a delete's whole row.
              insert: (row) => {
                const _id = row._id ?? generateId(12);
                const full = { ...row, _id };
                writes?.push({
                  table: name,
                  values: full,
                  columns: Object.keys(row),
                });
                return adapter.insert(name, full);
              },
              upsert: async (keys, data) => {
                const _id = generateId(12);
                if (recording) {
                  let lookup = adapter.query(name);
                  for (const [column, value] of Object.entries(keys)) {
                    lookup = lookup.where(column, "=", value);
                  }
                  const row = await lookup.first();
                  writes?.push(
                    row
                      ? updateWrite(row._id, row, data)
                      : {
                          table: name,
                          values: { ...keys, ...data, _id },
                          columns: Object.keys({ ...keys, ...data }),
                        },
                  );
                }
                return adapter.upsert(name, keys, data, _id);
              },
              update: async (id, data) => {
                const target = rowId(name, "update", id);
                writes?.push(updateWrite(target, await held(target), data));
                return adapter.update(name, target, data);
              },
              // No argument deletes every row the filters match; an
              // argument is one row's id, which `rowId` holds to a
              // string: read as "no argument", a missing id would empty
              // the table.
              delete: async (...args: [id?: string]) => {
                if (args.length === 0) {
                  if (recording) {
                    // The rows about to go, each as it is: every row
                    // the filters match, which a limit or offset on
                    // the chain bounds the read of but not the delete.
                    // Past a bound, or short of them all, only what the
                    // `=` filters say of them all.
                    const total = await qb.count();
                    const rows =
                      total <= DELETE_ROWS_RECORDED ? await qb.all() : [];
                    if (rows.length === total) {
                      for (const row of rows) {
                        writes?.push({ table: name, values: row });
                      }
                    } else {
                      writes?.push({ table: name, values: { ...eq } });
                    }
                  }
                  return qb.delete();
                }
                const target = rowId(name, "delete", args[0]);
                writes?.push({
                  table: name,
                  values: (await held(target)) ?? { _id: target },
                });
                return adapter.delete(name, target);
              },
            };
          }
          return build(adapter.query(name), {});
        },
      },
      user: user ?? undefined,
    };
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    if (!this.handlerTimeoutMs) return promise;
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(`Handler timed out after ${this.handlerTimeoutMs}ms`),
            ),
          this.handlerTimeoutMs,
        ),
      ),
    ]);
  }

  /**
   * Runs `handler` inside every middleware. A query's or mutation's
   * handler is bounded by the handler timeout, since it holds a read or
   * a transaction; an action's holds neither, and is not.
   */
  private async runMiddleware(
    ctx: QueryContext | MutationContext | ActionContext,
    info: MiddlewareInfo<any>,
    handler: () => Promise<any> | any,
    ectx: ExecContext,
  ): Promise<any> {
    // The middleware and the handler run in the handler's frame
    // (`guards.ts`); a webhook writes as a mutation does.
    const kind: FrameKind = info.type === "webhook" ? "action" : info.type;
    const run = () => {
      const result = Promise.resolve(inFrame(kind, info.name, handler));
      return info.type === "action" || info.type === "webhook"
        ? result
        : this.withTimeout(result);
    };
    if (this.middleware.length === 0) {
      return this.trace("handler", info.name, ectx, run);
    }
    return this.trace("middleware", info.name, ectx, (mwEctx) => {
      let i = 0;
      const chain = (): Promise<any> | any => {
        if (i < this.middleware.length) {
          const middleware = this.middleware[i++]!;
          return inFrame(kind, info.name, () => middleware(ctx, info, chain));
        }
        return this.trace("handler", info.name, mwEctx, run);
      };
      return chain();
    });
  }

  private resolveReactive(
    def: QueryDef<any>,
  ): false | Required<ReactiveBudget> {
    if (def.reactive === false) return false;
    return {
      maxRows: def.reactive?.maxRows ?? this.reactiveDefaults.maxRows,
      maxBytes: def.reactive?.maxBytes ?? this.reactiveDefaults.maxBytes,
    };
  }

  private measureReactiveResult(
    result: any,
    name: string,
  ): ReactiveMeasurement {
    const { serialized, exact } = serializeJson(
      result,
      `query ${name} answers`,
    );
    // An undefined result measures as the literal "undefined".
    const measured = serialized ?? "undefined";
    const resultRows = Array.isArray(result)
      ? result.length
      : result && typeof result === "object" && Array.isArray(result.rows)
        ? result.rows.length
        : undefined;
    return {
      hash: hashResult(measured),
      resultRows,
      resultBytes: utf8ByteLength(measured),
      serialized,
      exact,
    };
  }

  private assertReactiveBudget(
    measurement: { resultRows?: number; resultBytes: number },
    budget: Required<ReactiveBudget>,
  ) {
    if (
      measurement.resultRows !== undefined &&
      measurement.resultRows > budget.maxRows
    ) {
      throw new Error(
        `Reactive query budget exceeded: resultRows ${measurement.resultRows} > maxRows ${budget.maxRows}`,
      );
    }
    if (measurement.resultBytes > budget.maxBytes) {
      throw new Error(
        `Reactive query budget exceeded: resultBytes ${measurement.resultBytes} > maxBytes ${budget.maxBytes}`,
      );
    }
  }

  /**
   * Whether a subscription with `dependencies` may have seen the changes.
   * Over a changed table, only filters that the writes' values
   * (WriteDependency.values) rule out let it be skipped (`writeMayAffect`),
   * and only when every write to the table is one of those: not over an
   * unattributed table.
   */
  private dependencyAffected(
    dependencies: QueryDependency[],
    changed: Set<string>,
    unattributed: Set<string>,
    writesByTable?: Map<string, WriteDependency[]>,
  ): boolean {
    if (dependencies.length === 0) return true;
    for (const dep of dependencies) {
      if (dep.table === ANY_TABLE && dep.raw) return true;
      if (!changed.has(dep.table)) continue;
      if (dep.raw || unattributed.has(dep.table)) return true;
      const tableWrites = writesByTable?.get(dep.table) ?? [];
      if (
        tableWrites.length === 0 ||
        tableWrites.some((write) => write.raw || !write.values)
      )
        return true;
      const columns = this.columnTypes(dep.table);
      if (tableWrites.some((write) => writeMayAffect(dep, write, columns))) {
        return true;
      }
    }
    return false;
  }

  /**
   * The declared type of each column of `table`, `_id` included, for
   * the affinity-aware comparison of a write's values with a filter.
   * Undefined when the table is not registered: nothing is assumed
   * then. Held per schema object, which a (re)registration replaces.
   */
  private columnTypes(table: string): Record<string, ColumnType> | undefined {
    const schema = this.storage.getSchema(table);
    if (!schema) return undefined;
    let types = columnTypesBySchema.get(schema);
    if (!types) {
      types = { _id: "string" };
      for (const [name, def] of Object.entries(schema.columns)) {
        types[name] = def.type;
      }
      columnTypesBySchema.set(schema, types);
    }
    return types;
  }

  /**
   * Files `group` under the tables and values its dependencies name.
   * A dependency held to values files it under each combination; one
   * naming none files it wide; one on any table, or none at all,
   * files it among those judged on every pass. What a group is filed
   * by is its dependencies, so it is unfiled (`unindexGroup`) before
   * they change.
   */
  private indexGroup(group: SubscriptionGroup): void {
    this.unindexGroup(group);
    group.filed = true;
    // Reading no table, it is judged on every pass, as a raw read of
    // no table is: nothing says what it depends on.
    if (group.dependencies.length === 0) this.anyTableGroups.add(group);
    for (const dep of group.dependencies) {
      if (dep.table === ANY_TABLE) {
        this.anyTableGroups.add(group);
        continue;
      }
      const index = this.tableIndex(dep.table);
      index.all.add(group);
      const filing = filingOf(dep);
      if (filing === null) {
        index.wide.add(group);
        continue;
      }
      let shape = index.byShape.get(filing.shape);
      if (!shape) {
        shape = { columns: filing.shape.split(","), byKeys: new Map() };
        index.byShape.set(filing.shape, shape);
      }
      for (const key of filing.keys) slotAdd(shape.byKeys, key, group);
    }
  }

  /** Unfiles `group` from where its dependencies filed it. */
  private unindexGroup(group: SubscriptionGroup): void {
    if (!group.filed) return;
    group.filed = false;
    this.anyTableGroups.delete(group);
    for (const dep of group.dependencies) {
      const index = this.groupIndex.get(dep.table);
      if (!index) continue;
      index.all.delete(group);
      const filing = filingOf(dep);
      if (filing === null) {
        index.wide.delete(group);
      } else {
        const shape = index.byShape.get(filing.shape);
        if (shape) {
          for (const key of filing.keys) slotDelete(shape.byKeys, key, group);
          if (shape.byKeys.size === 0) index.byShape.delete(filing.shape);
        }
      }
      if (index.all.size === 0) this.groupIndex.delete(dep.table);
    }
  }

  private tableIndex(table: string): TableIndex {
    let index = this.groupIndex.get(table);
    if (!index) {
      index = { wide: new Set(), byShape: new Map(), all: new Set() };
      this.groupIndex.set(table, index);
    }
    return index;
  }

  /** A subscription leaves; its group goes with its last member. */
  private dropSubscription(sub: Subscription): void {
    this.subscriptions.delete(sub.id);
    const group = sub.group;
    group.members.delete(sub);
    if (group.members.size === 0) {
      this.groups.delete(group.key);
      this.runningGroups.delete(group);
      this.unindexGroup(group);
      this.clockGroups.delete(group);
      const family = this.families.get(group.family);
      family?.delete(group);
      if (family?.size === 0) this.families.delete(group.family);
    }
  }

  /**
   * The groups a pass judges: every one when any table may have
   * changed; else those with a run open (their dependencies are still
   * being recorded), those depending on any table, and on each
   * changed table, every one when a write there names no rows or the
   * change is unattributed, else those filed wide and, under each
   * shape, those under the keys the written rows may hold
   * (`writeKeys`), or every group of a shape whose columns a write
   * does not all know.
   */
  private candidates(
    everything: boolean,
    changed: Set<string>,
    unattributed: Set<string>,
    writesByTable: Map<string, WriteDependency[]> | undefined,
  ): Set<SubscriptionGroup> {
    if (everything) return new Set(this.groups.values());
    const found = new Set<SubscriptionGroup>(this.runningGroups);
    for (const group of this.anyTableGroups) found.add(group);
    for (const table of changed) {
      const index = this.groupIndex.get(table);
      if (!index) continue;
      const writes = writesByTable?.get(table);
      const rowsKnown =
        !unattributed.has(table) &&
        writes !== undefined &&
        writes.length > 0 &&
        writes.every((write) => !write.raw && write.values !== undefined);
      if (!rowsKnown) {
        for (const group of index.all) found.add(group);
        continue;
      }
      for (const group of index.wide) found.add(group);
      for (const shape of index.byShape.values()) {
        for (const write of writes) {
          const keys = writeKeys(write, shape.columns);
          if (keys === null) {
            for (const slot of shape.byKeys.values()) slotEach(slot, found);
            continue;
          }
          for (const key of keys) {
            const slot = shape.byKeys.get(key);
            if (slot) slotEach(slot, found);
          }
        }
      }
    }
    return found;
  }

  /**
   * One run of a group's query, repeated until no write that affects
   * it commits while it is open. The group's dependencies are the
   * run's as it records them, so an invalidation meanwhile judges
   * what the run has read so far and marks the group stale rather
   * than running it again; the run closes before the result is handed
   * back, so nothing lands unseen between a run and its delivery. A
   * group already running answers with that run.
   */
  private runGroup(
    group: SubscriptionGroup,
    reg: RegisteredQuery,
    ectx: ExecContext,
  ): Promise<{ result: unknown; measurement: ReactiveMeasurement }> {
    if (group.run) return group.run;
    // Judged whole while it runs (`runningGroups`), the group leaves
    // the index before its dependencies change, and returns after.
    this.unindexGroup(group);
    this.runningGroups.add(group);
    const run = (async () => {
      try {
        const answer =
          this.evaluation && group.offThread
            ? await this.runGroupOffThread(group, this.evaluation)
            : await this.runGroupHere(group, reg, ectx);
        group.last = answer.measurement;
        this.rehomeStrangers(group);
        return answer;
      } finally {
        group.run = null;
        this.runningGroups.delete(group);
        if (this.groups.get(group.key) === group) {
          this.indexGroup(group);
          this.timeGroup(group);
        }
      }
    })();
    group.run = run;
    return run;
  }

  private async runGroupHere(
    group: SubscriptionGroup,
    reg: RegisteredQuery,
    ectx: ExecContext,
  ): Promise<{ result: unknown; measurement: ReactiveMeasurement }> {
    const info: MiddlewareInfo<any> = {
      type: "query",
      name: group.queryName,
      args: group.args,
      access: reg.def.access,
    };
    let result: unknown;
    do {
      group.stale = false;
      result = await this.checkedRun(group.queryName, async () => {
        group.tables = new Set();
        group.dependencies = [];
        const reads = new Set<string>();
        const ctx = this.buildQueryContext(
          group.tables,
          group.user,
          group.dependencies,
          reads,
        );
        const answer = await this.runMiddleware(
          ctx,
          info,
          () => reg.def.handler(ctx, group.args),
          ectx,
        );
        group.reads = reads;
        return answer;
      });
    } while (group.stale);
    reg.returns?.(result);
    return {
      result,
      measurement: this.measureReactiveResult(result, group.queryName),
    };
  }

  /**
   * `runGroup` in a worker. What the run reads is known only when it
   * answers, so meanwhile the group is judged by its last run's
   * dependencies (a write those rule out cannot reach this run
   * either), or by any write at all before a first run.
   */
  private async runGroupOffThread(
    group: SubscriptionGroup,
    pool: EvaluationPool,
  ): Promise<{ result: unknown; measurement: ReactiveMeasurement }> {
    const request: EvaluationRequest = {
      name: group.queryName,
      args: group.args,
      user: group.user,
    };
    let evaluation: Evaluation;
    do {
      group.stale = false;
      if (group.dependencies.length === 0) {
        group.dependencies = [{ table: ANY_TABLE, raw: true }];
      }
      evaluation = await pool.run(request);
      group.tables = new Set(evaluation.tables);
      group.dependencies = evaluation.dependencies;
      group.reads = new Set(evaluation.callerReads);
    } while (group.stale);
    return { result: evaluation.result, measurement: evaluation };
  }

  /**
   * @internal A subscription's query run here for another engine's
   * subscription (`EvaluationPool`): its result, measured, and what
   * it read.
   */
  async evaluate(request: EvaluationRequest): Promise<Evaluation> {
    const reg = this.queries.get(request.name);
    if (!reg) throw new Error(`Query not found: ${request.name}`);
    const args = reg.args(request.args);
    const tables = new Set<string>();
    const dependencies: QueryDependency[] = [];
    const callerReads = new Set<string>();
    const ctx = this.buildQueryContext(
      tables,
      request.user,
      dependencies,
      callerReads,
    );
    const result = await this.trace("evaluate", request.name, null, (ectx) =>
      this.runMiddleware(
        ctx,
        {
          type: "query",
          name: request.name,
          args,
          access: reg.def.access,
        },
        () => reg.def.handler(ctx, args),
        ectx,
      ),
    );
    reg.returns?.(result);
    return {
      result,
      ...this.measureReactiveResult(result, request.name),
      tables: [...tables],
      dependencies,
      callerReads: [...callerReads],
    };
  }

  /**
   * Invalidates after a commit, in one pass with every other commit
   * that lands before the pass begins. When another write holds or
   * waits for the storage's write lock, the pass waits a turn of the
   * event loop for it: a burst of writes, which serialize on the lock
   * within a turn, re-evaluates each subscription once for all of
   * them. Otherwise it begins at once. The pass is a child of the
   * first commit's span, and every commit that joined it awaits it. A
   * pass already begun is not waited for: its runs repeat for what
   * lands meanwhile (`runGroup`).
   */
  private invalidateAfter(
    ectx: ExecContext,
    writes?: WriteDependency[],
  ): Promise<void> {
    const pending = this.pendingInvalidation;
    if (pending) {
      pending.commits++;
      if (pending.writes && writes) pending.writes.push(...writes);
      else pending.writes = undefined;
      return pending.pass;
    }
    const wait = this.storage.writesPending?.()
      ? nextTurn()
      : Promise.resolve();
    const joined: PendingInvalidation = {
      writes: writes && [...writes],
      commits: 1,
      pass: wait.then(() => {
        this.pendingInvalidation = null;
        return this.invalidateSubscriptions(
          ectx,
          joined.writes,
          joined.commits,
        );
      }),
    };
    this.pendingInvalidation = joined;
    return joined.pass;
  }

  private async invalidateSubscriptions(
    ectx: ExecContext,
    writes?: WriteDependency[],
    commits = 1,
  ): Promise<void> {
    // A pass that begins after close() has no subscription to serve.
    if (this.closing) return;
    const changes = this.storage.takeChanges();
    if (changes.tables.length === 0) return;

    const changedSet = new Set(changes.tables);
    const unattributed = new Set(changes.unattributed);
    const writesByTable = groupWritesByTable(writes);
    // A change to any table affects every subscription.
    const everything = changedSet.has(ANY_TABLE);

    return this.trace(
      "invalidation",
      "subscriptions",
      ectx,
      async (_invEctx, meta) => {
        const judged = this.candidates(
          everything,
          changedSet,
          unattributed,
          writesByTable,
        );
        const affected: SubscriptionGroup[] = [];
        for (const group of judged) {
          // A running group's dependencies are its open run's so far,
          // each recorded before its read runs: a read they rule out
          // could not have seen the write, and a read not yet made
          // sees it. Before any, nothing was missed.
          if (group.run && group.dependencies.length === 0) continue;
          if (
            !everything &&
            !this.dependencyAffected(
              group.dependencies,
              changedSet,
              unattributed,
              writesByTable,
            )
          )
            continue;
          if (group.run) group.stale = true;
          else affected.push(group);
        }

        meta.changedTables = [...changedSet];
        meta.commits = commits;
        meta.judged = judged.size;
        meta.affectedGroups = affected.length;
        if (this.evaluation) {
          meta.offThread = affected.filter((group) => group.offThread).length;
        }
        meta.activeSubs = this.subscriptions.size;
        meta.reEvaluated = affected.map((group) => group.queryName);

        // Groups run together: each is one query for one caller, with
        // nothing shared but the pool that bounds how many evaluate at
        // once off the main thread.
        await Promise.all([
          ...affected.map((group) => this.rerunGroup(group, _invEctx, meta)),
          ...this.skippedToCheck(new Set(affected)).map((group) =>
            this.recheckSkipped(group, _invEctx),
          ),
        ]);
      },
    );
  }

  /**
   * The group of `family` whose members `user` is alike in every field
   * its runs read (the whole caller, before a run ends): one run serves
   * them all.
   */
  private joinableGroup(
    family: string,
    user: VexUser | null | undefined,
  ): SubscriptionGroup | undefined {
    for (const group of this.families.get(family) ?? []) {
      if (callerSeen(user, group.reads) === callerSeen(group.user, group.reads))
        return group;
    }
    return undefined;
  }

  private newGroup(
    family: string,
    queryName: string,
    args: Record<string, any>,
    user: VexUser | null | undefined,
  ): SubscriptionGroup {
    const group: SubscriptionGroup = {
      key: `${family}\0${++this.groupSerial}`,
      queryName,
      args,
      user,
      members: new Set(),
      tables: new Set(),
      dependencies: [],
      last: null,
      run: null,
      stale: false,
      // A caller is plain data, so every one crosses to a worker.
      offThread: this.evaluation !== null,
      filed: false,
      family,
      reads: null,
    };
    this.groups.set(group.key, group);
    let members = this.families.get(family);
    if (!members) {
      members = new Set();
      this.families.set(family, members);
    }
    members.add(group);
    return group;
  }

  /**
   * After a run that read a field its members are not alike in, each
   * member who differs leaves for the group of callers alike in what
   * the runs read, and hears that group's answer: no one is answered
   * from what another caller is.
   */
  private rehomeStrangers(group: SubscriptionGroup): void {
    const own = callerSeen(group.user, group.reads);
    const strangers = [...group.members].filter(
      (sub) => callerSeen(sub.user, group.reads) !== own,
    );
    for (const sub of strangers) {
      group.members.delete(sub);
      const home =
        this.joinableGroup(group.family, sub.user) ??
        this.newGroup(group.family, group.queryName, group.args, sub.user);
      sub.group = home;
      home.members.add(sub);
      if (home.last && home.last.hash !== sub.lastHash) {
        sub.lastHash = home.last.hash;
        try {
          deliverSubscriptionResult(
            sub.callback,
            parsed(home.last),
            home.last.serialized,
          );
        } catch (err) {
          console.error(
            `[vex] subscription ${group.queryName} callback failed:`,
            err,
          );
        }
      } else if (!home.last && !home.run) {
        void this.trace("invalidation", "rehome", null, (ectx, meta) =>
          this.rerunGroup(home, ectx, meta),
        );
      }
    }
  }

  /**
   * Runs `group` again and hands its members the answer: ended, each
   * told why, when it outgrows its budget; on failure, its last answer
   * kept and each member told. A group with a run open repeats that
   * run instead.
   */
  private async rerunGroup(
    group: SubscriptionGroup,
    ectx: ExecContext,
    meta: Record<string, any>,
  ): Promise<void> {
    if (group.run) {
      group.stale = true;
      return;
    }
    try {
      const reg = this.queries.get(group.queryName);
      if (!reg) return;
      // A group exists only for a reactive query (`subscribe`).
      const budget = this.resolveReactive(reg.def) as Required<ReactiveBudget>;
      const { result, measurement } = await this.runGroup(group, reg, ectx);
      try {
        this.assertReactiveBudget(measurement, budget);
      } catch (err) {
        meta.budgetExceeded = true;
        meta.disabledSubscriptions =
          (meta.disabledSubscriptions ?? 0) + group.members.size;
        meta.resultRows = measurement.resultRows;
        meta.resultBytes = measurement.resultBytes;
        meta.budget = budget;
        // It cannot be answered within its budget: it ends, and each
        // member is told why.
        const members = [...group.members];
        this.dropGroup(group);
        for (const sub of members) this.notify(sub, err as Error, true);
        return;
      }
      this.deliver(group, result, measurement);
    } catch (err) {
      // A failed run keeps the last answer and runs again on the next
      // write or clock boundary that reaches it; each member is told.
      console.error(`[vex] subscription ${group.queryName} failed:`, err);
      for (const sub of group.members) this.notify(sub, err as Error, false);
    }
  }

  /**
   * `run`, or under `purityCheck`, `run` twice on the same data with
   * the answers compared: a query answering two ways reads state no
   * context tracks.
   */
  private async checkedRun<T>(name: string, run: () => Promise<T>): Promise<T> {
    if (this.purity === 0 || Math.random() >= this.purity) return run();
    return this.storage.transaction(async () => {
      const first = await run();
      const second = await run();
      const a = serializeJson(first, `query ${name} answers`).serialized;
      const b = serializeJson(second, `query ${name} answers`).serialized;
      if (a !== b) {
        throw new PurityError(
          `query ${name} answered two ways on the same data: its answer depends on state its context does not track, such as a module's variables`,
        );
      }
      return first;
    });
  }

  /** Under `purityCheck`, the groups a pass skipped that it checks. */
  private skippedToCheck(
    affected: ReadonlySet<SubscriptionGroup>,
  ): SubscriptionGroup[] {
    if (this.purity === 0) return [];
    const at = Date.now();
    return [...this.groups.values()].filter(
      (group) =>
        !affected.has(group) &&
        !group.run &&
        group.last !== null &&
        !(group.clockUntil !== undefined && group.clockUntil <= at) &&
        Math.random() < this.purity,
    );
  }

  /**
   * Runs a group nothing it read changed and compares the answer with
   * its last: one that differs ends, each member told why.
   */
  private async recheckSkipped(
    group: SubscriptionGroup,
    ectx: ExecContext,
  ): Promise<void> {
    const reg = this.queries.get(group.queryName);
    const before = group.last;
    if (!reg || !before) return;
    try {
      const { measurement } = await this.runGroup(group, reg, ectx);
      if (measurement.hash === before.hash) return;
    } catch {
      // A failure is the next write's to report, as any run's is.
      return;
    }
    const error = new PurityError(
      `query ${group.queryName} answered differently though nothing it read changed: its answer depends on state its context does not track (or a change went unseen)`,
    );
    const members = [...group.members];
    this.dropGroup(group);
    for (const sub of members) this.notify(sub, error, true);
  }

  /** Files `group` under the clock when its answer holds until a time. */
  private timeGroup(group: SubscriptionGroup): void {
    let until: number | undefined;
    for (const dep of group.dependencies) {
      if (dep.table === CLOCK && dep.until !== undefined) {
        until = until === undefined ? dep.until : Math.min(until, dep.until);
      }
    }
    group.clockUntil = until;
    if (until === undefined) this.clockGroups.delete(group);
    else this.clockGroups.add(group);
    this.armClock();
  }

  /** Sets the one clock timer for the soonest boundary any group holds. */
  private armClock(): void {
    let soonest = Number.POSITIVE_INFINITY;
    for (const group of this.clockGroups) {
      if (group.clockUntil !== undefined && group.clockUntil < soonest) {
        soonest = group.clockUntil;
      }
    }
    if (soonest === this.clockAt && this.clockTimer) return;
    if (this.clockTimer) clearTimeout(this.clockTimer);
    this.clockTimer = null;
    this.clockAt = soonest;
    if (this.closing || soonest === Number.POSITIVE_INFINITY) return;
    this.clockTimer = setTimeout(
      () => void this.clockTick(),
      Math.max(0, soonest - Date.now()),
    );
  }

  /** Re-runs every group whose answer has stopped holding. */
  private async clockTick(): Promise<void> {
    this.clockTimer = null;
    this.clockAt = Number.POSITIVE_INFINITY;
    if (this.closing) return;
    const at = Date.now();
    const due = [...this.clockGroups].filter(
      (group) => group.clockUntil !== undefined && group.clockUntil <= at,
    );
    // Not due again until a run says when: each run re-times its group.
    for (const group of due) this.clockGroups.delete(group);
    this.armClock();
    if (due.length === 0) return;
    await this.trace("invalidation", "clock", null, async (ectx, meta) => {
      meta.affectedGroups = due.length;
      meta.reEvaluated = due.map((group) => group.queryName);
      await Promise.all(due.map((group) => this.rerunGroup(group, ectx, meta)));
    });
  }

  /** Hands a run's result to each member that has not heard it. */
  private deliver(
    group: SubscriptionGroup,
    result: unknown,
    measurement: ReactiveMeasurement,
  ): void {
    // Every member hears one value: the result itself when it is its
    // own JSON reading, else that reading, which a joiner hears too.
    const answer = measurement.exact ? result : parsed(measurement);
    for (const sub of group.members) {
      if (measurement.hash === sub.lastHash) continue;
      sub.lastHash = measurement.hash;
      try {
        deliverSubscriptionResult(sub.callback, answer, measurement.serialized);
      } catch (err) {
        console.error(
          `[vex] subscription ${group.queryName} callback failed:`,
          err,
        );
      }
    }
  }

  /** Tells a subscriber its view failed; a throwing listener is logged. */
  private notify(sub: Subscription, error: Error, ended: boolean): void {
    try {
      sub.onError?.(error, ended);
    } catch (err) {
      console.error(
        `[vex] subscription ${sub.group.queryName} onError failed:`,
        err,
      );
    }
  }

  /** Every member of `group` leaves. */
  private dropGroup(group: SubscriptionGroup): void {
    for (const sub of [...group.members]) this.dropSubscription(sub);
  }

  // ─── Public API ───

  async query<T = any>(
    name: string,
    given: Record<string, any> = {},
    callCtx?: ExecContext | CallContext,
  ): Promise<T> {
    refuseReentry("vex.query");
    const { parent, user } = normalizeCallContext(callCtx);
    return this.trace("query", name, parent, async (ectx, meta) => {
      const reg = this.queries.get(name);
      if (!reg) throw new Error(`Query not found: ${name}`);
      const args = reg.args(given);
      const recording = isTraceRecording(ectx);
      const tables = recording ? new Set<string>() : undefined;
      const dependencies = recording ? ([] as QueryDependency[]) : undefined;
      const result = await this.checkedRun(name, () => {
        const ctx = this.buildQueryContext(tables, user, dependencies);
        return this.runMiddleware(
          ctx,
          { type: "query", name, args, access: reg.def.access },
          () => reg.def.handler(ctx, args),
          ectx,
        );
      });
      const { serialized } = serializeJson(result, `query ${name} answers`);
      reg.returns?.(result);
      if (tables && dependencies) {
        meta.plugin = reg.plugin;
        meta.tables = [...tables];
        meta.dependencies = describeQueryDependencies(dependencies);
        if (Array.isArray(result)) meta.resultRows = result.length;
        else if (result && typeof result === "object" && "rows" in result)
          meta.resultRows = (result as any).rows?.length;
        // Same convention as measureReactiveResult: undefined results
        // are counted as the literal "undefined".
        meta.resultBytes = utf8ByteLength(serialized ?? "undefined");
      }
      return result as T;
    });
  }

  async mutate<T = any>(
    name: string,
    given: Record<string, any> = {},
    callCtx?: ExecContext | CallContext,
  ): Promise<T> {
    refuseReentry("vex.mutate");
    const { parent, user } = normalizeCallContext(callCtx);
    return this.trace("mutation", name, parent, async (ectx, meta) => {
      const reg = this.mutations.get(name);
      if (!reg) throw new Error(`Mutation not found: ${name}`);
      const args = reg.args(given);
      const writes: WriteDependency[] = [];
      const ctx = this.buildMutationContext(user, writes);
      const result = await this.storage.transaction(() =>
        this.runMiddleware(
          ctx,
          { type: "mutation", name, args, access: reg.def.access },
          () => reg.def.handler(ctx, args),
          ectx,
        ).then((answer) => {
          // Refused inside the transaction, so a non-JSON answer
          // commits nothing.
          serializeJson(answer, `mutation ${name} answers`);
          reg.returns?.(answer);
          return answer;
        }),
      );
      if (isTraceRecording(ectx)) {
        meta.plugin = reg.plugin;
        meta.writes = describeWrites(writes);
      }
      await this.invalidateAfter(ectx, writes);
      return result as T;
    });
  }

  /**
   * Runs action `name` as the caller: decided by middleware like any
   * operation, outside any transaction, its calls to queries and
   * mutations each made as the same caller (`ActionContext`). A caller
   * that has already stopped waiting starts nothing: the call rejects
   * with the signal's reason, as `fetch` does.
   */
  async action<T = any>(
    name: string,
    given: Record<string, any> = {},
    callCtx?: ExecContext | CallContext,
  ): Promise<T> {
    refuseReentry("vex.action");
    const { parent, user, signal } = normalizeCallContext(callCtx);
    return this.trace("action", name, parent, async (ectx, meta) => {
      const reg = this.actions.get(name);
      if (!reg) throw new Error(`Action not found: ${name}`);
      const args = reg.args(given);
      signal?.throwIfAborted();
      if (isTraceRecording(ectx)) meta.plugin = reg.plugin;
      const ctx = this.buildActionContext(user, ectx, signal);
      const result = await this.runMiddleware(
        ctx,
        { type: "action", name, args, access: reg.def.access },
        () => reg.def.handler(ctx, args),
        ectx,
      );
      serializeJson(result, `action ${name} answers`);
      reg.returns?.(result);
      return result as T;
    });
  }

  async subscribe(
    name: string,
    given: Record<string, any>,
    callback: SubscriptionCallback,
    callCtx?: SubscribeContext,
  ): Promise<() => void> {
    refuseReentry("vex.subscribe");
    this.assertOpen();
    const { user } = callCtx ? normalizeCallContext(callCtx) : {};
    const subId = `sub_${++this.subIdCounter}`;
    return this.trace("subscribe", name, null, async (_ectx, meta) => {
      const reg = this.queries.get(name);
      if (!reg) throw new Error(`Query not found: ${name}`);
      const args = reg.args(given);
      const recording = isTraceRecording(_ectx);
      const budget = this.resolveReactive(reg.def);
      if (recording) meta.reactive = budget !== false;
      if (budget === false) throw new Error(`Query ${name} is not reactive`);
      if (recording) meta.budget = budget;
      // A member of the group holding this query for this caller,
      // made and registered before its first run, so a write
      // committing during the run finds it (`runGroup`). A group with
      // an answer already hands it over without a run.
      const family = `${name}\0${canonical(args)}`;
      const group =
        this.joinableGroup(family, user) ??
        this.newGroup(family, name, args, user);
      const sub: Subscription = {
        id: subId,
        group,
        callback,
        lastHash: 0,
        onError: callCtx?.onError,
        user,
      };
      group.members.add(sub);
      this.subscriptions.set(subId, sub);
      try {
        const { result, measurement } = group.last
          ? { result: parsed(group.last), measurement: group.last }
          : await this.runGroup(group, reg, _ectx);
        if (recording) {
          meta.resultRows = measurement.resultRows;
          meta.resultBytes = measurement.resultBytes;
          meta.shared = group.members.size > 1;
        }
        try {
          this.assertReactiveBudget(measurement, budget);
        } catch (err) {
          if (recording) meta.budgetExceeded = true;
          throw err;
        }
        // A close() during the first run has already dropped every
        // subscription; this one must not outlive it.
        this.assertOpen();
        sub.lastHash = measurement.hash;
        deliverSubscriptionResult(
          callback,
          measurement.exact ? result : parsed(measurement),
          measurement.serialized,
        );
      } catch (err) {
        this.dropSubscription(sub);
        throw err;
      }
      if (recording) {
        meta.subId = subId;
        if (this.evaluation) meta.offThread = group.offThread;
        meta.tables = [...group.tables];
        meta.dependencies = describeQueryDependencies(group.dependencies);
        meta.totalSubs = this.subscriptions.size;
      }

      return () => {
        this.dropSubscription(sub);
        this.trace("unsubscribe", name, null, (_ectx, umeta) => {
          umeta.subId = subId;
          umeta.totalSubs = this.subscriptions.size;
        });
      };
    });
  }

  async handleWebhook(req: WebhookRequest): Promise<WebhookResponse> {
    const match = this.findWebhook(req.path, req.method);
    if (!match) return { status: 404, body: { error: "Webhook not found" } };

    return this.trace(
      "webhook",
      `${match.plugin}.${match.name}`,
      null,
      async (ectx, meta) => {
        meta.method = req.method;
        meta.path = req.path;
        if (match.def.verify && !match.def.verify(req)) {
          meta.status = 401;
          return {
            status: 401,
            body: { error: "Verification failed" },
          } as WebhookResponse;
        }
        // An action reached over HTTP: what it writes goes through
        // ctx.mutate, each a transaction of its own.
        const ctx = this.buildActionContext(undefined, ectx, undefined);
        const info: MiddlewareInfo<any> = {
          type: "webhook",
          name: `${match.plugin}.${match.name}`,
          args: req.body ?? {},
        };
        const result = await this.runMiddleware(
          ctx,
          info,
          () => match.def.handler(ctx, req),
          ectx,
        );
        if (result && typeof result === "object" && "status" in result) {
          meta.status = (result as any).status;
          return result as WebhookResponse;
        }
        meta.status = 200;
        return { status: 200, body: result };
      },
    );
  }

  private findWebhook(path: string, method: string) {
    for (const plugin of this.plugins) {
      for (const [name, def] of Object.entries(plugin.webhooks ?? {})) {
        if (
          def.path === path &&
          (def.method ?? "POST") === method.toUpperCase()
        ) {
          return { plugin: plugin.name, name, def };
        }
      }
    }
    return null;
  }

  // ─── Raw (vex-core/internal) ───

  /**
   * Runs SQL on the storage as it is: no access policy, no tracking
   * of what it reads. What it writes is announced like any write:
   * subscriptions over what it changed re-run, judged as an
   * unattributed change (every one over the tables it touched).
   */
  private async rawSql<T = Record<string, any>>(
    sql: string,
    ...params: any[]
  ): Promise<T[]> {
    const rows = await this.storage.rawQuery<T>(sql, ...params);
    if (statementKind(sql) !== "read") await this.announceWrites();
    return rows;
  }

  private async rawBulkInsert(
    table: string,
    rows: Record<string, any>[],
  ): Promise<void> {
    return this.trace("bulkInsert", table, null, async (ectx) => {
      // Each row with the id it is given here, so a read held to ids
      // can rule the insert out.
      const full = rows.map((row) => ({
        ...row,
        _id: row._id ?? generateId(12),
      }));
      await this.storage.bulkInsert(table, full);
      await this.invalidateAfter(
        ectx,
        full.map((row) => ({ table, values: row })),
      );
    });
  }

  /**
   * The storage, for code that keeps tables of its own on it: every
   * write through it is announced as `rawSql`'s are, a
   * transaction's once it commits, so no write can leave a
   * subscription unaware of it. Every call answers the same handle.
   */
  private rawStorage(): StorageAdapter {
    this.announcingStorage ??= this.announcing(this.storage);
    return this.announcingStorage;
  }

  /** `storage`, with every write through it announced. */
  private announcing(storage: StorageAdapter): StorageAdapter {
    const announced =
      <F extends (...args: any[]) => Promise<any>>(write: F) =>
      async (...args: Parameters<F>) => {
        const result = await write(...args);
        await this.announceWrites();
        return result;
      };
    return {
      ...storage,
      insert: announced(storage.insert),
      upsert: announced(storage.upsert),
      update: announced(storage.update),
      delete: announced(storage.delete),
      bulkInsert: announced(storage.bulkInsert),
      rawExec: announced(storage.rawExec),
      rawQuery: async <T>(sql: string, ...params: any[]) => {
        const rows = await storage.rawQuery<T>(sql, ...params);
        if (statementKind(sql) !== "read") await this.announceWrites();
        return rows;
      },
      transaction: announced(
        storage.transaction,
      ) as StorageAdapter["transaction"],
    };
  }

  /**
   * Invalidates for writes the engine did not make itself, so did not
   * record: whatever the storage reports changed, judged whole. Not
   * traced, since a tracer may itself write through the storage.
   */
  /** Raw access for `vex-core/internal`; no public name reaches it. */
  [RAW](): RawAccess {
    return {
      sql: (sql, ...params) => this.rawSql(sql, ...params),
      storage: () => this.rawStorage(),
      bulkInsert: (table, rows) => this.rawBulkInsert(table, rows),
    };
  }

  private announceWrites(): Promise<void> {
    return this.invalidateAfter(noopExecCtx);
  }

  // ─── Introspection ───

  listQueries(): string[] {
    return [...this.queries.keys()];
  }
  listMutations(): string[] {
    return [...this.mutations.keys()];
  }
  listActions(): string[] {
    return [...this.actions.keys()];
  }
  listPlugins() {
    return this.plugins.map((p) => ({ name: p.name }));
  }
  listTables() {
    return [...this.tables].map((name) => ({ name }));
  }
  activeSubscriptionCount() {
    return this.subscriptions.size;
  }

  describeSubscriptions() {
    return {
      total: this.subscriptions.size,
      unique: this.groups.size,
      queries: [...this.groups.values()]
        .map((group) => ({
          name: group.queryName,
          args: JSON.stringify(group.args),
          count: group.members.size,
          tables: [...group.tables],
        }))
        .sort((a, b) => b.count - a.count),
    };
  }

  async describeTable(table: string) {
    const rowCount = await this.storage.query(table).count();
    return {
      name: table,
      columns: declaredColumns(this.storage.getSchema(table)),
      rowCount,
    };
  }

  describeQuery(name: string): OperationDescription<A> | null {
    const q = this.queries.get(name);
    return q ? describeOperation<A>(q) : null;
  }
  describeMutation(name: string): OperationDescription<A> | null {
    const m = this.mutations.get(name);
    return m ? describeOperation<A>(m) : null;
  }
  describeAction(name: string): OperationDescription<A> | null {
    const a = this.actions.get(name);
    return a ? describeOperation<A>(a) : null;
  }

  async introspect() {
    const tables = await Promise.all(
      [...this.tables].map((t) => this.describeTable(t)),
    );
    const queries = [...this.queries.entries()].map(([name, q]) => ({
      name,
      ...describeOperation<A>(q),
    }));
    const mutations = [...this.mutations.entries()].map(([name, m]) => ({
      name,
      ...describeOperation<A>(m),
    }));
    const actions = [...this.actions.entries()].map(([name, a]) => ({
      name,
      ...describeOperation<A>(a),
    }));
    return {
      tables,
      queries,
      mutations,
      actions,
      subscriptions: this.subscriptions.size,
    };
  }

  /**
   * Closes the engine. From the call on it refuses job changes, job runs
   * and subscriptions, and no timer starts a job. Job changes in flight
   * finish without arming a timer, running jobs settle, and then storage
   * closes. Calling it again returns the same promise.
   */
  close(): Promise<void> {
    if (!this.closing) {
      if (this.clockTimer) clearTimeout(this.clockTimer);
      this.clockTimer = null;
      for (const timer of this.cronTimers.values()) clearTimeout(timer);
      this.cronTimers.clear();
      this.closing = this.shutDown();
    }
    return this.closing;
  }

  private async shutDown(): Promise<void> {
    await Promise.allSettled([...this.jobChanges.values()]);
    await Promise.allSettled([...this.runningJobs.values()]);
    this.subscriptions.clear();
    this.groups.clear();
    this.groupIndex.clear();
    this.anyTableGroups.clear();
    this.runningGroups.clear();
    this.evaluation?.close();
    await this.storage.close();
  }
}

// Every table name, current or previous, has exactly one claimant: the
// engine, or one plugin. Two plugins sharing a name silently share one
// SQL table with merged schemas, where one plugin's NOT NULL breaks the
// other's inserts, and a rename whose previous name is in use takes that
// table away. Names are compared case-insensitively, as SQLite does, and
// all of them are checked before any table is migrated.
function claimTableNames<A>(plugins: PluginDef<A>[]): void {
  const claimants = new Map<string, string>();
  const claim = (table: string, claimant: string) => {
    const existing = claimants.get(table.toLowerCase());
    if (existing) {
      throw new Error(
        `Duplicate table "${table}": claimed by ${existing} and by ${claimant}. ` +
          `Rename one of them (table names are not namespaced by plugin and ignore case).`,
      );
    }
    claimants.set(table.toLowerCase(), claimant);
  };
  for (const table of Object.keys(INTERNAL_TABLES)) claim(table, "the engine");
  for (const plugin of plugins) {
    for (const [table, schema] of Object.entries(plugin.tables)) {
      claim(table, `plugin "${plugin.name}"`);
      for (const previous of schema.renamedFrom ?? []) {
        claim(
          previous,
          `plugin "${plugin.name}" as a previous name of "${table}"`,
        );
      }
    }
  }
}

/** A schema's columns as it declares them. */
function declaredColumns(
  schema: TableSchema | null,
): Record<string, DescribedColumn> {
  const columns: Record<string, DescribedColumn> = {};
  for (const [name, def] of Object.entries(schema?.columns ?? {})) {
    columns[name] = {
      type: def.type,
      ...(def.optional ? { optional: true } : {}),
    };
  }
  return columns;
}

/**
 * `id` as the row id an update or delete addresses. Anything but a
 * non-empty string (a NULL `_id` read back, an undefined field)
 * addresses no row, so the call throws instead of matching none, or,
 * for `delete`, reading as the filtered bulk delete.
 */
function rowId(table: string, verb: "update" | "delete", id: unknown): string {
  if (typeof id === "string" && id !== "") return id;
  const got = id === "" ? "an empty string" : String(id);
  throw new Error(
    verb === "delete"
      ? `${table}.delete(id) needs a row id, got ${got}; call delete() with no argument to delete the rows the filters match`
      : `${table}.update(id) needs a row id, got ${got}`,
  );
}

function normalizeCallContext(callCtx?: ExecContext | CallContext): {
  parent?: ExecContext;
  user?: VexUser | null;
  signal?: AbortSignal;
} {
  if (!callCtx) return {};
  // ExecContext has traceId + span, CallContext has parent? + user?
  if ("traceId" in callCtx && "span" in callCtx) {
    return { parent: callCtx as ExecContext };
  }
  const cc = callCtx as CallContext;
  if (cc.user != null && canonical(cc.user) === null) {
    throw new TypeError(
      "a caller is plain data: a function, symbol or cycle in it is state no query could track",
    );
  }
  return { parent: cc.parent, user: cc.user, signal: cc.signal };
}

function parseSchedule(schedule: string): number {
  const match = schedule.match(/^every\s+(\d+)(s|m|h)$/);
  if (!match) return 0;
  const n = Number.parseInt(match[1], 10);
  switch (match[2]) {
    case "s":
      return n * 1000;
    case "m":
      return n * 60 * 1000;
    case "h":
      return n * 60 * 60 * 1000;
    default:
      return 0;
  }
}

const NO_VIEWS: string[] = [];
const WORD = /[\w$]/;

// The tables the engine writes itself. `_spans` is provided for an
// app's tracer to keep, and is the app's to write.
const ENGINE_TABLES = ["_jobs", "_migrations"];

/**
 * Why a mutation's raw SQL is refused, or null: each statement reads
 * or changes rows (SELECT, VALUES, WITH, INSERT, UPDATE, DELETE,
 * REPLACE), never the schema, a PRAGMA, an attached database or the
 * transaction the mutation runs in, and writes no table the engine
 * keeps for itself.
 */
function rawWriteRefusal(sql: string): string | null {
  for (const statement of splitStatements(sql)) {
    const kind = statementKind(statement);
    if (kind === "other") {
      const word = statement.trim().split(/\s+/)[0]?.toUpperCase() ?? "";
      return `ctx.db.sql in a mutation reads and changes rows; ${word || "this statement"} is refused (schema changes are migrations)`;
    }
    if (kind !== "read") {
      const named = namesIn(statement, ENGINE_TABLES);
      if (named.length > 0) {
        return `ctx.db.sql in a mutation writes no table the engine keeps (${named.join(", ")})`;
      }
    }
  }
  return null;
}

/**
 * The names of `names` that `sql` holds as a whole word, any case. A
 * statement reaches a view or a table only by naming it (a view naming
 * another is reached through the first); a name inside a string
 * literal counts too, so nothing is missed and more than needed may
 * be refused.
 */
function namesIn(sql: string, names: string[]): string[] {
  if (names.length === 0) return NO_VIEWS;
  const text = sql.toLowerCase();
  return names.filter((candidate) => {
    const name = candidate.toLowerCase();
    for (
      let at = text.indexOf(name);
      at !== -1;
      at = text.indexOf(name, at + 1)
    ) {
      const before = text[at - 1] ?? "";
      const after = text[at + name.length] ?? "";
      if (!WORD.test(before) && !WORD.test(after)) return true;
    }
    return false;
  });
}

/** A query that answered differently from the same data (`purityCheck`). */
export class PurityError extends Error {
  override readonly name = "PurityError";
}
