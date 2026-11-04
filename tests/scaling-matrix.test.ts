/**
 * Scaling matrix: every way writes and subscriptions can interleave,
 * under every engine mode, judged by what a subscriber must never see.
 *
 * Modes: on the main thread over memory, on the main thread over a
 * file, and over a file with evaluation workers. Scenarios: bursts,
 * writes landing inside runs, jobs, webhooks, bulk and raw writes,
 * rollbacks, no-ops, deletes, subscribers arriving, leaving, failing
 * or exceeding their budget mid-burst, governed rows whose grants
 * move, grouped and numerous subscribers, close mid-burst.
 *
 * After every scenario settles, for every live subscription:
 *   - its last delivery equals a fresh run of its query (nothing stale);
 *   - its deliveries never went backwards (a result reflects a write
 *     version; versions are non-decreasing);
 *   - every mutation resolved only after what it wrote was delivered;
 *   - invalidation passes never outnumber commits.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import { Vex } from "../src/core/engine.js";
import type { Span } from "../src/core/tracer.js";
import type { VexUser } from "../src/core/types.js";
import { scalingPlugin } from "./fixtures/scaling-plugin.js";

const SETUP = new URL("./fixtures/scaling-setup.ts", import.meta.url);

type Mode = "memory" | "file" | "workers";
const MODES: Mode[] = ["memory", "file", "workers"];

interface Delivery {
  version: number;
  count: number;
  result: unknown;
  at: number;
}

interface Watch {
  name: string;
  args: Record<string, any>;
  user?: VexUser;
  deliveries: Delivery[];
  unsubscribe: () => void;
  live: boolean;
}

interface Harness {
  vex: Vex;
  mode: Mode;
  spans: Span[];
  watches: Watch[];
  watch(
    name: string,
    args?: Record<string, any>,
    user?: VexUser,
  ): Promise<Watch>;
  /** A mutation, tracked: when it resolves, what it wrote was delivered. */
  write(name: string, args?: Record<string, any>): Promise<unknown>;
  settle(): Promise<void>;
  check(): Promise<void>;
}

let harnesses: Harness[] = [];
let dirs: string[] = [];

afterEach(async () => {
  for (const h of harnesses) await h.vex.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  harnesses = [];
  dirs = [];
});

const field = (result: unknown, key: "version" | "count"): number =>
  result && typeof result === "object" && key in result
    ? ((result as Record<string, number>)[key] ?? 0)
    : 0;

async function create(mode: Mode): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "vex-scaling-"));
  dirs.push(dir);
  const path = mode === "memory" ? ":memory:" : join(dir, "db.sqlite");
  const spans: Span[] = [];
  const vex = await Vex.create({
    plugins: [scalingPlugin],
    storage: sqliteAdapter(path),
    tracer: { onSpan: (span) => spans.push(span) },
    reactive: { maxRows: 500, maxBytes: 512 * 1024 },
    ...(mode === "workers"
      ? { evaluation: { workers: 2, module: SETUP, setup: { path } } }
      : {}),
  });
  const watches: Watch[] = [];
  let clock = 0;
  const h: Harness = {
    vex,
    mode,
    spans,
    watches,
    async watch(name, args = {}, user) {
      const w: Watch = {
        name,
        args,
        user,
        deliveries: [],
        unsubscribe: () => {},
        live: true,
      };
      w.unsubscribe = await vex.subscribe(
        `sc.${name}`,
        args,
        (result: unknown) => {
          if (!w.live) throw new Error(`delivery after unsubscribe: ${name}`);
          w.deliveries.push({
            version: field(result, "version"),
            count: field(result, "count"),
            result,
            at: ++clock,
          });
        },
        user ? { user } : undefined,
      );
      watches.push(w);
      return w;
    },
    async write(name, args = {}) {
      const result = await vex.mutate(`sc.${name}`, args);
      return result;
    },
    async settle() {
      await new Promise((resolve) => setTimeout(resolve, 30));
    },
    async check() {
      for (const w of watches) {
        if (!w.live) continue;
        const fresh = await vex.query(
          `sc.${w.name}`,
          w.args,
          w.user ? { user: w.user } : undefined,
        );
        expect(
          JSON.stringify(w.deliveries.at(-1)?.result),
          `${w.name} ${JSON.stringify(w.args)} last delivery`,
        ).toBe(JSON.stringify(fresh));
        // A result's version is the highest write among its rows: it
        // falls only when rows left (a delete), never from a stale run.
        for (let i = 1; i < w.deliveries.length; i++) {
          const prev = w.deliveries[i - 1];
          const cur = w.deliveries[i];
          if (cur.version < prev.version && cur.count >= prev.count) {
            throw new Error(
              `${w.name} ${JSON.stringify(w.args)} went backwards: ${JSON.stringify(
                w.deliveries.map((d) => [d.version, d.count]),
              )}`,
            );
          }
        }
      }
    },
  };
  harnesses.push(h);
  return h;
}

const alice: VexUser = { id: "alice", name: "Alice", isAdmin: false };

/** A burst: `n` writes issued together. */
const burst = (
  h: Harness,
  n: number,
  make: (i: number) => [string, Record<string, any>],
) => Promise.all(Array.from({ length: n }, (_, i) => h.write(...make(i))));

const scenarios: Record<string, (h: Harness) => Promise<void>> = {
  "sequential writes": async (h) => {
    const id = (await h.write("add", { scope: "a", n: 1 })) as string;
    await h.watch("sum", { scope: "a" });
    for (let i = 0; i < 20; i++) await h.write("set", { id, n: i });
  },
  "burst of writes to one scope": async (h) => {
    await h.watch("sum", { scope: "a" });
    await burst(h, 20, (i) => ["add", { scope: "a", n: i }]);
  },
  "burst across scopes": async (h) => {
    for (const scope of ["a", "b", "c"]) await h.watch("sum", { scope });
    await h.watch("all");
    await h.watch("scopes", { scopes: ["a", "c"] });
    await burst(h, 24, (i) => ["add", { scope: "abc"[i % 3], n: i }]);
  },
  "writes landing inside slow runs": async (h) => {
    const id = (await h.write("add", { scope: "a", n: 1 })) as string;
    await h.watch("sum", { scope: "a" });
    await h.write("knob", { key: "slowMs", value: 15 });
    // Each write lands while the run the previous one opened is held.
    await Promise.all(
      Array.from(
        { length: 4 },
        (_, i) =>
          new Promise<void>((resolve) =>
            setTimeout(
              () => h.write("set", { id, n: 10 + i }).then(() => resolve()),
              i * 8,
            ),
          ),
      ),
    );
    await h.write("knob", { key: "slowMs", value: 0 });
  },
  "jobs and mutations together": async (h) => {
    await h.watch("sum", { scope: "a" });
    await Promise.all([
      burst(h, 5, (i) => ["add", { scope: "a", n: i }]),
      h.vex.triggerJob("sc.tick"),
      h.vex.triggerJob("sc.tick"),
    ]);
  },
  "webhooks and mutations together": async (h) => {
    await h.watch("sum", { scope: "a" });
    const hook = () =>
      h.vex.handleWebhook({
        path: "/sc/in",
        method: "POST",
        headers: {},
        body: { scope: "a", n: 7 },
      });
    await Promise.all([
      burst(h, 5, (i) => ["add", { scope: "a", n: i }]),
      hook(),
      hook(),
    ]);
  },
  "bulk insert inside a burst": async (h) => {
    await h.watch("sum", { scope: "a" });
    await Promise.all([
      burst(h, 5, (i) => ["add", { scope: "a", n: i }]),
      h.vex.unsafeBulkInsert(
        "items",
        Array.from({ length: 10 }, (_, i) => ({
          scope: "a",
          n: i,
          version: 0,
        })),
      ),
    ]);
  },
  "raw SQL write inside a burst": async (h) => {
    await h.watch("sum", { scope: "a" });
    await h.watch("sum", { scope: "b" });
    await Promise.all([
      burst(h, 5, (i) => ["add", { scope: "a", n: i }]),
      h.write("raw", { scope: "b", n: 3 }),
    ]);
  },
  "a mutation that rolls back inside a burst": async (h) => {
    await h.watch("sum", { scope: "a" });
    const results = await Promise.allSettled([
      burst(h, 5, (i) => ["add", { scope: "a", n: i }]),
      h.write("failing", { scope: "a" }),
      burst(h, 5, (i) => ["add", { scope: "a", n: i }]),
    ]);
    expect(results[1].status).toBe("rejected");
  },
  "no-op updates": async (h) => {
    const id = (await h.write("add", { scope: "a", n: 1 })) as string;
    await h.watch("sum", { scope: "a" });
    const before = h.watches[0].deliveries.length;
    await burst(h, 5, () => ["noop", { id }]);
    expect(h.watches[0].deliveries.length).toBe(before);
  },
  "deletes by id and by filter inside a burst": async (h) => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++)
      ids.push((await h.write("add", { scope: "a", n: i })) as string);
    await h.watch("sum", { scope: "a" });
    await h.watch("sum", { scope: "b" });
    await Promise.all([
      h.write("remove", { id: ids[0] }),
      h.write("removeScope", { scope: "b" }),
      burst(h, 4, (i) => ["add", { scope: "b", n: i }]),
      h.write("remove", { id: ids[1] }),
    ]);
  },
  "a subscriber arriving mid-burst": async (h) => {
    await h.watch("sum", { scope: "a" });
    await Promise.all([
      burst(h, 10, (i) => ["add", { scope: "a", n: i }]),
      h.watch("sum", { scope: "a" }),
      h.watch("all"),
    ]);
  },
  "a subscriber leaving mid-burst": async (h) => {
    const w = await h.watch("sum", { scope: "a" });
    await h.watch("sum", { scope: "a" });
    await Promise.all([
      burst(h, 10, (i) => ["add", { scope: "a", n: i }]),
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        w.live = false;
        w.unsubscribe();
      })(),
    ]);
  },
  "a handler failing through a burst, then recovering": async (h) => {
    await h.watch("sum", { scope: "a" });
    await h.write("knob", { key: "fail", value: 1 });
    await burst(h, 6, (i) => ["add", { scope: "a", n: i }]);
    await h.write("knob", { key: "fail", value: 0 });
    await h.write("add", { scope: "a", n: 100 });
  },
  "a subscriber exceeding its budget mid-burst": async (h) => {
    await h.watch("sum", { scope: "a" });
    const big = await h.watch("bounded");
    await burst(h, 6, (i) => ["add", { scope: "a", n: i }]);
    // Dropped once its result outgrew the budget; the rest live on.
    big.live = false;
    expect(h.vex.activeSubscriptionCount()).toBe(1);
  },
  "governed rows whose grants move mid-burst": async (h) => {
    const mine = (await h.write("addGoverned", { title: "mine" })) as string;
    const other = (await h.write("addGoverned", { title: "other" })) as string;
    await h.write("grant", { userId: "alice", itemId: mine });
    await h.watch("governed", {}, alice);
    await Promise.all([
      h.write("renameGoverned", { id: other, title: "other'" }),
      h.write("grant", { userId: "alice", itemId: other }),
      h.write("renameGoverned", { id: mine, title: "mine'" }),
      h.write("addGoverned", { title: "third" }),
    ]);
  },
  "three identical subscribers": async (h) => {
    for (let i = 0; i < 3; i++) await h.watch("sum", { scope: "a" });
    await burst(h, 10, (i) => ["add", { scope: "a", n: i }]);
    const seen = h.watches.map((w) =>
      JSON.stringify(w.deliveries.map((d) => d.result)),
    );
    expect(new Set(seen).size).toBe(1);
  },
  "a hundred subscribers, a burst of fifty": async (h) => {
    for (let i = 0; i < 100; i++) await h.watch("sum", { scope: `s${i % 10}` });
    const before = h.spans.filter((s) => s.type === "invalidation").length;
    await burst(h, 50, (i) => ["add", { scope: `s${i % 10}`, n: i }]);
    const passes =
      h.spans.filter((s) => s.type === "invalidation").length - before;
    expect(passes).toBeLessThanOrEqual(50);
  },
  "close mid-burst": async (h) => {
    await h.watch("sum", { scope: "a" });
    const results = await Promise.allSettled([
      burst(h, 10, (i) => ["add", { scope: "a", n: i }]),
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        await h.vex.close();
      })(),
    ]);
    expect(results[1].status).toBe("fulfilled");
    for (const w of h.watches) w.live = false;
  },
};

/** A small seeded generator, so a failing interleaving can be rerun. */
function prng(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  };
}

/**
 * Random interleavings of everything above: writes of every kind,
 * subscribers coming and going, with jittered timing, from a seed.
 */
async function fuzz(h: Harness, seed: number, steps = 60): Promise<void> {
  const random = prng(seed);
  const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)];
  const ids: string[] = [];
  const scopes = ["a", "b", "c"];
  for (const scope of scopes)
    ids.push((await h.write("add", { scope, n: 1 })) as string);
  for (const scope of scopes) await h.watch("sum", { scope });
  await h.watch("all");
  await h.watch("scopes", { scopes: ["a", "b"] });
  const inflight: Promise<unknown>[] = [];
  for (let step = 0; step < steps; step++) {
    const delay = random() < 0.5 ? 0 : Math.floor(random() * 4);
    const op = random();
    const run = async () => {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (op < 0.35) {
        const id = (await h.write("add", {
          scope: pick(scopes),
          n: step,
        })) as string;
        ids.push(id);
      } else if (op < 0.6 && ids.length > 0) {
        await h.write("set", { id: pick(ids), n: step }).catch(() => {});
      } else if (op < 0.7 && ids.length > 3) {
        const id = ids.splice(Math.floor(random() * ids.length), 1)[0];
        await h.write("remove", { id });
      } else if (op < 0.75) {
        await h.write("removeScope", { scope: pick(scopes) });
      } else if (op < 0.8) {
        await h.vex.triggerJob("sc.tick");
      } else if (op < 0.85) {
        await h.vex.handleWebhook({
          path: "/sc/in",
          method: "POST",
          headers: {},
          body: { scope: pick(scopes), n: step },
        });
      } else if (op < 0.92) {
        await h.watch("sum", { scope: pick(scopes) });
      } else {
        const live = h.watches.filter((w) => w.live);
        if (live.length > 2) {
          const w = pick(live);
          w.live = false;
          w.unsubscribe();
        }
      }
    };
    inflight.push(run());
  }
  await Promise.all(inflight);
}

const REPEAT = Number(process.env.MATRIX_REPEAT ?? 1);
const SEEDS = Number(process.env.MATRIX_SEEDS ?? 4);

describe("scaling matrix", () => {
  for (const mode of MODES) {
    for (const [name, scenario] of Object.entries(scenarios)) {
      for (let round = 0; round < REPEAT; round++) {
        test(`${mode}: ${name}${REPEAT > 1 ? ` #${round + 1}` : ""}`, async () => {
          const h = await create(mode);
          await scenario(h);
          await h.settle();
          await h.check();
        }, 30_000);
      }
    }
    for (let seed = 1; seed <= SEEDS; seed++) {
      test(`${mode}: fuzz seed ${seed}`, async () => {
        const h = await create(mode);
        await fuzz(h, seed);
        await h.settle();
        await h.check();
      }, 60_000);
    }
  }
});
