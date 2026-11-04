/**
 * What a handler may reach beyond its context (src/core/guards.ts):
 * the clock, randomness, I/O, timers and the environment are refused
 * in a query or mutation, each naming the context's way; an action may
 * reach them; no handler may call the engine but through its context;
 * and an engine refuses to start unguarded.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import type { VexPluginAPI } from "../src/core/api.js";
import { Vex } from "../src/core/engine.js";

let open: Vex[] = [];
afterEach(async () => {
  await Promise.all(open.map((v) => v.close()));
  open = [];
});

/** Each reach, by name, as a handler would make it. */
const REACHES: Record<string, () => unknown> = {
  "Date.now": () => Date.now(),
  "new Date()": () => new Date(),
  "Date()": () => Date(),
  "performance.now": () => performance.now(),
  "process.hrtime": () => process.hrtime(),
  "Bun.nanoseconds": () => Bun.nanoseconds(),
  "Math.random": () => Math.random(),
  "crypto.randomUUID": () => crypto.randomUUID(),
  "crypto.getRandomValues": () => crypto.getRandomValues(new Uint8Array(4)),
  "node:crypto.randomUUID": () => randomUUID(),
  fetch: () => fetch("http://127.0.0.1:1"),
  "Bun.file": () => Bun.file("/etc/hosts"),
  "Bun.spawnSync": () => Bun.spawnSync(["true"]),
  "node:fs.readFileSync": () => readFileSync("/etc/hosts"),
  setTimeout: () => setTimeout(() => {}, 1),
  setInterval: () => setInterval(() => {}, 1),
  "process.env.HOME": () => process.env.HOME,
  "process.cwd": () => process.cwd(),
};

let reach = "Date.now";

function plugin(api: VexPluginAPI) {
  api.setName("g");
  api.registerTable("items", { columns: { n: { type: "number" } } });
  api.registerQuery("reach", {
    args: {},
    handler: () => {
      REACHES[reach]!();
      return null;
    },
  });
  api.registerMutation("reach", {
    args: {},
    handler: () => {
      REACHES[reach]!();
      return null;
    },
  });
  api.registerAction("reach", {
    args: {},
    handler: () => {
      const value = REACHES[reach]!();
      if (value && typeof (value as any).catch === "function") {
        (value as Promise<unknown>).catch(() => {});
      }
      if (reach === "setInterval") clearInterval(value as any);
      return null;
    },
  });
  api.registerQuery("dated", {
    args: {},
    handler: () => new Date(0).toISOString(),
  });
  api.registerMutation("insert", {
    args: {},
    handler: (ctx) => ctx.db.table("items").insert({ n: ctx.now() }),
  });
  api.registerQuery("count", {
    args: {},
    handler: (ctx) => ctx.db.table("items").count(),
  });
}

async function engine(
  extra: Array<(api: VexPluginAPI) => void> = [],
): Promise<Vex> {
  const vex = await Vex.create({
    storage: sqliteAdapter(":memory:"),
    plugins: [plugin, ...extra],
  });
  open.push(vex);
  return vex;
}

describe("a query or mutation reaches nothing beyond its context", () => {
  for (const name of Object.keys(REACHES)) {
    test(`${name} is refused in a query and a mutation, naming the way instead, and allowed in an action`, async () => {
      const vex = await engine();
      reach = name;
      await expect(vex.query("g.reach")).rejects.toThrow(
        /is refused in query g\.reach: /,
      );
      await expect(vex.mutate("g.reach")).rejects.toThrow(
        /is refused in mutation g\.reach: /,
      );
      await expect(vex.action("g.reach")).resolves.toBeNull();
    });
  }

  test("each refusal names what to use", async () => {
    const vex = await engine();
    reach = "Date.now";
    await expect(vex.query("g.reach")).rejects.toThrow("ctx.now(resolutionMs)");
    await expect(vex.mutate("g.reach")).rejects.toThrow("ctx.now()");
    reach = "Math.random";
    await expect(vex.mutate("g.reach")).rejects.toThrow("ctx.random()");
    reach = "fetch";
    await expect(vex.query("g.reach")).rejects.toThrow(
      "I/O belongs in an action",
    );
  });

  test("a date from a value is no clock: allowed; the engine's own ids and time still work", async () => {
    const vex = await engine();
    expect(await vex.query("g.dated")).toBe("1970-01-01T00:00:00.000Z");
    await vex.mutate("g.insert");
    expect(await vex.query("g.count")).toBe(1);
  });

  test("outside every handler, nothing is refused", () => {
    for (const [name, fn] of Object.entries(REACHES)) {
      if (
        ["fetch", "setTimeout", "setInterval", "Bun.spawnSync"].includes(name)
      )
        continue;
      expect(fn).not.toThrow();
    }
    process.env.VEX_GUARD_TEST = "written";
    expect(process.env.VEX_GUARD_TEST).toBe("written");
    delete process.env.VEX_GUARD_TEST;
  });
});

describe("a handler calls the engine only through its context", () => {
  test("a query, a mutation or an action calling a captured engine is refused; an action's ctx calls are its own", async () => {
    const holder: { vex?: Vex } = {};
    const vex = await engine([
      (api) => {
        api.setName("re");
        api.registerQuery("q", {
          args: {},
          handler: () => holder.vex!.query("g.count"),
        });
        api.registerMutation("m", {
          args: {},
          handler: () => holder.vex!.mutate("g.insert"),
        });
        api.registerAction("a", {
          args: {},
          handler: () => holder.vex!.query("g.count"),
        });
        api.registerAction("viaCtx", {
          args: {},
          handler: async (ctx) => {
            await ctx.mutate("g.insert");
            return ctx.query("g.count");
          },
        });
      },
    ]);
    holder.vex = vex;
    await expect(vex.query("re.q")).rejects.toThrow(
      "vex.query is refused inside query re.q",
    );
    await expect(vex.mutate("re.m")).rejects.toThrow(
      "vex.mutate is refused inside mutation re.m",
    );
    await expect(vex.action("re.a")).rejects.toThrow(
      "vex.query is refused inside action re.a: call through the handler's context (ctx.query)",
    );
    expect(await vex.action("re.viaCtx")).toBe(1);
  });

  test("middleware runs in the handler's frame: it is guarded too", async () => {
    const vex = await engine([
      (api) => {
        api.setName("mw");
        api.use((_ctx, info, next) => {
          if (info.name === "g.count") Math.random();
          return next();
        });
      },
    ]);
    await expect(vex.query("g.count")).rejects.toThrow(
      "Math.random is refused in query g.count",
    );
  });
});

describe("an engine starts only guarded", () => {
  test("without the preload, Vex.create refuses, saying how to guard it", () => {
    const dir = mkdtempSync(join(tmpdir(), "vex-unguarded-"));
    const script = join(dir, "start.ts");
    const src = join(import.meta.dir, "../src");
    writeFileSync(
      script,
      `import { readFileSync } from "node:fs";
import { Vex } from ${JSON.stringify(`${src}/core/engine.ts`)};
import { sqliteAdapter } from ${JSON.stringify(`${src}/adapters/sqlite.ts`)};
void readFileSync;
try {
  await Vex.create({ storage: sqliteAdapter(":memory:"), plugins: [] });
  console.log("STARTED");
} catch (error) {
  console.log("REFUSED " + (error as Error).message);
}
`,
    );
    // Run from a directory with no bunfig: no preload.
    const result = Bun.spawnSync(["bun", script], { cwd: dir });
    const out = result.stdout.toString();
    expect(out).toContain("REFUSED");
    expect(out).toContain("bun --preload vex-core/guard");
  });
});
