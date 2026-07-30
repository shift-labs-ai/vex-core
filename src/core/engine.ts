import type { PluginFunction } from "./api.js";
import { resolvePlugin } from "./api.js";
import { INTERNAL_TABLES } from "./internal.js";
import type { StorageAdapter } from "./storage.js";
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

interface RegisteredQuery {
  plugin: string;
  def: QueryDef;
}
interface RegisteredMutation {
  plugin: string;
  def: MutationDef;
}

interface JobRunResult {
  status: "ok" | "error";
  error: string | null;
  durationMs: number;
}

export interface VexOptions {
  plugins: Array<PluginFunction | PluginDef>;
  storage: StorageAdapter;
  tracer?: Tracer;
  appId?: string;
  handlerTimeoutMs?: number;
  reactive?: ReactiveBudget;
}

export class Vex {
  private storage: StorageAdapter;
  private plugins: PluginDef[] = [];
  private queries: Map<string, RegisteredQuery> = new Map();
  private mutations: Map<string, RegisteredMutation> = new Map();
  private subscriptions: Map<string, Subscription> = new Map();
  private tables: Set<string> = new Set();
  // Who registered each table. Two plugins registering the same bare
  // name silently share one SQL table with merged schemas — one plugin's
  // NOT NULL can break the other's inserts. registerPlugin fails loudly
  // on collision using this map.
  private tableOwners: Map<string, string> = new Map();
  private middleware: MiddlewareFn[] = [];
  private cronTimers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private jobHandlers: Map<string, JobDef> = new Map();
  private jobIntervalMs: Map<string, number> = new Map();
  private runningJobs: Map<string, Promise<JobRunResult>> = new Map();
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

  static async create(options: VexOptions): Promise<Vex> {
    const vex = new Vex(options.storage);
    if (options.tracer) vex.tracer = options.tracer;
    if (options.appId) vex.appId = options.appId;
    if (options.handlerTimeoutMs)
      vex.handlerTimeoutMs = options.handlerTimeoutMs;
    if (options.reactive) {
      vex.reactiveDefaults = {
        maxRows: options.reactive.maxRows ?? vex.reactiveDefaults.maxRows,
        maxBytes: options.reactive.maxBytes ?? vex.reactiveDefaults.maxBytes,
      };
    }

    // Register internal tables
    for (const [name, schema] of Object.entries(INTERNAL_TABLES)) {
      vex.tables.add(name);
      await vex.storage.ensureTable(name, schema);
    }

    for (const pluginInput of options.plugins) {
      const plugin = resolvePlugin(pluginInput);
      vex.plugins.push(plugin);
      await vex.registerPlugin(plugin);
    }

    return vex;
  }

  // ─── Internal ───

  private async registerPlugin(plugin: PluginDef): Promise<void> {
    if (plugin.middleware) this.middleware.push(...plugin.middleware);

    for (const [tableName, schema] of Object.entries(plugin.tables)) {
      const existingOwner = this.tableOwners.get(tableName);
      if (existingOwner) {
        throw new Error(
          `Duplicate table "${tableName}": already registered by plugin "${existingOwner}", ` +
            `now re-registered by plugin "${plugin.name}". ` +
            `Rename one of them (table names are not namespaced by plugin).`,
        );
      }
      this.tableOwners.set(tableName, plugin.name);
      this.tables.add(tableName);
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

  private startJobTimer(cronName: string, job: JobDef, ms: number) {
    if (this.cronTimers.has(cronName)) return;
    this.cronTimers.set(
      cronName,
      setInterval(() => {
        this.executeJob(cronName, job);
      }, ms),
    );
  }

  private stopJobTimer(cronName: string) {
    const timer = this.cronTimers.get(cronName);
    if (timer) {
      clearInterval(timer);
      this.cronTimers.delete(cronName);
    }
  }

  async addJob(name: string, job: JobDef, plugin = "_dynamic") {
    const ms = parseSchedule(job.schedule);
    if (ms <= 0) throw new Error(`Invalid schedule: ${job.schedule}`);

    this.stopJobTimer(name);
    this.jobHandlers.set(name, job);
    this.jobIntervalMs.set(name, ms);

    const existing = await this.storage
      .rawQuery<any>("SELECT _id FROM _jobs WHERE name = ?", name)
      .then((r) => r[0]);
    if (existing) {
      await this.storage.update("_jobs", existing._id, {
        plugin,
        schedule: job.schedule,
        description: job.description ?? null,
        enabled: job.enabled !== false ? 1 : 0,
        timeoutMs: job.timeoutMs ?? null,
        retries: job.retries ?? 0,
        retryDelayMs: job.retryDelayMs ?? null,
      });
    } else {
      await this.storage.insert("_jobs", {
        name,
        plugin,
        schedule: job.schedule,
        description: job.description ?? null,
        enabled: job.enabled !== false ? 1 : 0,
        timeoutMs: job.timeoutMs ?? null,
        retries: job.retries ?? 0,
        retryDelayMs: job.retryDelayMs ?? null,
        runs: 0,
      });
    }

    if (job.enabled !== false) {
      this.startJobTimer(name, job, ms);
      await this.storage.rawExec(
        "UPDATE _jobs SET nextRun = ? WHERE name = ?",
        Date.now() + ms,
        name,
      );
    }
  }

  async removeJob(name: string) {
    this.stopJobTimer(name);
    this.jobHandlers.delete(name);
    this.jobIntervalMs.delete(name);
    const row = await this.storage
      .rawQuery<any>("SELECT _id FROM _jobs WHERE name = ?", name)
      .then((r) => r[0]);
    if (row) await this.storage.delete("_jobs", row._id);
  }

  async setJobEnabled(name: string, enabled: boolean) {
    const handler = this.jobHandlers.get(name);
    if (!handler) throw new Error(`Job not found: ${name}`);
    const ms = this.jobIntervalMs.get(name) ?? 0;

    const row = await this.storage
      .rawQuery<any>("SELECT _id FROM _jobs WHERE name = ?", name)
      .then((r) => r[0]);
    if (!row) throw new Error(`Job not found in DB: ${name}`);

    if (enabled && ms > 0) {
      this.startJobTimer(name, handler, ms);
      await this.storage.update("_jobs", row._id, {
        enabled: 1,
        nextRun: Date.now() + ms,
      });
    } else {
      this.stopJobTimer(name);
      await this.storage.update("_jobs", row._id, {
        enabled: 0,
        nextRun: null,
      });
    }
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

        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, retryDelay));
        }
      }
    }

    return lastResult;
  }

  async triggerJob(name: string) {
    const handler = this.jobHandlers.get(name);
    if (!handler) throw new Error(`Job not found: ${name}`);
    return this.executeJob(name, handler);
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
    return {
      db: {
        table(name: string) {
          const query = self.storage.query(name);
          if (!touchedTables && !dependencies) return query;
          touchedTables?.add(name);
          return self.trackQueryBuilder(query, name, dependencies);
        },
        sql<T = Record<string, any>>(
          sql: string,
          ...params: any[]
        ): Promise<T[]> {
          if (touchedTables || dependencies) {
            const tables = self.extractTables(sql);
            for (const table of tables) {
              touchedTables?.add(table);
              dependencies?.push({ table, raw: true });
            }
            if (tables.length === 0)
              dependencies?.push({ table: "*", raw: true });
          }
          return self.storage.rawQuery<T>(sql, ...params);
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

  private extractTables(sql: string): string[] {
    const tables = new Set<string>();
    const re = /\b(?:from|join)\s+["`]?([a-zA-Z_][\w]*)["`]?/gi;
    for (const match of sql.matchAll(re)) tables.add(match[1]);
    return [...tables];
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
          for (const table of self.extractTables(sql))
            writes?.push({ table, raw: true });
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
              insert: (row) => {
                writes?.push({ table: name, values: row });
                return adapter.insert(name, row);
              },
              upsert: (keys, data) => {
                writes?.push({ table: name, values: { ...keys, ...data } });
                return adapter.upsert(name, keys, data);
              },
              update: (id, data) => {
                writes?.push({ table: name, values: data });
                return adapter.update(name, id, data);
              },
              delete: (id?) => {
                writes?.push({ table: name });
                return typeof id === "string"
                  ? adapter.delete(name, id)
                  : qb.delete();
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
    info: MiddlewareInfo,
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

  private resolveReactive(def: QueryDef): false | Required<ReactiveBudget> {
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
    const resultRows = Array.isArray(result)
      ? result.length
      : result && typeof result === "object" && Array.isArray(result.rows)
        ? result.rows.length
        : undefined;
    return {
      hash: Number(Bun.hash(serialized)),
      resultRows,
      resultBytes: Buffer.byteLength(serialized ?? "undefined"),
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

  private dependencyAffected(
    dependencies: QueryDependency[],
    changedSet: Set<string>,
    writesByTable?: Map<string, WriteDependency[]>,
  ): boolean {
    if (dependencies.length === 0) return true;
    for (const dep of dependencies) {
      if (dep.table === "*" && dep.raw) return true;
      if (!changedSet.has(dep.table)) continue;
      if (dep.raw) return true;
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
    const changed = this.storage.getChangedTables();
    if (changed.length === 0) return;

    const changedSet = new Set(changed);
    const writesByTable = groupWritesByTable(writes);

    return this.trace(
      "invalidation",
      "subscriptions",
      ectx,
      async (_invEctx, meta) => {
        const groups = new Map<string, Subscription[]>();
        for (const sub of this.subscriptions.values()) {
          const affected = this.dependencyAffected(
            sub.dependencies,
            changedSet,
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
              { type: "query", name: first.queryName, args: first.args },
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

  use(fn: MiddlewareFn) {
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
        { type: "query", name, args },
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
          meta.resultBytes = Buffer.byteLength(
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
          { type: "mutation", name, args },
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
        { type: "query", name, args },
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
        const info: MiddlewareInfo = {
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
    const schema = this.storage.getSchema(table);
    const columns: Record<string, { type: string; optional?: boolean }> = {};
    if (schema?.columns) {
      for (const [col, def] of Object.entries(schema.columns))
        columns[col] = {
          type: (def as any).type,
          ...((def as any).optional ? { optional: true } : {}),
        };
    }
    return {
      name: table,
      columns,
      rowCount,
    };
  }

  describeQuery(name: string) {
    const q = this.queries.get(name);
    return q ? { plugin: q.plugin, args: q.def.args } : null;
  }
  describeMutation(name: string) {
    const m = this.mutations.get(name);
    return m ? { plugin: m.plugin, args: m.def.args } : null;
  }

  async introspect() {
    const tables = await Promise.all(
      [...this.tables].map((t) => this.describeTable(t)),
    );
    const queries = [...this.queries.entries()].map(([name, q]) => ({
      name,
      plugin: q.plugin,
      args: q.def.args,
    }));
    const mutations = [...this.mutations.entries()].map(([name, m]) => ({
      name,
      plugin: m.plugin,
      args: m.def.args,
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

  async close() {
    for (const timer of this.cronTimers.values()) clearInterval(timer);
    this.cronTimers.clear();
    await Promise.allSettled([...this.runningJobs.values()]);
    this.subscriptions.clear();
    await this.storage.close();
  }
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
