import type { TableAccessPolicy } from "./access.js";
import {
  governedRawSqlError,
  guardQueryBuilder,
  publishedGovernedError,
  UNRESTRICTED,
} from "./access.js";
import type { PluginFunction } from "./api.js";
import { resolvePlugin } from "./api.js";
import { INTERNAL_TABLES } from "./internal.js";
import { hashResult, utf8ByteLength } from "./result-measure.js";
import { statementKind, tablesRead, type ViewDefinition } from "./sql-text.js";
import { ANY_TABLE, type StorageAdapter } from "./storage.js";
import {
  describeQueryDependencies,
  describeWrites,
  type QueryDependency,
  type WriteDependency,
} from "./trace-metadata.js";
import type { ExecContext, Tracer } from "./tracer.js";
import { createRootSpan, isTraceRecording } from "./tracer.js";
import type {
  CallContext,
  DescribedColumn,
  JobDef,
  MiddlewareFn,
  MiddlewareInfo,
  MutationContext,
  MutationDef,
  MutationTable,
  PluginDef,
  QueryBuilder,
  QueryContext,
  QueryDef,
  ReactiveBudget,
  TableSchema,
  VexRuntime,
  VexUser,
  WebhookRequest,
  WebhookResponse,
} from "./types.js";

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

interface Subscription {
  id: string;
  queryName: string;
  args: Record<string, any>;
  argsKey: string;
  userKey: string;
  callback: SubscriptionCallback;
  lastHash: number;
  tables: Set<string>;
  dependencies: QueryDependency[];
  user?: VexUser | null;
}

function subscriptionGroupKey(subscription: Subscription): string {
  return `${subscription.queryName}\0${subscription.argsKey}\0${subscription.userKey}`;
}

function subscriptionUserKey(user: VexUser | null | undefined): string {
  return JSON.stringify(user ? [user.id, user.name, user.isAdmin] : null);
}

/**
 * A raw write in a mutation, as its trace records it: it names no rows,
 * and which tables it changed the adapter reports (`takeChanges`).
 */
const RAW_WRITE: WriteDependency = { table: ANY_TABLE, raw: true };

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
interface RegisteredQuery {
  plugin: string;
  def: QueryDef<any>;
}
interface RegisteredMutation {
  plugin: string;
  def: MutationDef<any>;
}

/**
 * How the engine describes a query or mutation, wherever it does: its
 * plugin, its args, and the access it declares (`OperationAccess`),
 * `undefined` when it declares none.
 */
export interface OperationDescription<A> {
  plugin: string;
  args: Record<string, string>;
  access: A | undefined;
}

function describeOperation<A>(
  registered: RegisteredQuery | RegisteredMutation,
): OperationDescription<A> {
  return {
    plugin: registered.plugin,
    args: registered.def.args,
    access: registered.def.access,
  };
}

interface JobRunResult {
  status: "ok" | "error";
  error: string | null;
  durationMs: number;
}

/**
 * `A` is the app's access declaration (`OperationAccess`): what every
 * query and mutation of every plugin must declare. Unchosen, there is
 * none to declare.
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
   * starts no timers.
   */
  jobScheduler?: "timers" | "external";
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
  private subscriptions: Map<string, Subscription> = new Map();
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
  private jobScheduler: "timers" | "external" = "timers";
  // Set by close(): a closed engine refuses job changes, job runs and
  // subscriptions.
  private closing: Promise<void> | null = null;
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
      this.queries.set(key, { plugin: plugin.name, def });
    }

    for (const [name, def] of Object.entries(plugin.mutations)) {
      const key = `${plugin.name}.${name}`;
      if (this.mutations.has(key))
        throw new Error(`Duplicate mutation: ${key}`);
      this.mutations.set(key, { plugin: plugin.name, def });
    }

    for (const [name, job] of Object.entries(plugin.jobs ?? {})) {
      const cronName = `${plugin.name}.${name}`;
      await this.addJob(cronName, job, plugin.name);
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
            const ctx = this.buildMutationContext();
            await job.handler(ctx);
            await this.invalidateSubscriptions(ectx);
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

  private buildQueryContext(
    touchedTables?: Set<string>,
    user?: VexUser | null,
    dependencies?: QueryDependency[],
  ): QueryContext {
    const self = this;
    // One prepared access context per governed table per operation:
    // a handler reading `sessions` through three chains resolves the
    // caller's standing once. Subscription re-runs rebuild the whole
    // context, so revocations apply on the next invalidation.
    const preparedAccess = new Map<string, Promise<unknown>>();
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
        prepared = Promise.resolve(policy.prepare(user, accessReader));
        preparedAccess.set(name, prepared);
      }
      return prepared;
    }
    // A raw read depends on every table it reads, any of whose changes
    // re-runs it; one that reads no table, on any change at all.
    function trackRaw(tables: readonly string[]): void {
      if (!touchedTables && !dependencies) return;
      for (const table of tables) {
        touchedTables?.add(table);
        dependencies?.push({ table, raw: true });
      }
      if (tables.length === 0)
        dependencies?.push({ table: ANY_TABLE, raw: true });
    }
    return {
      db: {
        table(name: string) {
          const policy = self.accessPolicies.get(name);
          if (!policy) return baseBuilder(name);
          return guardQueryBuilder(name, baseBuilder(name), policy, () =>
            resolvePrepared(name, policy),
          );
        },
        sql<T = Record<string, any>>(
          sql: string,
          ...params: any[]
        ): Promise<T[]> {
          const read = (tables: string[]): Promise<T[]> => {
            const governed = tables.filter((table) =>
              self.accessPolicies.has(table),
            );
            if (governed.length > 0) {
              return Promise.reject(governedRawSqlError(governed));
            }
            trackRaw(tables);
            return self.storage.rawQuery<T>(sql, ...params);
          };
          // Known tables are answered at once, without a microtask hop.
          const tables = self.rawReadTables(sql);
          return Array.isArray(tables) ? read(tables) : tables.then(read);
        },
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
      runtime: this.runtime(),
      user: user ?? undefined,
    };
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
    const record = () => dependencies?.push({ table, ...descriptor });
    const tracked: QueryBuilder = {
      where(column, operator, value) {
        current = current.where(column, operator, value);
        descriptor.filters = [
          ...(descriptor.filters ?? []),
          { column, operator, value },
        ];
        return tracked;
      },
      select(...columns) {
        current = current.select(...columns);
        descriptor.select = columns;
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
        record();
        return current.all();
      },
      first: async () => {
        record();
        return current.first();
      },
      distinct: async (col) => {
        record();
        return current.distinct(col);
      },
      count: async () => {
        record();
        return current.count();
      },
      countDistinct: async (col) => {
        record();
        return current.countDistinct(col);
      },
      sum: async (col) => {
        record();
        return current.sum(col);
      },
      avg: async (col) => {
        record();
        return current.avg(col);
      },
      min: async (col) => {
        record();
        return current.min(col);
      },
      max: async (col) => {
        record();
        return current.max(col);
      },
      groupBy: (col, aggs) => {
        record();
        return current.groupBy(col, aggs);
      },
      delete: () => current.delete(),
    };
    return tracked;
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

  private buildMutationContext(
    user?: VexUser | null,
    writes?: WriteDependency[],
  ): MutationContext {
    const self = this;
    return {
      db: {
        sql<T = Record<string, any>>(
          sql: string,
          ...params: any[]
        ): Promise<T[]> {
          if (statementKind(sql) !== "read" && !writes?.includes(RAW_WRITE))
            writes?.push(RAW_WRITE);
          return self.storage.rawQuery<T>(sql, ...params);
        },
        table(name: string): MutationTable {
          const adapter = self.storage;
          function build(qb: QueryBuilder): MutationTable {
            return {
              where: (col, op, val) => build(qb.where(col, op, val)),
              select: (...cols) => build(qb.select(...cols)),
              order: (col, dir) => build(qb.order(col, dir)),
              limit: (n) => build(qb.limit(n)),
              offset: (n) => build(qb.offset(n)),
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
              // after it (WriteDependency.values): an insert's whole row,
              // an upsert's keys that its data leaves alone, an update's or
              // delete's id. An update's new values are not among them: the
              // row may have left a filtered set by taking them.
              insert: (row) => {
                writes?.push({
                  table: name,
                  values: row,
                  columns: Object.keys(row),
                });
                return adapter.insert(name, row);
              },
              upsert: (keys, data) => {
                writes?.push({
                  table: name,
                  values: Object.fromEntries(
                    Object.entries(keys).filter(
                      ([column]) => !(column in data),
                    ),
                  ),
                  columns: Object.keys({ ...keys, ...data }),
                });
                return adapter.upsert(name, keys, data);
              },
              update: (id, data) => {
                const target = rowId(name, "update", id);
                writes?.push({
                  table: name,
                  values: { _id: target },
                  columns: Object.keys(data),
                });
                return adapter.update(name, target, data);
              },
              // No argument deletes every row the filters match; an
              // argument is one row's id, which `rowId` holds to a
              // string: read as "no argument", a missing id would empty
              // the table.
              delete: (...args: [id?: string]) => {
                if (args.length === 0) {
                  writes?.push({ table: name });
                  return qb.delete();
                }
                const target = rowId(name, "delete", args[0]);
                writes?.push({ table: name, values: { _id: target } });
                return adapter.delete(name, target);
              },
            };
          }
          return build(adapter.query(name));
        },
      },
      runtime: this.runtime(),
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

  private async runMiddleware(
    ctx: QueryContext | MutationContext,
    info: MiddlewareInfo<any>,
    handler: () => Promise<any> | any,
    ectx: ExecContext,
  ): Promise<any> {
    if (this.middleware.length === 0) {
      return this.trace("handler", info.name, ectx, () =>
        this.withTimeout(Promise.resolve(handler())),
      );
    }
    return this.trace("middleware", info.name, ectx, (mwEctx) => {
      let i = 0;
      const chain = (): Promise<any> | any => {
        if (i < this.middleware.length)
          return this.middleware[i++](ctx, info, chain);
        return this.trace("handler", info.name, mwEctx, () =>
          this.withTimeout(Promise.resolve(handler())),
        );
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

  private measureReactiveResult(result: any): {
    hash: number;
    resultRows: number | undefined;
    resultBytes: number;
    serialized: string | undefined;
  } {
    const serialized = JSON.stringify(result);
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
   * Over a changed table, only equality filters that the writes' values
   * (WriteDependency.values) rule out let it be skipped, and only when
   * every write to the table is one of those: not over an unattributed
   * table.
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
      const eqFilters = (dep.filters ?? []).filter(
        (filter) => filter.operator === "=",
      );
      if (eqFilters.length === 0) return true;
      if (
        tableWrites.some((write) =>
          eqFilters.every(
            (filter) =>
              !(filter.column in (write.values ?? {})) ||
              write.values?.[filter.column] === filter.value,
          ),
        )
      ) {
        return true;
      }
    }
    return false;
  }

  private async invalidateSubscriptions(
    ectx: ExecContext,
    writes?: WriteDependency[],
  ): Promise<void> {
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
        const groups = new Map<string, Subscription[]>();
        for (const sub of this.subscriptions.values()) {
          const affected =
            everything ||
            this.dependencyAffected(
              sub.dependencies,
              changedSet,
              unattributed,
              writesByTable,
            );
          if (!affected) continue;
          const key = subscriptionGroupKey(sub);
          let group = groups.get(key);
          if (!group) {
            group = [];
            groups.set(key, group);
          }
          group.push(sub);
        }

        meta.changedTables = [...changedSet];
        meta.affectedGroups = groups.size;
        meta.activeSubs = this.subscriptions.size;
        meta.reEvaluated = [...groups.values()].map((s) => s[0].queryName);

        for (const [, subs] of groups) {
          const first = subs[0];
          try {
            const tables = new Set<string>();
            const dependencies: QueryDependency[] = [];
            const reg = this.queries.get(first.queryName);
            if (!reg) continue;
            const budget = this.resolveReactive(reg.def);
            if (budget === false) {
              for (const sub of subs) this.subscriptions.delete(sub.id);
              meta.disabledSubscriptions =
                (meta.disabledSubscriptions ?? 0) + subs.length;
              continue;
            }
            const ctx = this.buildQueryContext(
              tables,
              first.user,
              dependencies,
            );
            const result = await this.runMiddleware(
              ctx,
              {
                type: "query",
                name: first.queryName,
                args: first.args,
                access: reg.def.access,
              },
              () => reg.def.handler(ctx, first.args),
              _invEctx,
            );
            const measurement = this.measureReactiveResult(result);
            try {
              this.assertReactiveBudget(measurement, budget);
            } catch {
              meta.budgetExceeded = true;
              meta.disabledSubscriptions =
                (meta.disabledSubscriptions ?? 0) + subs.length;
              meta.resultRows = measurement.resultRows;
              meta.resultBytes = measurement.resultBytes;
              meta.budget = budget;
              for (const sub of subs) this.subscriptions.delete(sub.id);
              continue;
            }
            for (const sub of subs) {
              sub.tables = tables;
              sub.dependencies = dependencies;
              if (measurement.hash !== sub.lastHash) {
                sub.lastHash = measurement.hash;
                try {
                  deliverSubscriptionResult(
                    sub.callback,
                    result,
                    measurement.serialized,
                  );
                } catch (err) {
                  console.error(
                    `[vex] subscription ${sub.queryName} callback failed:`,
                    err,
                  );
                }
              }
            }
          } catch (err) {
            console.error(`[vex] subscription ${first.queryName} failed:`, err);
          }
        }
      },
    );
  }

  // ─── Public API ───

  use(fn: MiddlewareFn<A>) {
    this.middleware.push(fn);
  }

  async query<T = any>(
    name: string,
    args: Record<string, any> = {},
    callCtx?: ExecContext | CallContext,
  ): Promise<T> {
    const { parent, user } = normalizeCallContext(callCtx);
    return this.trace("query", name, parent, async (ectx, meta) => {
      const reg = this.queries.get(name);
      if (!reg) throw new Error(`Query not found: ${name}`);
      const recording = isTraceRecording(ectx);
      const tables = recording ? new Set<string>() : undefined;
      const dependencies = recording ? ([] as QueryDependency[]) : undefined;
      const ctx = this.buildQueryContext(tables, user, dependencies);
      const result = await this.runMiddleware(
        ctx,
        { type: "query", name, args, access: reg.def.access },
        () => reg.def.handler(ctx, args),
        ectx,
      );
      if (tables && dependencies) {
        meta.plugin = reg.plugin;
        meta.tables = [...tables];
        meta.dependencies = describeQueryDependencies(dependencies);
        if (Array.isArray(result)) meta.resultRows = result.length;
        else if (result && typeof result === "object" && "rows" in result)
          meta.resultRows = (result as any).rows?.length;
        try {
          // Same convention as measureReactiveResult: undefined results
          // are counted as the literal "undefined".
          meta.resultBytes = utf8ByteLength(
            JSON.stringify(result) ?? "undefined",
          );
        } catch {}
      }
      return result as T;
    });
  }

  async mutate<T = any>(
    name: string,
    args: Record<string, any> = {},
    callCtx?: ExecContext | CallContext,
  ): Promise<T> {
    const { parent, user } = normalizeCallContext(callCtx);
    return this.trace("mutation", name, parent, async (ectx, meta) => {
      const reg = this.mutations.get(name);
      if (!reg) throw new Error(`Mutation not found: ${name}`);
      const writes: WriteDependency[] = [];
      const ctx = this.buildMutationContext(user, writes);
      const result = await this.storage.transaction(() =>
        this.runMiddleware(
          ctx,
          { type: "mutation", name, args, access: reg.def.access },
          () => reg.def.handler(ctx, args),
          ectx,
        ),
      );
      if (isTraceRecording(ectx)) {
        meta.plugin = reg.plugin;
        meta.writes = describeWrites(writes);
      }
      await this.invalidateSubscriptions(ectx, writes);
      return result as T;
    });
  }

  async subscribe(
    name: string,
    args: Record<string, any>,
    callback: SubscriptionCallback,
    callCtx?: CallContext,
  ): Promise<() => void> {
    this.assertOpen();
    const { user } = callCtx ? normalizeCallContext(callCtx) : {};
    const subId = `sub_${++this.subIdCounter}`;
    return this.trace("subscribe", name, null, async (_ectx, meta) => {
      const reg = this.queries.get(name);
      if (!reg) throw new Error(`Query not found: ${name}`);
      const recording = isTraceRecording(_ectx);
      const budget = this.resolveReactive(reg.def);
      if (recording) meta.reactive = budget !== false;
      if (budget === false) throw new Error(`Query ${name} is not reactive`);
      if (recording) meta.budget = budget;
      const tables = new Set<string>();
      const dependencies: QueryDependency[] = [];
      const ctx = this.buildQueryContext(tables, user, dependencies);
      const result = await this.runMiddleware(
        ctx,
        { type: "query", name, args, access: reg.def.access },
        () => reg.def.handler(ctx, args),
        _ectx,
      );
      const measurement = this.measureReactiveResult(result);
      if (recording) {
        meta.resultRows = measurement.resultRows;
        meta.resultBytes = measurement.resultBytes;
      }
      try {
        this.assertReactiveBudget(measurement, budget);
      } catch (err) {
        if (recording) meta.budgetExceeded = true;
        throw err;
      }
      const sub: Subscription = {
        id: subId,
        queryName: name,
        args,
        argsKey: JSON.stringify(args),
        userKey: subscriptionUserKey(user),
        callback,
        lastHash: measurement.hash,
        tables,
        dependencies,
        user,
      };
      // A close() during the first run has already dropped every
      // subscription; this one must not outlive it.
      this.assertOpen();
      this.subscriptions.set(subId, sub);
      try {
        deliverSubscriptionResult(callback, result, measurement.serialized);
      } catch (err) {
        this.subscriptions.delete(subId);
        throw err;
      }
      if (recording) {
        meta.subId = subId;
        meta.tables = [...tables];
        meta.dependencies = describeQueryDependencies(dependencies);
        meta.totalSubs = this.subscriptions.size;
      }

      return () => {
        this.subscriptions.delete(subId);
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
        const ctx = this.buildMutationContext();
        const info: MiddlewareInfo<any> = {
          type: "webhook",
          name: `${match.plugin}.${match.name}`,
          args: req.body ?? {},
        };
        const result = await this.storage.transaction(() =>
          this.runMiddleware(
            ctx,
            info,
            () => match.def.handler(ctx, req),
            ectx,
          ),
        );
        await this.invalidateSubscriptions(ectx);
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

  // ─── Unsafe ───

  async unsafeSql<T = Record<string, any>>(
    sql: string,
    ...params: any[]
  ): Promise<T[]> {
    return this.storage.rawQuery<T>(sql, ...params);
  }

  async unsafeBulkInsert(
    table: string,
    rows: Record<string, any>[],
  ): Promise<void> {
    return this.trace("bulkInsert", table, null, async (ectx) => {
      await this.storage.bulkInsert(table, rows);
      await this.invalidateSubscriptions(
        ectx,
        rows.map((row) => ({ table, values: row })),
      );
    });
  }

  unsafeGetStorage(): StorageAdapter {
    return this.storage;
  }

  // ─── Introspection ───

  listQueries(): string[] {
    return [...this.queries.keys()];
  }
  listMutations(): string[] {
    return [...this.mutations.keys()];
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
    const byQuery = new Map<
      string,
      { args: string; count: number; tables: string[] }
    >();
    for (const sub of this.subscriptions.values()) {
      const key = subscriptionGroupKey(sub);
      const existing = byQuery.get(key);
      if (existing) {
        existing.count++;
      } else {
        byQuery.set(key, {
          args: sub.argsKey,
          count: 1,
          tables: [...sub.tables],
        });
      }
    }
    return {
      total: this.subscriptions.size,
      unique: byQuery.size,
      queries: [...byQuery.entries()]
        .map(([key, v]) => ({
          name: key.split("\0")[0],
          args: v.args,
          count: v.count,
          tables: v.tables,
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
    return {
      tables,
      queries,
      mutations,
      subscriptions: this.subscriptions.size,
    };
  }

  async readTable(table: string, opts?: { limit?: number; offset?: number }) {
    return this.trace("query", `_system.readTable:${table}`, null, async () => {
      const total = await this.storage.query(table).count();
      const reader = this.storage.query(table);
      if (opts?.limit) reader.limit(opts.limit);
      if (opts?.offset) reader.offset(opts.offset);
      reader.order("_id", "desc");
      return { rows: await reader.all(), total };
    });
  }

  /**
   * Closes the engine. From the call on it refuses job changes, job runs
   * and subscriptions, and no timer starts a job. Job changes in flight
   * finish without arming a timer, running jobs settle, and then storage
   * closes. Calling it again returns the same promise.
   */
  close(): Promise<void> {
    if (!this.closing) {
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
} {
  if (!callCtx) return {};
  // ExecContext has traceId + span, CallContext has parent? + user?
  if ("traceId" in callCtx && "span" in callCtx) {
    return { parent: callCtx as ExecContext };
  }
  const cc = callCtx as CallContext;
  return { parent: cc.parent, user: cc.user };
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
