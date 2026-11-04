/**
 * The states the engine's interface makes impossible, each pinned:
 *
 *   - a caller answered with what another may see (callers share a
 *     run only when alike in every field, unless the app says which
 *     fields decide);
 *   - a write the engine is handed that no subscription hears of
 *     (`unsafeSql`, `unsafeGetStorage`);
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
    args: { scope: "string", extra: "json" },
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

  test("callers alike in every field share one run; a caller carrying functions shares only with itself", async () => {
    const vex = await create();
    await vex.subscribe("bp.visible", { scope: "a" }, () => {}, {
      user: { ...alice },
    });
    await vex.subscribe("bp.visible", { scope: "a" }, () => {}, {
      user: { ...alice },
    });
    expect(vex.describeSubscriptions().unique).toBe(1);
    const withReach = { ...alice, reach: () => true } as unknown as VexUser;
    await vex.subscribe("bp.visible", { scope: "a" }, () => {}, {
      user: withReach,
    });
    await vex.subscribe("bp.visible", { scope: "a" }, () => {}, {
      user: withReach,
    });
    await vex.subscribe("bp.visible", { scope: "a" }, () => {}, {
      user: { ...alice, reach: () => true } as unknown as VexUser,
    });
    expect(vex.describeSubscriptions().unique).toBe(3);
  });

  test("an app saying which fields decide shares across the rest", async () => {
    const vex = await create({ callerKey: (user) => user?.id ?? "none" });
    await vex.subscribe("bp.visible", { scope: "a" }, () => {}, {
      user: { ...alice, seenAt: 1 } as VexUser,
    });
    await vex.subscribe("bp.visible", { scope: "a" }, () => {}, {
      user: { ...alice, seenAt: 2 } as VexUser,
    });
    expect(vex.describeSubscriptions().unique).toBe(1);
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
  test("a write by unsafeSql re-runs the views it reaches", async () => {
    const vex = await create();
    const seen: number[] = [];
    await vex.subscribe("bp.count", { scope: "a", extra: null }, (n: number) =>
      seen.push(n),
    );
    await vex.unsafeSql(
      "INSERT INTO items (_id, scope, n) VALUES ('x', 'a', 1)",
    );
    expect(seen).toEqual([0, 1]);
  });

  test("a write through unsafeGetStorage, and a transaction there, are heard", async () => {
    const vex = await create();
    const seen: number[] = [];
    await vex.subscribe("bp.count", { scope: "a", extra: null }, (n: number) =>
      seen.push(n),
    );
    const storage = vex.unsafeGetStorage();
    await storage.insert("items", { scope: "a", n: 1 });
    expect(seen).toEqual([0, 1]);
    await storage.transaction(async () => {
      await storage.rawExec(
        "INSERT INTO items (_id, scope, n) VALUES ('y', 'a', 2)",
      );
    });
    expect(seen).toEqual([0, 1, 2]);
  });

  test("the storage handle is one handle: what a caller sets on it, the next caller sees", async () => {
    const vex = await create();
    expect(vex.unsafeGetStorage()).toBe(vex.unsafeGetStorage());
  });

  test("a tracer writing its spans through the storage does not feed on itself", async () => {
    let spans = 0;
    const holder: { vex?: Vex } = {};
    const vex = await create({
      tracer: {
        onSpan: () => {
          spans++;
          void holder.vex?.unsafeGetStorage().rawExec("SELECT 1");
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
    await vex.unsafeSql("CREATE VIEW item_view AS SELECT * FROM items");
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

  test("a view created after the list was taken, by unsafeSql, is seen", async () => {
    const vex = await create();
    expect(
      await vex.query("bp.raw", {
        reads: held,
        sql: "SELECT COUNT(*) AS n FROM items",
      }),
    ).toEqual([{ n: 0 }]);
    await vex.unsafeSql("CREATE VIEW late AS SELECT * FROM items");
    await expect(
      vex.query("bp.raw", { reads: held, sql: "SELECT * FROM late" }),
    ).rejects.toThrow("through a view (late)");
  });

  test("a view created by a mutation's raw SQL is seen", async () => {
    const vex = await create({
      plugins: [
        plugin,
        (api: VexPluginAPI) => {
          api.setName("ddl");
          api.registerMutation("view", {
            args: {},
            handler: (ctx) =>
              ctx.db.sql("CREATE VIEW by_mutation AS SELECT * FROM items"),
          });
        },
      ],
    });
    await vex.query("bp.raw", { reads: held, sql: "SELECT 1 FROM items" });
    await vex.mutate("ddl.view", {});
    await expect(
      vex.query("bp.raw", { reads: held, sql: "SELECT * FROM by_mutation" }),
    ).rejects.toThrow("through a view (by_mutation)");
  });

  test("a name that only contains a view's name is not the view", async () => {
    const vex = await create();
    await vex.unsafeSql("CREATE VIEW it AS SELECT * FROM items");
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
