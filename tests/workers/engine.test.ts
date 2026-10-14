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
});
