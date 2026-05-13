import type { PluginFunction } from "./api.js";
import { resolvePlugin } from "./api.js";
import { INTERNAL_TABLES } from "./internal.js";
import type { StorageAdapter } from "./storage.js";
import type { ExecContext, Tracer } from "./tracer.js";
import { createRootSpan } from "./tracer.js";
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
  VexUser,
  WebhookRequest,
  WebhookResponse,
} from "./types.js";

type SubscriptionCallback = (data: any) => void;

const TRACE_TYPES = new Set(["agent", "channel", "cron", "webhook"]);

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
  callback: SubscriptionCallback;
  lastHash: number;
  tables: Set<string>;
}

interface RegisteredQuery {
  plugin: string;
  def: QueryDef;
}
interface RegisteredMutation {
  plugin: string;
  def: MutationDef;
}

export interface VexOptions {
  plugins: Array<PluginFunction | PluginDef>;
  storage: StorageAdapter;
  tracer?: Tracer;
  appId?: string;
  handlerTimeoutMs?: number;
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
  private subIdCounter = 0;
  private tracer: Tracer | null = null;
  private appId: string = "unknown";
  private handlerTimeoutMs: number = 0;

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
      meta.stack = e.stack ?? null;
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

    // Sensitive columns get stripped from `_system.rows` so encrypted blobs
    // never leak via the row browser. Add new tables here as needed.
    const SENSITIVE_COLUMNS: Record<string, readonly string[]> = {
      provider_credentials: ["credential"],
      providers: ["credential"],
      secrets: ["value"],
      auth_users: ["token"],
      browser_sessions: ["token"],
    };

    vex.queries.set("_system.rows", {
      plugin: "_system",
      def: {
        args: { table: "string" },
        async handler(ctx: QueryContext, args: Record<string, any>) {
          const total = await ctx.db.table(args.table).count();
          const rows = await ctx.db
            .table(args.table)
            .order("_id", "desc")
            .limit(args.limit ?? 50)
            .offset(args.offset ?? 0)
            .all();
          const sensitive = SENSITIVE_COLUMNS[args.table];
          if (sensitive && sensitive.length > 0) {
            for (const row of rows as Record<string, any>[]) {
              for (const col of sensitive) {
                if (col in row) row[col] = "\u2022\u2022\u2022";
              }
            }
          }
          return { rows, total };
        },
      },
    });

    vex.queries.set("_system.jobs", {
      plugin: "_system",
      def: {
        args: {},
        async handler(ctx: QueryContext) {
          return ctx.db.table("_jobs").order("name", "asc").all();
        },
      },
    });

    vex.queries.set("_system.triggerJob", {
      plugin: "_system",
      def: {
        args: { name: "string" },
        async handler(_ctx: QueryContext, args: Record<string, any>) {
          return vex.triggerJob(args.name);
        },
      },
    });

    vex.mutations.set("_system.setJobEnabled", {
      plugin: "_system",
      def: {
        args: { name: "string", enabled: "number" },
        async handler(_ctx: MutationContext, args: Record<string, any>) {
          await vex.setJobEnabled(args.name, !!args.enabled);
        },
      },
    });

    // Admin-only raw SQL escape hatch. Needed for ad-hoc migrations
    // (rename/drop tables after a plugin refactor) and one-off fixes.
    // Bypasses schema validation entirely. Use sparingly.
    //
    // Already wrapped by vex.mutate() in a SQLite transaction, so DDL and
    // DML roll back cleanly on error without any extra work here.
    //
    // Does NOT trigger subscription invalidation — callers subscribed to
    // affected tables won't auto-refresh. Known limitation.
    vex.mutations.set("_system.sql", {
      plugin: "_system",
      def: {
        args: {
          sql: "string",
          params: "json",
        },
        async handler(ctx: MutationContext, args: Record<string, any>) {
          if (!ctx.user?.isAdmin) {
            throw new Error("_system.sql requires admin privileges");
          }
          const params = Array.isArray(args.params) ? args.params : [];
          return vex.storage.rawQuery(args.sql, ...params);
        },
      },
    });

    // ─── Trace mutations ───

    vex.mutations.set("_system.writeSpan", {
      plugin: "_system",
      def: {
        args: {},
        async handler(ctx: MutationContext, args: Record<string, any>) {
          await ctx.db.table("_spans").insert(args);
        },
      },
    });

    // ─── Trace queries ───

    vex.queries.set("_system.traces", {
      plugin: "_system",
      def: {
        args: {},
        async handler(ctx: QueryContext, args: Record<string, any>) {
          const limit = args.limit ?? 100;
          const showAll = args.all === true;
          const all = await ctx.db
            .table("_spans")
            .order("startTime", "desc")
            .limit(showAll ? limit : limit * 3)
            .all();
          let roots = all.filter((s: Record<string, any>) => !s.parentSpanId);
          if (!showAll)
            roots = roots.filter(
              (s) => TRACE_TYPES.has(s.type) && s.name !== "metrics.sample",
            );
          return roots.slice(0, limit).map((r) => ({
            ...r,
            meta: r.meta ? parseJsonSafe(r.meta) : null,
          }));
        },
      },
    });

    vex.queries.set("_system.traceDetail", {
      plugin: "_system",
      def: {
        args: { traceId: "string" },
        async handler(ctx: QueryContext, args: Record<string, any>) {
          const rows = await ctx.db
            .table("_spans")
            .where("traceId", "=", args.traceId)
            .order("startTime", "asc")
            .all();
          return rows.map((r) => ({
            ...r,
            meta: r.meta ? parseJsonSafe(r.meta) : null,
          }));
        },
      },
    });

    vex.queries.set("_system.traceStats", {
      plugin: "_system",
      def: {
        args: {},
        async handler(ctx: QueryContext) {
          const since = Date.now() - 60 * 60 * 1000;
          const [stats] = await ctx.db.sql<{
            total: number;
            errors: number | null;
            avgMs: number | null;
          }>(
            `SELECT
               COUNT(*) AS total,
               SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
               ROUND(AVG(duration) / 1000) AS avgMs
             FROM _spans
             WHERE startTime >= ?
               AND parentSpanId IS NULL
               AND type IN ('agent', 'channel', 'cron', 'webhook')`,
            since,
          );
          return {
            total: stats?.total ?? 0,
            errors: stats?.errors ?? 0,
            avgMs: stats?.avgMs ?? 0,
          };
        },
      },
    });

    vex.queries.set("_system.subscriptions", {
      plugin: "_system",
      def: {
        args: {},
        async handler() {
          const byQuery = new Map<
            string,
            { args: string; count: number; tables: string[] }
          >();
          for (const sub of vex.subscriptions.values()) {
            const key = `${sub.queryName}\0${sub.argsKey}`;
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
            total: vex.subscriptions.size,
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
        },
      },
    });

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
      await this.storage.rawQuery(
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

  private async executeJob(cronName: string, job: JobDef) {
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

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const handlerPromise = this.trace(
          "cron",
          cronName,
          null,
          async (ectx, meta) => {
            meta.schedule = job.schedule;
            meta.attempt = attempt;
            const ctx = this.buildMutationContext();
            await this.storage.transaction(() => job.handler(ctx));
            await this.invalidateSubscriptions(ectx);
          },
        );

        if (timeoutMs > 0) {
          const timeout = new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(`Job ${cronName} timed out after ${timeoutMs}ms`),
                ),
              timeoutMs,
            ),
          );
          await Promise.race([handlerPromise, timeout]);
        } else {
          await handlerPromise;
        }

        // Update status in table
        if (row) {
          await this.storage.update("_jobs", row._id, {
            lastStatus: "ok",
            lastError: null,
            lastDurationMs: Date.now() - startTime,
          });
        }
        return;
      } catch (err: any) {
        const errMsg = err?.message ?? String(err);
        console.error(
          `[vex] cron ${cronName} failed (attempt ${attempt + 1}/${maxRetries + 1}):`,
          errMsg,
        );

        if (row) {
          await this.storage.update("_jobs", row._id, {
            lastStatus: "error",
            lastError: errMsg,
            lastDurationMs: Date.now() - startTime,
          });
        }

        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, retryDelay));
        }
      }
    }
  }

  async triggerJob(name: string) {
    const handler = this.jobHandlers.get(name);
    if (!handler) throw new Error(`Job not found: ${name}`);
    await this.executeJob(name, handler);
    const row = await this.storage
      .rawQuery<any>(
        "SELECT lastStatus, lastError, lastDurationMs FROM _jobs WHERE name = ?",
        name,
      )
      .then((r) => r[0]);
    return {
      status: row?.lastStatus,
      error: row?.lastError,
      durationMs: row?.lastDurationMs,
    };
  }

  private buildQueryContext(
    touchedTables?: Set<string>,
    user?: VexUser | null,
  ): QueryContext {
    const self = this;
    return {
      db: {
        table(name: string) {
          if (touchedTables) touchedTables.add(name);
          return self.storage.query(name);
        },
        sql<T = Record<string, any>>(
          sql: string,
          ...params: any[]
        ): Promise<T[]> {
          return self.storage.rawQuery<T>(sql, ...params);
        },
      },
      user: user ?? undefined,
    };
  }

  private buildMutationContext(user?: VexUser | null): MutationContext {
    const self = this;
    return {
      db: {
        sql<T = Record<string, any>>(
          sql: string,
          ...params: any[]
        ): Promise<T[]> {
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
              insert: (row) => adapter.insert(name, row),
              upsert: (keys, data) => adapter.upsert(name, keys, data),
              update: (id, data) => adapter.update(name, id, data),
              delete: (id?) =>
                typeof id === "string" ? adapter.delete(name, id) : qb.delete(),
            };
          }
          return build(adapter.query(name));
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

  private async invalidateSubscriptions(ectx: ExecContext): Promise<void> {
    const changed = this.storage.getChangedTables();
    if (changed.length === 0) return;

    const changedSet = new Set(changed);

    return this.trace(
      "invalidation",
      "subscriptions",
      ectx,
      async (_invEctx, meta) => {
        const groups = new Map<string, Subscription[]>();
        for (const sub of this.subscriptions.values()) {
          let affected = false;
          for (const table of sub.tables) {
            if (changedSet.has(table)) {
              affected = true;
              break;
            }
          }
          if (!affected) continue;
          const key = `${sub.queryName}\0${sub.argsKey}`;
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
            const reg = this.queries.get(first.queryName);
            if (!reg) continue;
            const ctx = this.buildQueryContext(tables);
            const result = await reg.def.handler(ctx, first.args);
            const hash = Number(Bun.hash(JSON.stringify(result)));
            for (const sub of subs) {
              sub.tables = tables;
              if (hash !== sub.lastHash) {
                sub.lastHash = hash;
                sub.callback(result);
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
      meta.plugin = reg.plugin;
      const tables = new Set<string>();
      const ctx = this.buildQueryContext(tables, user);
      const result = await this.runMiddleware(
        ctx,
        { type: "query", name, args },
        () => reg.def.handler(ctx, args),
        ectx,
      );
      meta.tables = [...tables];
      if (Array.isArray(result)) meta.resultRows = result.length;
      else if (result && typeof result === "object" && "rows" in result)
        meta.resultRows = (result as any).rows?.length;
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
      meta.plugin = reg.plugin;
      const ctx = this.buildMutationContext(user);
      const result = await this.storage.transaction(() =>
        this.runMiddleware(
          ctx,
          { type: "mutation", name, args },
          () => reg.def.handler(ctx, args),
          ectx,
        ),
      );
      await this.invalidateSubscriptions(ectx);
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
      const tables = new Set<string>();
      const ctx = this.buildQueryContext(tables, user);
      const result = await reg.def.handler(ctx, args);
      const sub: Subscription = {
        id: subId,
        queryName: name,
        args,
        argsKey: JSON.stringify(args),
        callback,
        lastHash: Number(Bun.hash(JSON.stringify(result))),
        tables,
      };
      this.subscriptions.set(subId, sub);
      callback(result);
      meta.subId = subId;
      meta.tables = [...tables];
      meta.totalSubs = this.subscriptions.size;

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
      await this.invalidateSubscriptions(ectx);
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

function parseJsonSafe(val: any): any {
  if (typeof val === "string") {
    try {
      return JSON.parse(val);
    } catch {
      return val;
    }
  }
  return val;
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
