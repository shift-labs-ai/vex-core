/**
 * Value-precise invalidation beyond `=` (SHFT-2537).
 *
 * A write records the column values every row it touched holds before
 * and after it (WriteDependency.values), and an update also what it
 * changed. A subscription whose read of that table cannot have seen
 * the write is not re-run:
 *
 *   - its filters (any operator, OR groups included, compared as the
 *     column's SQL affinity would) reject the values the write's rows
 *     hold, or both what a changed column held and what it holds now;
 *   - or the write is an update that touched no column the read
 *     filters on, orders by or computes from, or changed nothing.
 *
 * Before this ticket only `=` filters were consulted, by `===`. The
 * production shape — every governed read's policy reading `sessions`
 * narrowed by `_id IN (the caller's conversations)` — carried an `IN`
 * filter, which was treated as "may be affected": one `update` of any
 * session re-ran every live view of every connected person.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import type { TableAccessPolicy } from "../src/core/access.js";
import type { VexPluginAPI } from "../src/core/api.js";
import { Vex } from "../src/core/engine.js";
import type { Span } from "../src/core/tracer.js";
import type { VexUser } from "../src/core/types.js";

let open: Vex[] = [];
const runs = new Map<string, number>();
const ran = (name: string) => runs.get(name) ?? 0;

async function create(options: Partial<Parameters<typeof Vex.create>[0]> = {}) {
  const vex = await Vex.create({
    plugins: [plugin],
    storage: sqliteAdapter(":memory:"),
    ...options,
  });
  open.push(vex);
  return vex;
}

afterEach(async () => {
  await Promise.all(open.map((v) => v.close()));
  open = [];
  runs.clear();
});

const alice: VexUser = { id: "alice", name: "Alice", isAdmin: false };

/**
 * The production policy shape: a caller sees the sessions of the
 * conversations granted to them, said as a narrowing on `_id`.
 */
const bySessionGrant: TableAccessPolicy<{ ids: string[] }> = {
  async prepare(user, db) {
    const grants = (await db
      .table("grants")
      .where("userId", "=", user?.id ?? "")
      .all()) as Array<{ sessionId: string }>;
    return { ids: grants.map((g) => g.sessionId) };
  },
  row: (p, row) => p.ids.includes(row._id),
  narrow: (p) => ({
    where: [[{ column: "_id", operator: "IN", value: p.ids }]],
    reads: ["_id"],
  }),
};

function plugin(api: VexPluginAPI) {
  api.setName("s");
  api.registerTable("sessions", {
    columns: {
      title: { type: "string" },
      platform: { type: "string", index: true },
      n: { type: "number", optional: true },
    },
  });
  api.registerTable("grants", {
    columns: {
      userId: { type: "string", index: true },
      sessionId: { type: "string", index: true },
    },
  });
  api.registerTable("governed", {
    columns: { title: { type: "string" } },
    access: bySessionGrant,
  });

  const counted = (
    name: string,
    fn: (ctx: any, args: any) => Promise<unknown>,
  ) => {
    api.registerQuery(name, {
      args: { arg: "json" },
      async handler(ctx, args) {
        runs.set(name, ran(name) + 1);
        return fn(ctx, args.arg);
      },
    });
  };
  // The shape the issue measured: a read of `sessions` held to a list
  // of ids the caller may see.
  counted("mine", (ctx, ids) =>
    ctx.db
      .table("sessions")
      .where("_id", "IN", ids)
      .order("title", "asc")
      .all(),
  );
  counted("notHeadless", (ctx) =>
    ctx.db
      .table("sessions")
      .where("platform", "!=", "headless")
      .order("title", "asc")
      .all(),
  );
  counted("small", (ctx) =>
    ctx.db.table("sessions").where("n", "<", 10).order("title", "asc").all(),
  );
  counted("anyOf", (ctx, [a, b]) =>
    ctx.db
      .table("sessions")
      .whereAny([
        [{ column: "platform", operator: "=", value: a }],
        [{ column: "platform", operator: "=", value: b }],
      ])
      .order("title", "asc")
      .all(),
  );
  counted("countWeb", (ctx) =>
    ctx.db.table("sessions").where("platform", "=", "web").count(),
  );
  counted("titlesWeb", (ctx) =>
    ctx.db
      .table("sessions")
      .select("title")
      .where("platform", "=", "web")
      .order("title", "asc")
      .all(),
  );
  counted("sumN", (ctx) => ctx.db.table("sessions").sum("n"));
  counted("all", (ctx) => ctx.db.table("sessions").order("title", "asc").all());
  counted("governed", (ctx) =>
    ctx.db.table("governed").order("title", "asc").all(),
  );

  api.registerMutation("open", {
    args: { title: "string", platform: "string", n: "any" },
    async handler(ctx, args) {
      return ctx.db.table("sessions").insert(args);
    },
  });
  api.registerMutation("openGoverned", {
    args: { title: "string" },
    async handler(ctx, args) {
      return ctx.db.table("governed").insert(args);
    },
  });
  api.registerMutation("grant", {
    args: { userId: "string", sessionId: "string" },
    async handler(ctx, args) {
      await ctx.db.table("grants").insert(args);
    },
  });
  // `conversations.touch`: one row's columns, by update.
  api.registerMutation("touch", {
    args: { table: "string", id: "string", data: "json" },
    async handler(ctx, args) {
      await ctx.db
        .table(args.table)
        .update(args.id, args.data as Record<string, unknown>);
    },
  });
  api.registerMutation("close", {
    args: { id: "string" },
    async handler(ctx, args) {
      await ctx.db.table("sessions").delete(args.id);
    },
  });
  api.registerMutation("closePlatform", {
    args: { platform: "string" },
    async handler(ctx, args) {
      await ctx.db
        .table("sessions")
        .where("platform", "=", args.platform)
        .delete();
    },
  });
  // A limit on the chain bounds a read of it, not the delete.
  api.registerMutation("closePlatformLimited", {
    args: { platform: "string" },
    async handler(ctx, args) {
      await ctx.db
        .table("sessions")
        .where("platform", "=", args.platform)
        .limit(1)
        .delete();
    },
  });
  api.registerWebhook("ingest", {
    path: "/s/ingest",
    async handler(ctx, req) {
      await ctx.db
        .table("sessions")
        .update(req.body.id, { title: req.body.title });
      return { ok: true };
    },
  });
  api.registerMutation("upsertTitle", {
    args: { title: "string", platform: "string" },
    async handler(ctx, args) {
      await ctx.db
        .table("sessions")
        .upsert({ title: args.title }, { platform: args.platform });
    },
  });
}

async function watch(
  vex: Vex,
  name: string,
  arg: unknown = null,
  user?: VexUser,
) {
  const seen: unknown[] = [];
  await vex.subscribe(
    `s.${name}`,
    { arg },
    (r: unknown) => seen.push(r),
    user ? { user } : undefined,
  );
  return seen;
}

describe("invalidation narrowing (SHFT-2537)", () => {
  test("an update of a row outside an IN list does not re-run the view", async () => {
    const vex = await create();
    const mine = await vex.mutate("s.open", {
      title: "mine",
      platform: "web",
      n: 1,
    });
    const other = await vex.mutate("s.open", {
      title: "other",
      platform: "web",
      n: 1,
    });
    const seen = await watch(vex, "mine", [mine]);
    expect(seen).toEqual([[expect.objectContaining({ title: "mine" })]]);
    const after = ran("mine");

    // Someone else's conversation is touched: this view cannot have
    // seen it. Under 0.21.0 it re-ran anyway.
    await vex.mutate("s.touch", {
      table: "sessions",
      id: other,
      data: { title: "other'" },
    });
    expect(ran("mine")).toBe(after);

    // The caller's own conversation is touched: it must re-run.
    await vex.mutate("s.touch", {
      table: "sessions",
      id: mine,
      data: { title: "mine'" },
    });
    expect(ran("mine")).toBe(after + 1);
    expect(seen).toHaveLength(2);
  });

  test("a webhook's writes narrow like a mutation's", async () => {
    const vex = await create();
    const mine = await vex.mutate("s.open", {
      title: "mine",
      platform: "web",
      n: 1,
    });
    const other = await vex.mutate("s.open", {
      title: "other",
      platform: "web",
      n: 1,
    });
    await watch(vex, "mine", [mine]);
    const after = ran("mine");
    const hook = (id: string) =>
      vex.handleWebhook({
        path: "/s/ingest",
        method: "POST",
        headers: {},
        body: { id, title: "t" },
      });
    await hook(other);
    expect(ran("mine")).toBe(after);
    await hook(mine);
    expect(ran("mine")).toBe(after + 1);
  });

  test("an insert carries its id: a view held to other ids is not re-run", async () => {
    const vex = await create();
    const mine = await vex.mutate("s.open", {
      title: "mine",
      platform: "web",
      n: 1,
    });
    await watch(vex, "mine", [mine]);
    const after = ran("mine");
    await vex.mutate("s.open", { title: "new", platform: "web", n: 1 });
    expect(ran("mine")).toBe(after);
    await vex.unsafeBulkInsert("sessions", [
      { title: "bulk", platform: "web", n: 1 },
    ]);
    expect(ran("mine")).toBe(after);
  });

  test("a governed read narrowed by its policy (whereAny) is skipped like an explicit filter", async () => {
    const vex = await create();
    const mine = await vex.mutate("s.openGoverned", { title: "mine" });
    const other = await vex.mutate("s.openGoverned", { title: "other" });
    await vex.mutate("s.grant", { userId: "alice", sessionId: mine });
    const seen = await watch(vex, "governed", null, alice);
    expect(seen).toEqual([[expect.objectContaining({ title: "mine" })]]);
    const after = ran("governed");

    await vex.mutate("s.touch", {
      table: "governed",
      id: other,
      data: { title: "other'" },
    });
    expect(ran("governed")).toBe(after);
    await vex.mutate("s.openGoverned", { title: "another" });
    expect(ran("governed")).toBe(after);

    await vex.mutate("s.touch", {
      table: "governed",
      id: mine,
      data: { title: "mine'" },
    });
    expect(ran("governed")).toBe(after + 1);
    expect(seen.at(-1)).toEqual([expect.objectContaining({ title: "mine'" })]);
  });

  test("!= and ordering filters narrow too", async () => {
    const vex = await create();
    const web = await vex.mutate("s.open", {
      title: "web",
      platform: "web",
      n: 1,
    });
    const headless = await vex.mutate("s.open", {
      title: "hl",
      platform: "headless",
      n: 50,
    });
    await watch(vex, "notHeadless");
    await watch(vex, "small");
    const notHeadless = ran("notHeadless");
    const small = ran("small");

    // A headless session's title: `platform != headless` never saw it;
    // n stays 50: `n < 10` never saw it either.
    await vex.mutate("s.touch", {
      table: "sessions",
      id: headless,
      data: { title: "hl'" },
    });
    expect(ran("notHeadless")).toBe(notHeadless);
    expect(ran("small")).toBe(small);

    // n moves 50 -> 40: rejected before and after, still not seen.
    await vex.mutate("s.touch", {
      table: "sessions",
      id: headless,
      data: { n: 40 },
    });
    expect(ran("small")).toBe(small);
    // n moves 40 -> 5: enters the set.
    await vex.mutate("s.touch", {
      table: "sessions",
      id: headless,
      data: { n: 5 },
    });
    expect(ran("small")).toBe(small + 1);

    await vex.mutate("s.touch", {
      table: "sessions",
      id: web,
      data: { title: "web'" },
    });
    expect(ran("notHeadless")).toBe(notHeadless + 1);
  });

  test("an OR of groups is skipped only when every group rejects the write", async () => {
    const vex = await create();
    await vex.mutate("s.open", { title: "a", platform: "web", n: 1 });
    await watch(vex, "anyOf", ["web", "ios"]);
    const after = ran("anyOf");
    await vex.mutate("s.open", { title: "b", platform: "android", n: 1 });
    expect(ran("anyOf")).toBe(after);
    await vex.mutate("s.open", { title: "c", platform: "ios", n: 1 });
    expect(ran("anyOf")).toBe(after + 1);
  });

  test("an update of a column the view does not read is skipped; a no-op update is skipped everywhere", async () => {
    const vex = await create();
    const id = await vex.mutate("s.open", {
      title: "a",
      platform: "web",
      n: 1,
    });
    await watch(vex, "countWeb");
    await watch(vex, "titlesWeb");
    await watch(vex, "sumN");
    await watch(vex, "all");
    const before = Object.fromEntries(
      ["countWeb", "titlesWeb", "sumN", "all"].map((n) => [n, ran(n)]),
    );

    // n changes: the count and the titles do not read it.
    await vex.mutate("s.touch", { table: "sessions", id, data: { n: 2 } });
    expect(ran("countWeb")).toBe(before.countWeb);
    expect(ran("titlesWeb")).toBe(before.titlesWeb);
    expect(ran("sumN")).toBe(before.sumN + 1);
    expect(ran("all")).toBe(before.all + 1);

    // The same values again: nothing changed, nothing re-runs.
    await vex.mutate("s.touch", {
      table: "sessions",
      id,
      data: { n: 2, title: "a" },
    });
    expect(ran("countWeb")).toBe(before.countWeb);
    expect(ran("titlesWeb")).toBe(before.titlesWeb);
    expect(ran("sumN")).toBe(before.sumN + 1);
    expect(ran("all")).toBe(before.all + 1);

    // The title changes: the titles view reads it.
    await vex.mutate("s.touch", {
      table: "sessions",
      id,
      data: { title: "b" },
    });
    expect(ran("titlesWeb")).toBe(before.titlesWeb + 1);
    expect(ran("countWeb")).toBe(before.countWeb);
  });

  test("deletes record the rows they remove", async () => {
    const vex = await create();
    const web = await vex.mutate("s.open", {
      title: "a",
      platform: "web",
      n: 1,
    });
    await vex.mutate("s.open", { title: "b", platform: "ios", n: 1 });
    await vex.mutate("s.open", { title: "c", platform: "ios", n: 1 });
    await watch(vex, "countWeb");
    const after = ran("countWeb");

    await vex.mutate("s.closePlatform", { platform: "ios" });
    expect(ran("countWeb")).toBe(after);
    expect(await vex.query("s.all", { arg: null })).toHaveLength(1);

    await vex.mutate("s.close", { id: web });
    expect(ran("countWeb")).toBe(after + 1);
  });

  test("a filtered delete past the recording bound still deletes every matching row", async () => {
    const vex = await create();
    await vex.unsafeBulkInsert(
      "sessions",
      Array.from({ length: 250 }, (_, i) => ({
        title: `t${i}`,
        platform: "ios",
        n: 1,
      })),
    );
    await vex.mutate("s.open", { title: "web", platform: "web", n: 1 });
    await watch(vex, "countWeb");
    const after = ran("countWeb");
    await vex.mutate("s.closePlatform", { platform: "ios" });
    // Recorded by its `=` filter alone: still not seen by `platform = web`.
    expect(ran("countWeb")).toBe(after);
    expect(await vex.query("s.all", { arg: null })).toHaveLength(1);
  });

  test("a filtered delete under a limit still invalidates views of every row it removes", async () => {
    const vex = await create();
    await vex.mutate("s.open", { title: "a", platform: "ios", n: 1 });
    const second = await vex.mutate("s.open", {
      title: "b",
      platform: "ios",
      n: 1,
    });
    await watch(vex, "mine", [second]);
    const after = ran("mine");
    await vex.mutate("s.closePlatformLimited", { platform: "ios" });
    expect(await vex.query("s.all", { arg: null })).toHaveLength(0);
    expect(ran("mine")).toBe(after + 1);
  });

  test("an upsert is recorded as the update or the insert it performs", async () => {
    const vex = await create();
    const mine = await vex.mutate("s.open", {
      title: "mine",
      platform: "web",
      n: 1,
    });
    await watch(vex, "mine", [mine]);
    await watch(vex, "countWeb");
    const mineRuns = ran("mine");
    const countRuns = ran("countWeb");

    // New row, ios: not among the ids, not web.
    await vex.mutate("s.upsertTitle", { title: "fresh", platform: "ios" });
    expect(ran("mine")).toBe(mineRuns);
    expect(ran("countWeb")).toBe(countRuns);
    // Existing row moves ios -> android: still neither.
    await vex.mutate("s.upsertTitle", { title: "fresh", platform: "android" });
    expect(ran("mine")).toBe(mineRuns);
    expect(ran("countWeb")).toBe(countRuns);
    // Existing row moves to web: the count sees it.
    await vex.mutate("s.upsertTitle", { title: "fresh", platform: "web" });
    expect(ran("countWeb")).toBe(countRuns + 1);
    expect(ran("mine")).toBe(mineRuns);
  });

  test("SQL affinity, not ===, decides a miss: NULL spellings and numeric text", async () => {
    const vex = await create();
    await watch(vex, "small"); // n < 10
    const small = ran("small");
    // `n: undefined` is NULL: `n < 10` never matches NULL, skipped.
    await vex.mutate("s.open", { title: "x", platform: "web", n: undefined });
    expect(ran("small")).toBe(small);
    // `"5"` in a REAL column is 5: it matches, re-run.
    await vex.mutate("s.open", { title: "y", platform: "web", n: "5" });
    expect(ran("small")).toBe(small + 1);
  });

  test("held and changed values never reach trace metadata", async () => {
    const spans: Span[] = [];
    const vex = await create({
      tracer: { onSpan: (span) => spans.push(span) },
    });
    const secret = "s3cret-title-9f8e7d";
    const id = await vex.mutate("s.open", {
      title: secret,
      platform: "web",
      n: 1,
    });
    await vex.mutate("s.touch", {
      table: "sessions",
      id,
      data: { title: `${secret}-2` },
    });
    await vex.mutate("s.close", { id });
    const all = spans.map((span) => span.meta ?? "").join("\n");
    expect(all).not.toContain(secret);
    const touch = spans.find(
      (s) => s.type === "mutation" && s.name === "s.touch",
    );
    expect(JSON.parse(touch!.meta!).writes).toEqual([
      { table: "sessions", columns: ["title"], changed: ["title"] },
    ]);
  });
});
