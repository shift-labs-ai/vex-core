/**
 * The plugin the scaling matrix drives, shared by the main engine and
 * each worker's (`scaling-setup.ts`). Every result carries `version`,
 * the highest write version it reflects, so deliveries can be judged
 * for going backwards.
 */

import type { TableAccessPolicy } from "../../src/core/access.js";
import { UNRESTRICTED } from "../../src/core/access.js";
import type { VexPluginAPI } from "../../src/core/api.js";

/**
 * Knobs a test turns through the database, so a handler honours them
 * on the main thread and in a worker alike: `slowMs`, how long `sum`
 * holds its answer after its read; `fail`, whether `sum` throws.
 */
async function knob(db: any, key: string): Promise<number> {
  const row = (await db.table("knobs").where("key", "=", key).first()) as {
    value: number;
  } | null;
  return row?.value ?? 0;
}

let version = 0;
const next = () => ++version;

const governedAccess: TableAccessPolicy<{ ids: string[] }> = {
  async prepare(user, db) {
    if (!user) return UNRESTRICTED;
    const grants = (await db
      .table("grants")
      .where("userId", "=", user.id)
      .all()) as Array<{ itemId: string }>;
    return { ids: grants.map((g) => g.itemId) };
  },
  row: (p, row) => p.ids.includes(row._id),
  narrow: (p) => ({
    where: [[{ column: "_id", operator: "IN", value: p.ids }]],
    reads: ["_id"],
  }),
};

export function scalingPlugin(api: VexPluginAPI) {
  api.setName("sc");
  api.registerTable("items", {
    columns: {
      scope: { type: "string", index: true },
      n: { type: "number" },
      version: { type: "number" },
    },
  });
  api.registerTable("governed", {
    columns: { title: { type: "string" }, version: { type: "number" } },
    access: governedAccess,
  });
  api.registerTable("grants", {
    columns: {
      userId: { type: "string", index: true },
      itemId: { type: "string", index: true },
    },
  });
  api.registerTable("knobs", {
    columns: {
      key: { type: "string", index: true },
      value: { type: "number" },
    },
    unique: [["key"]],
  });

  api.registerQuery("sum", {
    args: { scope: "string" },
    async handler(ctx, args) {
      const rows = (await ctx.db
        .table("items")
        .select("n", "version")
        .where("scope", "=", args.scope)
        .all()) as Array<{ n: number; version: number }>;
      const slowMs = await knob(ctx.db, "slowMs");
      if (slowMs > 0)
        await new Promise((resolve) => setTimeout(resolve, slowMs));
      if (await knob(ctx.db, "fail"))
        throw new Error("sum fails while told to");
      return {
        sum: rows.reduce((s, r) => s + r.n, 0),
        count: rows.length,
        version: Math.max(0, ...rows.map((r) => r.version)),
      };
    },
  });
  api.registerQuery("all", {
    args: {},
    async handler(ctx) {
      const rows = (await ctx.db
        .table("items")
        .select("scope", "n", "version")
        .order("scope", "asc")
        .all()) as Array<{ scope: string; n: number; version: number }>;
      return {
        rows: rows.map((r) => `${r.scope}:${r.n}`).sort(),
        count: rows.length,
        version: Math.max(0, ...rows.map((r) => r.version)),
      };
    },
  });
  // A raw statement over several scopes, held to their rows.
  api.registerQuery("scopes", {
    args: { scopes: "json" },
    async handler(ctx, args) {
      const scopes = args.scopes as string[];
      const rows = (await ctx.db.sqlOver(
        { items: [{ column: "scope", operator: "IN", value: scopes }] },
        `SELECT scope, SUM(n) AS sum, COUNT(*) AS count, MAX(version) AS version
           FROM items WHERE scope IN (${scopes.map(() => "?").join(", ")})
           GROUP BY scope ORDER BY scope`,
        ...scopes,
      )) as Array<{
        scope: string;
        sum: number;
        count: number;
        version: number;
      }>;
      return {
        rows,
        count: rows.reduce((c, r) => c + r.count, 0),
        version: Math.max(0, ...rows.map((r) => r.version)),
      };
    },
  });
  api.registerQuery("bounded", {
    args: {},
    reactive: { maxRows: 3, maxBytes: 10_000 },
    handler: (ctx) => ctx.db.table("items").all(),
  });
  api.registerQuery("governed", {
    args: {},
    async handler(ctx) {
      const rows = (await ctx.db
        .table("governed")
        .order("title", "asc")
        .all()) as Array<{ title: string; version: number }>;
      return {
        titles: rows.map((r) => r.title),
        count: rows.length,
        version: Math.max(0, ...rows.map((r) => r.version)),
      };
    },
  });
  api.registerQuery("whoami", {
    args: {},
    handler: (ctx) => ({ id: ctx.user?.id ?? null, version: 0 }),
  });

  api.registerMutation("add", {
    args: { scope: "string", n: "number" },
    handler: (ctx, args) =>
      ctx.db.table("items").insert({ ...args, version: next() }),
  });
  api.registerMutation("set", {
    args: { id: "string", n: "number" },
    handler: (ctx, args) =>
      ctx.db.table("items").update(args.id, { n: args.n, version: next() }),
  });
  api.registerMutation("noop", {
    args: { id: "string" },
    async handler(ctx, args) {
      const row = (await ctx.db
        .table("items")
        .where("_id", "=", args.id)
        .first()) as {
        n: number;
      };
      await ctx.db.table("items").update(args.id, { n: row.n });
    },
  });
  api.registerMutation("remove", {
    args: { id: "string" },
    handler: (ctx, args) => ctx.db.table("items").delete(args.id),
  });
  api.registerMutation("removeScope", {
    args: { scope: "string" },
    handler: (ctx, args) =>
      ctx.db.table("items").where("scope", "=", args.scope).delete(),
  });
  api.registerMutation("raw", {
    args: { scope: "string", n: "number" },
    handler: (ctx, args) =>
      ctx.db.sql(
        "INSERT INTO items (_id, scope, n, version) VALUES (?, ?, ?, ?)",
        `raw-${next()}`,
        args.scope,
        args.n,
        version,
      ),
  });
  api.registerMutation("failing", {
    args: { scope: "string" },
    async handler(ctx, args) {
      await ctx.db
        .table("items")
        .insert({ scope: args.scope, n: 999, version: next() });
      throw new Error("rolled back");
    },
  });
  api.registerMutation("addGoverned", {
    args: { title: "string" },
    handler: (ctx, args) =>
      ctx.db.table("governed").insert({ title: args.title, version: next() }),
  });
  api.registerMutation("renameGoverned", {
    args: { id: "string", title: "string" },
    handler: (ctx, args) =>
      ctx.db
        .table("governed")
        .update(args.id, { title: args.title, version: next() }),
  });
  api.registerMutation("grant", {
    args: { userId: "string", itemId: "string" },
    async handler(ctx, args) {
      await ctx.db.table("grants").insert(args);
    },
  });
  api.registerMutation("knob", {
    args: { key: "string", value: "number" },
    async handler(ctx, args) {
      await ctx.db
        .table("knobs")
        .upsert({ key: args.key }, { value: args.value });
    },
  });
  api.registerJob("tick", {
    schedule: "every 1h",
    async handler(ctx) {
      await ctx.db
        .table("items")
        .insert({ scope: "a", n: 50, version: next() });
    },
  });
  api.registerWebhook("in", {
    path: "/sc/in",
    async handler(ctx, req) {
      await ctx.db.table("items").insert({ ...req.body, version: next() });
      return { ok: true };
    },
  });
}
