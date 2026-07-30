import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import type { VexPluginAPI } from "../src/core/api.js";
import { Vex } from "../src/core/engine.js";
import type { Span, Tracer } from "../src/core/tracer.js";
import type { MiddlewareInfo, MutationContext } from "../src/core/types.js";

// Inline KV plugin for testing (replaces app-specific plugin imports)
function kvPlugin(api: VexPluginAPI) {
  api.setName("kv");
  api.registerTable("kv", {
    columns: {
      scope: { type: "string", index: true },
      key: { type: "string" },
      value: { type: "json" },
    },
    unique: [["scope", "key"]],
  });
  api.registerQuery("get", {
    args: { scope: "string", key: "string" },
    async handler(ctx, args) {
      const row = await ctx.db
        .table("kv")
        .where("scope", "=", args.scope)
        .where("key", "=", args.key)
        .first<{ value: any }>();
      return row?.value ?? null;
    },
  });
  api.registerQuery("getAll", {
    args: { scope: "string" },
    async handler(ctx, args) {
      const rows = await ctx.db
        .table("kv")
        .where("scope", "=", args.scope)
        .all<{ key: string; value: any }>();
      const result: Record<string, any> = {};
      for (const r of rows) result[r.key] = r.value;
      return result;
    },
  });
  api.registerMutation("set", {
    args: { scope: "string", key: "string", value: "any" },
    async handler(ctx, args) {
      await ctx.db
        .table("kv")
        .upsert({ scope: args.scope, key: args.key }, { value: args.value });
    },
  });
  api.registerMutation("delete", {
    args: { scope: "string", key: "string" },
    async handler(ctx, args) {
      const row = await ctx.db
        .table("kv")
        .where("scope", "=", args.scope)
        .where("key", "=", args.key)
        .first<{ _id: string }>();
      if (row) await ctx.db.table("kv").delete(row._id);
    },
  });
}

let vex: Vex;

beforeEach(async () => {
  vex = await Vex.create({
    plugins: [kvPlugin],
    storage: sqliteAdapter(":memory:"),
  });
});

afterEach(async () => {
  await vex.close();
});

describe("engine", () => {
  test("lists plugins", () => {
    const plugins = vex.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins.map((p) => p.name)).toContain("kv");
  });

  test("lists queries and mutations", () => {
    expect(vex.listQueries()).toContain("kv.get");
    expect(vex.listMutations()).toContain("kv.set");
  });

  test("does not register legacy _system RPCs by default", async () => {
    const core = await Vex.create({
      storage: sqliteAdapter(":memory:"),
      plugins: [kvPlugin],
    });

    expect(core.listQueries()).not.toContain("_system.rows");
    expect(core.listMutations()).not.toContain("_system.sql");
    await core.close();
  });
});

describe("kv plugin", () => {
  test("set and get", async () => {
    await vex.mutate("kv.set", { scope: "s1", key: "count", value: 42 });
    const result = await vex.query("kv.get", { scope: "s1", key: "count" });
    expect(result).toBe(42);
  });

  test("get missing key returns null", async () => {
    const result = await vex.query("kv.get", { scope: "s1", key: "nope" });
    expect(result).toBeNull();
  });

  test("upsert overwrites", async () => {
    await vex.mutate("kv.set", { scope: "s1", key: "x", value: "a" });
    await vex.mutate("kv.set", { scope: "s1", key: "x", value: "b" });
    expect(await vex.query("kv.get", { scope: "s1", key: "x" })).toBe("b");
  });

  test("getAll returns scoped entries", async () => {
    await vex.mutate("kv.set", { scope: "s1", key: "a", value: 1 });
    await vex.mutate("kv.set", { scope: "s1", key: "b", value: 2 });
    await vex.mutate("kv.set", { scope: "s2", key: "c", value: 3 });
    const all = await vex.query("kv.getAll", { scope: "s1" });
    expect(all).toEqual({ a: 1, b: 2 });
  });

  test("delete removes key", async () => {
    await vex.mutate("kv.set", { scope: "s1", key: "x", value: 1 });
    await vex.mutate("kv.delete", { scope: "s1", key: "x" });
    expect(await vex.query("kv.get", { scope: "s1", key: "x" })).toBeNull();
  });
});

describe("subscriptions", () => {
  test("subscribe fires on mutation", async () => {
    const results: any[] = [];
    const unsub = await vex.subscribe(
      "kv.get",
      { scope: "s1", key: "x" },
      (data) => {
        results.push(data);
      },
    );

    expect(results).toEqual([null]);

    await vex.mutate("kv.set", { scope: "s1", key: "x", value: 42 });
    expect(results).toEqual([null, 42]);

    await vex.mutate("kv.set", { scope: "s1", key: "x", value: 99 });
    expect(results).toEqual([null, 42, 99]);

    unsub();

    await vex.mutate("kv.set", { scope: "s1", key: "x", value: 0 });
    expect(results).toEqual([null, 42, 99]);
  });

  test("subscription invalidation preserves the subscriber user", async () => {
    const secure = await Vex.create({
      storage: sqliteAdapter(":memory:"),
      plugins: [
        (api: VexPluginAPI) => {
          api.setName("secure");
          api.registerTable("events", {
            columns: { value: { type: "string" } },
          });
          api.registerQuery("viewer", {
            args: {},
            async handler(ctx) {
              if (!ctx.user) throw new Error("User required");
              const count = await ctx.db.table("events").count();
              return { userId: ctx.user.id, count };
            },
          });
          api.registerMutation("touch", {
            args: { value: "string" },
            async handler(ctx, args) {
              await ctx.db.table("events").insert({ value: args.value });
            },
          });
        },
      ],
    });

    const results: Array<{ userId: string; count: number }> = [];
    const unsubscribe = await secure.subscribe(
      "secure.viewer",
      {},
      (data) => results.push(data),
      { user: { id: "u1", name: "User", isAdmin: false } },
    );

    await secure.mutate("secure.touch", { value: "changed" });

    expect(results).toEqual([
      { userId: "u1", count: 0 },
      { userId: "u1", count: 1 },
    ]);
    unsubscribe();
    await secure.close();
  });
});

describe("mutation context chaining", () => {
  test("where().where() chains correctly in mutations", async () => {
    const cvex = await Vex.create({
      storage: sqliteAdapter(":memory:"),
      plugins: [
        (api: VexPluginAPI) => {
          api.setName("t");
          api.registerTable("items", {
            columns: {
              category: { type: "string" },
              status: { type: "string" },
              name: { type: "string" },
            },
          });
          api.registerMutation("add", {
            args: { category: "string", status: "string", name: "string" },
            async handler(ctx, args) {
              await ctx.db.table("items").insert({
                category: args.category,
                status: args.status,
                name: args.name,
              });
            },
          });
          api.registerMutation("findAndDelete", {
            args: { category: "string", status: "string" },
            async handler(ctx, args) {
              const row = await ctx.db
                .table("items")
                .where("category", "=", args.category)
                .where("status", "=", args.status)
                .first<{ _id: string; name: string }>();
              if (row) await ctx.db.table("items").delete(row._id);
              return row;
            },
          });
          api.registerQuery("list", {
            args: {},
            async handler(ctx) {
              return ctx.db.table("items").all();
            },
          });
        },
      ],
    });

    await cvex.mutate("t.add", {
      category: "a",
      status: "active",
      name: "one",
    });
    await cvex.mutate("t.add", {
      category: "a",
      status: "inactive",
      name: "two",
    });
    await cvex.mutate("t.add", {
      category: "b",
      status: "active",
      name: "three",
    });

    const deleted = await cvex.mutate("t.findAndDelete", {
      category: "a",
      status: "inactive",
    });
    expect(deleted.name).toBe("two");

    const remaining = await cvex.query("t.list");
    expect(remaining).toHaveLength(2);
    expect(remaining.map((r: any) => r.name).sort()).toEqual(["one", "three"]);

    await cvex.close();
  });
});

describe("custom plugin", () => {
  test("register and use inline plugin", async () => {
    const customVex = await Vex.create({
      storage: sqliteAdapter(":memory:"),
      plugins: [
        (api: VexPluginAPI) => {
          api.setName("todo");
          api.registerTable("todos", {
            columns: {
              text: { type: "string" },
              done: { type: "boolean" },
            },
          });
          api.registerMutation("add", {
            args: { text: "string" },
            async handler(ctx, args) {
              return ctx.db
                .table("todos")
                .insert({ text: args.text, done: false });
            },
          });
          api.registerQuery("list", {
            args: {},
            async handler(ctx) {
              return ctx.db.table("todos").all();
            },
          });
        },
      ],
    });

    await customVex.mutate("todo.add", { text: "buy milk" });
    await customVex.mutate("todo.add", { text: "write code" });
    const todos = await customVex.query("todo.list");
    expect(todos).toHaveLength(2);
    expect(todos[0].text).toBe("buy milk");

    await customVex.close();
  });
});

describe("webhooks", () => {
  test("route by path and method", async () => {
    const wvex = await Vex.create({
      storage: sqliteAdapter(":memory:"),
      plugins: [
        kvPlugin,
        (api: VexPluginAPI) => {
          api.setName("billing");
          api.registerTable("payments", {
            columns: { amount: { type: "number" }, status: { type: "string" } },
          });
          api.registerWebhook("stripePayment", {
            path: "/stripe",
            async handler(ctx, req) {
              await ctx.db.table("payments").insert({
                amount: req.body.amount,
                status: "paid",
              });
              return { received: true };
            },
          });
        },
      ],
    });

    const result = await wvex.handleWebhook({
      body: { amount: 99 },
      rawBody: '{"amount":99}',
      headers: {},
      method: "POST",
      path: "/stripe",
      query: {},
    });

    expect(result.status).toBe(200);
    expect(result.body.received).toBe(true);

    const payments = await wvex.unsafeSql("SELECT * FROM payments");
    expect(payments).toHaveLength(1);
    expect(payments[0].amount).toBe(99);

    await wvex.close();
  });

  test("verify rejects invalid signature", async () => {
    const wvex = await Vex.create({
      storage: sqliteAdapter(":memory:"),
      plugins: [
        (api: VexPluginAPI) => {
          api.setName("hooks");
          api.registerWebhook("secure", {
            path: "/secure",
            verify: (req) => req.headers["x-secret"] === "valid",
            handler(_ctx, _req) {
              return { ok: true };
            },
          });
        },
      ],
    });

    const rejected = await wvex.handleWebhook({
      body: {},
      rawBody: "{}",
      headers: { "x-secret": "wrong" },
      method: "POST",
      path: "/secure",
      query: {},
    });
    expect(rejected.status).toBe(401);

    const accepted = await wvex.handleWebhook({
      body: {},
      rawBody: "{}",
      headers: { "x-secret": "valid" },
      method: "POST",
      path: "/secure",
      query: {},
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.ok).toBe(true);

    await wvex.close();
  });

  test("404 for unknown path", async () => {
    const wvex = await Vex.create({
      storage: sqliteAdapter(":memory:"),
      plugins: [],
    });

    const result = await wvex.handleWebhook({
      body: {},
      rawBody: "{}",
      headers: {},
      method: "POST",
      path: "/nope",
      query: {},
    });
    expect(result.status).toBe(404);

    await wvex.close();
  });
});

describe("middleware", () => {
  test("runs on queries and mutations", async () => {
    const log: string[] = [];

    const mvex = await Vex.create({
      storage: sqliteAdapter(":memory:"),
      plugins: [
        kvPlugin,
        (api: VexPluginAPI) => {
          api.setName("logger");
          api.use(
            (_ctx: MutationContext, info: MiddlewareInfo, next: () => any) => {
              log.push(`${info.type}:${info.name}`);
              return next();
            },
          );
        },
      ],
    });

    await mvex.mutate("kv.set", { scope: "s1", key: "x", value: 1 });
    await mvex.query("kv.get", { scope: "s1", key: "x" });

    expect(log).toEqual(["mutation:kv.set", "query:kv.get"]);

    await mvex.close();
  });

  test("can block operations", async () => {
    const mvex = await Vex.create({
      storage: sqliteAdapter(":memory:"),
      plugins: [
        kvPlugin,
        (api: VexPluginAPI) => {
          api.setName("guard");
          api.use(
            (_ctx: MutationContext, info: MiddlewareInfo, next: () => any) => {
              if (info.type === "mutation" && info.name === "kv.delete") {
                throw new Error("Deletes are disabled");
              }
              return next();
            },
          );
        },
      ],
    });

    await mvex.mutate("kv.set", { scope: "s1", key: "x", value: 1 });
    expect(async () =>
      mvex.mutate("kv.delete", { scope: "s1", key: "x" }),
    ).toThrow("Deletes are disabled");
    expect(await mvex.query("kv.get", { scope: "s1", key: "x" })).toBe(1);

    await mvex.close();
  });

  test("chains multiple middleware in order", async () => {
    const order: number[] = [];

    const mvex = await Vex.create({
      storage: sqliteAdapter(":memory:"),
      plugins: [
        kvPlugin,
        (api: VexPluginAPI) => {
          api.setName("m1");
          api.use(
            async (
              _ctx: MutationContext,
              _info: MiddlewareInfo,
              next: () => any,
            ) => {
              order.push(1);
              const result = await next();
              order.push(3);
              return result;
            },
          );
        },
        (api: VexPluginAPI) => {
          api.setName("m2");
          api.use(
            (_ctx: MutationContext, _info: MiddlewareInfo, next: () => any) => {
              order.push(2);
              return next();
            },
          );
        },
      ],
    });

    await mvex.mutate("kv.set", { scope: "s1", key: "x", value: 1 });
    expect(order).toEqual([1, 2, 3]);

    await mvex.close();
  });

  test("runs on webhooks", async () => {
    const log: string[] = [];

    const mvex = await Vex.create({
      storage: sqliteAdapter(":memory:"),
      plugins: [
        (api: VexPluginAPI) => {
          api.setName("hooks");
          api.registerWebhook("ping", {
            path: "/ping",
            handler(_ctx, _req) {
              return { pong: true };
            },
          });
          api.use(
            (_ctx: MutationContext, info: MiddlewareInfo, next: () => any) => {
              log.push(info.type);
              return next();
            },
          );
        },
      ],
    });

    await mvex.handleWebhook({
      body: {},
      rawBody: "{}",
      headers: {},
      method: "POST",
      path: "/ping",
      query: {},
    });

    expect(log).toEqual(["webhook"]);

    await mvex.close();
  });

  test("middleware during query gets read-only context", async () => {
    let contextHasInsert = false;

    const mvex = await Vex.create({
      plugins: [
        (api: VexPluginAPI) => {
          api.setName("test");
          api.registerTable("items", { columns: { name: { type: "string" } } });
          api.registerQuery("list", {
            args: {},
            handler: async (ctx) => ctx.db.table("items").all(),
          });
          api.use((ctx, _info, next) => {
            contextHasInsert =
              typeof (ctx.db.table("items") as any).insert === "function";
            return next();
          });
        },
      ],
      storage: sqliteAdapter(":memory:"),
    });

    await mvex.query("test.list");
    expect(contextHasInsert).toBe(false);

    await mvex.close();
  });

  test("middleware during mutation gets write context", async () => {
    let contextHasInsert = false;

    const mvex = await Vex.create({
      plugins: [
        (api: VexPluginAPI) => {
          api.setName("test");
          api.registerTable("items", { columns: { name: { type: "string" } } });
          api.registerMutation("add", {
            args: { name: "string" },
            handler: async (ctx, args) =>
              ctx.db.table("items").insert({ name: args.name }),
          });
          api.use((ctx, _info, next) => {
            contextHasInsert =
              typeof (ctx.db.table("items") as any).insert === "function";
            return next();
          });
        },
      ],
      storage: sqliteAdapter(":memory:"),
    });

    await mvex.mutate("test.add", { name: "x" });
    expect(contextHasInsert).toBe(true);

    await mvex.close();
  });
});

describe("plugin name collisions", () => {
  test("duplicate query name throws", async () => {
    expect(
      Vex.create({
        plugins: [
          (api: VexPluginAPI) => {
            api.setName("items");
            api.registerTable("items", {
              columns: { name: { type: "string" } },
            });
            api.registerQuery("list", {
              args: {},
              handler: async (ctx) => ctx.db.table("items").all(),
            });
          },
          (api: VexPluginAPI) => {
            api.setName("items");
            api.registerQuery("list", {
              args: {},
              handler: async (ctx) => ctx.db.table("items").all(),
            });
          },
        ],
        storage: sqliteAdapter(":memory:"),
      }),
    ).rejects.toThrow("Duplicate query: items.list");
  });

  test("duplicate mutation name throws", async () => {
    expect(
      Vex.create({
        plugins: [
          (api: VexPluginAPI) => {
            api.setName("items");
            api.registerTable("items", {
              columns: { name: { type: "string" } },
            });
            api.registerMutation("add", {
              args: { name: "string" },
              handler: async (ctx, args) =>
                ctx.db.table("items").insert({ name: args.name }),
            });
          },
          (api: VexPluginAPI) => {
            api.setName("items");
            api.registerMutation("add", {
              args: { name: "string" },
              handler: async (ctx, args) =>
                ctx.db.table("items").insert({ name: args.name }),
            });
          },
        ],
        storage: sqliteAdapter(":memory:"),
      }),
    ).rejects.toThrow("Duplicate mutation: items.add");
  });

  test("duplicate table name throws", async () => {
    expect(
      Vex.create({
        plugins: [
          (api: VexPluginAPI) => {
            api.setName("a");
            api.registerTable("runs", {
              columns: { name: { type: "string" } },
            });
          },
          (api: VexPluginAPI) => {
            api.setName("b");
            api.registerTable("runs", {
              columns: { other: { type: "string" } },
            });
          },
        ],
        storage: sqliteAdapter(":memory:"),
      }),
    ).rejects.toThrow('Duplicate table "runs"');
  });

  test("same name across different plugins is fine", async () => {
    const mvex = await Vex.create({
      plugins: [
        (api: VexPluginAPI) => {
          api.setName("users");
          api.registerTable("users", { columns: { name: { type: "string" } } });
          api.registerQuery("list", {
            args: {},
            handler: async (ctx) => ctx.db.table("users").all(),
          });
        },
        (api: VexPluginAPI) => {
          api.setName("posts");
          api.registerTable("posts", {
            columns: { title: { type: "string" } },
          });
          api.registerQuery("list", {
            args: {},
            handler: async (ctx) => ctx.db.table("posts").all(),
          });
        },
      ],
      storage: sqliteAdapter(":memory:"),
    });

    expect(mvex.listQueries()).toContain("users.list");
    expect(mvex.listQueries()).toContain("posts.list");

    await mvex.close();
  });
});

describe("jobs", () => {
  test("different scheduled jobs may run concurrently", async () => {
    let active = 0;
    let maxActive = 0;
    const started: string[] = [];

    const jvex = await Vex.create({
      storage: sqliteAdapter(":memory:"),
      plugins: [
        (api: VexPluginAPI) => {
          api.setName("parallel");
          for (const name of ["one", "two"] as const) {
            api.registerJob(name, {
              schedule: "every 1s",
              async handler() {
                started.push(name);
                active += 1;
                maxActive = Math.max(maxActive, active);
                await new Promise((resolve) => setTimeout(resolve, 300));
                active -= 1;
              },
            });
          }
        },
      ],
    });

    await new Promise((resolve) => setTimeout(resolve, 1_150));

    expect(started.sort()).toEqual(["one", "two"]);
    expect(maxActive).toBe(2);

    await jvex.close();
  });

  test("scheduled jobs do not overlap when a previous run is still active", async () => {
    let active = 0;
    let maxActive = 0;
    let runs = 0;

    const jvex = await Vex.create({
      storage: sqliteAdapter(":memory:"),
      plugins: [
        (api: VexPluginAPI) => {
          api.setName("slow");
          api.registerJob("tick", {
            schedule: "every 1s",
            async handler() {
              runs += 1;
              active += 1;
              maxActive = Math.max(maxActive, active);
              await new Promise((resolve) => setTimeout(resolve, 1_500));
              active -= 1;
            },
          });
        },
      ],
    });

    await new Promise((resolve) => setTimeout(resolve, 2_700));

    expect(runs).toBeGreaterThanOrEqual(1);
    expect(active).toBe(0);
    expect(maxActive).toBe(1);

    await jvex.close();
  });

  test("timed-out scheduled jobs do not overlap while their handler is still active", async () => {
    let active = 0;
    let maxActive = 0;
    let runs = 0;

    const jvex = await Vex.create({
      storage: sqliteAdapter(":memory:"),
      plugins: [
        (api: VexPluginAPI) => {
          api.setName("timeout");
          api.registerJob("tick", {
            schedule: "every 1s",
            timeoutMs: 200,
            async handler() {
              runs += 1;
              active += 1;
              maxActive = Math.max(maxActive, active);
              await new Promise((resolve) => setTimeout(resolve, 1_500));
              active -= 1;
            },
          });
        },
      ],
    });

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(active).toBe(1);
    expect(maxActive).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(runs).toBeGreaterThanOrEqual(1);
    expect(active).toBe(0);
    expect(maxActive).toBe(1);

    const [job] = await jvex.unsafeSql<any>(
      "SELECT runs, lastStatus, lastError FROM _jobs WHERE name = ?",
      "timeout.tick",
    );
    expect(job.runs).toBe(1);
    expect(job.lastStatus).toBe("error");
    expect(job.lastError).toBe("Job timeout.tick timed out after 200ms");

    await jvex.close();
  });

  test("timed-out jobs can run again after the timed-out handler settles", async () => {
    let active = 0;
    let maxActive = 0;
    let runs = 0;

    const jvex = await Vex.create({
      storage: sqliteAdapter(":memory:"),
      plugins: [
        (api: VexPluginAPI) => {
          api.setName("recover");
          api.registerJob("tick", {
            schedule: "every 1h",
            timeoutMs: 50,
            async handler() {
              runs += 1;
              active += 1;
              maxActive = Math.max(maxActive, active);
              await new Promise((resolve) => setTimeout(resolve, 100));
              active -= 1;
            },
          });
        },
      ],
    });

    await jvex.triggerJob("recover.tick");
    expect(runs).toBe(1);
    expect(active).toBe(0);

    await jvex.triggerJob("recover.tick");
    expect(runs).toBe(2);
    expect(active).toBe(0);
    expect(maxActive).toBe(1);

    await jvex.close();
  });

  test("job retries do not overlap with the failed attempt or scheduled ticks", async () => {
    let active = 0;
    let maxActive = 0;
    let runs = 0;

    const jvex = await Vex.create({
      storage: sqliteAdapter(":memory:"),
      plugins: [
        (api: VexPluginAPI) => {
          api.setName("retrying");
          api.registerJob("tick", {
            schedule: "every 1s",
            retries: 1,
            retryDelayMs: 300,
            async handler() {
              runs += 1;
              active += 1;
              maxActive = Math.max(maxActive, active);
              await new Promise((resolve) => setTimeout(resolve, 800));
              active -= 1;
              throw new Error("boom");
            },
          });
        },
      ],
    });

    await new Promise((resolve) => setTimeout(resolve, 3_000));

    expect(runs).toBe(2);
    expect(active).toBe(0);
    expect(maxActive).toBe(1);

    const [job] = await jvex.unsafeSql<any>(
      "SELECT runs, lastStatus, lastError FROM _jobs WHERE name = ?",
      "retrying.tick",
    );
    expect(job.runs).toBe(1);
    expect(job.lastStatus).toBe("error");
    expect(job.lastError).toBe("boom");

    await jvex.close();
  });

  test("concurrent manual triggers for the same job do not overlap", async () => {
    let active = 0;
    let maxActive = 0;
    let runs = 0;

    const jvex = await Vex.create({
      storage: sqliteAdapter(":memory:"),
      plugins: [
        (api: VexPluginAPI) => {
          api.setName("manual");
          api.registerJob("tick", {
            schedule: "every 1h",
            async handler() {
              runs += 1;
              active += 1;
              maxActive = Math.max(maxActive, active);
              await new Promise((resolve) => setTimeout(resolve, 300));
              active -= 1;
            },
          });
        },
      ],
    });

    await Promise.all([
      jvex.triggerJob("manual.tick"),
      jvex.triggerJob("manual.tick"),
      jvex.triggerJob("manual.tick"),
    ]);

    expect(runs).toBe(1);
    expect(active).toBe(0);
    expect(maxActive).toBe(1);

    await jvex.close();
  });

  test("close waits for running jobs before closing storage", async () => {
    let active = 0;
    let completed = false;

    const jvex = await Vex.create({
      storage: sqliteAdapter(":memory:"),
      plugins: [
        (api: VexPluginAPI) => {
          api.setName("shutdown");
          api.registerJob("tick", {
            schedule: "every 1h",
            async handler(ctx) {
              active += 1;
              await new Promise((resolve) => setTimeout(resolve, 100));
              await ctx.db.table("_jobs").count();
              active -= 1;
              completed = true;
            },
          });
        },
      ],
    });

    const trigger = jvex.triggerJob("shutdown.tick");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(active).toBe(1);

    await jvex.close();
    await trigger;

    expect(active).toBe(0);
    expect(completed).toBe(true);
  });
});

describe("trace metadata", () => {
  test("does not serialize query results when no trace is recording", async () => {
    let serializations = 0;
    const tracers: Array<Tracer | undefined> = [
      undefined,
      { shouldRecord: () => false, onSpan: () => {} },
    ];

    for (const tracer of tracers) {
      const tvex = await Vex.create({
        storage: sqliteAdapter(":memory:"),
        ...(tracer ? { tracer } : {}),
        plugins: [
          (api: VexPluginAPI) => {
            api.setName("sampled");
            api.registerQuery("result", {
              args: {},
              handler: () => ({
                toJSON() {
                  serializations++;
                  return { ok: true };
                },
              }),
            });
          },
        ],
      });

      await tvex.query("sampled.result");
      await tvex.close();
    }

    expect(serializations).toBe(0);
  });

  test("emits safe metadata for every query and write shape", async () => {
    const spans: Span[] = [];
    const tvex = await Vex.create({
      storage: sqliteAdapter(":memory:"),
      tracer: { onSpan: (span) => spans.push(span) },
      plugins: [
        (api: VexPluginAPI) => {
          api.setName("safe");
          api.registerTable("documents", {
            columns: {
              workspaceId: { type: "string" },
              content: { type: "string" },
            },
          });
          api.registerQuery("read", {
            args: { workspaceId: "string" },
            handler: (ctx, args) =>
              ctx.db
                .table("documents")
                .where("workspaceId", "=", args.workspaceId)
                .all(),
          });
          api.registerMutation("insert", {
            args: { workspaceId: "string", content: "string" },
            handler: (ctx, args) => ctx.db.table("documents").insert(args),
          });
          api.registerMutation("upsert", {
            args: { workspaceId: "string", content: "string" },
            handler: (ctx, args) =>
              ctx.db
                .table("documents")
                .upsert(
                  { workspaceId: args.workspaceId },
                  { content: args.content },
                ),
          });
          api.registerMutation("update", {
            args: { id: "string", content: "string" },
            handler: (ctx, args) =>
              ctx.db
                .table("documents")
                .update(args.id, { content: args.content }),
          });
          api.registerMutation("delete", {
            args: { id: "string" },
            handler: (ctx, args) => ctx.db.table("documents").delete(args.id),
          });
          api.registerMutation("rawDelete", {
            args: { workspaceId: "string" },
            handler: (ctx, args) =>
              ctx.db.sql(
                "DELETE FROM documents WHERE workspaceId = ?",
                args.workspaceId,
              ),
          });
        },
      ],
    });
    const secretWorkspace = "workspace-secret-value";
    const secretContent = "knowledge-content-must-not-enter-a-span";

    await tvex.query("safe.read", { workspaceId: secretWorkspace });
    const id = await tvex.mutate<string>("safe.insert", {
      workspaceId: secretWorkspace,
      content: secretContent,
    });
    await tvex.mutate("safe.upsert", {
      workspaceId: secretWorkspace,
      content: secretContent,
    });
    await tvex.mutate("safe.update", { id, content: secretContent });
    await tvex.mutate("safe.delete", { id });
    await tvex.mutate("safe.rawDelete", { workspaceId: secretWorkspace });

    function metadata(type: string, name: string) {
      const span = spans.find(
        (candidate) => candidate.type === type && candidate.name === name,
      );
      if (!span?.meta) throw new Error(`Missing ${type} span: ${name}`);
      return JSON.parse(span.meta);
    }

    expect(metadata("query", "safe.read").dependencies).toEqual([
      {
        table: "documents",
        filters: [{ column: "workspaceId", operator: "=" }],
      },
    ]);
    expect(metadata("mutation", "safe.insert").writes).toEqual([
      { table: "documents", columns: ["content", "workspaceId"] },
    ]);
    expect(metadata("mutation", "safe.upsert").writes).toEqual([
      { table: "documents", columns: ["content", "workspaceId"] },
    ]);
    expect(metadata("mutation", "safe.update").writes).toEqual([
      { table: "documents", columns: ["content"] },
    ]);
    expect(metadata("mutation", "safe.delete").writes).toEqual([
      { table: "documents" },
    ]);
    expect(metadata("mutation", "safe.rawDelete").writes).toEqual([
      { table: "documents", raw: true },
    ]);
    const serializedMetadata = spans.map((span) => span.meta).join("\n");
    expect(serializedMetadata).not.toContain(secretWorkspace);
    expect(serializedMetadata).not.toContain(secretContent);

    await tvex.close();
  });

  test("traced queries measure undefined and cyclic results safely", async () => {
    const spans: Span[] = [];
    const tvex = await Vex.create({
      storage: sqliteAdapter(":memory:"),
      tracer: { onSpan: (span) => spans.push(span) },
      plugins: [
        (api: VexPluginAPI) => {
          api.setName("edge");
          api.registerQuery("nothing", {
            args: {},
            reactive: false,
            handler: () => undefined,
          });
          api.registerQuery("cyclic", {
            args: {},
            reactive: false,
            handler: () => {
              const value: any = { ok: true };
              value.self = value;
              return value;
            },
          });
        },
      ],
    });

    await tvex.query("edge.nothing");
    await tvex.query("edge.cyclic");

    const metaFor = (name: string) => {
      const span = spans.find(
        (candidate) => candidate.type === "query" && candidate.name === name,
      );
      if (!span?.meta) throw new Error(`Missing query span: ${name}`);
      return JSON.parse(span.meta);
    };
    // Same convention as the reactive path: undefined serializes to the
    // literal "undefined" for byte accounting.
    expect(metaFor("edge.nothing").resultBytes).toBe(
      Buffer.byteLength("undefined"),
    );
    // Cyclic results cannot be measured; the span still records cleanly.
    expect(metaFor("edge.cyclic").resultBytes).toBeUndefined();

    await tvex.close();
  });

  test("does not auto-capture query, mutation, subscription, or webhook args", async () => {
    const spans: Span[] = [];
    const tvex = await Vex.create({
      storage: sqliteAdapter(":memory:"),
      tracer: { onSpan: (span) => spans.push(span) },
      plugins: [
        (api: VexPluginAPI) => {
          api.setName("echo");
          api.registerTable("items", { columns: { text: { type: "string" } } });
          api.registerQuery("get", {
            args: { text: "string", token: "string" },
            handler: async (_ctx, args) => args.text.length,
          });
          api.registerMutation("big", {
            args: { text: "string", token: "string" },
            handler: async (_ctx, args) => args.text.length,
          });
          api.registerWebhook("hook", {
            path: "/hook",
            handler: async (_ctx, req) => ({ length: req.body.text.length }),
          });
        },
      ],
    });

    const args = { text: "x".repeat(10_000), token: "secret-token" };
    await tvex.query("echo.get", args);
    await tvex.mutate("echo.big", args);
    const unsub = await tvex.subscribe("echo.get", args, () => {});
    unsub();
    await tvex.handleWebhook({
      body: args,
      rawBody: JSON.stringify(args),
      headers: {},
      method: "POST",
      path: "/hook",
      query: {},
    });

    for (const span of spans.filter((s) =>
      ["query", "mutation", "subscribe", "webhook"].includes(s.type),
    )) {
      const meta = span.meta ? JSON.parse(span.meta) : {};
      expect(meta.args).toBeUndefined();
      expect(JSON.stringify(meta)).not.toContain("secret-token");
      expect(JSON.stringify(meta)).not.toContain("x".repeat(100));
    }

    await tvex.close();
  });
});

describe("handler timeout", () => {
  test("query times out when handler exceeds limit", async () => {
    const tvex = await Vex.create({
      plugins: [
        (api: VexPluginAPI) => {
          api.setName("slow");
          api.registerQuery("hang", {
            args: {},
            async handler() {
              await new Promise((r) => setTimeout(r, 500));
              return "done";
            },
          });
        },
      ],
      storage: sqliteAdapter(":memory:"),
      handlerTimeoutMs: 50,
    });

    await expect(tvex.query("slow.hang")).rejects.toThrow(
      "Handler timed out after 50ms",
    );
    await tvex.close();
  });

  test("fast handler completes normally with timeout set", async () => {
    const tvex = await Vex.create({
      plugins: [
        (api: VexPluginAPI) => {
          api.setName("fast");
          api.registerQuery("quick", {
            args: {},
            async handler() {
              return "ok";
            },
          });
        },
      ],
      storage: sqliteAdapter(":memory:"),
      handlerTimeoutMs: 5000,
    });

    const result = await tvex.query("fast.quick");
    expect(result).toBe("ok");
    await tvex.close();
  });
});
