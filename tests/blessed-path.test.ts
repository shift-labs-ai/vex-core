/**
 * The states the engine's interface makes impossible, each pinned:
 *
 *   - a caller answered with what another may see (callers share a
 *     run only when alike in every field, unless the app says which
 *     fields decide);
 *   - a write the engine is handed that no subscription hears of
 *     (`rawSql`, `rawStorage` in vex-core/internal);
 *   - a raw read whose dependency is not written down (every table a
 *     raw read reads is named, held to rows or read whole), or whose
 *     hold a view slips past;
 *   - a subscription that stops or goes stale in silence (`onError`);
 *   - identical views apart because their args are spelled apart.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import type { VexPluginAPI } from "../src/core/api.js";
import { Vex } from "../src/core/engine.js";
import type { VexUser } from "../src/core/types.js";
import { createRouter } from "../src/http/router.js";
import { vexHandler } from "../src/http/vex-handler.js";
import { rawSql, rawStorage } from "../src/internal.js";

let open: Vex[] = [];
const runs = new Map<string, number>();
let failing = false;
afterEach(async () => {
  await Promise.all(open.map((v) => v.close()));
  open = [];
  runs.clear();
  failing = false;
});

function plugin(api: VexPluginAPI) {
  api.setName("bp");
  api.registerTable("items", {
    columns: {
      scope: { type: "string", index: true },
      n: { type: "number" },
    },
  });
  // What a caller sees depends on its fence, not only its id.
  api.registerQuery("visible", {
    args: { scope: "string" },
    async handler(ctx, args) {
      const fence = (ctx.user as { fence?: string } | undefined)?.fence;
      runs.set("visible", (runs.get("visible") ?? 0) + 1);
      let q = ctx.db.table("items").where("scope", "=", args.scope);
      if (fence) q = q.where("n", "<", Number(fence));
      return q.order("n", "asc").all();
    },
  });
  api.registerQuery("count", {
    args: { scope: "string", extra: "json?" },
    async handler(ctx, args) {
      runs.set("count", (runs.get("count") ?? 0) + 1);
      if (failing) throw new Error("count failed");
      return ctx.db.table("items").where("scope", "=", args.scope).count();
    },
  });
  api.registerQuery("bounded", {
    args: {},
    reactive: { maxRows: 2, maxBytes: 100_000 },
    handler: (ctx) => ctx.db.table("items").all(),
  });
  api.registerQuery("raw", {
    args: { reads: "json", sql: "string" },
    handler: (ctx, args) =>
      ctx.db.sql(args.reads as Record<string, any>, args.sql),
  });
  api.registerMutation("add", {
    args: { scope: "string", n: "number" },
    handler: (ctx, args) => ctx.db.table("items").insert(args),
  });
}

async function create(options: Partial<Parameters<typeof Vex.create>[0]> = {}) {
  const vex = await Vex.create({
    plugins: [plugin],
    storage: sqliteAdapter(":memory:"),
    ...options,
  });
  open.push(vex);
  return vex;
}

const alice = { id: "alice", name: "Alice", isAdmin: false };

describe("callers share a run only when nothing tells them apart", () => {
  test("a fenced caller is never answered with the unfenced caller's rows, nor the reverse", async () => {
    const vex = await create();
    await vex.mutate("bp.add", { scope: "a", n: 1 });
    await vex.mutate("bp.add", { scope: "a", n: 9 });
    const wide: any[] = [];
    const fenced: any[] = [];
    await vex.subscribe(
      "bp.visible",
      { scope: "a" },
      (r: any) => wide.push(r),
      {
        user: alice,
      },
    );
    await vex.subscribe(
      "bp.visible",
      { scope: "a" },
      (r: any) => fenced.push(r),
      {
        user: { ...alice, fence: "5" } as VexUser,
      },
    );
    expect(wide.at(-1).map((r: any) => r.n)).toEqual([1, 9]);
    expect(fenced.at(-1).map((r: any) => r.n)).toEqual([1]);
    await vex.mutate("bp.add", { scope: "a", n: 3 });
    expect(wide.at(-1).map((r: any) => r.n)).toEqual([1, 3, 9]);
    expect(fenced.at(-1).map((r: any) => r.n)).toEqual([1, 3]);
  });

  test("callers alike in every field share one run; a caller holding a function is refused", async () => {
    const vex = await create();
    await vex.subscribe("bp.visible", { scope: "a" }, () => {}, {
      user: { ...alice },
    });
    await vex.subscribe("bp.visible", { scope: "a" }, () => {}, {
      user: { ...alice },
    });
    expect(vex.describeSubscriptions().unique).toBe(1);
    const withReach = { ...alice, reach: () => true } as unknown as VexUser;
    await expect(
      vex.subscribe("bp.visible", { scope: "a" }, () => {}, {
        user: withReach,
      }),
    ).rejects.toThrow("a caller is plain data");
    await expect(
      vex.query("bp.visible", { scope: "a" }, { user: withReach }),
    ).rejects.toThrow("a caller is plain data");
  });

  test("callers differing only in fields the query never reads share one run", async () => {
    const vex = await create();
    // bp.visible reads only `fence`.
    await vex.subscribe("bp.visible", { scope: "a" }, () => {}, {
      user: { ...alice, seenAt: 1 } as VexUser,
    });
    await vex.subscribe("bp.visible", { scope: "a" }, () => {}, {
      user: { ...alice, id: "bob", seenAt: 2 } as VexUser,
    });
    expect(vex.describeSubscriptions().unique).toBe(1);
    // A different fence is a different answer: its own run.
    await vex.subscribe("bp.visible", { scope: "a" }, () => {}, {
      user: { ...alice, fence: "5" } as VexUser,
    });
    expect(vex.describeSubscriptions().unique).toBe(2);
  });

  test("a run that comes to read a field its members differ in splits them, each hearing its own answer", async () => {
    let readsTier = false;
    const vex = await create({
      plugins: [
        plugin,
        (api: VexPluginAPI) => {
          api.setName("sp");
          api.registerQuery("tiered", {
            args: {},
            handler: async (ctx) => {
              const n = await ctx.db.table("items").count();
              if (!readsTier) return { n };
              const tier = (ctx.user as { tier?: string } | undefined)?.tier;
              return { n, tier };
            },
          });
        },
      ],
    });
    const gold: any[] = [];
    const free: any[] = [];
    await vex.subscribe("sp.tiered", {}, (r) => gold.push(r), {
      user: { ...alice, tier: "gold" } as VexUser,
    });
    await vex.subscribe("sp.tiered", {}, (r) => free.push(r), {
      user: { ...alice, tier: "free" } as VexUser,
    });
    expect(vex.describeSubscriptions().unique).toBe(1);
    readsTier = true;
    await vex.mutate("bp.add", { scope: "a", n: 1 });
    await Bun.sleep(10);
    expect(gold.at(-1)).toEqual({ n: 1, tier: "gold" });
    expect(free.at(-1)).toEqual({ n: 1, tier: "free" });
    expect(vex.describeSubscriptions().unique).toBe(2);
  });

  test("args alike but spelled in another order are one view", async () => {
    const vex = await create();
    await vex.subscribe(
      "bp.count",
      { scope: "a", extra: { x: 1, y: 2 } },
      () => {},
    );
    await vex.subscribe(
      "bp.count",
      { extra: { y: 2, x: 1 }, scope: "a" },
      () => {},
    );
    expect(vex.describeSubscriptions().unique).toBe(1);
  });
});

describe("every write the engine is handed is heard", () => {
  test("a write by rawSql re-runs the views it reaches", async () => {
    const vex = await create();
    const seen: number[] = [];
    await vex.subscribe("bp.count", { scope: "a", extra: null }, (n: number) =>
      seen.push(n),
    );
    await rawSql(vex, "INSERT INTO items (_id, scope, n) VALUES ('x', 'a', 1)");
    expect(seen).toEqual([0, 1]);
  });

  test("a write through rawStorage, and a transaction there, are heard", async () => {
    const vex = await create();
    const seen: number[] = [];
    await vex.subscribe("bp.count", { scope: "a", extra: null }, (n: number) =>
      seen.push(n),
    );
    const storage = rawStorage(vex);
    await storage.insert("items", { scope: "a", n: 1 });
    expect(seen).toEqual([0, 1]);
    await storage.transaction(async () => {
      await storage.rawExec(
        "INSERT INTO items (_id, scope, n) VALUES ('y', 'a', 2)",
      );
    });
    expect(seen).toEqual([0, 1, 2]);
  });

  test("the raw storage handle is one handle: what a caller sets on it, the next caller sees", async () => {
    const vex = await create();
    expect(rawStorage(vex)).toBe(rawStorage(vex));
  });

  test("a tracer writing its spans through the storage does not feed on itself", async () => {
    let spans = 0;
    const holder: { vex?: Vex } = {};
    const vex = await create({
      tracer: {
        onSpan: () => {
          spans++;
          if (holder.vex) void rawStorage(holder.vex).rawExec("SELECT 1");
        },
      },
    });
    holder.vex = vex;
    await vex.mutate("bp.add", { scope: "a", n: 1 });
    const settled = spans;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spans).toBe(settled);
  });
});

describe("a raw read writes down what it depends on", () => {
  test("a table read but not named is refused, naming it", async () => {
    const vex = await create();
    await expect(
      vex.query("bp.raw", { reads: {}, sql: "SELECT * FROM items" }),
    ).rejects.toThrow('ctx.db.sql reads "items" without naming it');
    expect(
      await vex.query("bp.raw", {
        reads: { items: "all" },
        sql: "SELECT COUNT(*) AS n FROM items",
      }),
    ).toEqual([{ n: 0 }]);
  });

  test("a statement passed without its reads is refused, saying how to name them", async () => {
    const vex = await create();
    await expect(
      vex.query("bp.raw", { reads: "SELECT 1" as any, sql: "" }),
    ).rejects.toThrow("name each table the statement reads");
  });

  test("a held read may not reach its table through a view", async () => {
    const vex = await create();
    await rawSql(vex, "CREATE VIEW item_view AS SELECT * FROM items");
    await expect(
      vex.query("bp.raw", {
        reads: { items: [{ column: "scope", operator: "=", value: "a" }] },
        sql: "SELECT * FROM item_view",
      }),
    ).rejects.toThrow("through a view (item_view)");
    // Read whole, a view is as good as the table.
    expect(
      await vex.query("bp.raw", {
        reads: { items: "all" },
        sql: "SELECT COUNT(*) AS n FROM item_view",
      }),
    ).toEqual([{ n: 0 }]);
  });
});

describe("the views a held read is checked against are the schema's own", () => {
  const held = { items: [{ column: "scope", operator: "=", value: "a" }] };

  test("a view created after the list was taken, by raw SQL, is seen", async () => {
    const vex = await create();
    expect(
      await vex.query("bp.raw", {
        reads: held,
        sql: "SELECT COUNT(*) AS n FROM items",
      }),
    ).toEqual([{ n: 0 }]);
    await rawSql(vex, "CREATE VIEW late AS SELECT * FROM items");
    await expect(
      vex.query("bp.raw", { reads: held, sql: "SELECT * FROM late" }),
    ).rejects.toThrow("through a view (late)");
  });

  test("a name that only contains a view's name is not the view", async () => {
    const vex = await create();
    await rawSql(vex, "CREATE VIEW it AS SELECT * FROM items");
    expect(
      await vex.query("bp.raw", {
        reads: held,
        sql: "SELECT COUNT(*) AS n FROM items WHERE items.scope = 'a'",
      }),
    ).toEqual([{ n: 0 }]);
  });
});

describe("a subscription never fails in silence", () => {
  test("a view that outgrows its budget ends, and its subscriber is told", async () => {
    const vex = await create();
    const told: Array<[string, boolean]> = [];
    await vex.subscribe("bp.bounded", {}, () => {}, {
      onError: (error, ended) => told.push([error.message, ended]),
    });
    for (const n of [1, 2, 3]) await vex.mutate("bp.add", { scope: "a", n });
    expect(told).toEqual([[expect.stringContaining("budget exceeded"), true]]);
    expect(vex.activeSubscriptionCount()).toBe(0);
  });

  test("a failed run is told and recovered from: the subscriber keeps its answer and hears the next", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const vex = await create();
      const seen: number[] = [];
      const told: Array<[string, boolean]> = [];
      await vex.subscribe(
        "bp.count",
        { scope: "a", extra: null },
        (n: number) => seen.push(n),
        {
          onError: (error, ended) => told.push([error.message, ended]),
        },
      );
      failing = true;
      await vex.mutate("bp.add", { scope: "a", n: 1 });
      expect(told).toEqual([["count failed", false]]);
      expect(seen).toEqual([0]);
      failing = false;
      await vex.mutate("bp.add", { scope: "a", n: 2 });
      expect(seen).toEqual([0, 2]);
      expect(vex.activeSubscriptionCount()).toBe(1);
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("args are what the operation declares, and nothing else", () => {
  const typed = (api: VexPluginAPI) => {
    api.setName("t");
    api.registerQuery("typed", {
      args: { s: "string", n: "number", b: "boolean?", j: "json?" },
      handler: (_ctx, args) => ({ ...args }),
    });
    api.registerMutation("mut", {
      args: { s: "string" },
      handler: (_ctx, args) => args.s,
    });
    api.registerAction("act", {
      args: { n: "number" },
      handler: (_ctx, args) => args.n,
    });
  };
  const engine = () => create({ plugins: [plugin, typed] });

  test("a wrong type, a missing arg, an undeclared arg, a non-finite number or a non-JSON value is refused, by every call", async () => {
    const vex = await engine();
    const refusals: Array<[Record<string, unknown>, string]> = [
      [{ s: 1, n: 1 }, 'takes arg "s" as string; got number 1'],
      [{ n: 1 }, 'needs arg "s" (string)'],
      [{ s: "a", n: 1, x: 1 }, 'takes no arg "x"'],
      [{ s: "a", n: Number.NaN }, 'takes arg "n" as number'],
      [{ s: "a", n: Infinity }, 'takes arg "n" as number'],
      [{ s: "a", n: 1, b: "yes" }, 'takes arg "b" as boolean'],
      [{ s: "a", n: 1, j: new Date() }, "holds a Date"],
      [{ s: "a", n: 1, j: { f: () => 1 } }, "holds a function"],
    ];
    for (const [args, message] of refusals) {
      await expect(vex.query("t.typed", args)).rejects.toThrow(message);
      await expect(vex.subscribe("t.typed", args, () => {})).rejects.toThrow(
        message,
      );
    }
    await expect(vex.mutate("t.mut", { s: 2 })).rejects.toThrow(
      'takes arg "s" as string',
    );
    await expect(vex.action("t.act", {})).rejects.toThrow('needs arg "n"');
    expect(vex.activeSubscriptionCount()).toBe(0);
  });

  test("an optional arg may be absent or null; absent stays absent, null stays null", async () => {
    const vex = await engine();
    expect(await vex.query("t.typed", { s: "a", n: 1 })).toEqual({
      s: "a",
      n: 1,
    });
    expect(
      await vex.query("t.typed", { s: "a", n: 1, b: null, j: undefined }),
    ).toEqual({ s: "a", n: 1, b: null });
  });

  test("a declaration naming a type the engine cannot check is refused at create", async () => {
    for (const type of ["any", "String", "int", "string[]", ""]) {
      await expect(
        create({
          plugins: [
            (api: VexPluginAPI) => {
              api.setName("bad");
              api.registerQuery("q", {
                args: { x: type as any },
                handler: () => null,
              });
            },
          ],
        }),
      ).rejects.toThrow(`declares arg "x" as ${JSON.stringify(type)}`);
    }
  });

  test("middleware cannot change the args the handler was checked as", async () => {
    let seen: unknown;
    const vex = await create({
      plugins: [
        (api: VexPluginAPI) => {
          api.setName("m");
          api.use((_ctx, info, next) => {
            try {
              (info.args as any).s = "rewritten";
            } catch {}
            return next();
          });
          api.registerQuery("q", {
            args: { s: "string" },
            handler: (_ctx, args) => {
              seen = args.s;
              return null;
            },
          });
        },
      ],
    });
    await vex.query("m.q", { s: "given" });
    expect(seen).toBe("given");
  });

  test("over HTTP a refused arg answers 400 with the reason", async () => {
    const vex = await engine();
    const app = createRouter().mount("/vex", vexHandler(vex));
    const res = await app.handle(
      new Request("http://x/vex/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "t.typed", args: { s: "a" } }),
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      'needs arg "n"',
    );
  });
});

describe("an answer is JSON, and every reader hears the same one", () => {
  const answers = (api: VexPluginAPI) => {
    api.setName("a");
    api.registerQuery("dated", {
      args: {},
      handler: () => ({ at: new Date(0) }),
    });
    api.registerQuery("sparse", {
      args: {},
      handler: async (ctx) => ({
        n: await ctx.db.table("items").count(),
        missing: undefined,
      }),
    });
    api.registerMutation("dated", {
      args: {},
      handler: async (ctx) => {
        await ctx.db.table("items").insert({ scope: "x", n: 1 });
        return new Date(0);
      },
    });
    api.registerAction("dated", {
      args: {},
      handler: () => new Set([1]),
    });
  };

  test("a query, mutation or action answering something JSON cannot say is refused", async () => {
    const vex = await create({ plugins: [plugin, answers] });
    await expect(vex.query("a.dated")).rejects.toThrow(
      "query a.dated answers holds a Date",
    );
    await expect(vex.subscribe("a.dated", {}, () => {})).rejects.toThrow(
      "holds a Date",
    );
    await expect(vex.action("a.dated")).rejects.toThrow("holds a Set");
  });

  test("a mutation refused for its answer commits nothing", async () => {
    const vex = await create({ plugins: [plugin, answers] });
    await expect(vex.mutate("a.dated")).rejects.toThrow("holds a Date");
    expect(await vex.query("bp.count", { scope: "x", extra: null })).toBe(0);
  });

  test("the first member, a joiner and a member re-run hear one value, not as given", async () => {
    const vex = await create({ plugins: [plugin, answers] });
    const first: any[] = [];
    const joiner: any[] = [];
    await vex.subscribe("a.sparse", {}, (r) => first.push(r));
    await vex.subscribe("a.sparse", {}, (r) => joiner.push(r));
    expect(first[0]).toEqual({ n: 0 });
    expect("missing" in first[0]).toBe(false);
    expect("missing" in joiner[0]).toBe(false);
    await vex.mutate("bp.add", { scope: "q", n: 1 });
    expect(first[1]).toEqual({ n: 1 });
    expect("missing" in first[1]).toBe(false);
    expect(joiner[1]).toEqual(first[1]);
  });
});

describe("time and chance are the context's, and a query's time is reactive", () => {
  const timed = (api: VexPluginAPI) => {
    api.setName("tm");
    api.registerQuery("second", {
      args: {},
      handler: (ctx) => ({ at: ctx.now(1000) }),
    });
    api.registerQuery("badResolution", {
      args: { r: "number" },
      handler: (ctx, args) => ctx.now(args.r),
    });
    api.registerMutation("stamp", {
      args: {},
      handler: async (ctx) => {
        const a = ctx.now();
        await ctx.db.table("items").insert({ scope: "t", n: a });
        const b = ctx.now();
        return { same: a === b, id: ctx.id(), r: ctx.random() };
      },
    });
  };

  test("a query and a mutation have no job controls", async () => {
    let seen: unknown[] = [];
    const vex = await create({
      plugins: [
        (api: VexPluginAPI) => {
          api.setName("rt");
          api.registerQuery("q", {
            args: {},
            handler: (ctx) => {
              seen.push((ctx as any).runtime);
              return null;
            },
          });
          api.registerMutation("m", {
            args: {},
            handler: (ctx) => {
              seen.push((ctx as any).runtime);
              return null;
            },
          });
          api.registerAction("a", {
            args: {},
            handler: (ctx) => {
              seen.push(typeof ctx.runtime.triggerJob);
              return null;
            },
          });
        },
      ],
    });
    seen = [];
    await vex.query("rt.q");
    await vex.mutate("rt.m");
    await vex.action("rt.a");
    expect(seen).toEqual([undefined, undefined, "function"]);
  });

  test("a mutation's now is one time for the whole call; ids and chance are the context's", async () => {
    const vex = await create({ plugins: [plugin, timed] });
    const first = await vex.mutate("tm.stamp");
    const second = await vex.mutate("tm.stamp");
    expect(first.same).toBe(true);
    expect(first.id).not.toBe(second.id);
    expect(first.r).toBeGreaterThanOrEqual(0);
    expect(first.r).toBeLessThan(1);
  });

  test("a query's now is floored to its resolution, which is whole and at least a second", async () => {
    const vex = await create({ plugins: [plugin, timed] });
    const { at } = await vex.query("tm.second");
    expect(at % 1000).toBe(0);
    expect(Date.now() - at).toBeLessThan(1000);
    for (const r of [999, 1500.5, 0, -1000]) {
      await expect(vex.query("tm.badResolution", { r })).rejects.toThrow(
        "a whole number of milliseconds, at least 1000",
      );
    }
  });

  test("a subscription that read the time re-runs when the next interval begins, and not before", async () => {
    const vex = await create({ plugins: [plugin, timed] });
    const heard: number[] = [];
    await vex.subscribe("tm.second", {}, (r: any) => heard.push(r.at));
    expect(heard).toHaveLength(1);
    // A write it did not read leaves it alone.
    await vex.mutate("bp.add", { scope: "x", n: 1 });
    expect(heard).toHaveLength(1);
    await Bun.sleep(1100);
    expect(heard.length).toBeGreaterThanOrEqual(2);
    expect(heard[1]! - heard[0]!).toBeGreaterThanOrEqual(1000);
  });

  test("a group that leaves stops the clock for it", async () => {
    const vex = await create({ plugins: [plugin, timed] });
    const heard: number[] = [];
    const stop = await vex.subscribe("tm.second", {}, (r: any) =>
      heard.push(r.at),
    );
    stop();
    await Bun.sleep(1100);
    expect(heard).toHaveLength(1);
  });
});

describe("a mutation's raw SQL reads and changes rows, nothing else", () => {
  const raw = (api: VexPluginAPI) => {
    api.setName("rw");
    api.registerMutation("run", {
      args: { sql: "string" },
      handler: (ctx, args) => ctx.db.sql(args.sql),
    });
  };

  test("DML on the app's tables runs", async () => {
    const vex = await create({ plugins: [plugin, raw] });
    await vex.mutate("rw.run", {
      sql: "INSERT INTO items (_id, scope, n) VALUES ('r1', 'a', 1)",
    });
    await vex.mutate("rw.run", {
      sql: "UPDATE items SET n = 2 WHERE _id = 'r1'",
    });
    await vex.mutate("rw.run", {
      sql: "WITH t AS (SELECT 'r1' AS id) DELETE FROM items WHERE _id IN (SELECT id FROM t)",
    });
    expect(await vex.query("bp.count", { scope: "a", extra: null })).toBe(0);
  });

  test("schema, PRAGMA, attachments, transaction control and the engine's tables are refused, and nothing commits", async () => {
    const vex = await create({ plugins: [plugin, raw] });
    for (const sql of [
      "CREATE VIEW v AS SELECT * FROM items",
      "DROP TABLE items",
      "ALTER TABLE items ADD COLUMN x TEXT",
      "PRAGMA writable_schema = 1",
      "ATTACH DATABASE ':memory:' AS other",
      "BEGIN",
      "COMMIT",
      "SAVEPOINT s",
      "VACUUM",
      "INSERT INTO items (_id, scope, n) VALUES ('ok', 'a', 1); DROP TABLE items",
    ]) {
      await expect(vex.mutate("rw.run", { sql })).rejects.toThrow(
        "ctx.db.sql in a mutation reads and changes rows",
      );
    }
    await expect(
      vex.mutate("rw.run", { sql: "DELETE FROM _jobs" }),
    ).rejects.toThrow("writes no table the engine keeps (_jobs)");
    expect(await vex.query("bp.count", { scope: "a", extra: null })).toBe(0);
  });
});

describe("jobs and webhooks are actions; middleware is declared", () => {
  test("a job and a webhook get an action's context, and their writes are mutations that narrow", async () => {
    const seen: string[] = [];
    const vex = await create({
      plugins: [
        plugin,
        (api: VexPluginAPI) => {
          api.setName("jw");
          api.registerJob("sweep", {
            schedule: "every 1h",
            async handler(ctx) {
              seen.push(`job db:${typeof (ctx as any).db}`);
              await ctx.mutate("bp.add", { scope: "job", n: 1 });
            },
          });
          api.registerWebhook("in", {
            path: "/jw",
            async handler(ctx, req) {
              seen.push(`hook db:${typeof (ctx as any).db}`);
              await ctx.mutate("bp.add", { scope: req.body.scope, n: 1 });
              return { ok: true };
            },
          });
        },
      ],
    });
    const other: number[] = [];
    await vex.subscribe(
      "bp.count",
      { scope: "elsewhere", extra: null },
      (n: number) => other.push(n),
    );
    await vex.triggerJob("jw.sweep");
    await vex.handleWebhook({
      path: "/jw",
      method: "POST",
      headers: {},
      body: { scope: "hook" },
      rawBody: "",
      query: {},
    });
    expect(seen).toEqual(["job db:undefined", "hook db:undefined"]);
    expect(await vex.query("bp.count", { scope: "job", extra: null })).toBe(1);
    expect(await vex.query("bp.count", { scope: "hook", extra: null })).toBe(1);
    // Neither write reached the view of another scope: they narrowed.
    expect(other).toEqual([0]);
  });

  test("middleware cannot be added to a running engine, and no table is read past its policy", async () => {
    const vex = await create();
    expect((vex as any).use).toBeUndefined();
    expect((vex as any).readTable).toBeUndefined();
  });
});

describe("the schema changes through migrations; raw access is internal", () => {
  const migrating = (log: string[]) => [
    {
      id: "001-view",
      up: async (m: any) => {
        log.push("001");
        await m.sql("CREATE VIEW IF NOT EXISTS scoped AS SELECT * FROM items");
      },
    },
    {
      id: "002-seed",
      up: async (m: any) => {
        log.push("002");
        await m.mutate("bp.add", { scope: "seeded", n: 1 });
      },
    },
  ];

  test("migrations apply once each, in order, before create returns; a failing one rolls back and stops the engine", async () => {
    const dir = (await import("node:fs")).mkdtempSync(
      (await import("node:path")).join(
        (await import("node:os")).tmpdir(),
        "vex-mig-",
      ),
    );
    const file = (await import("node:path")).join(dir, "db.sqlite");
    const log: string[] = [];
    const first = await create({
      storage: sqliteAdapter(file),
      migrations: migrating(log),
    });
    expect(log).toEqual(["001", "002"]);
    expect(
      await first.query("bp.count", { scope: "seeded", extra: null }),
    ).toBe(1);
    await first.close();
    open = open.filter((v) => v !== first);
    const again = await create({
      storage: sqliteAdapter(file),
      migrations: [
        ...migrating(log),
        {
          id: "003-broken",
          up: async (m: any) => {
            await m.mutate("bp.add", { scope: "broken", n: 1 });
            throw new Error("migration failed");
          },
        },
      ],
    }).catch((error: Error) => error);
    expect((again as Error).message).toBe("migration failed");
    expect(log).toEqual(["001", "002"]);
    const after = await create({ storage: sqliteAdapter(file) });
    expect(
      await after.query("bp.count", { scope: "broken", extra: null }),
    ).toBe(0);
  });

  test("migration ids are unique", async () => {
    await expect(
      create({
        migrations: [
          { id: "a", up: () => {} },
          { id: "a", up: () => {} },
        ],
      }),
    ).rejects.toThrow("Duplicate migration: a");
  });

  test("the public engine holds no raw access", async () => {
    const vex = await create();
    for (const name of ["unsafeSql", "unsafeGetStorage", "unsafeBulkInsert"]) {
      expect((vex as any)[name]).toBeUndefined();
    }
    const entry = await import("../src/index.js");
    for (const name of ["rawSql", "rawStorage", "rawBulkInsert", "RAW"]) {
      expect((entry as any)[name]).toBeUndefined();
    }
  });
});
