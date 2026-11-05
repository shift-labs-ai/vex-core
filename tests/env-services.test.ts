/**
 * What an app hands its plugins: `env`, one JSON value every context
 * and every plugin's registration reads, the same on every thread; and
 * `services`, the host's live capabilities, which actions alone hold
 * (`ctx.services`), so no query or mutation can reach one.
 */

import { afterEach, expect, test } from "bun:test";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import type { VexPluginAPI } from "../src/core/api.js";
import { Vex } from "../src/core/engine.js";
import { Type } from "../src/portable.js";

let open: Vex[] = [];
afterEach(async () => {
  await Promise.all(open.map((v) => v.close()));
  open = [];
});

const ENV = { root: "/data", limits: { rows: 5 }, tags: ["a"] };

test("every context and every plugin's registration reads one frozen env", async () => {
  const seen: Record<string, unknown> = {};
  let registered: unknown;
  const vex = await Vex.create({
    storage: sqliteAdapter(":memory:"),
    env: ENV as never,
    migrations: [
      {
        id: "001",
        up: (m) => {
          seen.migration = m.env;
        },
      },
    ],
    plugins: [
      (api: VexPluginAPI) => {
        api.setName("e");
        registered = api.env;
        api.registerQuery("q", {
          args: {},
          handler: (ctx) => {
            seen.query = ctx.env;
            return null;
          },
        });
        api.registerMutation("m", {
          args: {},
          handler: (ctx) => {
            seen.mutation = ctx.env;
            return null;
          },
        });
        api.registerAction("a", {
          args: {},
          handler: (ctx) => {
            seen.action = ctx.env;
            return null;
          },
        });
        api.registerJob("j", {
          schedule: "every 1h",
          handler: (ctx) => {
            seen.job = ctx.env;
          },
        });
        api.registerWebhook("w", {
          path: "/w",
          handler: (ctx) => {
            seen.webhook = ctx.env;
            return { ok: true };
          },
        });
        api.use((ctx, _info, next) => {
          seen.middleware = ctx.env;
          return next();
        });
      },
    ],
  });
  open.push(vex);
  await vex.query("e.q");
  await vex.mutate("e.m");
  await vex.action("e.a");
  await vex.triggerJob("e.j");
  await vex.handleWebhook({
    path: "/w",
    method: "POST",
    headers: {},
    body: {},
    rawBody: "",
    query: {},
  });
  for (const where of [
    "migration",
    "query",
    "mutation",
    "action",
    "job",
    "webhook",
    "middleware",
  ]) {
    expect({ where, env: seen[where] }).toEqual({ where, env: ENV });
  }
  expect(registered).toEqual(ENV);
  // One value, frozen through: a handler cannot change what others read.
  expect(seen.query).toBe(registered);
  expect(Object.isFrozen(registered)).toBe(true);
  expect(Object.isFrozen((registered as typeof ENV).limits)).toBe(true);
  // A copy: the object the app passed is not the one handlers hold.
  expect(registered).not.toBe(ENV);
});

test("an env that is not plain data is refused as the engine starts, naming where", async () => {
  await expect(
    Vex.create({
      storage: sqliteAdapter(":memory:"),
      env: { root: "/data", resolve: () => "/x" } as never,
      plugins: [],
    }),
  ).rejects.toThrow('env holds a function (at "resolve")');
  await expect(
    Vex.create({
      storage: sqliteAdapter(":memory:"),
      env: ["not", "an", "object"] as never,
      plugins: [],
    }),
  ).rejects.toThrow("env is an object of settings");
});

test("no env is an empty one", async () => {
  let env: unknown;
  const vex = await Vex.create({
    storage: sqliteAdapter(":memory:"),
    plugins: [
      (api: VexPluginAPI) => {
        api.setName("n");
        api.registerQuery("q", {
          args: {},
          handler: (ctx) => {
            env = ctx.env;
            return null;
          },
        });
      },
    ],
  });
  open.push(vex);
  await vex.query("n.q");
  expect(env).toEqual({});
  expect(Object.isFrozen(env)).toBe(true);
});

test("services reach actions, jobs and webhooks as given, and no query or mutation", async () => {
  const clock = { now: () => 42 };
  const services = { clock };
  const held: Record<string, unknown> = {};
  const vex = await Vex.create({
    storage: sqliteAdapter(":memory:"),
    services: services as never,
    plugins: [
      (api: VexPluginAPI) => {
        api.setName("s");
        expect("services" in api).toBe(false);
        api.registerQuery("q", {
          args: {},
          handler: (ctx) => {
            held.query = "services" in ctx;
            return null;
          },
        });
        api.registerMutation("m", {
          args: {},
          handler: (ctx) => {
            held.mutation = "services" in ctx;
            return null;
          },
        });
        api.registerAction("a", {
          args: {},
          returns: Type.Number(),
          handler: (ctx) => (ctx.services as typeof services).clock.now(),
        });
        api.registerJob("j", {
          schedule: "every 1h",
          handler: (ctx) => {
            held.job = ctx.services;
          },
        });
        api.registerWebhook("w", {
          path: "/w",
          handler: (ctx) => {
            held.webhook = ctx.services;
            return { ok: true };
          },
        });
      },
    ],
  });
  open.push(vex);
  await vex.query("s.q");
  await vex.mutate("s.m");
  expect(held.query).toBe(false);
  expect(held.mutation).toBe(false);
  // Live objects, as given: functions and all, never copied.
  expect(await vex.action("s.a")).toBe(42);
  await vex.triggerJob("s.j");
  await vex.handleWebhook({
    path: "/w",
    method: "POST",
    headers: {},
    body: {},
    rawBody: "",
    query: {},
  });
  expect(held.job).toBe(services);
  expect(held.webhook).toBe(services);
});

test("no services is an empty set of them", async () => {
  let services: unknown;
  const vex = await Vex.create({
    storage: sqliteAdapter(":memory:"),
    plugins: [
      (api: VexPluginAPI) => {
        api.setName("ns");
        api.registerAction("a", {
          args: {},
          handler: (ctx) => {
            services = ctx.services;
            return null;
          },
        });
      },
    ],
  });
  open.push(vex);
  await vex.action("ns.a");
  expect(services).toEqual({});
});
