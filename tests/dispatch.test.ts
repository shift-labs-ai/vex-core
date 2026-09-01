/**
 * Dispatch hooks — the pre-transaction claim seam.
 *
 * A hook may answer a query or mutation itself (a federation proxy,
 * a cache, a remote engine). The contract under test:
 *
 *   1. A claim replaces the handler; no claim changes nothing.
 *   2. A claimed MUTATION never opens the storage transaction —
 *      the whole reason dispatch exists apart from middleware,
 *      whose mutation chain runs inside it.
 *   3. A claimed mutation triggers no invalidation (it wrote
 *      nothing locally).
 *   4. Hook reads are dependency-tracked: a subscription answered
 *      by a claim re-runs when the tables the hook consulted
 *      change.
 *   5. First claim wins; later hooks never run.
 *   6. Plugins register hooks through `api.useDispatch`.
 */

import { describe, expect, test } from "bun:test";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import type { VexPluginAPI } from "../src/core/api.js";
import { Vex } from "../src/core/engine.js";
import type { StorageAdapter } from "../src/core/storage.js";

function notesPlugin(api: VexPluginAPI) {
  api.setName("notes");
  api.registerTable("notes", {
    columns: { text: { type: "string" } },
  });
  api.registerQuery("list", {
    args: {},
    async handler(ctx) {
      return ctx.db.table("notes").all();
    },
  });
  api.registerMutation("add", {
    args: { text: "string" },
    async handler(ctx, args) {
      return ctx.db.table("notes").insert({ text: args.text });
    },
  });
}

function countingAdapter(): { adapter: StorageAdapter; transactions: number } {
  const inner = sqliteAdapter(":memory:");
  const state = { transactions: 0 };
  const adapter: StorageAdapter = {
    ...inner,
    transaction: (fn) => {
      state.transactions++;
      return inner.transaction(fn);
    },
  };
  return {
    adapter,
    get transactions() {
      return state.transactions;
    },
  };
}

describe("dispatch hooks", () => {
  test("a claim replaces the query handler; no claim passes through", async () => {
    const vex = await Vex.create({
      plugins: [notesPlugin],
      storage: sqliteAdapter(":memory:"),
    });
    try {
      await vex.mutate("notes.add", { text: "local" });
      let handlerRan = 0;
      vex.useDispatch((_ctx, info) => {
        if (info.args.remote === true) {
          handlerRan++;
          return { result: ["from-the-hook"] };
        }
        return null;
      });

      await expect(
        vex.query("notes.list", { remote: true }),
      ).resolves.toEqual(["from-the-hook"]);
      expect(handlerRan).toBe(1);

      const local = (await vex.query("notes.list", {})) as Array<{
        text: string;
      }>;
      expect(local.map((n) => n.text)).toEqual(["local"]);
    } finally {
      await vex.close();
    }
  });

  test("a claimed mutation opens no transaction and fires no invalidation", async () => {
    const counting = countingAdapter();
    const vex = await Vex.create({
      plugins: [notesPlugin],
      storage: counting.adapter,
    });
    try {
      vex.useDispatch((_ctx, info) =>
        info.args.remote === true ? { result: "claimed" } : null,
      );

      const invalidations: unknown[] = [];
      const unsubscribe = await vex.subscribe("notes.list", {}, (rows) => {
        invalidations.push(rows);
      });
      expect(invalidations).toHaveLength(1); // initial delivery

      const before = counting.transactions;
      await expect(
        vex.mutate("notes.add", { text: "x", remote: true }),
      ).resolves.toBe("claimed");
      expect(counting.transactions).toBe(before);
      expect(invalidations).toHaveLength(1); // nothing changed locally

      // An unclaimed mutation still transacts and invalidates.
      await vex.mutate("notes.add", { text: "real" });
      expect(counting.transactions).toBe(before + 1);
      expect(invalidations).toHaveLength(2);
      unsubscribe();
    } finally {
      await vex.close();
    }
  });

  test("hook reads are tracked: a claimed subscription re-runs when its tables change", async () => {
    const vex = await Vex.create({
      plugins: [notesPlugin],
      storage: sqliteAdapter(":memory:"),
    });
    try {
      // The hook derives its answer from the notes table — the way a
      // federation hook derives link rows — so a notes write must
      // re-run the subscription and deliver the fresh claim.
      vex.useDispatch(async (ctx, info) => {
        if (info.name !== "notes.list" || info.args.remote !== true) {
          return null;
        }
        const count = await ctx.db.table("notes").count();
        return { result: { claimed: true, count } };
      });

      const delivered: Array<{ count: number }> = [];
      const unsubscribe = await vex.subscribe(
        "notes.list",
        { remote: true },
        (data) => delivered.push(data as { count: number }),
      );
      expect(delivered.at(-1)?.count).toBe(0);

      await vex.mutate("notes.add", { text: "one" });
      expect(delivered.at(-1)?.count).toBe(1);
      unsubscribe();
    } finally {
      await vex.close();
    }
  });

  test("first claim wins; later hooks and the handler never run", async () => {
    const vex = await Vex.create({
      plugins: [notesPlugin],
      storage: sqliteAdapter(":memory:"),
    });
    try {
      let secondRan = false;
      vex.useDispatch(() => ({ result: "first" }));
      vex.useDispatch(() => {
        secondRan = true;
        return { result: "second" };
      });
      await expect(vex.query("notes.list", {})).resolves.toBe("first");
      expect(secondRan).toBe(false);
    } finally {
      await vex.close();
    }
  });

  test("plugins register dispatch hooks through api.useDispatch", async () => {
    const vex = await Vex.create({
      plugins: [
        notesPlugin,
        (api: VexPluginAPI) => {
          api.setName("federator");
          api.useDispatch((_ctx, info) =>
            info.args.remote === true ? { result: "plugin-claimed" } : null,
          );
        },
      ],
      storage: sqliteAdapter(":memory:"),
    });
    try {
      await expect(vex.query("notes.list", { remote: true })).resolves.toBe(
        "plugin-claimed",
      );
      await expect(vex.query("notes.list", {})).resolves.toEqual([]);
    } finally {
      await vex.close();
    }
  });

  test("an unknown name still throws before any hook runs", async () => {
    const vex = await Vex.create({
      plugins: [notesPlugin],
      storage: sqliteAdapter(":memory:"),
    });
    try {
      let hookRan = false;
      vex.useDispatch(() => {
        hookRan = true;
        return { result: "never" };
      });
      await expect(vex.query("nope.list", {})).rejects.toThrow(
        "Query not found",
      );
      await expect(vex.mutate("nope.add", {})).rejects.toThrow(
        "Mutation not found",
      );
      expect(hookRan).toBe(false);
    } finally {
      await vex.close();
    }
  });
});
