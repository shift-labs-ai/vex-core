/**
 * Scale: how the engine's own cost grows with the subscriptions it
 * holds, and how many writes a second it sustains under them.
 *
 * Players each open a few live views over the governed `sessions`
 * table (the dashboard-shaped plugin of `invalidation.ts`); writes
 * touch random players' sessions at a steady rate. Handlers cost
 * nothing, so what is measured is the engine: judging every
 * subscription on each pass, the re-runs a write earns, delivery.
 *
 *   bun benchmarks/scale.ts
 *   BENCH_PLAYERS=2000,10000,50000 BENCH_VIEWS=5 bun benchmarks/scale.ts
 *   BENCH_WORKERS=4 bun benchmarks/scale.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import { Vex } from "../src/core/engine.js";
import type { Span } from "../src/core/tracer.js";
import type { VexUser } from "../src/core/types.js";
import { rawBulkInsert } from "../src/internal.js";
import { benchmarkPlugin } from "./invalidation-plugin.js";

const PLAYERS = (process.env.BENCH_PLAYERS ?? "1000,5000,20000")
  .split(",")
  .map(Number);
const VIEWS = Number(process.env.BENCH_VIEWS ?? 5);
const CONVERSATIONS = 3;
/** Writes issued per burst, and bursts per second, for the sustained phase. */
const BURST = Number(process.env.BENCH_BURST ?? 50);
const SECONDS = Number(process.env.BENCH_SECONDS ?? 5);
const WORKERS = Number(process.env.BENCH_WORKERS ?? 0);

function percentile(sorted: number[], fraction: number): number {
  return (
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ??
    0
  );
}

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(0);

async function tier(players: number) {
  const dir = mkdtempSync(join(tmpdir(), "vex-scale-"));
  const path = join(dir, "scale.db");
  const passes: Array<{ duration: number; reEvaluated: number }> = [];
  const vex = await Vex.create({
    plugins: [benchmarkPlugin],
    storage: sqliteAdapter(path),
    reactive: { maxRows: 10_000, maxBytes: 16 * 1024 * 1024 },
    tracer: {
      onSpan(span: Span) {
        if (span.type !== "invalidation" || !span.meta) return;
        const meta = JSON.parse(span.meta);
        passes.push({
          duration: span.duration,
          reEvaluated: meta.reEvaluated?.length ?? 0,
        });
      },
    },
    ...(WORKERS > 0
      ? {
          evaluation: {
            workers: WORKERS,
            module: new URL("./invalidation-setup.ts", import.meta.url),
            setup: { path },
          },
        }
      : {}),
  });
  try {
    // Seed: players × conversations, bulk, with grants.
    const seedStart = performance.now();
    const sessions: Record<string, any>[] = [];
    const grants: Record<string, any>[] = [];
    const ids: string[][] = [];
    for (let u = 0; u < players; u++) {
      const mine: string[] = [];
      for (let c = 0; c < CONVERSATIONS; c++) {
        const _id = `s${u}-${c}`;
        sessions.push({
          _id,
          workspaceId: `w${u % 50}`,
          platform: "whatsapp",
          title: `u${u} c${c}`,
          lastSeenAt: u * 10 + c,
          enabled: 1,
        });
        grants.push({ userId: `u${u}`, sessionId: _id });
        mine.push(_id);
      }
      ids.push(mine);
    }
    await rawBulkInsert(vex, "sessions", sessions);
    await rawBulkInsert(vex, "grants", grants);
    const seedMs = performance.now() - seedStart;

    // Open every player's views.
    const subStart = performance.now();
    let deliveries = 0;
    const deliver = () => {
      deliveries++;
    };
    for (let u = 0; u < players; u++) {
      const user: VexUser = { id: `u${u}`, name: `u${u}`, isAdmin: false };
      const as = { user };
      const views: Array<Promise<unknown>> = [
        vex.subscribe("b.sidebar", {}, deliver, as),
        vex.subscribe("b.decide", {}, deliver, as),
        vex.subscribe(
          "b.effective",
          { workspaceId: `w${u % 50}` },
          deliver,
          as,
        ),
      ];
      for (let c = 0; c < VIEWS - 3 && c < CONVERSATIONS; c++) {
        views.push(
          vex.subscribe("b.conversation", { id: ids[u][c] }, deliver, as),
        );
      }
      await Promise.all(views);
    }
    const subscribeMs = performance.now() - subStart;
    const subs = vex.activeSubscriptionCount();
    const rssAfterSubscribe = process.memoryUsage().rss;

    // One write, measured alone: the pass's judging cost at this size.
    passes.length = 0;
    const lone: number[] = [];
    for (let i = 0; i < 20; i++) {
      const started = performance.now();
      await vex.mutate("b.touch", { id: ids[i % players][0], at: 1e9 + i });
      lone.push(performance.now() - started);
    }
    lone.sort((a, b) => a - b);
    const lonePass = passes.reduce((s, p) => s + p.duration, 0) / passes.length;

    // Sustained: bursts of BURST writes to random players, back to
    // back, for SECONDS; what rate the engine keeps up with.
    passes.length = 0;
    deliveries = 0;
    const latencies: number[] = [];
    let writes = 0;
    let at = 2e9;
    const sustainedStart = performance.now();
    const deadline = sustainedStart + SECONDS * 1000;
    while (performance.now() < deadline) {
      const started = performance.now();
      await Promise.all(
        Array.from({ length: BURST }, (_, i) => {
          const u = (writes + i) % players;
          return vex.mutate("b.touch", {
            id: ids[u][i % CONVERSATIONS],
            at: at++,
          });
        }),
      );
      writes += BURST;
      latencies.push((performance.now() - started) / BURST);
    }
    const elapsed = (performance.now() - sustainedStart) / 1000;
    latencies.sort((a, b) => a - b);
    const reruns = passes.reduce((s, p) => s + p.reEvaluated, 0);
    const passMs = passes.reduce((s, p) => s + p.duration, 0);

    console.log(
      [
        `players ${players}`,
        `subs ${subs}`,
        `seed ${seedMs.toFixed(0)} ms`,
        `subscribe ${subscribeMs.toFixed(0)} ms (${(subscribeMs / subs).toFixed(2)} ms/sub)`,
        `rss ${mb(rssAfterSubscribe)} MB`,
        `lone write p50 ${percentile(lone, 0.5).toFixed(1)} ms (pass ${lonePass.toFixed(1)} ms)`,
        `sustained ${(writes / elapsed).toFixed(0)} writes/s`,
        `passes ${passes.length}`,
        `re-runs/write ${(reruns / writes).toFixed(2)}`,
        `pass ms/write ${(passMs / writes).toFixed(2)}`,
        `write latency p50 ${percentile(latencies, 0.5).toFixed(2)} p99 ${percentile(latencies, 0.99).toFixed(2)} ms`,
        `deliveries ${deliveries}`,
      ].join(" | "),
    );
  } finally {
    await vex.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  console.log(
    `views/player ${VIEWS}, burst ${BURST}, sustained ${SECONDS} s, workers ${WORKERS}`,
  );
  for (const players of PLAYERS) await tier(players);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
