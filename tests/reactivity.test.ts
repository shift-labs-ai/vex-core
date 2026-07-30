import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import type { VexPluginAPI } from "../src/core/api.js";
import { Vex, withSerializedSubscriptionResult } from "../src/core/engine.js";

const user = { id: "u1", name: "User", isAdmin: false };
let open: Vex[] = [];
let listRuns = 0;
let rawRuns = 0;
let flakyThrows = false;
let cyclicNow = false;
let serializationCalls = 0;
async function create(options: Parameters<typeof Vex.create>[0]) {
  const vex = await Vex.create(options);
  open.push(vex);
  return vex;
}
afterEach(async () => {
  await Promise.all(open.map((v) => v.close()));
  open = [];
  listRuns = 0;
  rawRuns = 0;
  flakyThrows = false;
  cyclicNow = false;
  serializationCalls = 0;
});

function reactivityPlugin(api: VexPluginAPI) {
  api.setName("rx");
  api.registerTable("items", {
    columns: {
      scope: { type: "string", index: true },
      kind: { type: "string", index: true },
      name: { type: "string" },
      score: { type: "number", optional: true },
      body: { type: "json", optional: true },
    },
  });
  api.registerTable("audit", { columns: { value: { type: "string" } } });
  api.registerQuery("list", {
    args: { scope: "string" },
    async handler(ctx, args) {
      listRuns++;
      return ctx.db
        .table("items")
        .where("scope", "=", args.scope)
        .order("name", "asc")
        .all();
    },
  });
  api.registerQuery("limited", {
    args: {},
    reactive: { maxRows: 2, maxBytes: 10_000 },
    async handler(ctx) {
      return ctx.db.table("items").order("name", "asc").all();
    },
  });
  api.registerQuery("disabled", {
    args: {},
    reactive: false,
    async handler(ctx) {
      return ctx.db.table("items").all();
    },
  });
  api.registerQuery("wrapped", {
    args: {},
    reactive: { maxRows: 2, maxBytes: 10_000 },
    async handler(ctx) {
      return {
        rows: await ctx.db.table("items").all(),
        total: await ctx.db.table("items").count(),
      };
    },
  });
  api.registerQuery("names", {
    args: { scope: "string" },
    async handler(ctx, args) {
      return ctx.db
        .table("items")
        .where("scope", "=", args.scope)
        .select("name")
        .order("name", "asc")
        .limit(1)
        .offset(1)
        .all();
    },
  });
  api.registerQuery("summary", {
    args: { scope: "string" },
    async handler(ctx, args) {
      const scoped = ctx.db.table("items").where("scope", "=", args.scope);
      return {
        first: await scoped.order("name", "asc").first(),
        count: await ctx.db
          .table("items")
          .where("scope", "=", args.scope)
          .count(),
        distinctKinds: await ctx.db
          .table("items")
          .where("scope", "=", args.scope)
          .distinct("kind"),
        countDistinctKinds: await ctx.db
          .table("items")
          .where("scope", "=", args.scope)
          .countDistinct("kind"),
        sumScore: await ctx.db
          .table("items")
          .where("scope", "=", args.scope)
          .sum("score"),
        avgScore: await ctx.db
          .table("items")
          .where("scope", "=", args.scope)
          .avg("score"),
        minScore: await ctx.db
          .table("items")
          .where("scope", "=", args.scope)
          .min("score"),
        maxScore: await ctx.db
          .table("items")
          .where("scope", "=", args.scope)
          .max("score"),
        grouped: await ctx.db
          .table("items")
          .where("scope", "=", args.scope)
          .groupBy("kind", { count: "count" })
          .having("count", ">=", 1)
          .order("kind", "asc")
          .limit(10),
      };
    },
  });
  api.registerQuery("twoPhase", {
    args: {},
    async handler(ctx) {
      const q = ctx.db.table("items").where("scope", "=", "a");
      const broad = await q.count();
      q.where("kind", "=", "one");
      const narrow = await q.count();
      return { broad, narrow };
    },
  });
  api.registerQuery("sometimesCyclic", {
    args: {},
    async handler(ctx) {
      const rows = await ctx.db.table("items").order("name", "asc").all();
      if (!cyclicNow) return rows;
      const value: any = { rows };
      value.self = value;
      return value;
    },
  });
  api.registerQuery("nothing", {
    args: {},
    async handler(ctx) {
      await ctx.db.table("items").count();
      return undefined;
    },
  });
  api.registerQuery("branched", {
    args: { scope: "string" },
    async handler(ctx, args) {
      // The underlying query builder is mutable-shared: this order() call
      // changes the SQL that base.all() executes. The recorded descriptor
      // must describe that SQL, not the pre-order chain state.
      const base = ctx.db.table("items").where("scope", "=", args.scope);
      base.order("name", "desc");
      return base.all();
    },
  });
  api.registerQuery("raw", {
    args: {},
    async handler(ctx) {
      rawRuns++;
      return ctx.db.sql("SELECT * FROM items ORDER BY name ASC");
    },
  });
  api.registerQuery("rawUnknown", {
    args: {},
    async handler(ctx) {
      rawRuns++;
      return ctx.db.sql("SELECT 1 as value");
    },
  });
  api.registerQuery("flaky", {
    args: {},
    async handler(ctx) {
      if (flakyThrows) throw new Error("flaky query failed");
      return ctx.db.table("items").order("name", "asc").all();
    },
  });
  api.registerQuery("viewer", {
    args: {},
    async handler(ctx) {
      if (!ctx.user) throw new Error("User required");
      return { userId: ctx.user.id, rows: await ctx.db.table("items").count() };
    },
  });
  api.registerQuery("serializable", {
    args: {},
    async handler(ctx) {
      const rows = await ctx.db.table("items").order("name", "asc").all();
      return {
        rows,
        toJSON() {
          serializationCalls++;
          return { rows };
        },
      };
    },
  });
  api.registerQuery("cyclic", {
    args: {},
    handler() {
      const value: any = { ok: true };
      value.self = value;
      return value;
    },
  });
  api.registerMutation("add", {
    args: { scope: "string", kind: "string", name: "string", body: "any" },
    async handler(ctx, args) {
      return ctx.db.table("items").insert({ ...args, score: args.score ?? 0 });
    },
  });
  api.registerMutation("touchAudit", {
    args: { value: "string" },
    async handler(ctx, args) {
      await ctx.db.table("audit").insert(args);
    },
  });
  api.registerMutation("upsert", {
    args: { scope: "string", kind: "string", name: "string", body: "any" },
    async handler(ctx, args) {
      await ctx.db
        .table("items")
        .upsert(
          { scope: args.scope, name: args.name },
          { kind: args.kind, body: args.body, score: args.score ?? 0 },
        );
    },
  });
  api.registerMutation("renameFirst", {
    args: { scope: "string", name: "string" },
    async handler(ctx, args) {
      const row = await ctx.db
        .table("items")
        .where("scope", "=", args.scope)
        .first<{ _id: string }>();
      if (row) await ctx.db.table("items").update(row._id, { name: args.name });
    },
  });
  api.registerMutation("deleteByScope", {
    args: { scope: "string" },
    async handler(ctx, args) {
      return ctx.db.table("items").where("scope", "=", args.scope).delete();
    },
  });
  api.registerMutation("rawTouchAudit", {
    args: { value: "string" },
    async handler(ctx, args) {
      await ctx.db.sql("INSERT INTO audit (value) VALUES (?)", args.value);
    },
  });
  api.registerWebhook("ingest", {
    path: "/rx/ingest",
    async handler(ctx, req) {
      await ctx.db.table("items").insert({
        scope: req.body.scope,
        kind: "hook",
        name: req.body.name,
        score: 0,
        body: null,
      });
      return { ok: true };
    },
  });
}

describe("reactive subscription bedrock", () => {
  test("preserves callback ordering, grouping, unsubscribe, touched-table updates, and no duplicate unchanged callbacks", async () => {
    listRuns = 0;
    const vex = await create({
      plugins: [reactivityPlugin],
      storage: sqliteAdapter(":memory:"),
    });
    await vex.mutate("rx.add", {
      scope: "a",
      kind: "one",
      name: "b",
      body: null,
    });

    const first: any[] = [];
    const second: any[] = [];
    const unsubFirst = await vex.subscribe("rx.list", { scope: "a" }, (rows) =>
      first.push(rows.map((r: any) => r.name)),
    );
    const unsubSecond = await vex.subscribe("rx.list", { scope: "a" }, (rows) =>
      second.push(rows.map((r: any) => r.name)),
    );

    expect(first).toEqual([["b"]]);
    expect(second).toEqual([["b"]]);
    expect(vex.describeSubscriptions()).toMatchObject({ total: 2, unique: 1 });

    await vex.mutate("rx.touchAudit", { value: "ignored" });
    expect(first).toEqual([["b"]]);

    const runsBeforeGroupedInvalidation = listRuns;
    await vex.mutate("rx.add", {
      scope: "a",
      kind: "one",
      name: "a",
      body: null,
    });
    expect(listRuns).toBe(runsBeforeGroupedInvalidation + 1);
    expect(first).toEqual([["b"], ["a", "b"]]);
    expect(second).toEqual([["b"], ["a", "b"]]);

    unsubFirst();
    await vex.mutate("rx.add", {
      scope: "a",
      kind: "one",
      name: "c",
      body: null,
    });
    expect(first).toEqual([["b"], ["a", "b"]]);
    expect(second).toEqual([["b"], ["a", "b"], ["a", "b", "c"]]);

    const runsBeforeUnrelatedWrite = listRuns;
    await vex.mutate("rx.add", {
      scope: "other",
      kind: "one",
      name: "z",
      body: null,
    });
    expect(listRuns).toBe(runsBeforeUnrelatedWrite);
    expect(second).toEqual([["b"], ["a", "b"], ["a", "b", "c"]]);
    unsubSecond();
  });

  test("raw SQL subscriptions are tracked coarsely and invalidated by matching changed tables", async () => {
    const vex = await create({
      plugins: [reactivityPlugin],
      storage: sqliteAdapter(":memory:"),
    });
    const calls: number[] = [];
    await vex.subscribe("rx.raw", {}, (rows) => calls.push(rows.length));
    expect(rawRuns).toBe(1);
    await vex.mutate("rx.touchAudit", { value: "ignored" });
    expect(rawRuns).toBe(1);
    await vex.mutate("rx.add", {
      scope: "a",
      kind: "one",
      name: "a",
      body: null,
    });
    expect(rawRuns).toBe(2);
    expect(calls).toEqual([0, 1]);
  });

  test("raw SQL with unknown tables falls back to global conservative invalidation", async () => {
    const vex = await create({
      plugins: [reactivityPlugin],
      storage: sqliteAdapter(":memory:"),
    });
    const calls: number[] = [];
    await vex.subscribe("rx.rawUnknown", {}, (rows) =>
      calls.push(rows[0].value),
    );
    expect(rawRuns).toBe(1);
    await vex.mutate("rx.touchAudit", { value: "changed" });
    expect(rawRuns).toBe(2);
    expect(calls).toEqual([1]);
  });

  test("mutation insert, upsert, update, delete, and raw writes invalidate deterministically", async () => {
    const vex = await create({
      plugins: [reactivityPlugin],
      storage: sqliteAdapter(":memory:"),
    });
    const calls: string[][] = [];
    await vex.subscribe("rx.list", { scope: "a" }, (rows) =>
      calls.push(rows.map((row: any) => row.name)),
    );

    await vex.mutate("rx.upsert", {
      scope: "other",
      kind: "one",
      name: "ignored",
      body: null,
    });
    expect(calls).toEqual([[]]);

    await vex.mutate("rx.upsert", {
      scope: "a",
      kind: "one",
      name: "a",
      body: null,
    });
    expect(calls).toEqual([[], ["a"]]);

    await vex.mutate("rx.renameFirst", { scope: "a", name: "b" });
    expect(calls).toEqual([[], ["a"], ["b"]]);

    await vex.mutate("rx.rawTouchAudit", { value: "raw" });
    expect(calls).toEqual([[], ["a"], ["b"]]);

    await vex.mutate("rx.deleteByScope", { scope: "a" });
    expect(calls).toEqual([[], ["a"], ["b"], []]);
  });

  test("query-builder descriptors include select, order, limit, and offset", async () => {
    const spans: any[] = [];
    const vex = await create({
      plugins: [reactivityPlugin],
      storage: sqliteAdapter(":memory:"),
      tracer: { onSpan: (span) => spans.push(span) },
    });
    await vex.mutate("rx.add", {
      scope: "a",
      kind: "one",
      name: "a",
      body: null,
    });
    await vex.mutate("rx.add", {
      scope: "a",
      kind: "one",
      name: "b",
      body: null,
    });
    const calls: any[] = [];
    await vex.subscribe("rx.names", { scope: "a" }, (rows) => calls.push(rows));

    expect(calls).toEqual([[{ name: "b" }]]);
    const meta = JSON.parse(
      spans.find((span) => span.type === "subscribe")!.meta,
    );
    expect(meta.dependencies[0]).toMatchObject({
      table: "items",
      select: ["name"],
      order: { column: "name", dir: "asc" },
      limit: 1,
      offset: 1,
    });
  });

  test("tracked descriptors match the SQL executed through intermediate references", async () => {
    const spans: any[] = [];
    const vex = await create({
      plugins: [reactivityPlugin],
      storage: sqliteAdapter(":memory:"),
      tracer: { onSpan: (span) => spans.push(span) },
    });
    await vex.mutate("rx.add", {
      scope: "a",
      kind: "one",
      name: "a",
      body: null,
    });
    await vex.mutate("rx.add", {
      scope: "a",
      kind: "one",
      name: "b",
      body: null,
    });
    const calls: string[][] = [];
    await vex.subscribe("rx.branched", { scope: "a" }, (rows) =>
      calls.push(rows.map((row: any) => row.name)),
    );

    // The order() call through the saved reference reached the SQL.
    expect(calls).toEqual([["b", "a"]]);
    // The descriptor must agree with that SQL.
    const meta = JSON.parse(
      spans.find((span) => span.type === "subscribe")!.meta,
    );
    expect(meta.dependencies[0]).toMatchObject({
      table: "items",
      filters: [{ column: "scope", operator: "=" }],
      order: { column: "name", dir: "desc" },
    });
  });

  test("descriptors snapshot at each terminal read; later chaining cannot rewrite them", async () => {
    const spans: any[] = [];
    const vex = await create({
      plugins: [reactivityPlugin],
      storage: sqliteAdapter(":memory:"),
      tracer: { onSpan: (span) => spans.push(span) },
    });
    await vex.mutate("rx.add", {
      scope: "a",
      kind: "one",
      name: "a",
      body: null,
    });
    await vex.mutate("rx.add", {
      scope: "a",
      kind: "two",
      name: "b",
      body: null,
    });
    const calls: any[] = [];
    await vex.subscribe("rx.twoPhase", {}, (data) => calls.push(data));

    // Both reads executed against their own chain state.
    expect(calls).toEqual([{ broad: 2, narrow: 1 }]);
    // Each terminal read froze its own descriptor: the second where()
    // must not retroactively appear on the first recorded dependency.
    const meta = JSON.parse(
      spans.find((span) => span.type === "subscribe")!.meta,
    );
    expect(meta.dependencies).toHaveLength(2);
    expect(meta.dependencies[0].filters).toEqual([
      { column: "scope", operator: "=" },
    ]);
    expect(meta.dependencies[1].filters).toEqual([
      { column: "scope", operator: "=" },
      { column: "kind", operator: "=" },
    ]);
  });

  test("cyclic results during invalidation do not kill the subscription, and it recovers", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    const vex = await create({
      plugins: [reactivityPlugin],
      storage: sqliteAdapter(":memory:"),
    });
    const calls: any[] = [];
    await vex.subscribe("rx.sometimesCyclic", {}, (rows) =>
      calls.push(rows.map((row: any) => row.name)),
    );

    try {
      // The re-run result becomes unserializable: measurement throws
      // outside the handler, after middleware succeeded.
      cyclicNow = true;
      await vex.mutate("rx.add", {
        scope: "a",
        kind: "one",
        name: "a",
        body: null,
      });
      expect(calls).toEqual([[]]);
      expect(vex.activeSubscriptionCount()).toBe(1);
      expect(consoleError).toHaveBeenCalledWith(
        "[vex] subscription rx.sometimesCyclic failed:",
        expect.any(Error),
      );

      // Once results are serializable again, the same subscription
      // resumes with the full current state — nothing was skipped.
      cyclicNow = false;
      await vex.mutate("rx.add", {
        scope: "a",
        kind: "one",
        name: "b",
        body: null,
      });
      expect(calls).toEqual([[], ["a", "b"]]);
    } finally {
      consoleError.mockRestore();
    }
  });

  test("unsafeBulkInsert invalidation is value-precise for filtered subscriptions", async () => {
    const vex = await create({
      plugins: [reactivityPlugin],
      storage: sqliteAdapter(":memory:"),
    });
    const calls: string[][] = [];
    await vex.subscribe("rx.list", { scope: "a" }, (rows) =>
      calls.push(rows.map((row: any) => row.name)),
    );
    const runsAfterSubscribe = listRuns;

    // Bulk rows for a different scope: recorded write values miss the
    // eq-filter, so the group must not even re-run.
    await vex.unsafeBulkInsert("items", [
      { scope: "other", kind: "one", name: "x", score: 0, body: null },
      { scope: "other", kind: "two", name: "y", score: 0, body: null },
    ]);
    expect(listRuns).toBe(runsAfterSubscribe);
    expect(calls).toEqual([[]]);

    // Matching rows re-run and deliver.
    await vex.unsafeBulkInsert("items", [
      { scope: "a", kind: "one", name: "m", score: 0, body: null },
    ]);
    expect(listRuns).toBe(runsAfterSubscribe + 1);
    expect(calls).toEqual([[], ["m"]]);
  });

  test("undefined reactive results deliver without serialized JSON and stay hash-stable", async () => {
    const vex = await create({
      plugins: [reactivityPlugin],
      storage: sqliteAdapter(":memory:"),
    });
    const deliveries: Array<[unknown, string | undefined]> = [];
    const deliver = withSerializedSubscriptionResult(
      (result: unknown, serialized?: string) => {
        deliveries.push([result, serialized]);
      },
    );
    await vex.subscribe("rx.nothing", {}, deliver);

    // JSON.stringify(undefined) is undefined: transports must receive
    // the explicit absence, not the string "undefined".
    expect(deliveries).toEqual([[undefined, undefined]]);

    // Invalidations rerun the query, but the hash of an undefined
    // result is stable — no duplicate push.
    await vex.mutate("rx.add", {
      scope: "a",
      kind: "one",
      name: "a",
      body: null,
    });
    expect(deliveries).toHaveLength(1);
    expect(vex.activeSubscriptionCount()).toBe(1);
  });

  test("webhook writes without recorded write metadata still invalidate filtered subscriptions", async () => {
    const vex = await create({
      plugins: [reactivityPlugin],
      storage: sqliteAdapter(":memory:"),
    });
    const calls: string[][] = [];
    await vex.subscribe("rx.list", { scope: "a" }, (rows) =>
      calls.push(rows.map((row: any) => row.name)),
    );

    const response = await vex.handleWebhook({
      body: { scope: "a", name: "hooked" },
      rawBody: JSON.stringify({ scope: "a", name: "hooked" }),
      headers: {},
      method: "POST",
      path: "/rx/ingest",
      query: {},
    });

    expect(response.status).toBe(200);
    expect(calls).toEqual([[], ["hooked"]]);
  });

  test("query-builder terminal reads record dependencies and stay reactive", async () => {
    const spans: any[] = [];
    const vex = await create({
      plugins: [reactivityPlugin],
      storage: sqliteAdapter(":memory:"),
      tracer: { onSpan: (span) => spans.push(span) },
    });
    await vex.mutate("rx.add", {
      scope: "a",
      kind: "one",
      name: "b",
      body: null,
      score: 2,
    });
    await vex.mutate("rx.add", {
      scope: "a",
      kind: "two",
      name: "a",
      body: null,
      score: 1,
    });
    const calls: any[] = [];
    await vex.subscribe("rx.summary", { scope: "a" }, (data) =>
      calls.push(data),
    );
    expect(calls[0]).toMatchObject({
      count: 2,
      countDistinctKinds: 2,
      distinctKinds: ["one", "two"],
      sumScore: 3,
      avgScore: 1.5,
      minScore: 1,
      maxScore: 2,
    });
    expect(calls[0].first.name).toBe("a");
    expect(calls[0].grouped).toEqual([
      { kind: "one", count: 1 },
      { kind: "two", count: 1 },
    ]);

    await vex.mutate("rx.add", {
      scope: "other",
      kind: "one",
      name: "z",
      body: null,
    });
    expect(calls).toHaveLength(1);
    await vex.mutate("rx.add", {
      scope: "a",
      kind: "one",
      name: "c",
      body: null,
    });
    expect(calls).toHaveLength(2);
    expect(calls[1].count).toBe(3);

    const subscribeMeta = JSON.parse(
      spans.find((span) => span.type === "subscribe")!.meta,
    );
    expect(subscribeMeta.dependencies.length).toBeGreaterThanOrEqual(9);
    expect(
      subscribeMeta.dependencies.every((dep: any) => dep.table === "items"),
    ).toBe(true);
  });

  test("errors in invalidated queries do not unsubscribe or corrupt the last good hash", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    flakyThrows = false;
    const vex = await create({
      plugins: [reactivityPlugin],
      storage: sqliteAdapter(":memory:"),
    });
    const calls: string[][] = [];
    await vex.subscribe("rx.flaky", {}, (rows) =>
      calls.push(rows.map((row: any) => row.name)),
    );

    try {
      flakyThrows = true;
      await vex.mutate("rx.add", {
        scope: "a",
        kind: "one",
        name: "a",
        body: null,
      });
      expect(calls).toEqual([[]]);
      expect(vex.activeSubscriptionCount()).toBe(1);

      flakyThrows = false;
      await vex.mutate("rx.add", {
        scope: "a",
        kind: "one",
        name: "b",
        body: null,
      });
      expect(calls).toEqual([[], ["a", "b"]]);
      expect(consoleError).toHaveBeenCalledWith(
        "[vex] subscription rx.flaky failed:",
        expect.any(Error),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  test("callback exceptions do not prevent other invalidated subscribers", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    const vex = await create({
      plugins: [reactivityPlugin],
      storage: sqliteAdapter(":memory:"),
    });
    const good: string[][] = [];
    let throwOnInvalidation = false;
    await vex.subscribe("rx.list", { scope: "a" }, () => {
      if (throwOnInvalidation) throw new Error("callback failed");
    });
    await vex.subscribe("rx.list", { scope: "a" }, (rows) => {
      good.push(rows.map((row: any) => row.name));
    });
    good.length = 0;
    throwOnInvalidation = true;

    try {
      await vex.mutate("rx.add", {
        scope: "a",
        kind: "one",
        name: "a",
        body: null,
      });
      expect(good).toEqual([["a"]]);
      expect(vex.activeSubscriptionCount()).toBe(2);
      expect(consoleError).toHaveBeenCalledWith(
        "[vex] subscription rx.list callback failed:",
        expect.any(Error),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  test("unsubscribe during an invalidation callback is safe and does not skip siblings", async () => {
    const vex = await create({
      plugins: [reactivityPlugin],
      storage: sqliteAdapter(":memory:"),
    });
    const first: string[][] = [];
    const second: string[][] = [];
    let unsubscribeFirst: () => void = () => {};
    unsubscribeFirst = await vex.subscribe(
      "rx.list",
      { scope: "a" },
      (rows) => {
        first.push(rows.map((row: any) => row.name));
        if (first.length > 1) unsubscribeFirst();
      },
    );
    await vex.subscribe("rx.list", { scope: "a" }, (rows) => {
      second.push(rows.map((row: any) => row.name));
    });

    await vex.mutate("rx.add", {
      scope: "a",
      kind: "one",
      name: "a",
      body: null,
    });
    await vex.mutate("rx.add", {
      scope: "a",
      kind: "one",
      name: "b",
      body: null,
    });

    expect(first).toEqual([[], ["a"]]);
    expect(second).toEqual([[], ["a"], ["a", "b"]]);
    expect(vex.activeSubscriptionCount()).toBe(1);
  });

  test("initial callback exceptions reject subscribe and do not leak subscriptions", async () => {
    const vex = await create({
      plugins: [reactivityPlugin],
      storage: sqliteAdapter(":memory:"),
    });
    await expect(
      vex.subscribe("rx.list", { scope: "a" }, () => {
        throw new Error("initial callback failed");
      }),
    ).rejects.toThrow("initial callback failed");
    expect(vex.activeSubscriptionCount()).toBe(0);
  });

  test("middleware/user context survives grouped initial subscribe and invalidation reruns", async () => {
    const seen: string[] = [];
    const vex = await create({
      plugins: [
        reactivityPlugin,
        (api: VexPluginAPI) => {
          api.setName("mw");
          api.use((ctx, info, next) => {
            seen.push(`${info.type}:${info.name}:${ctx.user?.id ?? "none"}`);
            return next();
          });
        },
      ],
      storage: sqliteAdapter(":memory:"),
    });
    const first: any[] = [];
    const second: any[] = [];
    await vex.subscribe("rx.viewer", {}, (data) => first.push(data), { user });
    await vex.subscribe("rx.viewer", {}, (data) => second.push(data), { user });
    expect(vex.describeSubscriptions()).toMatchObject({ total: 2, unique: 1 });

    await vex.mutate("rx.add", {
      scope: "a",
      kind: "one",
      name: "a",
      body: null,
    });

    expect(first).toEqual([
      { userId: "u1", rows: 0 },
      { userId: "u1", rows: 1 },
    ]);
    expect(second).toEqual([
      { userId: "u1", rows: 0 },
      { userId: "u1", rows: 1 },
    ]);
    expect(seen).toEqual([
      "query:rx.viewer:u1",
      "query:rx.viewer:u1",
      "mutation:rx.add:none",
      "query:rx.viewer:u1",
    ]);
  });

  test("grouped invalidation never crosses subscriber user contexts", async () => {
    const vex = await create({
      plugins: [reactivityPlugin],
      storage: sqliteAdapter(":memory:"),
    });
    const first: any[] = [];
    const second: any[] = [];
    await vex.subscribe("rx.viewer", {}, (data) => first.push(data), { user });
    await vex.subscribe("rx.viewer", {}, (data) => second.push(data), {
      user: { id: "u2", name: "Other", isAdmin: true },
    });

    await vex.mutate("rx.add", {
      scope: "a",
      kind: "one",
      name: "a",
      body: null,
    });

    expect(first.map((value) => value.userId)).toEqual(["u1", "u1"]);
    expect(second.map((value) => value.userId)).toEqual(["u2", "u2"]);
    expect(vex.describeSubscriptions()).toMatchObject({ total: 2, unique: 2 });
  });

  test("initial subscribe budget failures include telemetry and do not register", async () => {
    const spans: any[] = [];
    const vex = await create({
      plugins: [reactivityPlugin],
      storage: sqliteAdapter(":memory:"),
      tracer: { onSpan: (span) => spans.push(span) },
      reactive: { maxRows: 1, maxBytes: 10_000 },
    });
    await vex.mutate("rx.add", {
      scope: "a",
      kind: "one",
      name: "a",
      body: null,
    });
    await vex.mutate("rx.add", {
      scope: "a",
      kind: "one",
      name: "b",
      body: null,
    });

    await expect(
      vex.subscribe("rx.list", { scope: "a" }, () => {}),
    ).rejects.toThrow(/maxRows/);
    expect(vex.activeSubscriptionCount()).toBe(0);
    const meta = JSON.parse(
      spans.find((span) => span.type === "subscribe")!.meta,
    );
    expect(meta).toMatchObject({
      reactive: true,
      budgetExceeded: true,
      resultRows: 2,
      budget: { maxRows: 1, maxBytes: 10_000 },
    });
  });

  test("initial byte-only budget failures reject subscribe without blocking explicit query", async () => {
    const spans: any[] = [];
    const vex = await create({
      plugins: [reactivityPlugin],
      storage: sqliteAdapter(":memory:"),
      tracer: { onSpan: (span) => spans.push(span) },
      reactive: { maxRows: 100, maxBytes: 400 },
    });
    await vex.mutate("rx.add", {
      scope: "a",
      kind: "one",
      name: "a",
      body: { text: "x".repeat(1000) },
    });

    expect(await vex.query("rx.list", { scope: "a" })).toHaveLength(1);
    await expect(
      vex.subscribe("rx.list", { scope: "a" }, () => {}),
    ).rejects.toThrow(/resultBytes/);
    expect(vex.activeSubscriptionCount()).toBe(0);
    const meta = JSON.parse(
      spans.find((span) => span.type === "subscribe")!.meta,
    );
    expect(meta.budgetExceeded).toBe(true);
    expect(meta.resultRows).toBe(1);
    expect(meta.resultBytes).toBeGreaterThan(400);
  });

  test("explicit query may be large, but subscribe enforces default row and byte budgets", async () => {
    const vex = await create({
      plugins: [reactivityPlugin],
      storage: sqliteAdapter(":memory:"),
      reactive: { maxRows: 2, maxBytes: 400 },
    });
    await vex.mutate("rx.add", {
      scope: "a",
      kind: "one",
      name: "a",
      body: { text: "x".repeat(1000) },
    });
    await vex.mutate("rx.add", {
      scope: "a",
      kind: "one",
      name: "b",
      body: { text: "small" },
    });
    await vex.mutate("rx.add", {
      scope: "a",
      kind: "one",
      name: "c",
      body: { text: "small" },
    });

    expect(await vex.query("rx.list", { scope: "a" })).toHaveLength(3);
    await expect(
      vex.subscribe("rx.list", { scope: "a" }, () => {}),
    ).rejects.toThrow(/Reactive query budget exceeded/);
    expect(vex.activeSubscriptionCount()).toBe(0);
  });

  test("byte budget violations during invalidation disable subscriptions without a callback", async () => {
    const vex = await create({
      plugins: [reactivityPlugin],
      storage: sqliteAdapter(":memory:"),
      reactive: { maxRows: 100, maxBytes: 500 },
    });
    await vex.mutate("rx.add", {
      scope: "a",
      kind: "one",
      name: "a",
      body: { text: "small" },
    });
    const calls: any[] = [];
    await vex.subscribe("rx.list", { scope: "a" }, (rows) => calls.push(rows));

    await vex.mutate("rx.add", {
      scope: "a",
      kind: "one",
      name: "b",
      body: { text: "x".repeat(1000) },
    });

    expect(calls).toHaveLength(1);
    expect(vex.activeSubscriptionCount()).toBe(0);
  });

  test("query-level reactive budgets override defaults for arrays and nested rows results", async () => {
    const vex = await create({
      plugins: [reactivityPlugin],
      storage: sqliteAdapter(":memory:"),
      reactive: { maxRows: 100, maxBytes: 100_000 },
    });
    await vex.mutate("rx.add", {
      scope: "a",
      kind: "one",
      name: "a",
      body: null,
    });
    await vex.mutate("rx.add", {
      scope: "a",
      kind: "one",
      name: "b",
      body: null,
    });
    await expect(
      vex.subscribe("rx.limited", {}, () => {}),
    ).resolves.toBeFunction();
    await vex.mutate("rx.add", {
      scope: "a",
      kind: "one",
      name: "c",
      body: null,
    });
    expect(vex.activeSubscriptionCount()).toBe(0);
    await expect(vex.subscribe("rx.wrapped", {}, () => {})).rejects.toThrow(
      /maxRows/,
    );
  });

  test("reactive false queries can be called explicitly but cannot be subscribed", async () => {
    const vex = await create({
      plugins: [reactivityPlugin],
      storage: sqliteAdapter(":memory:"),
    });
    expect(await vex.query("rx.disabled")).toEqual([]);
    await expect(vex.subscribe("rx.disabled", {}, () => {})).rejects.toThrow(
      /not reactive/,
    );
  });

  test("grouped invalidation reuses one serialized result for every callback", async () => {
    const vex = await create({
      plugins: [reactivityPlugin],
      storage: sqliteAdapter(":memory:"),
    });
    const frames: string[] = [];
    const deliver = withSerializedSubscriptionResult(
      (result: unknown, serialized?: string) => {
        frames.push(serialized ?? JSON.stringify(result));
      },
    );
    await vex.subscribe("rx.serializable", {}, deliver);
    await vex.subscribe("rx.serializable", {}, deliver);
    let ordinaryCallbackArgs = 0;
    await vex.subscribe("rx.serializable", {}, (...args) => {
      ordinaryCallbackArgs = args.length;
    });
    frames.length = 0;
    serializationCalls = 0;
    ordinaryCallbackArgs = 0;

    await vex.mutate("rx.add", {
      scope: "a",
      kind: "one",
      name: "added",
      body: null,
    });

    expect(serializationCalls).toBe(1);
    expect(ordinaryCallbackArgs).toBe(1);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toBe(frames[1]);
    expect(JSON.parse(frames[0])).toEqual({
      rows: [expect.objectContaining({ name: "added" })],
    });
  });

  test("non-array results are byte-budgeted and cyclic results fail deterministically", async () => {
    const vex = await create({
      plugins: [reactivityPlugin],
      storage: sqliteAdapter(":memory:"),
      reactive: { maxRows: 100, maxBytes: 100 },
    });
    await expect(
      vex.subscribe("rx.viewer", {}, () => {}, { user }),
    ).resolves.toBeFunction();
    await expect(vex.subscribe("rx.cyclic", {}, () => {})).rejects.toThrow();
  });

  test("trace metadata records reactive rows, bytes, budget, and budgetExceeded", async () => {
    const spans: any[] = [];
    const vex = await create({
      plugins: [reactivityPlugin],
      storage: sqliteAdapter(":memory:"),
      tracer: { onSpan: (span) => spans.push(span) },
      reactive: { maxRows: 1, maxBytes: 10_000 },
    });
    await vex.mutate("rx.add", {
      scope: "a",
      kind: "one",
      name: "a",
      body: null,
    });
    await expect(
      vex.subscribe("rx.list", { scope: "a" }, () => {}),
    ).resolves.toBeFunction();
    await vex.mutate("rx.add", {
      scope: "a",
      kind: "one",
      name: "b",
      body: null,
    });

    const subscribeMeta = JSON.parse(
      spans.find((s) => s.type === "subscribe")!.meta,
    );
    expect(subscribeMeta.reactive).toBe(true);
    expect(subscribeMeta.resultRows).toBe(1);
    expect(subscribeMeta.resultBytes).toBeGreaterThan(0);
    expect(subscribeMeta.budget).toEqual({ maxRows: 1, maxBytes: 10_000 });

    const invalidationMeta = spans
      .filter((s) => s.type === "invalidation")
      .map((s) => JSON.parse(s.meta))
      .find((meta) => meta.budgetExceeded);
    expect(invalidationMeta.budgetExceeded).toBe(true);
    expect(invalidationMeta.disabledSubscriptions).toBe(1);
  });
});
