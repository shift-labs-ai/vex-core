/**
 * The plugin `invalidation.ts` measures: a governed `sessions` table
 * and the views a dashboard keeps open on it. Passed by module, so
 * each evaluation worker imports it too.
 */

import { performance } from "node:perf_hooks";
import type { TableAccessPolicy } from "../src/core/access.js";
import { UNRESTRICTED } from "../src/core/access.js";
import type { VexPluginAPI } from "../src/core/api.js";
import { Type } from "../src/portable.js";

/**
 * CPU each query handler burns besides its reads, in ms: the policy
 * decisions, projections and serialization a real view does. The
 * measured deployment's views cost 50–90 ms each.
 */
export const HANDLER_MS = Number(process.env.BENCH_HANDLER_MS ?? 0);

function work(): void {
  if (HANDLER_MS <= 0) return;
  const until = performance.now() + HANDLER_MS;
  while (performance.now() < until) {
    /* a view's own computation */
  }
}

interface Grants {
  ids: string[];
}

/** A person sees the sessions granted to them, said to SQL as `_id IN`. */
const sessionsAccess: TableAccessPolicy<Grants> = {
  async prepare(user, db) {
    if (!user) return UNRESTRICTED;
    const grants = (await db
      .table("grants")
      .where("userId", "=", user.id)
      .all()) as Array<{ sessionId: string }>;
    return { ids: grants.map((g) => g.sessionId) };
  },
  row: (p, row) => p.ids.includes(row._id),
  narrow: (p) => ({
    where: [[{ column: "_id", operator: "IN", value: p.ids }]],
    reads: ["_id"],
  }),
};

export default function benchmarkPlugin(api: VexPluginAPI) {
  api.setName("b");
  api.registerTable("sessions", {
    columns: {
      workspaceId: Type.String({ index: true }),
      platform: Type.String({ index: true }),
      title: Type.String(),
      lastSeenAt: Type.Number({ index: true }),
      enabled: Type.Number(),
    },
    access: sessionsAccess,
  });
  api.registerTable("grants", {
    columns: {
      userId: Type.String({ index: true }),
      sessionId: Type.String({ index: true }),
    },
  });
  api.registerTable("messages", {
    columns: {
      sessionId: Type.String({ index: true }),
      text: Type.String(),
    },
  });

  // The sidebar: the caller's sessions, newest first.
  api.registerQuery("sidebar", {
    args: {},
    handler: (ctx) => {
      work();
      return ctx.db
        .table("sessions")
        .where("platform", "!=", "headless")
        .order("lastSeenAt", "desc")
        .limit(50)
        .all();
    },
  });
  // One conversation: its session row and its message count.
  api.registerQuery("conversation", {
    args: { id: Type.String() },
    handler: async (ctx, args) => {
      work();
      const sessions = ctx.db.table("sessions");
      const messages = ctx.db.table("messages");
      return {
        session: await sessions.where("_id", "=", args.id).first(),
        messages: await messages.where("sessionId", "=", args.id).count(),
      };
    },
  });
  // An access decision: whether the caller may see anything here.
  api.registerQuery("decide", {
    args: {},
    handler: async (ctx) => {
      work();
      return (await ctx.db.table("sessions").count()) > 0;
    },
  });
  // A workspace's effective bindings: its sessions, enabled or not.
  api.registerQuery("effective", {
    args: { workspaceId: Type.String() },
    handler: (ctx, args) => {
      work();
      return ctx.db
        .table("sessions")
        .select("_id", "enabled")
        .where("workspaceId", "=", args.workspaceId)
        .all();
    },
  });

  api.registerMutation("seed", {
    args: { users: Type.Number(), conversations: Type.Number() },
    async handler(ctx, args) {
      const ids: string[][] = [];
      for (let u = 0; u < args.users; u++) {
        const mine: string[] = [];
        for (let c = 0; c < args.conversations; c++) {
          const id = await ctx.db.table("sessions").insert({
            workspaceId: `w${u % 5}`,
            platform: c % 4 === 3 ? "headless" : "whatsapp",
            title: `u${u} c${c}`,
            lastSeenAt: u * 1000 + c,
            enabled: 1,
          });
          await ctx.db
            .table("grants")
            .insert({ userId: `u${u}`, sessionId: id });
          mine.push(id);
        }
        ids.push(mine);
      }
      return ids;
    },
  });
  // `conversations.touch`: an inbound message's mark on its session.
  api.registerMutation("touch", {
    args: { id: Type.String(), at: Type.Number() },
    async handler(ctx, args) {
      await ctx.db
        .table("sessions")
        .update(args.id, { lastSeenAt: args.at, title: `seen ${args.at}` });
    },
  });
  api.registerMutation("message", {
    args: { id: Type.String(), text: Type.String() },
    async handler(ctx, args) {
      await ctx.db
        .table("messages")
        .insert({ sessionId: args.id, text: args.text });
    },
  });
}
