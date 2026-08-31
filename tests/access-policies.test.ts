/**
 * Table access policies — row-level visibility as an engine contract.
 *
 * A plugin may attach an `access` policy to a table:
 *
 *   access: {
 *     prepare(user, db)  → UNRESTRICTED | P     (I/O, once per operation)
 *     row(prepared, row) → boolean              (pure, per row)
 *   }
 *
 * The engine then enforces the policy on every query-context read of
 * that table. The governing invariant, pinned by everything below:
 *
 *   A governed table behaves IDENTICALLY for a restricted caller as
 *   an ungoverned table containing only the rows their policy
 *   accepts.
 *
 * That makes `.limit(n)` mean "n rows this caller may see", `count()`
 * mean "rows this caller may see", and so on — handlers write plain
 * bounded queries and stop knowing authorization exists. Raw SQL over
 * a governed table throws for every caller: a handler that behaves
 * differently per caller is the bug class this feature removes, and
 * there is deliberately no escape hatch. Mutation contexts are the
 * trusted tier and stay ungoverned.
 *
 * The toy model: `docs` rows are visible to their owner and to users
 * granted through the `grants` table; admins and userless (internal)
 * calls are unrestricted. `grants` is read through the policy's
 * `prepare`, which makes visibility itself reactive — a grant write
 * re-runs live subscriptions.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import { UNRESTRICTED } from "../src/core/access.js";
import type { VexPluginAPI } from "../src/core/api.js";
import { Vex } from "../src/core/engine.js";
import type { VexUser } from "../src/core/types.js";

const alice: VexUser = { id: "alice", name: "Alice", isAdmin: false };
const bob: VexUser = { id: "bob", name: "Bob", isAdmin: false };
const admin: VexUser = { id: "root", name: "Root", isAdmin: true };

let open: Vex[] = [];
let prepareCalls = 0;

afterEach(async () => {
  await Promise.all(open.map((v) => v.close()));
  open = [];
  prepareCalls = 0;
});

interface DocRow {
  _id: string;
  ownerId: string;
  title: string;
  kind: string;
  score: number | null;
}

function docsPlugin(api: VexPluginAPI) {
  api.setName("dx");
  api.registerTable("grants", {
    columns: {
      userId: { type: "string", index: true },
      docId: { type: "string", index: true },
    },
  });
  api.registerTable("docs", {
    columns: {
      ownerId: { type: "string", index: true },
      title: { type: "string" },
      kind: { type: "string" },
      score: { type: "number", optional: true },
    },
    access: {
      async prepare(user, db) {
        prepareCalls++;
        if (!user || user.isAdmin) return UNRESTRICTED;
        const grants = await db
          .table("grants")
          .where("userId", "=", user.id)
          .all<{ docId: string }>();
        return {
          userId: user.id,
          granted: new Set(grants.map((g) => g.docId)),
        };
      },
      row(prepared, row) {
        const p = prepared as { userId: string; granted: Set<string> };
        return row.ownerId === p.userId || p.granted.has(row._id);
      },
    },
  });
  // The same rows with no policy — the equivalence oracles. A
  // restricted read of `docs` must equal the same read of `mirror`
  // (only the accessible rows); an unrestricted read of `docs` must
  // equal the same read of `mirrorAll` (every row) — which pins the
  // guard's release path, where held select/limit/offset are handed
  // back to SQL.
  for (const oracle of ["mirror", "mirrorAll"]) {
    api.registerTable(oracle, {
      columns: {
        ownerId: { type: "string", index: true },
        title: { type: "string" },
        kind: { type: "string" },
        score: { type: "number", optional: true },
      },
    });
  }
  // A second governed table with its own policy: a handler reading
  // both must resolve two independent prepared contexts.
  api.registerTable("pets", {
    columns: { ownerId: { type: "string", index: true }, name: { type: "string" } },
    access: {
      prepare(user) {
        if (!user || user.isAdmin) return UNRESTRICTED;
        return user.id;
      },
      row(prepared, row) {
        return row.ownerId === prepared;
      },
    },
  });
  // A governed table whose policy fails — failures must reject the
  // operation, never fail open.
  api.registerTable("vault", {
    columns: { name: { type: "string" } },
    access: {
      prepare(user) {
        if (!user) return UNRESTRICTED;
        if (user.id === "alice") throw new Error("prepare exploded");
        return user.id;
      },
      row(_prepared, row) {
        if (row.name === "mine") throw new Error("row verdict exploded");
        return false;
      },
    },
  });

  api.registerQuery("run", {
    args: { op: "json" },
    // The test drives arbitrary builder chains through one query so
    // every read path is exercised inside a real query context.
    async handler(ctx, args) {
      const spec = args.op as {
        table: string;
        where?: Array<[string, any, any]>;
        select?: string[];
        order?: [string, "asc" | "desc"];
        limit?: number;
        offset?: number;
        terminal:
          | "all"
          | "first"
          | "count"
          | "distinct"
          | "countDistinct"
          | "sum"
          | "avg"
          | "min"
          | "max"
          | "delete";
        column?: string;
      };
      let q = ctx.db.table(spec.table);
      for (const [col, op, val] of spec.where ?? []) q = q.where(col, op, val);
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
        case "delete":
          return q.delete();
      }
    },
  });

  api.registerQuery("grouped", {
    args: { table: "string", spec: "json" },
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

  api.registerQuery("bothGoverned", {
    args: {},
    async handler(ctx) {
      return {
        docs: (await ctx.db.table("docs").all()).length,
        pets: (await ctx.db.table("pets").all()).length,
      };
    },
  });

  api.registerQuery("vaultRead", {
    args: {},
    async handler(ctx) {
      return ctx.db.table("vault").all();
    },
  });

  api.registerQuery("rawRead", {
    args: {},
    async handler(ctx) {
      return ctx.db.sql("SELECT * FROM docs ORDER BY title ASC");
    },
  });

  api.registerQuery("rawJoin", {
    args: {},
    async handler(ctx) {
      return ctx.db.sql(
        "SELECT g.userId FROM grants g JOIN docs d ON d._id = g.docId",
      );
    },
  });

  api.registerQuery("rawUngoverned", {
    args: {},
    async handler(ctx) {
      return ctx.db.sql("SELECT COUNT(*) AS n FROM grants");
    },
  });

  api.registerQuery("twoReads", {
    args: {},
    async handler(ctx) {
      // Two separate chains over the governed table in one handler:
      // the policy's prepare must run once, not per chain.
      const a = await ctx.db.table("docs").count();
      const b = await ctx.db.table("docs").order("title", "asc").all();
      return { count: a, rows: b.length };
    },
  });

  api.registerMutation("addDoc", {
    args: { id: "string", ownerId: "string", title: "string", kind: "string" },
    async handler(ctx, args) {
      await ctx.db.table("docs").insert({
        _id: args.id,
        ownerId: args.ownerId,
        title: args.title,
        kind: args.kind,
        score: null,
      });
    },
  });

  api.registerMutation("grant", {
    args: { userId: "string", docId: "string" },
    async handler(ctx, args) {
      await ctx.db.table("grants").insert(args);
    },
  });

  api.registerMutation("mutationReadsAll", {
    args: {},
    async handler(ctx) {
      // Mutation contexts are the trusted tier: reads are ungoverned.
      return (await ctx.db.table("docs").all()).length;
    },
  });
}

async function create(): Promise<Vex> {
  const vex = await Vex.create({
    plugins: [docsPlugin],
    storage: sqliteAdapter(":memory:"),
  });
  open.push(vex);
  return vex;
}

/**
 * Seed `docs` with interleaved ownership plus a `mirror` holding only
 * Alice's accessible rows. Titles sort so accessibility alternates —
 * every limit/offset test crosses inaccessible rows.
 */
async function seed(vex: Vex, total = 20): Promise<DocRow[]> {
  const accessible: DocRow[] = [];
  for (let i = 0; i < total; i++) {
    const mine = i % 2 === 0;
    const granted = i % 5 === 4; // bob-owned but granted to alice
    const row: DocRow = {
      _id: `doc-${String(i).padStart(3, "0")}`,
      ownerId: mine ? "alice" : "bob",
      title: `t-${String(i).padStart(3, "0")}`,
      kind: i % 3 === 0 ? "memo" : "report",
      score: i % 4 === 0 ? null : i,
    };
    await vex.mutate("dx.addDoc", {
      id: row._id,
      ownerId: row.ownerId,
      title: row.title,
      kind: row.kind,
    });
    if (row.score !== null) {
      await vex.unsafeSql("UPDATE docs SET score = ? WHERE _id = ?", row.score, row._id);
    }
    if (granted) await vex.mutate("dx.grant", { userId: "alice", docId: row._id });
    if (mine || granted) accessible.push(row);
  }
  for (const row of accessible) {
    await vex.unsafeSql(
      "INSERT INTO mirror (_id, ownerId, title, kind, score) VALUES (?, ?, ?, ?, ?)",
      `m-${row._id}`,
      row.ownerId,
      row.title,
      row.kind,
      row.score,
    );
  }
  await vex.unsafeSql(
    "INSERT INTO mirrorAll (_id, ownerId, title, kind, score) SELECT 'a-' || _id, ownerId, title, kind, score FROM docs",
  );
  return accessible;
}

const run = (vex: Vex, user: VexUser | null, op: Record<string, unknown>) =>
  vex.query("dx.run", { op }, user ? { user } : undefined);

describe("table access policies", () => {
  test("unrestricted callers (internal, admin) see every row", async () => {
    const vex = await create();
    await seed(vex);
    const internal = (await run(vex, null, { table: "docs", terminal: "all" })) as DocRow[];
    const asAdmin = (await run(vex, admin, { table: "docs", terminal: "all" })) as DocRow[];
    expect(internal.length).toBe(20);
    expect(asAdmin.length).toBe(20);
  });

  test("a restricted caller sees exactly their owned and granted rows, in order", async () => {
    const vex = await create();
    const accessible = await seed(vex);
    const rows = (await run(vex, alice, {
      table: "docs",
      order: ["title", "asc"],
      terminal: "all",
    })) as DocRow[];
    expect(rows.map((r) => r._id)).toEqual(accessible.map((r) => r._id));
    // Nothing of Bob's leaks.
    expect(rows.every((r) => r.ownerId === "alice" || r.ownerId === "bob")).toBe(true);
    const bobRows = (await run(vex, bob, {
      table: "docs",
      order: ["title", "asc"],
      terminal: "all",
    })) as DocRow[];
    expect(bobRows.every((r) => r.ownerId === "bob")).toBe(true);
  });

  test("limit means 'n rows this caller may see', across interleaved inaccessible rows", async () => {
    const vex = await create();
    const accessible = await seed(vex);
    const rows = (await run(vex, alice, {
      table: "docs",
      order: ["title", "asc"],
      limit: 5,
      terminal: "all",
    })) as DocRow[];
    expect(rows.map((r) => r._id)).toEqual(accessible.slice(0, 5).map((r) => r._id));
  });

  test("offset pages the accessible stream, not the raw table", async () => {
    const vex = await create();
    const accessible = await seed(vex);
    const rows = (await run(vex, alice, {
      table: "docs",
      order: ["title", "asc"],
      limit: 4,
      offset: 3,
      terminal: "all",
    })) as DocRow[];
    expect(rows.map((r) => r._id)).toEqual(
      accessible.slice(3, 7).map((r) => r._id),
    );
  });

  test("a window past the accessible rows is empty, not an error", async () => {
    const vex = await create();
    const accessible = await seed(vex);
    expect(
      await run(vex, alice, {
        table: "docs",
        order: ["title", "asc"],
        limit: 5,
        offset: accessible.length,
        terminal: "all",
      }),
    ).toEqual([]);
    expect(
      await run(vex, alice, {
        table: "docs",
        offset: accessible.length,
        terminal: "first",
      }),
    ).toBeNull();
  });

  test("the refill loop grows past sparse prefixes until the window fills", async () => {
    // 200 rows where only the LAST few are Alice's: the first fetch
    // (needed*2, floored at the minimum fetch size) accepts nothing,
    // and only a grown refetch reaches her rows. Pins the loop's
    // growth branch — a refill that never refills returns an
    // under-filled window instead of the caller's limit.
    const vex = await create();
    for (let i = 0; i < 200; i++) {
      await vex.mutate("dx.addDoc", {
        id: `sparse-${String(i).padStart(3, "0")}`,
        ownerId: i >= 195 ? "alice" : "bob",
        title: `s-${String(i).padStart(3, "0")}`,
        kind: "memo",
      });
    }
    const rows = (await run(vex, alice, {
      table: "docs",
      order: ["title", "asc"],
      limit: 3,
      terminal: "all",
    })) as DocRow[];
    expect(rows.map((r) => r._id)).toEqual([
      "sparse-195",
      "sparse-196",
      "sparse-197",
    ]);
  });

  test("first returns the first accessible row", async () => {
    const vex = await create();
    const accessible = await seed(vex);
    const first = (await run(vex, alice, {
      table: "docs",
      order: ["title", "desc"],
      terminal: "first",
    })) as DocRow;
    expect(first._id).toBe(accessible[accessible.length - 1]._id);
    const projected = await run(vex, alice, {
      table: "docs",
      select: ["title"],
      order: ["title", "asc"],
      terminal: "first",
    });
    expect(projected).toEqual({ title: accessible[0].title });
    const none = await run(vex, alice, {
      table: "docs",
      where: [["ownerId", "=", "bob"], ["kind", "=", "memo"], ["score", "=", -1]],
      terminal: "first",
    });
    expect(none).toBeNull();
  });

  test("select projects the requested columns while filtering on unselected ones", async () => {
    const vex = await create();
    const accessible = await seed(vex);
    const rows = (await run(vex, alice, {
      table: "docs",
      select: ["title"],
      order: ["title", "asc"],
      limit: 3,
      terminal: "all",
    })) as Array<Record<string, unknown>>;
    expect(rows).toEqual(
      accessible.slice(0, 3).map((r) => ({ title: r.title })),
    );
  });

  test("every aggregate matches the mirror of accessible rows", async () => {
    const vex = await create();
    await seed(vex);
    for (const terminal of [
      "count",
      "distinct",
      "countDistinct",
      "sum",
      "avg",
      "min",
      "max",
    ] as const) {
      const governed = await run(vex, alice, {
        table: "docs",
        order: ["title", "asc"],
        terminal,
      });
      const mirror = await run(vex, null, {
        table: "mirror",
        order: ["title", "asc"],
        terminal,
      });
      expect({ terminal, value: governed }).toEqual({ terminal, value: mirror });
    }
  });

  test("groupBy over a governed table matches the mirror", async () => {
    const vex = await create();
    await seed(vex);
    const governed = await vex.query("dx.grouped", { table: "docs" }, { user: alice });
    const mirror = await vex.query("dx.grouped", { table: "mirror" });
    expect(governed).toEqual(mirror);
  });

  test("filtered reads compose with the policy", async () => {
    const vex = await create();
    const accessible = await seed(vex);
    const memos = (await run(vex, alice, {
      table: "docs",
      where: [["kind", "=", "memo"]],
      order: ["title", "asc"],
      terminal: "all",
    })) as DocRow[];
    expect(memos.map((r) => r._id)).toEqual(
      accessible.filter((r) => r.kind === "memo").map((r) => r._id),
    );
  });

  test("raw SQL over a governed table throws for every caller", async () => {
    const vex = await create();
    await seed(vex);
    await expect(vex.query("dx.rawRead", {}, { user: admin })).rejects.toThrow(
      /access-governed/,
    );
    await expect(vex.query("dx.rawRead", {})).rejects.toThrow(/docs/);
    await expect(vex.query("dx.rawJoin", {}, { user: alice })).rejects.toThrow(
      /access-governed/,
    );
    // Raw SQL over ungoverned tables is untouched.
    const counts = (await vex.query("dx.rawUngoverned", {})) as Array<{ n: number }>;
    expect(counts[0].n).toBeGreaterThan(0);
  });

  test("bulk delete through a query context is refused for restricted callers", async () => {
    const vex = await create();
    await seed(vex);
    await expect(
      run(vex, alice, { table: "docs", terminal: "delete" }),
    ).rejects.toThrow(/query context/);
    // The rows survive.
    expect(await run(vex, null, { table: "docs", terminal: "count" })).toBe(20);
  });

  test("mutation contexts stay ungoverned — the trusted tier", async () => {
    const vex = await create();
    await seed(vex);
    expect(await vex.mutate("dx.mutationReadsAll", {}, { user: alice })).toBe(20);
  });

  test("prepare runs once per operation, not once per chain", async () => {
    const vex = await create();
    await seed(vex);
    prepareCalls = 0;
    const result = (await vex.query("dx.twoReads", {}, { user: alice })) as {
      count: number;
      rows: number;
    };
    expect(prepareCalls).toBe(1);
    expect(result.count).toBe(result.rows);
  });

  test("every windowed read matches its oracle, restricted and unrestricted alike", async () => {
    // The spec matrix × caller matrix: alice (restricted, JS
    // evaluation) against the accessible mirror, admin (unrestricted,
    // the guard's release path) against the full mirror. Any
    // divergence between the two implementations of one read is a
    // policy bug by definition.
    const vex = await create();
    await seed(vex);
    const specs: Array<Record<string, unknown>> = [
      { order: ["title", "asc"], limit: 3, offset: 2, terminal: "all" },
      { select: ["title", "kind"], order: ["title", "desc"], limit: 4, terminal: "all" },
      { where: [["kind", "=", "memo"]], order: ["title", "asc"], offset: 1, terminal: "all" },
      { where: [["kind", "IN", ["memo", "report"]]], order: ["title", "asc"], terminal: "all" },
      { where: [["score", "=", null]], order: ["title", "asc"], terminal: "all" },
      { where: [["score", ">", 5]], order: ["score", "desc"], limit: 2, terminal: "all" },
      { select: ["title"], order: ["title", "asc"], offset: 2, terminal: "first" },
      { limit: 3, terminal: "count" },
      { order: ["title", "asc"], limit: 2, offset: 1, terminal: "distinct", column: "kind" },
      { terminal: "countDistinct", column: "ownerId" },
      { where: [["kind", "=", "memo"]], terminal: "sum", column: "score" },
      { where: [["kind", "=", "report"]], terminal: "avg", column: "score" },
      { terminal: "min", column: "score" },
      { terminal: "max", column: "score" },
    ];
    const strip = (value: unknown) =>
      Array.isArray(value)
        ? value.map((row) =>
            row && typeof row === "object" && "_id" in (row as object)
              ? { ...(row as object), _id: "~" }
              : row,
          )
        : value && typeof value === "object" && "_id" in (value as object)
          ? { ...(value as object), _id: "~" }
          : value;
    for (const spec of specs) {
      const restricted = strip(await run(vex, alice, { ...spec, table: "docs" }));
      const restrictedOracle = strip(await run(vex, null, { ...spec, table: "mirror" }));
      expect({ spec, value: restricted }).toEqual({ spec, value: restrictedOracle });
      const released = strip(await run(vex, admin, { ...spec, table: "docs" }));
      const releasedOracle = strip(await run(vex, null, { ...spec, table: "mirrorAll" }));
      expect({ spec, value: released }).toEqual({ spec, value: releasedOracle });
    }
  });

  test("groupBy variants match their oracles for both caller kinds", async () => {
    const vex = await create();
    await seed(vex);
    const specs: Array<Record<string, unknown>> = [
      {},
      { columns: ["kind", "ownerId"], order: ["kind", "asc"] },
      { having: [["count", ">", 2]], order: ["count", "desc"] },
      { having: [["top", "<", 100], ["owners", "IN", [1, 2]]], order: ["kind", "desc"], limit: 1 },
    ];
    const sorted = (rows: unknown) =>
      JSON.parse(JSON.stringify(rows)) as Array<Record<string, unknown>>;
    for (const spec of specs) {
      expect({
        spec,
        value: sorted(await vex.query("dx.grouped", { table: "docs", spec }, { user: alice })),
      }).toEqual({
        spec,
        value: sorted(await vex.query("dx.grouped", { table: "mirror", spec })),
      });
      expect({
        spec,
        value: sorted(await vex.query("dx.grouped", { table: "docs", spec }, { user: admin })),
      }).toEqual({
        spec,
        value: sorted(await vex.query("dx.grouped", { table: "mirrorAll", spec })),
      });
    }
  });

  test("two governed tables resolve independent prepared contexts", async () => {
    const vex = await create();
    await seed(vex, 4);
    await vex.unsafeSql(
      "INSERT INTO pets (_id, ownerId, name) VALUES ('p1','alice','rex'), ('p2','bob','tux')",
    );
    prepareCalls = 0;
    const result = (await vex.query("dx.bothGoverned", {}, { user: alice })) as {
      docs: number;
      pets: number;
    };
    // docs' prepare ran once (counter is docs-only); pets filtered by
    // its own policy to Alice's single pet.
    expect(prepareCalls).toBe(1);
    expect(result.pets).toBe(1);
    expect(result.docs).toBe(2);
  });

  test("policy failures reject the operation — never fail open", async () => {
    const vex = await create();
    await vex.unsafeSql("INSERT INTO vault (_id, name) VALUES ('v1','mine')");
    // prepare throwing rejects the query…
    await expect(vex.query("dx.vaultRead", {}, { user: alice })).rejects.toThrow(
      "prepare exploded",
    );
    // …a row verdict throwing rejects the query…
    await expect(vex.query("dx.vaultRead", {}, { user: bob })).rejects.toThrow(
      "row verdict exploded",
    );
    // …and a failing subscribe registers nothing.
    await expect(
      vex.subscribe("dx.vaultRead", {}, () => {}, { user: alice }),
    ).rejects.toThrow("prepare exploded");
    expect(vex.activeSubscriptionCount()).toBe(0);
    // Unrestricted callers are untouched by either failure mode.
    expect((await vex.query("dx.vaultRead", {})) as unknown[]).toHaveLength(1);
  });

  test("subscriptions are policy-filtered per user and react to grant changes", async () => {
    const vex = await create();
    await seed(vex);
    const aliceSees: number[] = [];
    const bobSees: number[] = [];
    await vex.subscribe(
      "dx.run",
      { op: { table: "docs", terminal: "all" } },
      (rows) => aliceSees.push((rows as DocRow[]).length),
      { user: alice },
    );
    await vex.subscribe(
      "dx.run",
      { op: { table: "docs", terminal: "all" } },
      (rows) => bobSees.push((rows as DocRow[]).length),
      { user: bob },
    );
    const aliceBefore = aliceSees[0];
    const bobBefore = bobSees[0];
    expect(aliceBefore).toBeGreaterThan(0);
    expect(bobBefore).toBeGreaterThan(0);

    // Granting Bob one of Alice's docs is a write to `grants` — a
    // table the HANDLER never reads, only the policy's prepare does.
    // The subscription must still re-run and widen Bob's view.
    await vex.mutate("dx.grant", { userId: "bob", docId: "doc-000" });
    expect(bobSees[bobSees.length - 1]).toBe(bobBefore + 1);
    // Alice's result is unchanged — and unchanged results dedupe, so
    // she received no duplicate push.
    expect(aliceSees).toEqual([aliceBefore]);
  });
});
