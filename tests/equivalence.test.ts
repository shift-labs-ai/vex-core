/**
 * Equivalence under every read shape and write kind: random
 * subscriptions, generated from a grammar over every column type,
 * operator, OR group, selection, window and terminal — as builder
 * reads, raw reads, raw reads held to rows and to columns, and reads
 * of a governed table — against random writes of every kind, on the
 * main thread over memory and a file and over a file with workers.
 *
 * The oracle is the engine's own one-shot query. Sequentially, every
 * mutation resolves after its pass delivered, so after each write
 * each subscription's last delivery must equal a fresh run; under a
 * burst, after it settles. Deliveries never go backwards in version.
 * Precision is measured too: how many group runs a pass spent beyond
 * the results that changed, bounded so it cannot regress unnoticed.
 *
 *   EQ_SEEDS=50 bun test tests/equivalence.test.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import { Vex } from "../src/core/engine.js";
import type { Span } from "../src/core/tracer.js";
import type { Filter, VexUser } from "../src/core/types.js";
import {
  COLUMNS,
  equivalencePlugin,
  type Spec,
  type Terminal,
} from "./fixtures/equivalence-plugin.js";

const SETUP = new URL("./fixtures/equivalence-setup.ts", import.meta.url);
const SEEDS = Number(process.env.EQ_SEEDS ?? 8);
const MODES = ["memory", "file", "workers"] as const;
type Mode = (typeof MODES)[number];

function prng(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  };
}

/* ─── Generators ─── */

const VALUES: Record<string, unknown[]> = {
  s: ["a", "b", "5", "5.0", " 5", "", null],
  n: [0, 1, 5, 5.5, -1, null],
  b: [true, false, null],
  j: [{ a: 1 }, [1], null],
  k: ["x", "y", "z"],
  version: [0, 1, 5],
};
// What a mutation may write: each column's own type (a table's schema
// refuses the rest), or nothing.
const WRITE_VALUES: Record<string, unknown[]> = {
  ...VALUES,
  n: [...VALUES.n, undefined],
  s: [...VALUES.s, undefined],
};
// What raw SQL may leave in a column besides: each value's affinity
// twin, which reads as the same value to SQLite and not to `===`.
const TWINS: Record<string, unknown[]> = {
  n: ["5", "5.0", null],
  s: [5, null],
  b: [1, 0, null],
};
const OPERATORS: Filter["operator"][] = ["=", "!=", "IN", "<", ">", "<=", ">="];
const TERMINALS: Terminal[] = [
  "all",
  "all",
  "all",
  "first",
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "distinct",
  "countDistinct",
  "groupBy",
];

type Random = () => number;
const pick = <T>(random: Random, items: readonly T[]): T =>
  items[Math.floor(random() * items.length)];
const chance = (random: Random, p: number) => random() < p;

function filter(random: Random, ids: string[]): Filter {
  const column =
    chance(random, 0.15) && ids.length > 0 ? "_id" : pick(random, COLUMNS);
  const pool = column === "_id" ? ids : VALUES[column];
  const operator = pick(random, OPERATORS);
  if (operator === "IN") {
    const n = Math.floor(random() * 4);
    const value = Array.from({ length: n }, () => pick(random, pool));
    if (chance(random, 0.2)) value.push(null);
    return { column, operator, value };
  }
  return { column, operator, value: pick(random, pool) };
}

function spec(random: Random, ids: string[]): Spec {
  const table = chance(random, 0.2) ? "g" : "t";
  const filters = Array.from({ length: Math.floor(random() * 3) }, () =>
    filter(random, ids),
  );
  const spec: Spec = { table, filters, terminal: pick(random, TERMINALS) };
  if (chance(random, 0.2)) {
    spec.any = Array.from({ length: 1 + Math.floor(random() * 3) }, () =>
      Array.from({ length: Math.floor(random() * 2) }, () =>
        filter(random, ids),
      ),
    );
  }
  if (chance(random, 0.4)) {
    spec.select = [
      ...new Set(
        Array.from({ length: 1 + Math.floor(random() * 3) }, () =>
          pick(random, COLUMNS),
        ),
      ),
    ];
  }
  const dir = chance(random, 0.5) ? "asc" : "desc";
  if (chance(random, 0.5)) spec.order = { column: pick(random, COLUMNS), dir };
  if (chance(random, 0.3)) spec.limit = 1 + Math.floor(random() * 4);
  if (spec.limit !== undefined && chance(random, 0.3)) {
    spec.offset = Math.floor(random() * 3);
  }
  // Rows have no order but the one asked for, and a column with ties
  // orders a window's edge by the plan: a window and a first row are
  // ordered by the row id, distinct values by themselves.
  if (spec.terminal === "first" || spec.limit !== undefined) {
    spec.order = { column: "_id", dir };
  }
  if (spec.terminal === "distinct") spec.order = { column: "k", dir };
  if (table === "t" && chance(random, 0.3)) {
    spec.raw = pick(random, ["sql", "over", "overReads"] as const);
    spec.terminal = "all";
    spec.any = undefined;
    spec.order = undefined;
    spec.limit = undefined;
    spec.offset = undefined;
  }
  return spec;
}

function row(random: Random): Record<string, unknown> {
  const r: Record<string, unknown> = { k: pick(random, VALUES.k) };
  for (const column of ["s", "n", "b", "j"]) {
    if (chance(random, 0.8)) r[column] = pick(random, WRITE_VALUES[column]);
  }
  return r;
}

/* ─── Harness ─── */

interface Watch {
  spec: Spec;
  user?: VexUser;
  deliveries: Array<{ version: number | null; data: unknown; count: number }>;
}

const alice: VexUser = { id: "alice", name: "Alice", isAdmin: false };

let dirs: string[] = [];
let engines: Vex[] = [];
afterEach(async () => {
  for (const vex of engines) await vex.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  engines = [];
  dirs = [];
});

// EQ_PURITY=1: every run repeated on the same data, and every group a
// write skipped run again and compared: the engine's narrowing and
// each query's purity checked at once. Runs double, so the waste
// bound does not apply.
const PURITY = process.env.EQ_PURITY === "1";

async function create(mode: Mode) {
  const dir = mkdtempSync(join(tmpdir(), "vex-eq-"));
  dirs.push(dir);
  const path = mode === "memory" ? ":memory:" : join(dir, "db.sqlite");
  const passes: Array<{ groups: number }> = [];
  const vex = await Vex.create({
    plugins: [equivalencePlugin],
    storage: sqliteAdapter(path),
    reactive: { maxRows: 1000, maxBytes: 1024 * 1024 },
    purityCheck: PURITY ? "always" : "off",
    tracer: {
      onSpan(span: Span) {
        if (span.type === "invalidation" && span.meta) {
          passes.push({ groups: JSON.parse(span.meta).affectedGroups ?? 0 });
        }
      },
    },
    ...(mode === "workers"
      ? { evaluation: { workers: 2, module: SETUP, setup: { path } } }
      : {}),
  });
  engines.push(vex);
  return { vex, passes };
}

const rowCount = (data: unknown) =>
  Array.isArray(data) ? data.length : data === null ? 0 : 1;

/**
 * A result as compared: an unwindowed read's rows sorted, since the
 * order of rows a column with ties leaves is the plan's, and plans
 * differ by connection; a window's are in the total order it asked.
 */
function comparable(spec: Spec, result: unknown): string {
  const { data, version } = result as { data: unknown; version: unknown };
  const rows =
    Array.isArray(data) && spec.limit === undefined
      ? data.map((row) => JSON.stringify(row)).sort()
      : data;
  return JSON.stringify({ data: rows, version });
}

async function run(mode: Mode, seed: number) {
  const random = prng(seed);
  const { vex, passes } = await create(mode);
  const ids: string[] = [];
  const gids: string[] = [];
  for (let i = 0; i < 8; i++)
    ids.push(
      (await vex.mutate("eq.insert", {
        table: "t",
        row: row(random),
      })) as string,
    );
  for (let i = 0; i < 4; i++)
    gids.push(
      (await vex.mutate("eq.insert", {
        table: "g",
        row: row(random),
      })) as string,
    );
  await vex.mutate("eq.grant", { userId: "alice", itemId: gids[0] });
  await vex.mutate("eq.grant", { userId: "alice", itemId: gids[1] });

  const watches: Watch[] = [];
  // Views that ended: under EQ_PURITY, a check that failed.
  const endings: string[] = [];
  for (let i = 0; i < 12; i++) {
    const s = spec(random, ids);
    const w: Watch = {
      spec: s,
      user: s.table === "g" ? alice : undefined,
      deliveries: [],
    };
    await vex.subscribe(
      "eq.read",
      { spec: s },
      (result: { data: unknown; version: number | null }) =>
        w.deliveries.push({ ...result, count: rowCount(result.data) }),
      {
        ...(w.user ? { user: w.user } : {}),
        onError: (error: Error, ended: boolean) => {
          if (ended) endings.push(error.message);
        },
      },
    );
    watches.push(w);
  }

  const fresh = (w: Watch) =>
    vex.query(
      "eq.read",
      { spec: w.spec },
      w.user ? { user: w.user } : undefined,
    );
  const write = (): Promise<unknown> => {
    const roll = random();
    const table = chance(random, 0.25) ? "g" : "t";
    const pool = table === "g" ? gids : ids;
    const id = pick(random, pool);
    if (roll < 0.25) {
      return vex.mutate("eq.insert", { table, row: row(random) }).then((id) => {
        pool.push(id as string);
      });
    }
    if (roll < 0.45)
      return vex.mutate("eq.update", { table, id, data: row(random) });
    if (roll < 0.52)
      return vex.mutate("eq.touch", {
        table,
        id,
        data: { k: pick(random, VALUES.k) },
      });
    if (roll < 0.6) {
      return vex.mutate("eq.upsert", {
        table,
        keys: { k: pick(random, VALUES.k) },
        data: row(random),
      });
    }
    if (roll < 0.68 && pool.length > 2) {
      pool.splice(pool.indexOf(id), 1);
      return vex.mutate("eq.delete", { table, id });
    }
    if (roll < 0.74)
      return vex.mutate("eq.deleteWhere", {
        table,
        filters: [filter(random, pool)],
      });
    if (roll < 0.8)
      return vex.mutate("eq.rawInsert", {
        table,
        k: pick(random, VALUES.k),
        s: pick(random, TWINS.s),
        n: pick(random, TWINS.n),
        b: pick(random, TWINS.b),
      });
    if (roll < 0.86)
      return vex.mutate("eq.rawUpdate", {
        table,
        id,
        k: pick(random, VALUES.k),
      });
    if (roll < 0.9) return vex.mutate("eq.failing", { table }).catch(() => {});
    if (roll < 0.95)
      return vex.mutate("eq.grant", {
        userId: "alice",
        itemId: pick(random, gids),
      });
    return vex.mutate("eq.revoke", {
      userId: "alice",
      itemId: pick(random, gids),
    });
  };

  // Sequential: after each write, every subscription is current.
  let changed = 0;
  let spent = 0;
  for (let step = 0; step < 40; step++) {
    const before = await Promise.all(
      watches.map(async (w) => comparable(w.spec, await fresh(w))),
    );
    passes.length = 0;
    await write();
    const after = await Promise.all(
      watches.map(async (w) => comparable(w.spec, await fresh(w))),
    );
    for (let i = 0; i < watches.length; i++) {
      if (before[i] !== after[i]) changed++;
      const last = watches[i].deliveries.at(-1);
      expect(
        comparable(watches[i].spec, {
          data: last?.data,
          version: last?.version,
        }),
        `${mode} seed ${seed} step ${step} ${JSON.stringify(watches[i].spec)}`,
      ).toBe(after[i]);
    }
    spent += passes.reduce((s, p) => s + p.groups, 0);
  }

  // A burst, then settled: current again.
  await Promise.all(Array.from({ length: 15 }, () => write()));
  await new Promise((resolve) => setTimeout(resolve, 30));
  for (const w of watches) {
    const last = w.deliveries.at(-1);
    expect(
      comparable(w.spec, { data: last?.data, version: last?.version }),
    ).toBe(comparable(w.spec, await fresh(w)));
    // A window's highest version falls when a row sorts out of it
    // (a first row is a window of one): only an unwindowed read's
    // falls on a delete alone.
    if (w.spec.limit !== undefined || w.spec.terminal === "first") continue;
    // On the governed table a grant shows a row at the version it has
    // and a revoke hides one: what a caller sees can fall in version
    // with no write. Only an ungoverned read's rows arrive by writes.
    if (w.spec.table === "g") continue;
    for (let i = 1; i < w.deliveries.length; i++) {
      const prev = w.deliveries[i - 1];
      const cur = w.deliveries[i];
      if (
        prev.version !== null &&
        cur.version !== null &&
        cur.version < prev.version &&
        cur.count >= prev.count
      ) {
        throw new Error(
          `${mode} seed ${seed} went backwards: ${JSON.stringify(w.spec)}`,
        );
      }
    }
  }
  expect(endings).toEqual([]);
  return { changed, spent };
}

describe("equivalence under every read shape and write kind", () => {
  for (const mode of MODES) {
    test(`${mode}: ${SEEDS} seeds`, async () => {
      let changed = 0;
      let spent = 0;
      for (let seed = 1; seed <= SEEDS; seed++) {
        const outcome = await run(mode, seed);
        changed += outcome.changed;
        spent += outcome.spent;
      }
      // Runs a pass spends beyond the results that changed: the price
      // of judging without computing (aggregates, ranges, windows,
      // raw reads). About as many as changed, for this mix; bounded
      // so it cannot grow unnoticed.
      const wasted = spent - changed;
      console.log(
        `${mode}: ${spent} group runs for ${changed} changed results (${wasted} beyond)`,
      );
      if (!PURITY) expect(wasted).toBeLessThanOrEqual(changed * 1.5);
    }, 120_000);
  }
});
