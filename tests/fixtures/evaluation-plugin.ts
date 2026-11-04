/**
 * The plugin the evaluation tests subscribe through, shared by the
 * main engine and each worker's (`evaluation-setup.ts`).
 */

import type { TableAccessPolicy } from "../../src/core/access.js";
import { UNRESTRICTED } from "../../src/core/access.js";
import type { VexPluginAPI } from "../../src/core/api.js";

/** A person sees the items granted to them, said to SQL as `_id IN`. */
const itemsAccess: TableAccessPolicy<{ ids: string[] }> = {
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

export function evaluationPlugin(api: VexPluginAPI) {
  api.setName("ev");
  api.registerTable("items", {
    columns: {
      scope: { type: "string", index: true },
      name: { type: "string" },
      when: { type: "number", optional: true },
    },
    access: itemsAccess,
  });
  api.registerTable("grants", {
    columns: {
      userId: { type: "string", index: true },
      itemId: { type: "string", index: true },
    },
  });
  api.registerQuery("list", {
    args: { scope: "string" },
    handler: (ctx, args) =>
      ctx.db
        .table("items")
        .where("scope", "=", args.scope)
        .order("name", "asc")
        .all(),
  });
  api.registerQuery("names", {
    args: { scope: "string" },
    async handler(ctx, args) {
      const rows = await ctx.db
        .table("items")
        .select("name", "when")
        .where("scope", "=", args.scope)
        .order("name", "asc")
        .all();
      return rows.map((r: any) => ({ name: r.name, when: r.when }));
    },
  });
  api.registerQuery("whoami", {
    args: {},
    handler: (ctx) => ctx.user?.id ?? null,
  });
  api.registerQuery("failing", {
    args: {},
    handler: () => {
      throw new Error("handler failed");
    },
  });
  api.registerQuery("huge", {
    args: {},
    reactive: { maxRows: 2, maxBytes: 10_000 },
    handler: (ctx) => ctx.db.table("items").all(),
  });
  // Chance drawn in a query: refused, in a worker as on the main thread.
  api.registerQuery("chance", {
    args: {},
    handler: () => Math.random(),
  });
  // The time to the second: re-run by the clock.
  api.registerQuery("second", {
    args: {},
    handler: (ctx) => ({ at: ctx.now(1000) }),
  });
  // An answer that is not its own JSON reading: an undefined field.
  api.registerQuery("sparse", {
    args: { scope: "string" },
    handler: async (ctx, args) => ({
      n: await ctx.db.table("items").where("scope", "=", args.scope).count(),
      missing: undefined,
    }),
  });
  api.registerMutation("add", {
    args: { scope: "string", name: "string" },
    handler: (ctx, args) => ctx.db.table("items").insert(args),
  });
  api.registerMutation("grant", {
    args: { userId: "string", itemId: "string" },
    handler: async (ctx, args) => {
      await ctx.db.table("grants").insert(args);
    },
  });
  api.registerMutation("rename", {
    args: { id: "string", name: "string" },
    handler: (ctx, args) =>
      ctx.db.table("items").update(args.id, { name: args.name }),
  });
}
