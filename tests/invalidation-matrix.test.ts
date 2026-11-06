/**
 * Invalidation matrix (SHFT-2537): a grid search for places where the
 * engine's "this write cannot have touched that subscription" judgment
 * disagrees with what the database actually does.
 *
 * Two layers, each against a real oracle rather than hand-written
 * expectations:
 *
 *   1. Value grid — every (column type × stored value × operator ×
 *      filter value) is run through SQLite: a row holding the value,
 *      a query carrying the filter. SQL says whether the row matches;
 *      `filterExcludes` must never say "excluded" when SQL matches
 *      (a false skip = a stale subscription). An identity rule
 *      (`===`, on `=` filters only) is scored alongside: what SQL's
 *      own semantics buy over JavaScript's.
 *
 *   2. Engine grid — every (write kind × query shape × hit/miss) on a
 *      live engine: a subscription is open, a mutation runs, and the
 *      oracle is whether the query's result actually changed. The
 *      invariant: a changed result was re-run. Everything else is
 *      precision: re-runs that were not needed, and which of those the
 *      engine had the information to skip.
 *
 * Set MATRIX_REPORT=<path> to also write the full grid as markdown.
 */

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import { UNRESTRICTED } from "../src/core/access.js";
import type { VexPluginAPI } from "../src/core/api.js";
import { Vex } from "../src/core/engine.js";
import { filterExcludes } from "../src/core/invalidation.js";
import type { ColumnType, Filter } from "../src/core/types.js";

const REPORT = process.env.MATRIX_REPORT;
const sections: string[] = [];

/* ------------------------------------------------------------------ */
/* Layer 1: value grid                                                 */
/* ------------------------------------------------------------------ */

const COLUMN_TYPES: ColumnType[] = [
  "string",
  "number",
  "boolean",
  "json",
  "any",
];
const OPERATORS: Filter["operator"][] = ["=", "!=", "IN", "<", ">", "<=", ">="];

/** Stored values: what a write's `values` can hold. */
const VALUES: Array<[label: string, value: unknown]> = [
  ["null", null],
  ["undefined", undefined],
  ['""', ""],
  ['"a"', "a"],
  ['"5"', "5"],
  ['"5.0"', "5.0"],
  ['"05"', "05"],
  ["5", 5],
  ["0", 0],
  ["1", 1],
  ["-1", -1],
  ["1.5", 1.5],
  ["10", 10],
  ["-10", -10],
  ['" 5"', " 5"],
  ['"1e1"', "1e1"],
  ['"abc"', "abc"],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["NaN", Number.NaN],
  ["true", true],
  ["false", false],
  ['{"a":1}', { a: 1 }],
  ["[1,2]", [1, 2]],
  ['"[1,2]"', "[1, 2]"],
  ['"{\\"a\\":1}"', '{"a":1}'],
];

/** Filter values: the scalars above, plus lists for IN. */
function filterValues(op: Filter["operator"]): Array<[string, unknown]> {
  if (op !== "IN") return VALUES;
  const lists: Array<[string, unknown]> = [["[]", []]];
  for (const [label, value] of VALUES) {
    lists.push([`[${label}]`, [value]]);
    lists.push([`[${label},"zz"]`, [value, "zz"]]);
  }
  lists.push(['[null,"a"]', [null, "a"]]);
  lists.push(["scalar 5", 5]);
  return lists;
}

/** The identity rule: `=` by `===`, every other operator "may match". */
function identityExcludes(filter: Filter, value: unknown): boolean {
  if (filter.operator !== "=") return false;
  return value !== filter.value;
}

interface ValueCell {
  type: ColumnType;
  stored: string;
  op: string;
  filter: string;
  sql: boolean | "insert-rejected" | "query-rejected";
  /** The judgment given the declared column type. */
  excludes: boolean;
  /** The judgment with no column type known. */
  untyped: boolean;
  /** The identity rule's judgment. */
  identity: boolean;
}

async function valueGrid(): Promise<ValueCell[]> {
  const cells: ValueCell[] = [];
  for (const type of COLUMN_TYPES) {
    const adapter = sqliteAdapter(":memory:");
    await adapter.ensureTable("t", {
      columns: { v: { type, optional: true } },
    });
    for (const [storedLabel, stored] of VALUES) {
      await adapter.rawQuery("DELETE FROM t");
      let inserted = true;
      try {
        await adapter.insert("t", { v: stored });
      } catch {
        inserted = false;
      }
      for (const op of OPERATORS) {
        for (const [filterLabel, filterValue] of filterValues(op)) {
          const filter: Filter = {
            column: "v",
            operator: op,
            value: filterValue,
          };
          let sql: ValueCell["sql"];
          if (!inserted) sql = "insert-rejected";
          else {
            try {
              sql =
                (await adapter
                  .query("t")
                  .where("v", op, filterValue)
                  .count()) === 1;
            } catch {
              sql = "query-rejected";
            }
          }
          cells.push({
            type,
            stored: storedLabel,
            op,
            filter: filterLabel,
            sql,
            excludes: filterExcludes(filter, stored, type),
            untyped: filterExcludes(filter, stored),
            identity: identityExcludes(filter, stored),
          });
        }
      }
    }
    await adapter.close();
  }
  return cells;
}

/* ------------------------------------------------------------------ */
/* Layer 2: engine grid                                                */
/* ------------------------------------------------------------------ */

interface Ids {
  A1: string;
  A2: string;
  B1: string;
  C1: string;
  G1: string;
  G2: string;
}

type Shape = (ctx: any, ids: Ids) => Promise<unknown>;

/** Query shapes: how a subscription reads `t`. */
const SHAPES: Record<string, Shape> = {
  none: (ctx) => ctx.db.table("t").order("name", "asc").all(),
  "scope = a": (ctx) =>
    ctx.db.table("t").where("scope", "=", "a").order("name", "asc").all(),
  "scope != a": (ctx) =>
    ctx.db.table("t").where("scope", "!=", "a").order("name", "asc").all(),
  "scope IN [a,b]": (ctx) =>
    ctx.db
      .table("t")
      .where("scope", "IN", ["a", "b"])
      .order("name", "asc")
      .all(),
  "scope IN []": (ctx) => ctx.db.table("t").where("scope", "IN", []).all(),
  "_id IN [A1,A2]": (ctx, ids) =>
    ctx.db
      .table("t")
      .where("_id", "IN", [ids.A1, ids.A2])
      .order("name", "asc")
      .all(),
  "_id = A1": (ctx, ids) => ctx.db.table("t").where("_id", "=", ids.A1).first(),
  "n < 10": (ctx) =>
    ctx.db.table("t").where("n", "<", 10).order("name", "asc").all(),
  "n = null": (ctx) =>
    ctx.db.table("t").where("n", "=", null).order("name", "asc").all(),
  "flag = true": (ctx) =>
    ctx.db.table("t").where("flag", "=", true).order("name", "asc").all(),
  "scope = a AND kind = k": (ctx) =>
    ctx.db
      .table("t")
      .where("scope", "=", "a")
      .where("kind", "=", "k")
      .order("name", "asc")
      .all(),
  "whereAny [[scope = a]]": (ctx) =>
    ctx.db
      .table("t")
      .whereAny([[{ column: "scope", operator: "=", value: "a" }]])
      .order("name", "asc")
      .all(),
  "whereAny [[scope = a],[kind = z]]": (ctx) =>
    ctx.db
      .table("t")
      .whereAny([
        [{ column: "scope", operator: "=", value: "a" }],
        [{ column: "kind", operator: "=", value: "z" }],
      ])
      .order("name", "asc")
      .all(),
  "select(name) scope = a": (ctx) =>
    ctx.db
      .table("t")
      .select("name")
      .where("scope", "=", "a")
      .order("name", "asc")
      .all(),
  "count scope = a": (ctx) =>
    ctx.db.table("t").where("scope", "=", "a").count(),
  "sum(n) scope = a": (ctx) =>
    ctx.db.table("t").where("scope", "=", "a").sum("n"),
  "groupBy kind scope = a": (ctx) =>
    ctx.db
      .table("t")
      .where("scope", "=", "a")
      .groupBy("kind", { c: "count" })
      .order("kind", "asc")
      .limit(10),
  "limit 1 scope = a": (ctx) =>
    ctx.db
      .table("t")
      .where("scope", "=", "a")
      .order("name", "asc")
      .limit(1)
      .all(),
  "two reads: scope = a, scope = b": async (ctx) => ({
    a: await ctx.db
      .table("t")
      .where("scope", "=", "a")
      .order("name", "asc")
      .all(),
    b: await ctx.db
      .table("t")
      .where("scope", "=", "b")
      .order("name", "asc")
      .all(),
  }),
  "read t scope = a, read u": async (ctx) => ({
    t: await ctx.db
      .table("t")
      .where("scope", "=", "a")
      .order("name", "asc")
      .all(),
    u: await ctx.db.table("u").order("name", "asc").all(),
  }),
  "raw SELECT scope = a": (ctx) =>
    ctx.db.sql("SELECT name FROM t WHERE scope = 'a' ORDER BY name"),
  "sqlOver scope IN [a,b]": (ctx) =>
    ctx.db.sqlOver(
      { t: [{ column: "scope", operator: "IN", value: ["a", "b"] }] },
      "SELECT scope, COUNT(*) AS n FROM t GROUP BY scope ORDER BY scope",
    ),
  "sqlOver _id = A1 (UNION ALL)": (ctx, ids) =>
    ctx.db.sqlOver(
      { t: [{ column: "_id", operator: "=", value: ids.A1 }] },
      "SELECT name FROM t UNION ALL SELECT name FROM t WHERE n > 0",
    ),
  "n = '5' (text twin)": (ctx) =>
    ctx.db.table("t").where("n", "=", "5").order("name", "asc").all(),
  "scope IN [a, null]": (ctx) =>
    ctx.db
      .table("t")
      .where("scope", "IN", ["a", null])
      .order("name", "asc")
      .all(),
  "whereAny [[scope = a],[n = null]]": (ctx) =>
    ctx.db
      .table("t")
      .whereAny([
        [{ column: "scope", operator: "=", value: "a" }],
        [{ column: "n", operator: "=", value: null }],
      ])
      .order("name", "asc")
      .all(),
  "groupBy kind having c >= 2": (ctx) =>
    ctx.db
      .table("t")
      .groupBy("kind", { c: "count" })
      .having("c", ">=", 2)
      .order("kind", "asc")
      .limit(10),
  "offset 1 scope = a": (ctx) =>
    ctx.db
      .table("t")
      .where("scope", "=", "a")
      .order("name", "asc")
      .limit(1)
      .offset(1)
      .all(),
  "first() scope = c (no order)": (ctx) =>
    ctx.db.table("t").select("name").where("scope", "=", "c").first(),
  "governed (alice: G1)": (ctx) =>
    ctx.db.table("g").order("title", "asc").all(),
  "avg(n) kind = k": (ctx) =>
    ctx.db.table("t").where("kind", "=", "k").avg("n"),
  "distinct(kind)": (ctx) => ctx.db.table("t").distinct("kind"),
  "flag IN [true]": (ctx) =>
    ctx.db.table("t").where("flag", "IN", [true]).order("name", "asc").all(),
};

type Write = (ctx: any, ids: Ids) => Promise<unknown>;

/** Write kinds: what a mutation does to `t` (or elsewhere). */
const WRITES: Record<string, Write> = {
  "insert scope a": (ctx) =>
    ctx.db
      .table("t")
      .insert({ scope: "a", kind: "k", name: "a9", n: 1, flag: false }),
  "insert scope c": (ctx) =>
    ctx.db
      .table("t")
      .insert({ scope: "c", kind: "z", name: "c9", n: 100, flag: false }),
  "insert scope c, n undefined": (ctx) =>
    ctx.db
      .table("t")
      .insert({ scope: "c", kind: "z", name: "c8", n: undefined, flag: false }),
  "insert scope c, flag true": (ctx) =>
    ctx.db
      .table("t")
      .insert({ scope: "c", kind: "z", name: "c7", n: 100, flag: true }),
  "update A1 kind": (ctx, ids) =>
    ctx.db.table("t").update(ids.A1, { kind: "k2" }),
  "update A1 kind (same value)": (ctx, ids) =>
    ctx.db.table("t").update(ids.A1, { kind: "k" }),
  "update C1 kind": (ctx, ids) =>
    ctx.db.table("t").update(ids.C1, { kind: "z2" }),
  "update C1 scope -> a (moves in)": (ctx, ids) =>
    ctx.db.table("t").update(ids.C1, { scope: "a" }),
  "update A1 scope -> c (moves out)": (ctx, ids) =>
    ctx.db.table("t").update(ids.A1, { scope: "c" }),
  "update C1 n -> 1": (ctx, ids) => ctx.db.table("t").update(ids.C1, { n: 1 }),
  "update C1 flag -> true": (ctx, ids) =>
    ctx.db.table("t").update(ids.C1, { flag: true }),
  "upsert keys{scope a,kind k} data{n}": (ctx) =>
    ctx.db
      .table("t")
      .upsert({ scope: "a", kind: "k" }, { n: 7, name: "a1", flag: false }),
  "upsert keys{scope c,kind q} data{n} (new row)": (ctx) =>
    ctx.db
      .table("t")
      .upsert({ scope: "c", kind: "q" }, { n: 7, name: "c6", flag: false }),
  "upsert keys{kind k} data{scope c}": (ctx) =>
    ctx.db
      .table("t")
      .upsert({ kind: "k" }, { scope: "c", n: 7, name: "x", flag: false }),
  "delete A1": (ctx, ids) => ctx.db.table("t").delete(ids.A1),
  "delete C1": (ctx, ids) => ctx.db.table("t").delete(ids.C1),
  "delete where scope = c": (ctx) =>
    ctx.db.table("t").where("scope", "=", "c").delete(),
  "delete where scope = a": (ctx) =>
    ctx.db.table("t").where("scope", "=", "a").delete(),
  "delete where scope = zz (no rows)": (ctx) =>
    ctx.db.table("t").where("scope", "=", "zz").delete(),
  "raw INSERT scope c": (ctx) =>
    ctx.db.sql(
      "INSERT INTO t (_id, scope, kind, name, n, flag) VALUES ('raw1','c','z','c5',100,0)",
    ),
  "raw UPDATE C1 kind": (ctx, ids) =>
    ctx.db.sql("UPDATE t SET kind = 'z3' WHERE _id = ?", ids.C1),
  "raw UPDATE A1 kind": (ctx, ids) =>
    ctx.db.sql("UPDATE t SET kind = 'k3' WHERE _id = ?", ids.A1),
  "insert into u (other table)": (ctx) =>
    ctx.db.table("u").insert({ name: "u9" }),
  "raw INSERT into u (other table)": (ctx) =>
    ctx.db.sql("INSERT INTO u (_id, name) VALUES ('rawu','u8')"),
  "insert scope c + insert into u": async (ctx) => {
    await ctx.db
      .table("t")
      .insert({ scope: "c", kind: "z", name: "c4", n: 100, flag: false });
    await ctx.db.table("u").insert({ name: "u7" });
  },
  "update C1 kind + update A1 kind": async (ctx, ids) => {
    await ctx.db.table("t").update(ids.C1, { kind: "z4" });
    await ctx.db.table("t").update(ids.A1, { kind: "k4" });
  },
  "read only (no write)": (ctx) => ctx.db.table("t").count(),
  "update A1 n -> '5' (text twin)": (ctx, ids) =>
    ctx.db.table("t").update(ids.A1, { n: "5" }),
  "update missing id": (ctx) => ctx.db.table("t").update("nope", { kind: "x" }),
  "delete missing id": (ctx) => ctx.db.table("t").delete("nope"),
  "upsert keys{scope a,kind k} data{kind q} (key changes)": (ctx) =>
    ctx.db
      .table("t")
      .upsert(
        { scope: "a", kind: "k" },
        { kind: "q", name: "a1", n: 5, flag: false },
      ),
  "insert scope a with own _id": (ctx) =>
    ctx.db.table("t").insert({
      _id: "own-a",
      scope: "a",
      kind: "k",
      name: "a7",
      n: 1,
      flag: false,
    }),
  "delete where scope IN [c]": (ctx) =>
    ctx.db.table("t").where("scope", "IN", ["c"]).delete(),
  "delete where n > 40": (ctx) =>
    ctx.db.table("t").where("n", ">", 40).delete(),
  "raw DELETE scope = c": (ctx) =>
    ctx.db.sql("DELETE FROM t WHERE scope = 'c'"),
  "governed: rename G1 (alice's)": (ctx, ids) =>
    ctx.db.table("g").update(ids.G1, { title: "mine!" }),
  "governed: rename G2 (other's)": (ctx, ids) =>
    ctx.db.table("g").update(ids.G2, { title: "other!" }),
  "governed: grant alice G2": (ctx) =>
    ctx.db.table("grants").insert({ userId: "alice", itemId: "G2" }),
  "governed: insert G3": (ctx) =>
    ctx.db.table("g").insert({ _id: "G3", title: "third" }),
};

/** Bulk inserts go through the engine, not a mutation context. */
const BULK: Record<string, (vex: Vex) => Promise<unknown>> = {
  "unsafeBulkInsert scope c": (vex) =>
    vex.unsafeBulkInsert("t", [
      { scope: "c", kind: "z", name: "c3", n: 100, flag: false },
    ]),
  "unsafeBulkInsert scope a": (vex) =>
    vex.unsafeBulkInsert("t", [
      { scope: "a", kind: "k", name: "a8", n: 1, flag: false },
    ]),
};

const runs = new Map<string, number>();

function matrixPlugin(api: VexPluginAPI) {
  api.setName("m");
  api.registerTable("t", {
    columns: {
      scope: { type: "string", index: true },
      kind: { type: "string", index: true },
      name: { type: "string" },
      n: { type: "number", optional: true },
      flag: { type: "boolean", optional: true },
    },
  });
  api.registerTable("u", { columns: { name: { type: "string" } } });
  api.registerTable("g", {
    columns: { title: { type: "string" } },
    access: {
      async prepare(user, db) {
        if (!user) return UNRESTRICTED;
        const grants = (await db
          .table("grants")
          .where("userId", "=", user.id)
          .all()) as Array<{ itemId: string }>;
        return { ids: grants.map((g) => g.itemId) };
      },
      row: (p: { ids: string[] }, row) => p.ids.includes(row._id),
      narrow: (p: { ids: string[] }) => ({
        where: [[{ column: "_id", operator: "IN", value: p.ids }]],
        reads: ["_id"],
      }),
    },
  });
  api.registerTable("grants", {
    columns: {
      userId: { type: "string", index: true },
      itemId: { type: "string", index: true },
    },
  });
  api.registerQuery("q", {
    args: { shape: "string", ids: "json" },
    async handler(ctx, args) {
      runs.set(args.shape, (runs.get(args.shape) ?? 0) + 1);
      return SHAPES[args.shape](ctx, args.ids as Ids);
    },
  });
  api.registerMutation("w", {
    args: { write: "string", ids: "json" },
    async handler(ctx, args) {
      await WRITES[args.write](ctx, args.ids as Ids);
    },
  });
  api.registerMutation("seed", {
    args: {},
    async handler(ctx) {
      const t = ctx.db.table("t");
      const ids = {
        A1: await t.insert({
          scope: "a",
          kind: "k",
          name: "a1",
          n: 5,
          flag: false,
        }),
        A2: await t.insert({
          scope: "a",
          kind: "x",
          name: "a2",
          n: 50,
          flag: true,
        }),
        B1: await t.insert({
          scope: "b",
          kind: "k",
          name: "b1",
          n: 5,
          flag: false,
        }),
        C1: await t.insert({
          scope: "c",
          kind: "z",
          name: "c1",
          n: null,
          flag: null,
        }),
      } as Ids;
      await ctx.db.table("u").insert({ name: "u1" });
      ids.G1 = await ctx.db.table("g").insert({ _id: "G1", title: "mine" });
      ids.G2 = await ctx.db.table("g").insert({ _id: "G2", title: "other" });
      await ctx.db.table("grants").insert({ userId: "alice", itemId: "G1" });
      return ids;
    },
  });
}

interface EngineCell {
  shape: string;
  write: string;
  changed: boolean;
  reran: boolean;
  /** changed && !reran: a stale subscription. */
  stale: boolean;
  /** !changed && reran: a re-run the oracle did not need. */
  wasted: boolean;
}

async function engineCell(
  shape: string,
  write: string,
  perform: (vex: Vex, ids: Ids) => Promise<unknown>,
): Promise<EngineCell> {
  const vex = await Vex.create({
    plugins: [matrixPlugin],
    storage: sqliteAdapter(":memory:"),
  });
  try {
    const ids = (await vex.mutate("m.seed", {})) as Ids;
    const args = { shape, ids };
    const as = shape.startsWith("governed")
      ? { user: { id: "alice", name: "Alice", isAdmin: false } }
      : undefined;
    const before = JSON.stringify(await vex.query("m.q", args, as));
    const unsubscribe = await vex.subscribe("m.q", args, () => {}, as);
    const runsBefore = runs.get(shape) ?? 0;
    await perform(vex, ids);
    const reran = (runs.get(shape) ?? 0) > runsBefore;
    unsubscribe();
    const after = JSON.stringify(await vex.query("m.q", args, as));
    const changed = before !== after;
    return {
      shape,
      write,
      changed,
      reran,
      stale: changed && !reran,
      wasted: !changed && reran,
    };
  } finally {
    await vex.close();
  }
}

async function engineGrid(): Promise<EngineCell[]> {
  const cells: EngineCell[] = [];
  for (const shape of Object.keys(SHAPES)) {
    for (const write of Object.keys(WRITES)) {
      cells.push(
        await engineCell(shape, write, (vex, ids) =>
          vex.mutate("m.w", { write, ids }),
        ),
      );
    }
    for (const [write, bulk] of Object.entries(BULK)) {
      cells.push(await engineCell(shape, write, (vex) => bulk(vex)));
    }
  }
  return cells;
}

/* ------------------------------------------------------------------ */
/* Reporting                                                           */
/* ------------------------------------------------------------------ */

function table(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
}

function code(s: string): string {
  return `\`${s.replaceAll("|", "\\|")}\``;
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe("invalidation matrix (SHFT-2537)", () => {
  test("value grid: filterExcludes never contradicts SQLite", async () => {
    const cells = await valueGrid();
    const judged = cells.filter((c) => typeof c.sql === "boolean");
    const unsound = judged.filter((c) => c.sql === true && c.excludes);
    const untypedUnsound = judged.filter((c) => c.sql === true && c.untyped);
    const identityUnsound = judged.filter((c) => c.sql === true && c.identity);
    const missed = judged.filter((c) => c.sql === false && !c.excludes);
    const untypedMissed = judged.filter((c) => c.sql === false && !c.untyped);
    const identityMissed = judged.filter((c) => c.sql === false && !c.identity);
    const rejected = cells.filter((c) => typeof c.sql !== "boolean");

    const byOp = (list: ValueCell[]) =>
      OPERATORS.map(
        (op) => `${op}: ${list.filter((c) => c.op === op).length}`,
      ).join(", ");

    sections.push(
      [
        "## Layer 1 — value grid (`filterExcludes` vs SQLite)",
        "",
        `Cells: ${cells.length} (${judged.length} judged by SQL, ${rejected.length} rejected by the adapter).`,
        "",
        table(
          [
            "judgment",
            "new, typed",
            "new, column type unknown",
            "identity (`===` on `=`)",
          ],
          [
            [
              "**unsound** (SQL matches, predicate excludes → stale view)",
              `${unsound.length}`,
              `${untypedUnsound.length}`,
              `${identityUnsound.length}`,
            ],
            [
              "imprecise (SQL misses, predicate keeps → needless re-run)",
              `${missed.length}`,
              `${untypedMissed.length}`,
              `${identityMissed.length}`,
            ],
          ],
        ),
        "",
        `Imprecise by operator, new typed: ${byOp(missed)}.`,
        `Imprecise by operator, new untyped: ${byOp(untypedMissed)}.`,
        `Imprecise by operator, identity: ${byOp(identityMissed)}.`,
        "",
        "### Identity rule unsound cells (`===` skipping a row SQL matches)",
        "",
        identityUnsound.length === 0
          ? "none"
          : table(
              ["column type", "stored", "op", "filter"],
              identityUnsound.map((c) => [
                c.type,
                code(c.stored),
                c.op,
                code(c.filter),
              ]),
            ),
        "",
        "### New predicate unsound cells (typed)",
        "",
        unsound.length === 0
          ? "none"
          : table(
              ["column type", "stored", "op", "filter"],
              unsound.map((c) => [
                c.type,
                code(c.stored),
                c.op,
                code(c.filter),
              ]),
            ),
        "",
        "### New predicate unsound cells (column type unknown)",
        "",
        untypedUnsound.length === 0
          ? "none"
          : table(
              ["column type", "stored", "op", "filter"],
              untypedUnsound.map((c) => [
                c.type,
                code(c.stored),
                c.op,
                code(c.filter),
              ]),
            ),
        "",
        "### New predicate imprecise cells (kept, SQL would not match)",
        "",
        missed.length === 0
          ? "none"
          : table(
              ["column type", "stored", "op", "filter"],
              missed.map((c) => [c.type, code(c.stored), c.op, code(c.filter)]),
            ),
        "",
        "### Adapter-rejected cells",
        "",
        rejected.length === 0
          ? "none"
          : table(
              ["column type", "stored", "op", "filter", "why"],
              rejected.map((c) => [
                c.type,
                code(c.stored),
                c.op,
                code(c.filter),
                String(c.sql),
              ]),
            ),
      ].join("\n"),
    );

    expect(unsound).toEqual([]);
    expect(untypedUnsound).toEqual([]);
  }, 120_000);

  test("engine grid: a changed result is always re-run", async () => {
    const cells = await engineGrid();
    const stale = cells.filter((c) => c.stale);
    const wasted = cells.filter((c) => c.wasted);
    const shapes = Object.keys(SHAPES);
    const writes = [...Object.keys(WRITES), ...Object.keys(BULK)];
    const mark = (c: EngineCell) =>
      c.stale ? "**STALE**" : c.changed ? "rerun" : c.reran ? "wasted" : "skip";

    sections.push(
      [
        "## Layer 2 — engine grid (write kind × query shape)",
        "",
        `Cells: ${cells.length}. Legend: **rerun** = result changed and the view re-ran; **skip** = unchanged and not re-run; **wasted** = unchanged but re-run; **STALE** = changed and not re-run (a bug).`,
        "",
        `Stale: ${stale.length}. Wasted: ${wasted.length} of ${cells.filter((c) => !c.changed).length} unchanged cells.`,
        "",
        table(
          ["write \\ shape", ...shapes.map(code)],
          writes.map((w) => [
            code(w),
            ...shapes.map((s) =>
              mark(cells.find((c) => c.shape === s && c.write === w)!),
            ),
          ]),
        ),
        "",
        "### Wasted re-runs grouped by cause",
        "",
        table(
          ["write", "shapes re-run without need"],
          writes
            .map(
              (w) =>
                [
                  w,
                  wasted.filter((c) => c.write === w).map((c) => c.shape),
                ] as const,
            )
            .filter(([, s]) => s.length > 0)
            .map(([w, s]) => [code(w), s.map(code).join(", ")]),
        ),
        "",
        "### Stale cells",
        "",
        stale.length === 0
          ? "none"
          : table(
              ["write", "shape"],
              stale.map((c) => [code(c.write), code(c.shape)]),
            ),
      ].join("\n"),
    );

    expect(stale).toEqual([]);
  }, 300_000);

  test("report", () => {
    if (!REPORT) return;
    writeFileSync(
      REPORT,
      [
        "# Invalidation matrix — SHFT-2537",
        "",
        `Generated ${new Date().toISOString()} on vex-core ${process.env.npm_package_version ?? ""}.`,
        "",
        ...sections,
        "",
      ].join("\n"),
    );
  });
});
