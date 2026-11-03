/**
 * Invalidation under a dashboard-shaped load: many people, each with
 * live views whose policy narrows `sessions` to their conversations,
 * while `sessions` is written as inbound messages arrive.
 *
 * Shapes the measured deployment of SHFT-2537: ~200 subscriptions,
 * each write to `sessions` re-evaluating what it must. Prints, per
 * scenario, how many invalidation passes ran, how many subscription
 * groups re-ran, and the wall time, so a change to the engine can be
 * read as a number.
 *
 *   bun benchmarks/invalidation.ts
 *   BENCH_HANDLER_MS=20 bun benchmarks/invalidation.ts
 *   BENCH_USERS=35 BENCH_CONVERSATIONS=6 BENCH_ROUNDS=20 bun benchmarks/invalidation.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import type { TableAccessPolicy } from "../src/core/access.js";
import { UNRESTRICTED } from "../src/core/access.js";
import type { VexPluginAPI } from "../src/core/api.js";
import { Vex } from "../src/core/engine.js";
import type { Span } from "../src/core/tracer.js";
import type { VexUser } from "../src/core/types.js";

const USERS = Number(process.env.BENCH_USERS ?? 35);
const CONVERSATIONS = Number(process.env.BENCH_CONVERSATIONS ?? 6);
const OPEN = Number(process.env.BENCH_OPEN ?? 3);
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 20);
const BURST = Number(process.env.BENCH_BURST ?? 6);
const MEMORY = process.env.BENCH_MEMORY === "1";
/**
 * CPU each query handler burns besides its reads, in ms: the policy
 * decisions, projections and serialization a real view does. The
 * measured deployment's views cost 50–90 ms each.
 */
const HANDLER_MS = Number(process.env.BENCH_HANDLER_MS ?? 0);

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

function plugin(api: VexPluginAPI) {
  api.setName("b");
  api.registerTable("sessions", {
    columns: {
      workspaceId: { type: "string", index: true },
      platform: { type: "string", index: true },
      title: { type: "string" },
      lastSeenAt: { type: "number", index: true },
      enabled: { type: "number" },
    },
    access: sessionsAccess,
  });
  api.registerTable("grants", {
    columns: {
      userId: { type: "string", index: true },
      sessionId: { type: "string", index: true },
    },
  });
  api.registerTable("messages", {
    columns: {
      sessionId: { type: "string", index: true },
      text: { type: "string" },
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
    args: { id: "string" },
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
    args: { workspaceId: "string" },
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
    args: { users: "number", conversations: "number" },
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
    args: { id: "string", at: "number" },
    async handler(ctx, args) {
      await ctx.db
        .table("sessions")
        .update(args.id, { lastSeenAt: args.at, title: `seen ${args.at}` });
    },
  });
  api.registerMutation("message", {
    args: { id: "string", text: "string" },
    async handler(ctx, args) {
      await ctx.db
        .table("messages")
        .insert({ sessionId: args.id, text: args.text });
    },
  });
}

interface Pass {
  duration: number;
  reEvaluated: number;
  activeSubs: number;
}

function percentile(sorted: number[], fraction: number): number {
  return (
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ??
    0
  );
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "vex-bench-"));
  const path = MEMORY ? ":memory:" : join(dir, "bench.db");
  const passes: Pass[] = [];
  const tracer = {
    onSpan(span: Span) {
      if (span.type !== "invalidation" || !span.meta) return;
      const meta = JSON.parse(span.meta);
      passes.push({
        duration: span.duration,
        reEvaluated: meta.reEvaluated?.length ?? 0,
        activeSubs: meta.activeSubs ?? 0,
      });
    },
  };
  const vex = await Vex.create({
    plugins: [plugin],
    storage: sqliteAdapter(path),
    tracer,
    reactive: { maxRows: 10_000, maxBytes: 16 * 1024 * 1024 },
  });
  try {
    const ids = (await vex.mutate("b.seed", {
      users: USERS,
      conversations: CONVERSATIONS,
    })) as string[][];
    const deliveries = { count: 0 };
    const deliver = () => {
      deliveries.count++;
    };
    for (let u = 0; u < USERS; u++) {
      const user: VexUser = { id: `u${u}`, name: `u${u}`, isAdmin: false };
      const as = { user };
      await vex.subscribe("b.sidebar", {}, deliver, as);
      await vex.subscribe("b.decide", {}, deliver, as);
      await vex.subscribe(
        "b.effective",
        { workspaceId: `w${u % 5}` },
        deliver,
        as,
      );
      for (let c = 0; c < OPEN; c++) {
        await vex.subscribe("b.conversation", { id: ids[u][c] }, deliver, as);
      }
    }
    const subs = vex.activeSubscriptionCount();
    passes.length = 0;

    const scenario = async (
      label: string,
      writes: number,
      run: (round: number) => Promise<void>,
    ) => {
      passes.length = 0;
      deliveries.count = 0;
      const wall: number[] = [];
      for (let round = 0; round < ROUNDS; round++) {
        const started = performance.now();
        await run(round);
        wall.push(performance.now() - started);
      }
      wall.sort((a, b) => a - b);
      const reruns = passes.reduce((sum, p) => sum + p.reEvaluated, 0);
      const invalidationMs = passes.reduce((sum, p) => sum + p.duration, 0);
      console.log(
        [
          label.padEnd(28),
          `writes/round ${String(writes).padStart(2)}`,
          `passes ${String(passes.length / ROUNDS).padStart(5)}`,
          `re-runs/round ${String((reruns / ROUNDS).toFixed(1)).padStart(6)}`,
          `deliveries/round ${String((deliveries.count / ROUNDS).toFixed(1)).padStart(6)}`,
          `invalidation ms/round ${(invalidationMs / ROUNDS).toFixed(1).padStart(7)}`,
          `wall p50 ${percentile(wall, 0.5).toFixed(1).padStart(7)}`,
          `max ${(wall.at(-1) ?? 0).toFixed(1).padStart(7)}`,
        ].join("  "),
      );
    };

    console.log(
      `users ${USERS}, conversations/user ${CONVERSATIONS}, open/user ${OPEN}, subscriptions ${subs}, rounds ${ROUNDS}, handler ${HANDLER_MS} ms, storage ${MEMORY ? "memory" : "file"}`,
    );
    let at = 1_000_000;
    // One inbound message to one conversation: its session touched.
    await scenario("touch one session", 1, async (round) => {
      await vex.mutate("b.touch", { id: ids[round % USERS][0], at: at++ });
    });
    // A burst: several messages landing at once, each touching a session.
    await scenario(`touch ${BURST} sessions at once`, BURST, async (round) => {
      await Promise.all(
        Array.from({ length: BURST }, (_, i) =>
          vex.mutate("b.touch", {
            id: ids[(round + i) % USERS][i % OPEN],
            at: at++,
          }),
        ),
      );
    });
    // A burst to one conversation: the same session touched repeatedly.
    await scenario(`touch 1 session ${BURST} times`, BURST, async (round) => {
      await Promise.all(
        Array.from({ length: BURST }, () =>
          vex.mutate("b.touch", { id: ids[round % USERS][0], at: at++ }),
        ),
      );
    });
    // A message row: a write to a table only conversation views read.
    await scenario("one message", 1, async (round) => {
      await vex.mutate("b.message", { id: ids[round % USERS][0], text: "hi" });
    });
  } finally {
    await vex.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
