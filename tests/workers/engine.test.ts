// Imports the built package, as a Worker would: under the "workerd"
// condition "vex-core" resolves to its portable entry.

import { env } from "cloudflare:workers";
import * as root from "vex-core";
import { durableObjectAdapter, Vex, type VexPluginAPI } from "vex-core";
import * as vitest from "vitest";
import { describe, expect, objectStorage, test } from "./bun-test.js";

function ledgerPlugin(api: VexPluginAPI) {
  api.setName("ledger");
  api.registerTable("entries", {
    columns: {
      account: { type: "string", index: true },
      amount: { type: "number" },
    },
  });
  api.registerQuery("balance", {
    args: { account: "string" },
    async handler(ctx, args) {
      return ctx.db
        .table("entries")
        .where("account", "=", args.account)
        .sum("amount");
    },
  });
  // Moves money between accounts; fails after the first write when the
  // source would go negative, so the transfer must roll back whole.
  api.registerMutation("transfer", {
    args: { from: "string", to: "string", amount: "number" },
    async handler(ctx, args) {
      await ctx.db
        .table("entries")
        .insert({ account: args.to, amount: args.amount });
      const balance = await ctx.db
        .table("entries")
        .where("account", "=", args.from)
        .sum("amount");
      if (balance < args.amount) throw new Error("insufficient funds");
      await ctx.db
        .table("entries")
        .insert({ account: args.from, amount: -args.amount });
    },
  });
  api.registerQuery("total", {
    args: {},
    async handler(ctx) {
      return ctx.db.table("entries").sum("amount");
    },
  });
  api.registerMutation("deposit", {
    args: { account: "string", amount: "number" },
    async handler(ctx, args) {
      await ctx.db
        .table("entries")
        .insert({ account: args.account, amount: args.amount });
    },
  });
}

describe("Vex on a Durable Object", () => {
  test("the package root leaves out the Bun-only exports", () => {
    expect("sqliteAdapter" in root).toBe(false);
    expect("config" in root).toBe(false);
  });

  test("mutations commit and queries read them", async () => {
    const vex = await Vex.create({
      plugins: [ledgerPlugin],
      storage: durableObjectAdapter(objectStorage()),
    });
    await vex.mutate("ledger.deposit", { account: "a", amount: 100 });
    await vex.mutate("ledger.transfer", { from: "a", to: "b", amount: 30 });
    expect(await vex.query("ledger.balance", { account: "a" })).toBe(70);
    expect(await vex.query("ledger.balance", { account: "b" })).toBe(30);
    await vex.close();
  });

  test("a mutation that throws rolls back its writes", async () => {
    const vex = await Vex.create({
      plugins: [ledgerPlugin],
      storage: durableObjectAdapter(objectStorage()),
    });
    await vex.mutate("ledger.deposit", { account: "a", amount: 10 });
    await expect(
      vex.mutate("ledger.transfer", { from: "a", to: "b", amount: 50 }),
    ).rejects.toThrow("insufficient funds");
    expect(await vex.query("ledger.balance", { account: "b" })).toBe(0);
    expect(await vex.query("ledger.balance", { account: "a" })).toBe(10);
    await vex.close();
  });

  test("the schema persists for the next engine on the same object", async () => {
    const first = await Vex.create({
      plugins: [ledgerPlugin],
      storage: durableObjectAdapter(objectStorage()),
    });
    await first.mutate("ledger.deposit", { account: "a", amount: 5 });
    await first.close();

    const second = await Vex.create({
      plugins: [ledgerPlugin],
      storage: durableObjectAdapter(objectStorage()),
    });
    expect(await second.query("ledger.balance", { account: "a" })).toBe(5);
    await second.close();
  });

  // Not run inside an object like the tests above: requests reach the
  // App through its stub, as a Worker's would.
  vitest.test("the README's App serves concurrent requests", async () => {
    const app = env.APP.get(env.APP.newUniqueId());
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => app.fetch("http://app/")),
    );
    const sizes = await Promise.all(
      responses.map(async (res) => ((await res.json()) as unknown[]).length),
    );
    expect(sizes.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  test("subscriptions push a result only when it changes", async () => {
    const vex = await Vex.create({
      plugins: [ledgerPlugin],
      storage: durableObjectAdapter(objectStorage()),
    });
    const seen: number[] = [];
    const unsubscribe = await vex.subscribe("ledger.total", {}, (total) =>
      seen.push(total),
    );
    await vex.mutate("ledger.deposit", { account: "a", amount: 5 });
    // Re-runs the query; the total, and so its hash, stays the same.
    await vex.mutate("ledger.deposit", { account: "b", amount: 0 });
    await vex.mutate("ledger.deposit", { account: "a", amount: 2 });
    expect(seen).toEqual([0, 5, 7]);
    unsubscribe();
    await vex.close();
  });

  vitest.test(
    "a Durable Object alarm runs due jobs and schedules the next",
    async () => {
      const jobs = env.JOBS.get(env.JOBS.newUniqueId());
      const ticks = async () =>
        (await (await jobs.fetch("http://jobs/")).json()) as number;
      expect(await ticks()).toBe(0);
      const deadline = Date.now() + 8_000;
      while ((await ticks()) < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(await ticks()).toBeGreaterThanOrEqual(2);
    },
    10_000,
  );

  vitest.test(
    "vex-core/http serves Vex and sessions from the object",
    async () => {
      const api = env.API.get(env.API.newUniqueId());
      const call = (path: string, body: unknown) =>
        api.fetch(`http://api${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });

      const mutated = await call("/vex/mutate", {
        name: "counter.set",
        args: { key: "hits", value: 3 },
      });
      expect(mutated.status).toBe(200);
      expect(mutated.headers.get("access-control-allow-origin")).toBe("*");
      const queried = await call("/vex/query", { name: "counter.list" });
      expect(await queried.json()).toMatchObject({
        data: [{ key: "hits", value: 3 }],
      });

      const login = await api.fetch("http://api/login", {
        method: "POST",
        body: "ada",
      });
      const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
      expect(cookie).toMatch(/^vex_session=/);
      const me = await api.fetch("http://api/me", { headers: { cookie } });
      expect(await me.json()).toBe("ada");
    },
  );
});
