/**
 * An MMO's load on the engine: every player holds eleven live views
 * (self, inventory, its count, weapons; the zone's roster and chat,
 * what is nearby; the party and its health; the guild's roster and
 * chat; the leaderboard), and play writes constantly: moves most of
 * all, then chat, damage, loot, the odd level-up.
 *
 * Views that do not depend on who looks (a zone's roster) are held
 * without a caller, so every player in the zone shares one run of
 * it; a player's own views are theirs.
 *
 * Reports, per tier of players: the data and subscriptions it holds,
 * what a burst of play costs (passes, groups re-run, deliveries), the
 * sustained writes a second, latency, and the main thread's stall.
 *
 *   bun benchmarks/mmo.ts
 *   BENCH_PLAYERS=1000,10000,50000 BENCH_BURST=200 BENCH_SECONDS=10 bun benchmarks/mmo.ts
 *   BENCH_WORKERS=4 bun benchmarks/mmo.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import { Vex } from "../src/core/engine.js";
import type { Span } from "../src/core/tracer.js";
import { rawBulkInsert } from "../src/internal.js";
import {
  cellOf,
  guildOf,
  ITEMS_PER_PLAYER,
  mmoPlugin,
  partyOf,
  playerId,
  zoneOf,
} from "./mmo-plugin.js";

const PLAYERS = (process.env.BENCH_PLAYERS ?? "1000,10000")
  .split(",")
  .map(Number);
/** Writes per burst: a tick's worth of play landing together. */
const BURST = Number(process.env.BENCH_BURST ?? 100);
const SECONDS = Number(process.env.BENCH_SECONDS ?? 5);
const WORKERS = Number(process.env.BENCH_WORKERS ?? 0);
const JSON_LINES = process.env.BENCH_JSON === "1";

function percentile(sorted: number[], fraction: number): number {
  return (
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ??
    0
  );
}
const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);

/** A small seeded generator: the same play each run. */
function prng(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  };
}

interface Pass {
  duration: number;
  judged: number;
  groups: number;
  reEvaluated: string[];
}

async function tier(players: number) {
  const dir = mkdtempSync(join(tmpdir(), "vex-mmo-"));
  const path = join(dir, "world.db");
  const passes: Pass[] = [];
  const vex = await Vex.create({
    plugins: [mmoPlugin],
    storage: sqliteAdapter(path),
    reactive: { maxRows: 10_000, maxBytes: 16 * 1024 * 1024 },
    tracer: {
      onSpan(span: Span) {
        if (span.type !== "invalidation" || !span.meta) return;
        const meta = JSON.parse(span.meta);
        passes.push({
          duration: span.duration,
          judged: meta.judged ?? 0,
          groups: meta.affectedGroups ?? 0,
          reEvaluated: meta.reEvaluated ?? [],
        });
      },
    },
    ...(WORKERS > 0
      ? {
          evaluation: {
            workers: WORKERS,
            module: new URL("./mmo-setup.ts", import.meta.url),
            setup: { path },
          },
        }
      : {}),
  });
  const random = prng(7);
  try {
    // ─── The world ───
    const seedStart = performance.now();
    const rows: Record<string, any>[] = [];
    for (let p = 0; p < players; p++) {
      rows.push({
        _id: playerId(p),
        name: `Player ${p}`,
        zone: zoneOf(p),
        partyId: partyOf(p),
        guildId: guildOf(p),
        level: 1 + Math.floor(random() * 60),
        x: 0,
        y: 0,
        cell: "",
        hp: 100,
      });
      const row = rows[rows.length - 1];
      row.x = Math.floor(random() * 1000);
      row.y = Math.floor(random() * 1000);
      row.cell = cellOf(row.x, row.y);
    }
    await rawBulkInsert(vex, "players", rows);
    const items: Record<string, any>[] = [];
    const kinds = ["weapon", "armor", "potion", "gem", "scroll"];
    for (let p = 0; p < players; p++) {
      for (let i = 0; i < ITEMS_PER_PLAYER; i++) {
        items.push({
          playerId: playerId(p),
          kind: kinds[i % kinds.length],
          qty: 1 + (i % 9),
        });
      }
      if (items.length >= 50_000) {
        await rawBulkInsert(vex, "items", items.splice(0));
      }
    }
    if (items.length > 0) await rawBulkInsert(vex, "items", items);
    const messages: Record<string, any>[] = [];
    for (let p = 0; p < players; p++) {
      for (let m = 0; m < 5; m++) {
        messages.push({
          channel: m < 3 ? zoneOf(p) : guildOf(p),
          playerId: playerId(p),
          text: `hello from ${p} #${m}`,
          at: p * 10 + m,
        });
      }
      if (messages.length >= 50_000) {
        await rawBulkInsert(vex, "messages", messages.splice(0));
      }
    }
    if (messages.length > 0) await rawBulkInsert(vex, "messages", messages);
    const seedMs = performance.now() - seedStart;

    // ─── Every player logs in ───
    const subStart = performance.now();
    let deliveries = 0;
    const deliver = () => {
      deliveries++;
    };
    for (let p = 0; p < players; p++) {
      const id = playerId(p);
      const me = { user: { id, name: id, isAdmin: false } };
      const zone = zoneOf(p);
      await Promise.all([
        vex.subscribe("mmo.self", { id }, deliver, me),
        vex.subscribe("mmo.inventory", { id }, deliver, me),
        vex.subscribe("mmo.inventoryCount", { id }, deliver, me),
        vex.subscribe("mmo.weapons", { id }, deliver, me),
        vex.subscribe("mmo.zoneRoster", { zone }, deliver),
        vex.subscribe("mmo.nearby", { zone, cell: rows[p].cell }, deliver),
        vex.subscribe("mmo.zoneChat", { zone }, deliver),
        vex.subscribe("mmo.party", { partyId: partyOf(p) }, deliver),
        vex.subscribe("mmo.partyHp", { partyId: partyOf(p) }, deliver),
        vex.subscribe("mmo.guildRoster", { guildId: guildOf(p) }, deliver),
        vex.subscribe("mmo.guildChat", { guildId: guildOf(p) }, deliver),
        vex.subscribe("mmo.leaderboard", {}, deliver),
      ]);
    }
    const subscribeMs = performance.now() - subStart;
    const subs = vex.activeSubscriptionCount();
    const rss = process.memoryUsage().rss;

    // ─── Play ───
    let at = 1e9;
    const tick = (i: number) => {
      const p = Math.floor(random() * players);
      const id = playerId(p);
      const roll = random();
      if (roll < 0.7) {
        return vex.mutate("mmo.move", {
          id,
          x: Math.floor(random() * 1000),
          y: Math.floor(random() * 1000),
        });
      }
      if (roll < 0.85) {
        return vex.mutate("mmo.say", {
          channel: random() < 0.8 ? zoneOf(p) : guildOf(p),
          playerId: id,
          text: `tick ${i}`,
          at: at++,
        });
      }
      if (roll < 0.95) {
        return vex.mutate("mmo.damage", { id, hp: Math.floor(random() * 100) });
      }
      if (roll < 0.99) {
        return vex.mutate("mmo.loot", {
          playerId: id,
          kind: kinds[i % kinds.length],
          qty: 1,
        });
      }
      return vex.mutate("mmo.levelUp", {
        id,
        level: 1 + Math.floor(random() * 60),
      });
    };

    // Warm: one burst, so the first pass's costs are not the measure.
    await Promise.all(Array.from({ length: BURST }, (_, i) => tick(i)));
    passes.length = 0;
    deliveries = 0;

    // Main-thread stall: a 1 ms timer's drift, summed.
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

    const latencies: number[] = [];
    let writes = 0;
    const started = performance.now();
    const deadline = started + SECONDS * 1000;
    while (performance.now() < deadline) {
      const burstStart = performance.now();
      await Promise.all(
        Array.from({ length: BURST }, (_, i) => tick(writes + i)),
      );
      writes += BURST;
      latencies.push(performance.now() - burstStart);
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
    probing = false;
    const elapsed = (performance.now() - started) / 1000;
    latencies.sort((a, b) => a - b);
    const judged = passes.reduce((s, p) => s + p.judged, 0);
    const groups = passes.reduce((s, p) => s + p.groups, 0);
    const passMs = passes.reduce((s, p) => s + p.duration, 0);

    const tally: Record<string, number> = {};
    for (const pass of passes) {
      for (const name of pass.reEvaluated) tally[name] = (tally[name] ?? 0) + 1;
    }
    const reruns = Object.entries(tally)
      .sort((a, b) => b[1] - a[1])
      .map(
        ([name, n]) =>
          `${name.replace("mmo.", "")} ${(n / Math.max(1, passes.length)).toFixed(0)}`,
      )
      .join(", ");
    const report = {
      players,
      subs,
      rows: players * (1 + ITEMS_PER_PLAYER + 5),
      seedMs: Math.round(seedMs),
      subscribeMs: Math.round(subscribeMs),
      rssMb: mb(rss),
      writesPerSec: Math.round(writes / elapsed),
      passes: passes.length,
      judgedPerPass: Math.round(judged / Math.max(1, passes.length)),
      groupsPerPass: Math.round(groups / Math.max(1, passes.length)),
      deliveriesPerSec: Math.round(deliveries / elapsed),
      passMsPerBurst: +(passMs / Math.max(1, passes.length)).toFixed(1),
      burstP50: +percentile(latencies, 0.5).toFixed(1),
      burstP99: +percentile(latencies, 0.99).toFixed(1),
      stallPct: +((stall / (elapsed * 1000)) * 100).toFixed(0),
      reruns,
    };
    if (JSON_LINES) console.log(JSON.stringify(report));
    else
      console.log(
        [
          `players ${report.players}`,
          `subs ${report.subs}`,
          `rows ${report.rows}`,
          `seed ${report.seedMs} ms`,
          `login ${report.subscribeMs} ms`,
          `rss ${report.rssMb} MB`,
          `writes/s ${report.writesPerSec}`,
          `passes ${report.passes}`,
          `judged/pass ${report.judgedPerPass}`,
          `groups/pass ${report.groupsPerPass}`,
          `deliveries/s ${report.deliveriesPerSec}`,
          `pass ms ${report.passMsPerBurst}`,
          `burst p50 ${report.burstP50} p99 ${report.burstP99} ms`,
          `main stall ${report.stallPct}%`,
          `re-runs/pass: ${report.reruns}`,
        ].join(" | "),
      );
  } finally {
    await vex.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  if (!JSON_LINES) {
    console.log(`burst ${BURST}, sustained ${SECONDS} s, workers ${WORKERS}`);
  }
  for (const players of PLAYERS) await tier(players);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
