/**
 * The states the engine's interface makes impossible, each pinned:
 *
 *   - a caller answered with what another may see (callers share a
 *     run only when alike in every field its runs read);
 *   - a write the engine is handed that no subscription hears of
 *     (`rawSql`, `rawStorage` in vex-core/internal);
 *   - a raw read whose dependency is not written down (every table a
 *     raw read reads is named, held to rows or read whole), or whose
 *     hold a view slips past;
 *   - a subscription that stops or goes stale in silence (`onError`);
 *   - identical views apart because their args are spelled apart;
 *   - an arg, column or answer outside its schema, or a declaration
 *     that is not one;
 *   - a handler reaching past its context: the engine's tables, the
 *     clock, the schema.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import type { VexPluginAPI } from "../src/core/api.js";
import { Vex } from "../src/core/engine.js";
import type { VexUser } from "../src/core/types.js";
import { createRouter } from "../src/http/router.js";
import { vexHandler } from "../src/http/vex-handler.js";
import { rawSql, rawStorage } from "../src/internal.js";
import { Type } from "../src/portable.js";

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
      scope: Type.String({ index: true }),
      n: Type.Number(),
    },
  });
  // What a caller sees depends on its fence, not only its id.
  api.registerQuery("visible", {
    args: { scope: Type.String() },
    async handler(ctx, args) {
      const fence = (ctx.user as { fence?: string } | undefined)?.fence;
      runs.set("visible", (runs.get("visible") ?? 0) + 1);
      let q = ctx.db.table("items").where("scope", "=", args.scope);
      if (fence) q = q.where("n", "<", Number(fence));
      return q.order("n", "asc").all();
    },
  });
  api.registerQuery("count", {
    args: { scope: Type.String(), extra: Type.Optional(Type.Unknown()) },
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
    args: { reads: Type.Unknown(), sql: Type.String() },
    handler: (ctx, args) =>
      ctx.db.sql(args.reads as Record<string, any>, args.sql),
  });
  api.registerMutation("add", {
    args: { scope: Type.String(), n: Type.Number() },
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
    ).rejects.toThrow('a caller holds a function (at "reach")');
    await expect(
      vex.query("bp.visible", { scope: "a" }, { user: withReach }),
    ).rejects.toThrow('a caller holds a function (at "reach")');
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

  test("a subscriber finds its group without passing every other caller's", async () => {
    const vex = await create();
    await vex.mutate("bp.add", { scope: "a", n: 1 });
    await vex.mutate("bp.add", { scope: "a", n: 9 });
    const callers = 8000;
    const fenced = (i: number) => ({ ...alice, fence: String(i) }) as VexUser;
    const opened = performance.now();
    for (let i = 0; i < callers; i++) {
      await vex.subscribe("bp.visible", { scope: "a" }, () => {}, {
        user: fenced(i),
      });
    }
    const ms = performance.now() - opened;
    // One group per fence, every caller its own.
    expect(vex.describeSubscriptions().unique).toBe(callers);
    // A caller alike in what the runs read joins its group, hearing
    // that group's answer without a run.
    const before = runs.get("visible");
    const heard: any[] = [];
    await vex.subscribe("bp.visible", { scope: "a" }, (r) => heard.push(r), {
      user: { ...fenced(5), id: "bob" } as VexUser,
    });
    expect(runs.get("visible")).toBe(before);
    expect(vex.describeSubscriptions().unique).toBe(callers);
    expect(heard.at(-1).map((r: any) => r.n)).toEqual([1]);
    // Scanning every group per subscriber takes seconds here; finding
    // it by what the runs read, tens of milliseconds.
    expect(ms).toBeLessThan(1500);
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
      args: {
        s: Type.String(),
        n: Type.Number(),
        b: Type.Optional(Type.Boolean()),
        j: Type.Optional(Type.Unknown()),
      },
      handler: (_ctx, args) => ({ ...args }),
    });
    api.registerMutation("mut", {
      args: { s: Type.String() },
      handler: (_ctx, args) => args.s,
    });
    api.registerAction("act", {
      args: { n: Type.Number() },
      handler: (_ctx, args) => args.n,
    });
  };
  const engine = () => create({ plugins: [plugin, typed] });

  test("a wrong type, a missing arg, an undeclared arg, a non-finite number or a non-JSON value is refused, by every call", async () => {
    const vex = await engine();
    const refusals: Array<[Record<string, unknown>, string]> = [
      [{ s: 1, n: 1 }, 'takes arg "s": must be string'],
      [{ n: 1 }, 'needs arg "s"'],
      [{ s: "a", n: 1, x: 1 }, 'takes no arg "x"'],
      [{ s: "a", n: Number.NaN }, 'takes arg "n": must be number'],
      [{ s: "a", n: Infinity }, 'takes arg "n": must be number'],
      [{ s: "a", n: 1, b: "yes" }, 'takes arg "b": must be boolean'],
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
      'takes arg "s": must be string',
    );
    await expect(vex.action("t.act", {})).rejects.toThrow('needs arg "n"');
    expect(vex.activeSubscriptionCount()).toBe(0);
  });

  test("an optional arg may be absent; null is a value its schema must allow", async () => {
    const vex = await engine();
    expect(await vex.query("t.typed", { s: "a", n: 1 })).toEqual({
      s: "a",
      n: 1,
    });
    // Undefined is an arg not given.
    expect(await vex.query("t.typed", { s: "a", n: 1, j: undefined })).toEqual({
      s: "a",
      n: 1,
    });
    await expect(
      vex.query("t.typed", { s: "a", n: 1, b: null }),
    ).rejects.toThrow('takes arg "b": must be boolean');
    const nullable = await create({
      plugins: [
        (api: VexPluginAPI) => {
          api.setName("nl");
          api.registerQuery("q", {
            args: {
              b: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
            },
            handler: (_ctx, args) => ({ ...args }),
          });
        },
      ],
    });
    expect(await nullable.query("nl.q", { b: null })).toEqual({ b: null });
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
            args: { s: Type.String() },
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

  test("an answer outside its returns schema is refused, every part named", async () => {
    const vex = await create({
      plugins: [
        (api: VexPluginAPI) => {
          api.setName("ret");
          api.registerQuery("q", {
            args: {},
            returns: Type.Object(
              { n: Type.Number(), s: Type.String() },
              { additionalProperties: false },
            ),
            handler: () => ({ n: "x", extra: 1 }),
          });
        },
      ],
    });
    await expect(vex.query("ret.q")).rejects.toThrow(
      'query ret.q answers without "s"; with "extra", which it does not return; /n: must be number',
    );
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

  test("a call's answer, like a subscription's, drops what JSON does not say", async () => {
    const vex = await create({
      plugins: [
        (api: VexPluginAPI) => {
          api.setName("ans");
          api.registerQuery("q", {
            args: {},
            handler: () => ({ kept: 1, dropped: undefined, zero: -0 }),
          });
          api.registerMutation("m", {
            args: {},
            handler: () => ({ dropped: undefined }),
          });
        },
      ],
    });
    const answer = await vex.query("ans.q");
    expect(Object.keys(answer)).toEqual(["kept", "zero"]);
    expect(Object.is(answer.zero, 0)).toBe(true);
    expect(Object.keys(await vex.mutate("ans.m"))).toEqual([]);
    let heard: any;
    await vex.subscribe("ans.q", {}, (value) => {
      heard = value;
    });
    expect(heard).toEqual(answer);
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
      args: { r: Type.Number() },
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
      args: { sql: Type.String() },
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
    await expect(
      vex.mutate("rw.run", { sql: "DELETE FROM _migrations" }),
    ).rejects.toThrow("writes no table the engine keeps (_migrations)");
    // The span table is the app's tracer's to keep.
    await vex.mutate("rw.run", { sql: "DELETE FROM _spans" });
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

  test("what an app handles is exported: the schema language and the errors it may catch", async () => {
    const entry = await import("../src/index.js");
    const framework = await import("../src/framework/index.js");
    for (const name of ["Type", "ArgsError", "PurityError", "ReentryError"]) {
      expect((entry as any)[name]).toBeDefined();
    }
    expect(framework.Type).toBe(entry.Type);
    // Each error a caller catches says which it is, logged or not.
    expect(new entry.ArgsError("x").name).toBe("ArgsError");
    expect(new entry.PurityError("x").name).toBe("PurityError");
    expect(new entry.ReentryError("x").name).toBe("ReentryError");
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

describe("under purityCheck, a query answers from its context alone", () => {
  let counter = 0;
  let mode = "a";
  const impure = (api: VexPluginAPI) => {
    api.setName("pu");
    api.registerQuery("counted", {
      args: {},
      // Module state in the answer: a different answer every run.
      handler: () => ++counter,
    });
    api.registerQuery("moded", {
      args: {},
      handler: async (ctx) => ({
        n: await ctx.db.table("items").where("scope", "=", "m").count(),
        mode,
      }),
    });
  };

  test("a run answering two ways on the same data is refused, naming why", async () => {
    const vex = await create({
      plugins: [plugin, impure],
      purityCheck: "always",
    });
    await expect(vex.query("pu.counted")).rejects.toThrow(
      "query pu.counted answered two ways on the same data",
    );
    await expect(vex.subscribe("pu.counted", {}, () => {})).rejects.toThrow(
      "answered two ways on the same data",
    );
  });

  test("a subscription that answers differently though nothing it read changed is ended and told", async () => {
    const vex = await create({
      plugins: [plugin, impure],
      purityCheck: "always",
    });
    mode = "a";
    const told: Array<[string, boolean]> = [];
    const heard: unknown[] = [];
    await vex.subscribe("pu.moded", {}, (r) => heard.push(r), {
      onError: (error, ended) => told.push([error.message, ended]),
    });
    mode = "b";
    // A write it did not read: skipped, then checked.
    await vex.mutate("bp.add", { scope: "elsewhere", n: 1 });
    expect(told).toEqual([
      [
        expect.stringContaining(
          "answered differently though nothing it read changed",
        ),
        true,
      ],
    ]);
    expect(heard).toEqual([{ n: 0, mode: "a" }]);
    expect(vex.activeSubscriptionCount()).toBe(0);
  });

  test("pure queries answer and deliver as ever under the check", async () => {
    const vex = await create({ purityCheck: "always" });
    const seen: number[] = [];
    await vex.subscribe("bp.count", { scope: "a", extra: null }, (n: number) =>
      seen.push(n),
    );
    await vex.mutate("bp.add", { scope: "a", n: 1 });
    await vex.mutate("bp.add", { scope: "other", n: 1 });
    expect(seen).toEqual([0, 1]);
    expect(await vex.query("bp.count", { scope: "a", extra: null })).toBe(1);
  });

  test("the check takes always, off, or a share of runs", async () => {
    for (const purityCheck of [1.5, -1, "sometimes"]) {
      await expect(create({ purityCheck: purityCheck as any })).rejects.toThrow(
        'purityCheck: "always", "off", or a share of runs from 0 to 1',
      );
    }
  });
});

test("an action's call may name its caller, as the app decides", async () => {
  const seen: Array<string | null> = [];
  const vex = await create({
    plugins: [
      (api: VexPluginAPI) => {
        api.setName("as");
        api.registerQuery("who", {
          args: {},
          handler: (ctx) => {
            seen.push(ctx.user?.id ?? null);
            return null;
          },
        });
        api.registerAction("run", {
          args: {},
          async handler(ctx) {
            await ctx.query("as.who");
            await ctx.query(
              "as.who",
              {},
              { user: { id: "system", name: "S", isAdmin: true } },
            );
            return null;
          },
        });
      },
    ],
  });
  await vex.action("as.run", {}, { user: alice });
  expect(seen).toEqual(["alice", "system"]);
});

describe("a table's columns are schemas, and every write passes them", () => {
  const rows = (api: VexPluginAPI) => {
    api.setName("rows");
    api.registerTable("cards", {
      columns: {
        title: Type.String(),
        votes: Type.Number({ default: 0 }),
        note: Type.Optional(Type.String()),
        meta: Type.Optional(Type.Object({ tags: Type.Array(Type.String()) })),
      },
    });
    api.registerMutation("insert", {
      args: { row: Type.Unknown() },
      handler: (ctx, args) =>
        ctx.db.table("cards").insert(args.row as Record<string, unknown>),
    });
    api.registerMutation("update", {
      args: { id: Type.String(), data: Type.Unknown() },
      handler: async (ctx, args) => {
        await ctx.db
          .table("cards")
          .update(args.id, args.data as Record<string, unknown>);
        return null;
      },
    });
    api.registerQuery("one", {
      args: { id: Type.String() },
      handler: (ctx, args) =>
        ctx.db.table("cards").where("_id", "=", args.id).first(),
    });
  };

  test("an insert gives each required column, of its type, and no undeclared one; a default may be omitted", async () => {
    const vex = await create({ plugins: [rows] });
    const id = await vex.mutate("rows.insert", {
      row: { title: "a", meta: { tags: ["x"] } },
    });
    expect(await vex.query("rows.one", { id })).toMatchObject({
      title: "a",
      votes: 0,
      meta: { tags: ["x"] },
    });
    for (const [row, message] of [
      [{}, 'needs column "title"'],
      [{ title: 1 }, 'column "title": must be string'],
      [{ title: "a", extra: 1 }, 'has no column "extra"'],
      [{ title: "a", meta: { tags: [1] } }, 'column "meta"'],
    ] as const) {
      await expect(vex.mutate("rows.insert", { row })).rejects.toThrow(message);
    }
  });

  test("an update gives any of the columns, each of its type; none commits a refused write", async () => {
    const vex = await create({ plugins: [rows] });
    const id = await vex.mutate("rows.insert", { row: { title: "a" } });
    await vex.mutate("rows.update", { id, data: { votes: 3, note: null } });
    expect(await vex.query("rows.one", { id })).toMatchObject({
      title: "a",
      votes: 3,
    });
    await expect(
      vex.mutate("rows.update", { id, data: { votes: "3" } }),
    ).rejects.toThrow('update into cards: column "votes": must be number');
    expect(await vex.query("rows.one", { id })).toMatchObject({ votes: 3 });
  });

  test("a column declared in the old form is refused, saying how to declare it", async () => {
    await expect(
      create({
        plugins: [
          (api: VexPluginAPI) => {
            api.setName("old");
            api.registerTable("t", {
              columns: { x: { type: "json" } as any },
            });
          },
        ],
      }),
    ).rejects.toThrow(
      'table t declares column "x" as {"type":"json"}: declare it with a schema',
    );
  });
});

describe("the engine's tables are the engine's", () => {
  const forger = (api: VexPluginAPI) => {
    api.setName("forge");
    api.registerMutation("write", {
      args: { table: Type.String() },
      handler: async (ctx, args) => {
        await ctx.db.table(args.table).insert({ name: "x" });
        return null;
      },
    });
    api.registerMutation("raw", {
      args: { sql: Type.String() },
      handler: (ctx, args) => ctx.db.sql(args.sql),
    });
    api.registerQuery("read", {
      args: { table: Type.String() },
      handler: (ctx, args) => ctx.db.table(args.table).all(),
    });
    api.registerQuery("rawRead", {
      args: { table: Type.String() },
      handler: (ctx, args) =>
        ctx.db.sql({ [args.table]: "all" }, `SELECT * FROM ${args.table}`),
    });
  };

  test("no handler writes one; none reads _scheduled, which says whom each schedule runs as", async () => {
    const vex = await create({ plugins: [forger] });
    for (const table of ["_scheduled", "_SCHEDULED", "_jobs", "_migrations"]) {
      await expect(vex.mutate("forge.write", { table })).rejects.toThrow(
        `ctx.db ${table.toLowerCase() === "_scheduled" ? "reads and writes" : "writes"} no ${table}`,
      );
    }
    await expect(
      vex.mutate("forge.raw", {
        sql: "INSERT INTO _scheduled (_id, name, kind, args, runAt, status, createdAt) VALUES ('x', 'a.b', 'mutation', '{}', 0, 'pending', 0)",
      }),
    ).rejects.toThrow("ctx.db.sql reads and writes no _scheduled");
    await expect(
      vex.mutate("forge.raw", { sql: "SELECT * FROM _Scheduled" }),
    ).rejects.toThrow("ctx.db.sql reads and writes no _scheduled");
    await expect(
      vex.query("forge.read", { table: "_scheduled" }),
    ).rejects.toThrow("ctx.db reads and writes no _scheduled");
    await expect(
      vex.query("forge.rawRead", { table: "_scheduled" }),
    ).rejects.toThrow("ctx.db reads and writes no _scheduled");
    // What the engine keeps of its jobs is readable: an app lists them.
    expect(await vex.query("forge.read", { table: "_jobs" })).toEqual([]);
  });
});

describe("only a schema Type builds declares an arg or a return", () => {
  test("an old-form arg or return is refused as the engine starts, saying how to declare it", async () => {
    const declaring = (declare: (api: VexPluginAPI) => void) =>
      create({
        plugins: [
          (api: VexPluginAPI) => {
            api.setName("old");
            declare(api);
          },
        ],
      });
    await expect(
      declaring((api) =>
        api.registerQuery("q", {
          args: { n: { type: "number", optional: true } as any },
          handler: () => null,
        }),
      ),
    ).rejects.toThrow(
      'query old.q declares arg "n" as {"type":"number","optional":true}: declare it with a schema',
    );
    await expect(
      declaring((api) =>
        api.registerQuery("r", {
          args: {},
          returns: { type: "string" } as any,
          handler: () => "x",
        }),
      ),
    ).rejects.toThrow("query old.r declares what it returns as");
  });

  test("every refused part of an arg is named, each once", async () => {
    const vex = await create({
      plugins: [
        (api: VexPluginAPI) => {
          api.setName("two");
          api.registerQuery("q", {
            args: { p: Type.Object({ a: Type.Number(), b: Type.String() }) },
            handler: () => null,
          });
        },
      ],
    });
    await expect(vex.query("two.q", { p: { a: "x", b: 1 } })).rejects.toThrow(
      'query two.q takes arg "p" at /a: must be number; takes arg "p" at /b: must be string',
    );
  });

  test("a nullable arg is refused once, by its first branch", async () => {
    const vex = await create({
      plugins: [
        (api: VexPluginAPI) => {
          api.setName("nul");
          api.registerQuery("q", {
            args: { n: Type.Union([Type.Number(), Type.Null()]) },
            handler: (_ctx, args) => args.n,
          });
        },
      ],
    });
    await expect(vex.query("nul.q", { n: "5" })).rejects.toThrow(
      /^query nul\.q takes arg "n": must be number \(it takes "n"\)$/,
    );
  });
});

describe("a query composes another by name (ctx.query)", () => {
  const seen: Array<{ type: string; name: string; as: string | null }> = [];
  const composing = (api: VexPluginAPI) => {
    api.setName("cq");
    api.use((ctx, info, next) => {
      seen.push({
        type: info.type,
        name: info.name,
        as: ctx.user?.id ?? null,
      });
      return next();
    });
    api.registerQuery("wrapped", {
      args: { scope: Type.String() },
      handler: async (ctx, args) => {
        runs.set("wrapped", (runs.get("wrapped") ?? 0) + 1);
        return {
          n: await ctx.query("bp.count", { scope: args.scope, extra: null }),
        };
      },
    });
    api.registerQuery("fenced", {
      args: {},
      handler: async (ctx) => ({
        rows: await ctx.query("bp.visible", { scope: "a" }),
      }),
    });
    api.registerQuery("optional", {
      args: {},
      handler: async (ctx) => {
        try {
          return await ctx.query("absent.thing");
        } catch (error) {
          return (error as Error).message;
        }
      },
    });
    api.registerQuery("badArgs", {
      args: {},
      handler: (ctx) => ctx.query("bp.count", { scope: 1 }),
    });
    api.registerQuery("asSystem", {
      args: {},
      handler: (ctx) => ctx.query("bp.visible", { scope: "a" }, { user: null }),
    });
    api.registerQuery("asReach", {
      args: {},
      handler: (ctx) =>
        ctx
          .query(
            "bp.visible",
            { scope: "a" },
            {
              user: { ...alice, reach: () => true } as unknown as VexUser,
            },
          )
          .catch((error: Error) => `rejected: ${error.message}`),
    });
  };

  test("what the called query reads is the caller's: a write it reads re-runs the subscription, one it rules out does not", async () => {
    const vex = await create({ plugins: [plugin, composing] });
    const heard: number[] = [];
    await vex.subscribe("cq.wrapped", { scope: "a" }, (r: any) =>
      heard.push(r.n),
    );
    const before = runs.get("wrapped")!;
    await vex.mutate("bp.add", { scope: "a", n: 1 });
    expect(heard).toEqual([0, 1]);
    await vex.mutate("bp.add", { scope: "b", n: 1 });
    expect(runs.get("wrapped")).toBe(before + 1);
  });

  test("it is a call: middleware decides it as the caller, its args are checked, a missing query is said so", async () => {
    seen.length = 0;
    const vex = await create({ plugins: [plugin, composing] });
    await vex.query("cq.wrapped", { scope: "a" }, { user: alice });
    expect(seen).toEqual([
      { type: "query", name: "cq.wrapped", as: "alice" },
      { type: "query", name: "bp.count", as: "alice" },
    ]);
    expect(await vex.query("cq.optional")).toBe(
      "Query not found: absent.thing",
    );
    await expect(vex.query("cq.badArgs")).rejects.toThrow(
      'query bp.count takes arg "scope": must be string',
    );
    // A caller holding a function rejects, as every refusal does.
    expect(await vex.query("cq.asReach")).toStartWith(
      'rejected: a caller holds a function (at "reach")',
    );
    seen.length = 0;
    await vex.query("cq.asSystem", {}, { user: alice });
    expect(seen.at(-1)).toEqual({
      type: "query",
      name: "bp.visible",
      as: null,
    });
  });

  test("the caller's fields the called query reads tell callers apart", async () => {
    const vex = await create({ plugins: [plugin, composing] });
    await vex.mutate("bp.add", { scope: "a", n: 1 });
    await vex.mutate("bp.add", { scope: "a", n: 9 });
    const wide: any[] = [];
    const fenced: any[] = [];
    await vex.subscribe("cq.fenced", {}, (r: any) => wide.push(r), {
      user: alice,
    });
    await vex.subscribe("cq.fenced", {}, (r: any) => fenced.push(r), {
      user: { ...alice, fence: "5" } as VexUser,
    });
    expect(wide.at(-1).rows.map((r: any) => r.n)).toEqual([1, 9]);
    expect(fenced.at(-1).rows.map((r: any) => r.n)).toEqual([1]);
    expect(vex.describeSubscriptions().unique).toBe(2);
  });
});
