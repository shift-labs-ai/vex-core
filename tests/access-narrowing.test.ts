/**
 * Narrowed governed reads (SHFT-2481).
 *
 * A table access policy may say, as filters, which rows its `row` may
 * accept (`narrow`). A restricted read then asks SQL for those rows
 * only, for the columns the caller and `row` need, and for as many as
 * its window needs; `row` still decides every row fetched.
 *
 * Pinned here:
 *   - the invariant is unchanged: a narrowed governed table answers
 *     every read exactly as an ungoverned table holding only the rows
 *     the policy accepts (the mirror oracle);
 *   - the SQL a restricted read emits is one narrow statement: no
 *     `SELECT *`, the narrowing in its WHERE, the caller's LIMIT;
 *   - a narrowing that matches more than `row` accepts costs a
 *     refetch and is counted, never shown;
 *   - a policy that cannot narrow (`narrow` returning null, or none)
 *     keeps the whole-row path.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import {
  narrowingDrift,
  type TableAccessPolicy,
  UNRESTRICTED,
} from "../src/core/access.js";
import type { VexPluginAPI } from "../src/core/api.js";
import { Vex } from "../src/core/engine.js";
import type { VexUser } from "../src/core/types.js";
import { rawSql } from "../src/internal.js";
import { Type } from "../src/portable.js";

const alice: VexUser = { id: "alice", name: "Alice", isAdmin: false };
const admin: VexUser = { id: "root", name: "Root", isAdmin: true };

interface Prepared {
  userId: string;
  granted: string[];
}

/** Owned or granted, as every policy below decides it. */
function decide(prepared: Prepared, row: Record<string, any>): boolean {
  return row.ownerId === prepared.userId || prepared.granted.includes(row._id);
}

async function prepareFor(
  user: VexUser | null | undefined,
  db: { table(name: string): any },
): Promise<Prepared | typeof UNRESTRICTED> {
  if (!user || user.isAdmin) return UNRESTRICTED;
  const grants = (await db
    .table("grants")
    .where("userId", "=", user.id)
    .all()) as Array<{ docId: string }>;
  return { userId: user.id, granted: grants.map((g) => g.docId) };
}

/** Says exactly the rows `row` accepts. */
const exact: TableAccessPolicy<Prepared> = {
  prepare: prepareFor,
  row: decide,
  narrow: (p) => ({
    where: [
      [{ column: "ownerId", operator: "=", value: p.userId }],
      ...(p.granted.length > 0
        ? [[{ column: "_id", operator: "IN" as const, value: p.granted }]]
        : []),
    ],
    reads: ["_id", "ownerId"],
  }),
};

/** Lets every row of a second owner through too: `row` refuses those. */
const loose: TableAccessPolicy<Prepared> = {
  prepare: prepareFor,
  row: decide,
  narrow: (p) => ({
    where: [
      [{ column: "ownerId", operator: "IN", value: [p.userId, "bob"] }],
      [{ column: "_id", operator: "IN", value: p.granted }],
    ],
    reads: ["_id", "ownerId"],
  }),
};

/** Cannot say its rows: the whole-row path. */
const unsaid: TableAccessPolicy<Prepared> = {
  prepare: prepareFor,
  row: decide,
  narrow: () => null,
};

/** Says the caller may see nothing. */
const nothing: TableAccessPolicy<Prepared> = {
  prepare: prepareFor,
  row: decide,
  narrow: () => ({ where: [], reads: ["_id", "ownerId"] }),
};

const DOC_COLUMNS = {
  ownerId: Type.String({ index: true }),
  title: Type.String(),
  kind: Type.String(),
  score: Type.Optional(Type.Number()),
  /** The heavy column no window asks for. */
  body: Type.Optional(Type.String()),
};

const GOVERNED = { docs: exact, loose, unsaid, hidden: nothing } as const;
type Governed = keyof typeof GOVERNED;

function plugin(api: VexPluginAPI) {
  api.setName("nx");
  api.registerTable("grants", {
    columns: {
      userId: Type.String({ index: true }),
      docId: Type.String({ index: true }),
    },
  });
  for (const [name, access] of Object.entries(GOVERNED)) {
    api.registerTable(name, { columns: DOC_COLUMNS, access });
  }
  for (const oracle of ["mirror", "mirrorAll"]) {
    api.registerTable(oracle, { columns: DOC_COLUMNS });
  }

  api.registerQuery("run", {
    args: { op: Type.Unknown() },
    async handler(ctx, args) {
      const spec = args.op as {
        table: string;
        where?: Array<[string, any, any]>;
        any?: Array<Array<[string, any, any]>>;
        select?: string[];
        order?: [string, "asc" | "desc"];
        limit?: number;
        offset?: number;
        terminal: string;
        column?: string;
      };
      let q = ctx.db.table(spec.table);
      for (const [col, op, val] of spec.where ?? []) q = q.where(col, op, val);
      if (spec.any) {
        q = q.whereAny(
          spec.any.map((group) =>
            group.map(([column, operator, value]) => ({
              column,
              operator,
              value,
            })),
          ),
        );
      }
      if (spec.select) q = q.select(...spec.select);
      if (spec.order) q = q.order(spec.order[0], spec.order[1]);
      if (spec.limit !== undefined) q = q.limit(spec.limit);
      if (spec.offset !== undefined) q = q.offset(spec.offset);
      switch (spec.terminal) {
        case "all":
          return q.all();
        case "first":
          return q.first();
        case "count":
          return q.count();
        case "distinct":
          return q.distinct(spec.column ?? "kind");
        case "countDistinct":
          return q.countDistinct(spec.column ?? "kind");
        case "sum":
          return q.sum(spec.column ?? "score");
        case "avg":
          return q.avg(spec.column ?? "score");
        case "min":
          return q.min(spec.column ?? "score");
        case "max":
          return q.max(spec.column ?? "score");
      }
      throw new Error(`unknown terminal ${spec.terminal}`);
    },
  });

  api.registerQuery("grouped", {
    args: { table: Type.String(), spec: Type.Unknown() },
    async handler(ctx, args) {
      const spec = (args.spec ?? {}) as {
        columns?: string | string[];
        having?: Array<[string, any, any]>;
        order?: [string, "asc" | "desc"];
        limit?: number;
      };
      let chain = ctx.db.table(args.table).groupBy(spec.columns ?? "kind", {
        count: "count",
        total: ["sum", "score"],
        top: ["max", "score"],
        mean: ["avg", "score"],
        owners: ["countDistinct", "ownerId"],
      });
      for (const [col, op, val] of spec.having ?? [])
        chain = chain.having(col, op, val);
      if (spec.order) chain = chain.order(spec.order[0], spec.order[1]);
      if (spec.limit !== undefined) chain = chain.limit(spec.limit);
      return chain;
    },
  });

  api.registerQuery("twice", {
    args: {},
    async handler(ctx) {
      const q = ctx.db.table("docs").order("title", "asc");
      const count = await q.count();
      const rows = await q.all();
      return { count, rows: rows.length, whole: "body" in (rows[0] ?? {}) };
    },
  });

  api.registerMutation("anyInMutation", {
    args: {},
    async handler(ctx) {
      // A mutation's table reads take the same OR groups.
      const rows = await ctx.db
        .table("mirrorAll")
        .whereAny([
          [{ column: "ownerId", operator: "=", value: "carol" }],
          [{ column: "_id", operator: "=", value: "doc-000" }],
        ])
        .select("_id")
        .all();
      return rows.length;
    },
  });

  api.registerMutation("grant", {
    args: { userId: Type.String(), docId: Type.String() },
    async handler(ctx, args) {
      await ctx.db.table("grants").insert(args);
    },
  });
}

let open: Vex[] = [];

afterEach(async () => {
  await Promise.all(open.map((v) => v.close()));
  open = [];
});

async function create(): Promise<Vex> {
  const vex = await Vex.create({
    plugins: [plugin],
    storage: sqliteAdapter(":memory:"),
  });
  open.push(vex);
  return vex;
}

interface Doc {
  _id: string;
  ownerId: string;
  title: string;
  kind: string;
  score: number | null;
}

/**
 * Every governed table and `mirrorAll` hold the same rows, owned by
 * alice, bob and carol in turn, some of bob's granted to alice;
 * `mirror` holds the ones alice may see.
 */
async function seed(vex: Vex, total = 30): Promise<Doc[]> {
  const owners = ["alice", "bob", "carol"];
  const rows: Doc[] = [];
  for (let i = 0; i < total; i++) {
    rows.push({
      _id: `doc-${String(i).padStart(3, "0")}`,
      ownerId: owners[i % 3],
      title: `t-${String(i).padStart(3, "0")}`,
      kind: i % 4 === 0 ? "memo" : "report",
      score: i % 5 === 0 ? null : i,
    });
  }
  const granted = rows.filter((_, i) => i % 7 === 1).map((r) => r._id);
  for (const docId of granted) {
    await vex.mutate("nx.grant", { userId: "alice", docId });
  }
  const insert = async (table: string, docs: Doc[]) => {
    for (const r of docs) {
      await rawSql(
        vex,
        `INSERT INTO ${table} (_id, ownerId, title, kind, score, body) VALUES (?, ?, ?, ?, ?, ?)`,
        r._id,
        r.ownerId,
        r.title,
        r.kind,
        r.score,
        "x".repeat(64),
      );
    }
  };
  for (const table of [...Object.keys(GOVERNED), "mirrorAll"]) {
    await insert(table, rows);
  }
  const visible = rows.filter(
    (r) => r.ownerId === "alice" || granted.includes(r._id),
  );
  await insert("mirror", visible);
  return visible;
}

const run = (vex: Vex, user: VexUser | null, op: Record<string, unknown>) =>
  vex.query("nx.run", { op }, user ? { user } : undefined);

// Every statement records its SQL when it runs while a capture is
// open. The adapter caches statements, so one prepared once may run
// many times; bun:sqlite puts a statement's run methods on the
// statement itself, so each is wrapped as it is prepared.
let capturing: string[] | null = null;
{
  const db = Database.prototype as any;
  for (const method of ["prepare", "query"]) {
    const original = db[method];
    db[method] = function (sql: string, ...rest: unknown[]) {
      const statement = original.call(this, sql, ...rest);
      for (const run of ["all", "get", "values", "run", "iterate"]) {
        const own = statement[run];
        if (typeof own !== "function") continue;
        statement[run] = (...args: unknown[]) => {
          capturing?.push(sql);
          return own.apply(statement, args);
        };
      }
      return statement;
    };
  }
}

/** Every SQL statement executed while `fn` runs, in order. */
async function statements(fn: () => Promise<unknown>): Promise<string[]> {
  const seen: string[] = [];
  capturing = seen;
  try {
    await fn();
  } finally {
    capturing = null;
  }
  return seen;
}

const reads = (sqls: string[], table: string) =>
  sqls.filter((sql) => sql.includes(`FROM "${table}"`));

const SPECS: Array<Record<string, unknown>> = [
  { order: ["title", "asc"], terminal: "all" },
  { order: ["title", "asc"], limit: 3, offset: 2, terminal: "all" },
  {
    select: ["title", "kind"],
    order: ["title", "desc"],
    limit: 4,
    terminal: "all",
  },
  {
    where: [["kind", "=", "memo"]],
    order: ["title", "asc"],
    offset: 1,
    terminal: "all",
  },
  {
    any: [[["kind", "=", "memo"]], [["score", ">", 20]]],
    select: ["title"],
    order: ["title", "asc"],
    terminal: "all",
  },
  { where: [["score", "=", null]], order: ["title", "asc"], terminal: "all" },
  {
    where: [["score", ">", 5]],
    order: ["score", "desc"],
    limit: 2,
    terminal: "all",
  },
  {
    select: ["title"],
    order: ["title", "asc"],
    offset: 2,
    terminal: "first",
  },
  { order: ["title", "asc"], limit: 50, offset: 100, terminal: "all" },
  { limit: 3, terminal: "count" },
  {
    order: ["title", "asc"],
    limit: 2,
    offset: 1,
    terminal: "distinct",
    column: "kind",
  },
  { terminal: "countDistinct", column: "ownerId" },
  { where: [["kind", "=", "memo"]], terminal: "sum", column: "score" },
  { where: [["kind", "=", "report"]], terminal: "avg", column: "score" },
  { terminal: "min", column: "score" },
  { terminal: "max", column: "score" },
];

const GROUP_SPECS: Array<Record<string, unknown>> = [
  { order: ["kind", "asc"] },
  { columns: ["kind", "ownerId"], order: ["kind", "asc"] },
  { having: [["count", ">", 2]], order: ["count", "desc"] },
  {
    having: [
      ["top", "<", 100],
      ["owners", "IN", [1, 2]],
    ],
    order: ["kind", "desc"],
    limit: 1,
  },
];

/** A plain copy of a result, to compare with its oracle's. */
const same = (value: unknown) => JSON.parse(JSON.stringify(value ?? null));

/**
 * Groups in a canonical order: a group order that ties (`kind` over
 * `kind, ownerId` groups) is the plan's in SQL and insertion order in
 * JS, so only the set is the contract there.
 */
const groups = (value: unknown) =>
  (same(value) as unknown[]).map((group) => JSON.stringify(group)).sort();

describe("narrowed governed reads", () => {
  for (const table of ["docs", "loose", "unsaid"] as Governed[]) {
    test(`${table}: every read matches the oracle of visible rows, restricted and unrestricted`, async () => {
      const vex = await create();
      await seed(vex);
      for (const spec of SPECS) {
        expect({
          spec,
          value: same(await run(vex, alice, { ...spec, table })),
        }).toEqual({
          spec,
          value: same(await run(vex, null, { ...spec, table: "mirror" })),
        });
        expect({
          spec,
          value: same(await run(vex, admin, { ...spec, table })),
        }).toEqual({
          spec,
          value: same(await run(vex, null, { ...spec, table: "mirrorAll" })),
        });
      }
      for (const spec of GROUP_SPECS) {
        const compare = spec.limit === undefined ? groups : same;
        expect({
          spec,
          value: compare(
            await vex.query("nx.grouped", { table, spec }, { user: alice }),
          ),
        }).toEqual({
          spec,
          value: compare(
            await vex.query("nx.grouped", { table: "mirror", spec }),
          ),
        });
      }
    });
  }

  test("a restricted window is one statement: the caller's columns and the policy's, the narrowing, the caller's limit", async () => {
    const vex = await create();
    const visible = await seed(vex);
    let rows: unknown;
    const sqls = await statements(async () => {
      rows = await run(vex, alice, {
        table: "docs",
        where: [["kind", "!=", "draft"]],
        select: ["title"],
        order: ["title", "desc"],
        limit: 5,
        terminal: "all",
      });
    });
    expect(rows).toEqual(
      visible
        .slice()
        .reverse()
        .slice(0, 5)
        .map((r) => ({ title: r.title })),
    );
    const docReads = reads(sqls, "docs");
    expect(docReads).toHaveLength(1);
    const [sql] = docReads;
    expect(sql).toStartWith('SELECT "title", "_id", "ownerId" FROM "docs"');
    expect(sql).toContain('"kind" != ?');
    expect(sql).toContain('(("ownerId" = ?) OR (("_id" IN (');
    expect(sql).toContain('ORDER BY "title" desc LIMIT 5');
    expect(sql).not.toContain("*");
    expect(sql).not.toContain("body");
  });

  test("an aggregate fetches only the column it aggregates and the policy's", async () => {
    const vex = await create();
    await seed(vex);
    const sqls = await statements(() =>
      run(vex, alice, { table: "docs", terminal: "sum", column: "score" }),
    );
    expect(reads(sqls, "docs")).toEqual([
      expect.stringMatching(
        /^SELECT "score", "_id", "ownerId" FROM "docs" WHERE /,
      ),
    ]);
    const counted = await statements(() =>
      run(vex, alice, { table: "docs", terminal: "count" }),
    );
    expect(reads(counted, "docs")).toEqual([
      expect.stringMatching(/^SELECT "_id", "ownerId" FROM "docs" WHERE /),
    ]);
  });

  test("an unrestricted caller's read is untouched by the narrowing", async () => {
    const vex = await create();
    await seed(vex);
    const sqls = await statements(() =>
      run(vex, admin, {
        table: "docs",
        select: ["title"],
        order: ["title", "asc"],
        limit: 5,
        terminal: "all",
      }),
    );
    expect(reads(sqls, "docs")).toEqual([
      'SELECT "title" FROM "docs"  ORDER BY "title" asc LIMIT 5',
    ]);
  });

  test("a narrowing that lets more through costs a refetch and is counted, never shown", async () => {
    const vex = await create();
    const visible = await seed(vex);
    const before = narrowingDrift().loose ?? 0;
    let rows: unknown;
    const sqls = await statements(async () => {
      rows = await run(vex, alice, {
        table: "loose",
        select: ["title"],
        order: ["title", "asc"],
        limit: 4,
        terminal: "all",
      });
    });
    expect(rows).toEqual(visible.slice(0, 4).map((r) => ({ title: r.title })));
    // bob's rows came back and were refused: the first window ran
    // short and grew.
    const looseReads = reads(sqls, "loose");
    expect(looseReads).toHaveLength(2);
    expect(looseReads[0]).toContain("LIMIT 4");
    expect(looseReads[1]).toContain("LIMIT 16");
    // Counted once, from the answer's own fetch: of its 16 rows, bob's
    // six ungranted ones (docs 4, 7, 10, 13, 16 and 19).
    expect((narrowingDrift().loose ?? 0) - before).toBe(6);
    // The exact narrowing never drifts.
    await run(vex, alice, {
      table: "docs",
      order: ["title", "asc"],
      terminal: "all",
    });
    expect(narrowingDrift().docs ?? 0).toBe(0);
  });

  test("a policy that cannot narrow keeps the whole-row path", async () => {
    const vex = await create();
    await seed(vex);
    const sqls = await statements(() =>
      run(vex, alice, {
        table: "unsaid",
        select: ["title"],
        order: ["title", "asc"],
        limit: 5,
        terminal: "all",
      }),
    );
    const [first] = reads(sqls, "unsaid");
    expect(first).toStartWith('SELECT * FROM "unsaid"');
    expect(first).toContain("LIMIT 64");
  });

  test("a narrowing with no group answers nothing: its SQL matches no row", async () => {
    const vex = await create();
    await seed(vex);
    let rows: unknown;
    const sqls = await statements(async () => {
      rows = await run(vex, alice, {
        table: "hidden",
        order: ["title", "asc"],
        limit: 5,
        terminal: "all",
      });
    });
    expect(rows).toEqual([]);
    expect(reads(sqls, "hidden")[0]).toContain("0 = 1");
    expect(await run(vex, alice, { table: "hidden", terminal: "count" })).toBe(
      0,
    );
  });

  test("a builder read twice narrows once", async () => {
    const vex = await create();
    const visible = await seed(vex);
    let result: unknown;
    const sqls = await statements(async () => {
      result = await vex.query("nx.twice", {}, { user: alice });
    });
    // The count's narrow columns do not stick to the chain: `all()`
    // with no select still answers whole rows.
    expect(result).toEqual({
      count: visible.length,
      rows: visible.length,
      whole: true,
    });
    const docReads = reads(sqls, "docs");
    expect(docReads).toHaveLength(2);
    for (const sql of docReads) {
      expect(sql.match(/"ownerId" = \?/g)).toHaveLength(1);
    }
  });

  test("subscriptions re-narrow on each run: a grant widens the window", async () => {
    const vex = await create();
    await seed(vex);
    const seen: number[] = [];
    await vex.subscribe(
      "nx.run",
      { op: { table: "docs", terminal: "count" } },
      (n) => seen.push(n as number),
      { user: alice },
    );
    const before = seen[0];
    await vex.mutate("nx.grant", { userId: "alice", docId: "doc-002" });
    expect(seen[seen.length - 1]).toBe(before + 1);
  });
});

describe("whereAny", () => {
  test("ORs its groups and ANDs each group, on ungoverned tables too", async () => {
    const vex = await create();
    await seed(vex);
    const rows = (await run(vex, null, {
      table: "mirrorAll",
      any: [
        [
          ["ownerId", "=", "carol"],
          ["kind", "=", "memo"],
        ],
        [["_id", "IN", ["doc-001", "doc-003"]]],
      ],
      select: ["_id"],
      order: ["_id", "asc"],
      terminal: "all",
    })) as Array<{ _id: string }>;
    expect(rows.map((r) => r._id)).toEqual([
      "doc-001",
      "doc-003",
      "doc-008",
      "doc-020",
    ]);
    expect(
      await run(vex, null, { table: "mirrorAll", any: [], terminal: "count" }),
    ).toBe(0);
    expect(
      await run(vex, null, {
        table: "mirrorAll",
        any: [[]],
        terminal: "count",
      }),
    ).toBe(30);
    // carol's ten, and doc-000.
    expect(await vex.mutate("nx.anyInMutation", {})).toBe(11);
  });
});
