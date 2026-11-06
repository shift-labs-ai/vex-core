/**
 * Jobs against removal and shutdown (SHFT-2212).
 *
 * `addJob` and `setJobEnabled` arm a job's timer after awaiting storage.
 * A `removeJob`, a newer `addJob` for the same name, or `close()` can
 * land during those awaits; the engine, which owns the timers, keeps
 * them consistent:
 *   - the last call for a name decides its handler, its `_jobs` row and
 *     its timer
 *   - a closed engine arms nothing, starts no job run, and refuses job
 *     changes, job runs and subscriptions
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import type { VexPluginAPI } from "../src/core/api.js";
import { Vex } from "../src/core/engine.js";
import type { JobDef } from "../src/core/types.js";

let open: Vex[] = [];
afterEach(async () => {
  await Promise.all(open.map((vex) => vex.close()));
  open = [];
});

async function engine(
  jobScheduler: "timers" | "external" = "timers",
): Promise<Vex> {
  const vex = await Vex.create({
    storage: sqliteAdapter(":memory:"),
    jobScheduler,
    plugins: [
      (api: VexPluginAPI) => {
        api.setName("t");
        api.registerTable("items", { columns: { v: { type: "string" } } });
        // Reads nothing: it would succeed on a closed engine's storage.
        api.registerQuery("pure", { args: {}, handler: () => 1 });
        api.registerMutation("add", {
          args: {},
          handler: (ctx) => ctx.db.table("items").insert({ v: "x" }),
        });
      },
    ],
  });
  open.push(vex);
  return vex;
}

function counting(): { job: JobDef; runs: () => number } {
  let runs = 0;
  return {
    job: {
      schedule: "every 1s",
      handler() {
        runs++;
      },
    },
    runs: () => runs,
  };
}

/** Long enough for an `every 1s` timer to tick once. */
const oneInterval = () => new Promise((resolve) => setTimeout(resolve, 1_200));

async function jobRows(vex: Vex, name: string): Promise<number> {
  const [row] = await vex.unsafeSql<{ c: number }>(
    "SELECT count(*) AS c FROM _jobs WHERE name = ?",
    name,
  );
  return row.c;
}

describe("the last call for a job name wins", () => {
  test("a removeJob during addJob leaves no timer, no row, and no run", async () => {
    const vex = await engine();
    const { job, runs } = counting();
    const adding = vex.addJob("x", job);
    await vex.removeJob("x");
    await adding;
    await oneInterval();
    expect(runs()).toBe(0);
    expect(await jobRows(vex, "x")).toBe(0);
  });

  test("of two addJob calls for one name, the second runs, on one timer", async () => {
    const vex = await engine();
    const first = counting();
    const second = counting();
    const a = vex.addJob("x", first.job, "first");
    const b = vex.addJob("x", second.job, "second");
    await Promise.all([a, b]);
    await oneInterval();
    expect(first.runs()).toBe(0);
    expect(second.runs()).toBe(1);
    const rows = await vex.unsafeSql<{ plugin: string }>(
      "SELECT plugin FROM _jobs WHERE name = 'x'",
    );
    expect(rows).toEqual([{ plugin: "second" }]);
  });

  test("a removeJob during setJobEnabled leaves no timer and no run", async () => {
    const vex = await engine();
    const { job, runs } = counting();
    await vex.addJob("x", { ...job, enabled: false });
    const enabling = vex.setJobEnabled("x", true);
    await vex.removeJob("x");
    await enabling;
    await oneInterval();
    expect(runs()).toBe(0);
    expect(await jobRows(vex, "x")).toBe(0);
  });
});

describe("a closed engine", () => {
  test("an addJob in flight when close() runs never arms its timer", async () => {
    const vex = await engine();
    const { job, runs } = counting();
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const adding = vex.addJob("x", job);
      await vex.close();
      await adding;
      await oneInterval();
      expect(runs()).toBe(0);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  test("a setJobEnabled in flight when close() runs never arms its timer", async () => {
    const vex = await engine();
    const { job, runs } = counting();
    await vex.addJob("x", { ...job, enabled: false });
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const enabling = vex.setJobEnabled("x", true);
      await vex.close();
      await enabling;
      await oneInterval();
      expect(runs()).toBe(0);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  test("refuses job changes, job runs and subscriptions", async () => {
    const vex = await engine();
    await vex.addJob("x", counting().job);
    await vex.close();
    for (const call of [
      () => vex.addJob("y", counting().job),
      () => vex.removeJob("x"),
      () => vex.setJobEnabled("x", false),
      () => vex.triggerJob("x"),
      () => vex.runDueJobs(),
      () => vex.subscribe("t.pure", {}, () => {}),
    ]) {
      await expect(call()).rejects.toThrow("Vex engine is closed");
    }
  });

  test("a subscribe in flight when close() runs registers nothing", async () => {
    const vex = await engine();
    const subscribing = vex.subscribe("t.pure", {}, () => {});
    await vex.close();
    await expect(subscribing).rejects.toThrow("Vex engine is closed");
    expect(vex.activeSubscriptionCount()).toBe(0);
  });

  test("runDueJobs starts no further job once close() is called", async () => {
    const vex = await engine("external");
    const ran: string[] = [];
    await vex.addJob("a", {
      schedule: "every 1s",
      handler() {
        ran.push("a");
        void vex.close();
      },
    });
    await vex.addJob("b", {
      schedule: "every 1s",
      handler() {
        ran.push("b");
      },
    });
    await vex.runDueJobs(Date.now() + 60_000);
    expect(ran).toEqual(["a"]);
  });

  test("a failing job makes no further attempt once close() is called", async () => {
    const vex = await engine("external");
    let attempts = 0;
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      await vex.addJob("flaky", {
        schedule: "every 1s",
        retries: 3,
        retryDelayMs: 50,
        handler() {
          attempts++;
          throw new Error("down");
        },
      });
      const running = vex.triggerJob("flaky");
      await new Promise((resolve) => setTimeout(resolve, 10));
      await vex.close();
      expect(await running).toMatchObject({ status: "error", error: "down" });
      expect(attempts).toBe(1);
    } finally {
      errors.mockRestore();
    }
  });

  test("a mutation after close() fails, in storage", async () => {
    const vex = await engine();
    await vex.close();
    await expect(vex.mutate("t.add", {})).rejects.toThrow("closed");
  });

  test("close() can be called again", async () => {
    const vex = await engine();
    await Promise.all([vex.close(), vex.close()]);
    await vex.close();
  });
});
