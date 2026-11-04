/**
 * The plugin the equivalence fuzz drives: one query that reads by a
 * spec (any filter, any OR group, any selection, order, window and
 * terminal; as a builder read, a raw read, or a raw read held to rows
 * and columns; of a plain table or a governed one), and a mutation
 * for every way a row can be written. Shared with evaluation workers
 * (`equivalence-setup.ts`).
 */

import type { TableAccessPolicy } from "../../src/core/access.js";
import { UNRESTRICTED } from "../../src/core/access.js";
import type { VexPluginAPI } from "../../src/core/api.js";
import { quoteIdent } from "../../src/core/sql-where.js";
import type { Filter } from "../../src/core/types.js";
import { Type } from "../../src/portable.js";

export type Terminal =
  | "all"
  | "first"
  | "count"
  | "sum"
  | "avg"
  | "min"
  | "max"
  | "distinct"
  | "countDistinct"
  | "groupBy";

export interface Spec {
  table: "t" | "g";
  filters: Filter[];
  any?: Filter[][];
  select?: string[];
  order?: { column: string; dir: "asc" | "desc" };
  limit?: number;
  offset?: number;
  terminal: Terminal;
  /** A raw statement instead of the builder: whole-table, held to the
   *  filters, or held to the filters and the selection. */
  raw?: "sql" | "over" | "overReads";
}

export const COLUMNS = ["s", "n", "b", "j", "k", "version"] as const;

const governed: TableAccessPolicy<{ ids: string[] }> = {
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

let version = 0;
const next = () => ++version;

function versionOf(rows: unknown): number | null {
  if (Array.isArray(rows)) {
    const versions = rows
      .map((row) =>
        row && typeof row === "object" ? (row as any).version : undefined,
      )
      .filter((v): v is number => typeof v === "number");
    return versions.length === rows.length && rows.length > 0
      ? Math.max(...versions)
      : null;
  }
  if (
    rows &&
    typeof rows === "object" &&
    typeof (rows as any).version === "number"
  ) {
    return (rows as any).version;
  }
  return null;
}

export function equivalencePlugin(api: VexPluginAPI) {
  api.setName("eq");
  const columns = {
    s: { type: "string" as const, optional: true, index: true },
    n: { type: "number" as const, optional: true },
    b: { type: "boolean" as const, optional: true },
    j: { type: "json" as const, optional: true },
    k: { type: "string" as const, index: true },
    version: { type: "number" as const },
  };
  api.registerTable("t", { columns });
  api.registerTable("g", { columns, access: governed });
  api.registerTable("grants", {
    columns: {
      userId: { type: "string", index: true },
      itemId: { type: "string", index: true },
    },
  });

  api.registerQuery("read", {
    args: { spec: Type.Unknown() },
    async handler(ctx, args) {
      const spec = args.spec as Spec;
      let data: unknown;
      if (spec.raw) {
        const cols = spec.select
          ? [...new Set(["_id", ...spec.select])]
          : ["*"];
        const sql = `SELECT ${cols.map((c) => (c === "*" ? c : quoteIdent(c))).join(", ")} FROM ${quoteIdent(spec.table)} ORDER BY _id`;
        data =
          spec.raw === "sql"
            ? await ctx.db.sql({ [spec.table]: "all" }, sql)
            : await ctx.db.sql(
                {
                  [spec.table]:
                    spec.raw === "over" || !spec.select
                      ? spec.filters
                      : { where: spec.filters, reads: spec.select },
                },
                sql,
              );
      } else {
        let q = ctx.db.table(spec.table);
        for (const filter of spec.filters)
          q = q.where(filter.column, filter.operator, filter.value);
        if (spec.any) q = q.whereAny(spec.any);
        if (spec.select && spec.terminal !== "groupBy")
          q = q.select(...spec.select);
        if (spec.order) q = q.order(spec.order.column, spec.order.dir);
        if (spec.limit !== undefined) q = q.limit(spec.limit);
        if (spec.offset !== undefined) q = q.offset(spec.offset);
        switch (spec.terminal) {
          case "all":
            data = await q.all();
            break;
          case "first":
            data = await q.first();
            break;
          case "count":
            data = await q.count();
            break;
          case "sum":
            data = await q.sum("n");
            break;
          case "avg":
            data = await q.avg("n");
            break;
          case "min":
            data = await q.min("n");
            break;
          case "max":
            data = await q.max("n");
            break;
          case "distinct":
            data = await q.distinct("k");
            break;
          case "countDistinct":
            data = await q.countDistinct("k");
            break;
          case "groupBy":
            data = await q
              .groupBy("k", { c: "count", total: ["sum", "n"] })
              .order("k", "asc");
            break;
        }
      }
      return { data, version: versionOf(data) };
    },
  });

  api.registerMutation("insert", {
    args: { table: Type.String(), row: Type.Unknown() },
    handler: (ctx, args) =>
      ctx.db
        .table(args.table)
        .insert({ ...(args.row as object), version: next() }),
  });
  api.registerMutation("update", {
    args: { table: Type.String(), id: Type.String(), data: Type.Unknown() },
    handler: (ctx, args) =>
      ctx.db
        .table(args.table)
        .update(args.id, { ...(args.data as object), version: next() }),
  });
  api.registerMutation("touch", {
    args: { table: Type.String(), id: Type.String(), data: Type.Unknown() },
    handler: (ctx, args) =>
      ctx.db.table(args.table).update(args.id, args.data as object),
  });
  api.registerMutation("upsert", {
    args: { table: Type.String(), keys: Type.Unknown(), data: Type.Unknown() },
    handler: (ctx, args) =>
      ctx.db.table(args.table).upsert(args.keys as object, {
        ...(args.data as object),
        version: next(),
      }),
  });
  api.registerMutation("delete", {
    args: { table: Type.String(), id: Type.String() },
    handler: (ctx, args) => ctx.db.table(args.table).delete(args.id),
  });
  api.registerMutation("deleteWhere", {
    args: { table: Type.String(), filters: Type.Unknown() },
    handler: (ctx, args) => {
      let q = ctx.db.table(args.table);
      for (const f of args.filters as Filter[])
        q = q.where(f.column, f.operator, f.value);
      return q.delete();
    },
  });
  api.registerMutation("rawInsert", {
    args: { table: Type.String(), k: Type.String() },
    handler: (ctx, args) =>
      ctx.db.sql(
        `INSERT INTO ${quoteIdent(args.table)} (_id, k, version) VALUES (?, ?, ?)`,
        `raw${next()}`,
        args.k,
        version,
      ),
  });
  api.registerMutation("rawUpdate", {
    args: { table: Type.String(), id: Type.String(), k: Type.String() },
    handler: (ctx, args) =>
      ctx.db.sql(
        `UPDATE ${quoteIdent(args.table)} SET k = ?, version = ? WHERE _id = ?`,
        args.k,
        next(),
        args.id,
      ),
  });
  api.registerMutation("failing", {
    args: { table: Type.String() },
    async handler(ctx, args) {
      await ctx.db.table(args.table).insert({ k: "x", version: next() });
      throw new Error("rolled back");
    },
  });
  api.registerMutation("grant", {
    args: { userId: Type.String(), itemId: Type.String() },
    async handler(ctx, args) {
      await ctx.db.table("grants").insert(args);
    },
  });
  api.registerMutation("revoke", {
    args: { userId: Type.String(), itemId: Type.String() },
    handler: (ctx, args) =>
      ctx.db
        .table("grants")
        .where("userId", "=", args.userId)
        .where("itemId", "=", args.itemId)
        .delete(),
  });
}
