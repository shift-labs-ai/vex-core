/**
 * Writes committing in one turn of the event loop invalidate in one
 * pass: a burst of mutations re-evaluates each affected subscription
 * once for all of them, and each mutation still resolves only after
 * its subscribers heard.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import type { VexPluginAPI } from "../src/core/api.js";
import { Vex } from "../src/core/engine.js";
import type { Span } from "../src/core/tracer.js";

let open: Vex[] = [];
let runs = 0;
const spans: Span[] = [];

afterEach(async () => {
  await Promise.all(open.map((v) => v.close()));
  open = [];
  runs = 0;
  spans.length = 0;
});

function plugin(api: VexPluginAPI) {
  api.setName("c");
  api.registerTable("items", {
    columns: { scope: { type: "string", index: true }, n: { type: "number" } },
  });
  api.registerQuery("sum", {
    args: { scope: "string" },
    async handler(ctx, args) {
      runs++;
      return ctx.db.table("items").where("scope", "=", args.scope).sum("n");
    },
  });
  api.registerMutation("add", {
    args: { scope: "string", n: "number" },
    handler: (ctx, args) => ctx.db.table("items").insert(args),
  });
  api.registerMutation("set", {
    args: { id: "string", n: "number" },
    handler: (ctx, args) =>
      ctx.db.table("items").update(args.id, { n: args.n }),
  });
  api.registerJob("tick", {
    schedule: "every 1h",
    async handler(ctx) {
      await ctx.db.table("items").insert({ scope: "a", n: 100 });
    },
  });
}

async function create() {
  const vex = await Vex.create({
    plugins: [plugin],
    storage: sqliteAdapter(":memory:"),
    tracer: { onSpan: (span) => spans.push(span) },
  });
  open.push(vex);
  return vex;
}

const invalidations = () =>
  spans
    .filter((s) => s.type === "invalidation")
    .map((s) => JSON.parse(s.meta ?? "{}"));

describe("invalidation coalescing", () => {
  test("a burst of mutations runs one pass and re-evaluates each view once", async () => {
    const vex = await create();
    const seen: number[] = [];
    await vex.subscribe("c.sum", { scope: "a" }, (n: number) => seen.push(n));
    const after = runs;
    spans.length = 0;

    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        vex.mutate("c.add", { scope: "a", n: i + 1 }),
      ),
    );

    expect(invalidations()).toEqual([
      expect.objectContaining({
        commits: 6,
        changedTables: expect.arrayContaining(["items"]),
      }),
    ]);
    expect(runs).toBe(after + 1);
    expect(seen).toEqual([0, 21]);
  });

  test("a mutation resolves after its subscribers heard", async () => {
    const vex = await create();
    const seen: number[] = [];
    await vex.subscribe("c.sum", { scope: "a" }, (n: number) => seen.push(n));
    await vex.mutate("c.add", { scope: "a", n: 5 });
    expect(seen).toEqual([0, 5]);
  });

  test("a burst's writes narrow together: views none of them touch do not re-run", async () => {
    const vex = await create();
    await vex.subscribe("c.sum", { scope: "a" }, () => {});
    await vex.subscribe("c.sum", { scope: "b" }, () => {});
    const after = runs;
    await Promise.all([
      vex.mutate("c.add", { scope: "a", n: 1 }),
      vex.mutate("c.add", { scope: "a", n: 2 }),
    ]);
    expect(runs).toBe(after + 1);
  });

  test("a commit that recorded no writes makes the whole pass conservative", async () => {
    const vex = await create();
    await vex.subscribe("c.sum", { scope: "a" }, () => {});
    await vex.subscribe("c.sum", { scope: "b" }, () => {});
    const after = runs;
    await Promise.all([
      vex.mutate("c.add", { scope: "a", n: 1 }),
      // A job records nothing of its rows.
      vex.triggerJob("c.tick"),
    ]);
    expect(invalidations().at(-1)).toEqual(
      expect.objectContaining({ commits: 2 }),
    );
    expect(runs).toBe(after + 2);
  });

  test("a write committing while a pass is open is not lost", async () => {
    const vex = await create();
    const id = await vex.mutate("c.add", { scope: "a", n: 1 });
    const seen: number[] = [];
    await vex.subscribe("c.sum", { scope: "a" }, (n: number) => seen.push(n));
    // The second write lands in the next turn, while the first's pass
    // re-runs the view.
    await Promise.all([
      vex.mutate("c.set", { id, n: 2 }),
      new Promise<void>((resolve) =>
        setTimeout(
          () => vex.mutate("c.set", { id, n: 3 }).then(() => resolve()),
          0,
        ),
      ),
    ]);
    expect(seen.at(-1)).toBe(3);
  });
});
