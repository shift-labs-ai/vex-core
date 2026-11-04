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
 *   BENCH_HANDLER_MS=20 BENCH_WORKERS=4 bun benchmarks/invalidation.ts
 *   BENCH_USERS=35 BENCH_CONVERSATIONS=6 BENCH_ROUNDS=20 bun benchmarks/invalidation.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import { Vex } from "../src/core/engine.js";
import type { Span } from "../src/core/tracer.js";
import type { VexUser } from "../src/core/types.js";
import { benchmarkPlugin, HANDLER_MS } from "./invalidation-plugin.js";

const USERS = Number(process.env.BENCH_USERS ?? 35);
const CONVERSATIONS = Number(process.env.BENCH_CONVERSATIONS ?? 6);
const OPEN = Number(process.env.BENCH_OPEN ?? 3);
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 20);
const BURST = Number(process.env.BENCH_BURST ?? 6);
const MEMORY = process.env.BENCH_MEMORY === "1";
/** Evaluation workers; none evaluates on the main thread. */
const WORKERS = Number(process.env.BENCH_WORKERS ?? 0);
/** The run time past which a read goes to the pool; the engine's default unless set. */
const OFFLOAD_MS =
  process.env.BENCH_OFFLOAD_MS === undefined
    ? undefined
    : Number(process.env.BENCH_OFFLOAD_MS);
/** Print each scenario as one JSON line instead of a table row. */
const JSON_LINES = process.env.BENCH_JSON === "1";

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
    plugins: [new URL("./invalidation-plugin.ts", import.meta.url)],
    storage: sqliteAdapter(path),
    tracer,
    reactive: { maxRows: 10_000, maxBytes: 16 * 1024 * 1024 },
    ...(WORKERS > 0 && !MEMORY
      ? {
          evaluation: {
            workers: WORKERS,
            ...(OFFLOAD_MS !== undefined ? { offloadAboveMs: OFFLOAD_MS } : {}),
          },
        }
      : {}),
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
      // How long the main thread was held: a 1 ms timer's drift, summed.
      let stall = 0;
      let last = performance.now();
      let probing = true;
      const probe = () => {
        const now = performance.now();
        stall += Math.max(0, now - last - 1);
        last = now;
        if (probing) setTimeout(probe, 1);
      };
      setTimeout(probe, 1);
      for (let round = 0; round < ROUNDS; round++) {
        const started = performance.now();
        await run(round);
        wall.push(performance.now() - started);
      }
      // The probe fires only when the main thread yields: let it, so the
      // last stretch it was held counts.
      await new Promise((resolve) => setTimeout(resolve, 2));
      probing = false;
      wall.sort((a, b) => a - b);
      const reruns = passes.reduce((sum, p) => sum + p.reEvaluated, 0);
      const invalidationMs = passes.reduce((sum, p) => sum + p.duration, 0);
      if (JSON_LINES) {
        console.log(
          JSON.stringify({
            scenario: label,
            writes,
            passes: passes.length / ROUNDS,
            reruns: reruns / ROUNDS,
            deliveries: deliveries.count / ROUNDS,
            invalidationMs: invalidationMs / ROUNDS,
            wallP50: percentile(wall, 0.5),
            wallMax: wall.at(-1) ?? 0,
            stallMs: stall / ROUNDS,
          }),
        );
        return;
      }
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
          `main stall/round ${(stall / ROUNDS).toFixed(1).padStart(7)}`,
        ].join("  "),
      );
    };

    if (!JSON_LINES)
      console.log(
        `users ${USERS}, conversations/user ${CONVERSATIONS}, open/user ${OPEN}, subscriptions ${subs}, rounds ${ROUNDS}, handler ${HANDLER_MS} ms, workers ${WORKERS}, storage ${MEMORY ? "memory" : "file"}`,
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
