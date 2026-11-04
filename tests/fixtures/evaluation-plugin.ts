/**
 * The plugin the evaluation tests read through. The tests pass it by
 * module, so each evaluation worker imports this same plugin.
 */

import type { TableAccessPolicy } from "../../src/core/access.js";
import { UNRESTRICTED } from "../../src/core/access.js";
import type { VexPluginAPI } from "../../src/core/api.js";
import { HttpError } from "../../src/http/error.js";
import { Type } from "../../src/portable.js";

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

export default function evaluationPlugin(api: VexPluginAPI) {
  api.setName("ev");
  api.registerTable("items", {
    columns: {
      scope: Type.String({ index: true }),
      name: Type.String(),
      when: Type.Optional(Type.Number()),
    },
    access: itemsAccess,
  });
  api.registerTable("grants", {
    columns: {
      userId: Type.String({ index: true }),
      itemId: Type.String({ index: true }),
    },
  });
  api.registerQuery("list", {
    args: { scope: Type.String() },
    handler: (ctx, args) =>
      ctx.db
        .table("items")
        .where("scope", "=", args.scope)
        .order("name", "asc")
        .all(),
  });
  api.registerQuery("names", {
    args: { scope: Type.String() },
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
  // The time to the second: re-run by the clock.
  api.registerQuery("second", {
    args: {},
    handler: (ctx) => ({ at: ctx.now(1000) }),
  });
  // An answer that is not its own JSON reading: an undefined field.
  api.registerQuery("sparse", {
    args: { scope: Type.String() },
    handler: async (ctx, args) => ({
      n: await ctx.db.table("items").where("scope", "=", args.scope).count(),
      missing: undefined,
    }),
  });
  // The app's settings, as the thread that runs it reads them.
  api.registerQuery("env", {
    args: {},
    handler: (ctx) => ctx.env,
  });
  // A read that costs `ms` of CPU: what the pool takes.
  api.registerQuery("slow", {
    args: { ms: Type.Number() },
    handler: async (ctx, args) => {
      const until = performance.now() + args.ms;
      while (performance.now() < until) {}
      return ctx.db.table("items").count();
    },
  });
  // A refusal with an HTTP meaning, as a gate throws one.
  api.registerQuery("forbidden", {
    args: {},
    handler: () => {
      throw new HttpError(403, "not yours", { body: { code: "NOT_YOURS" } });
    },
  });
  // A refusal whose body carries what no thread boundary copies.
  api.registerQuery("forbiddenOddly", {
    args: {},
    handler: () => {
      throw new HttpError(403, "not yours", {
        body: { code: "NOT_YOURS", explain: () => "why" },
      });
    },
  });
  api.registerMutation("add", {
    args: { scope: Type.String(), name: Type.String() },
    handler: (ctx, args) => ctx.db.table("items").insert(args),
  });
  api.registerMutation("grant", {
    args: { userId: Type.String(), itemId: Type.String() },
    handler: async (ctx, args) => {
      await ctx.db.table("grants").insert(args);
    },
  });
  api.registerMutation("rename", {
    args: { id: Type.String(), name: Type.String() },
    handler: (ctx, args) =>
      ctx.db.table("items").update(args.id, { name: args.name }),
  });
}
