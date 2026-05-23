import { Database as BunDatabase } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import type { VexPluginAPI } from "../src/core/api.js";
import { Vex } from "../src/core/engine.js";

let tmp = "";
let dbPath = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "vex-core-tx-"));
  dbPath = join(tmp, "data.db");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function peerValues(): string[] {
  const peer = new BunDatabase(dbPath, { readonly: true });
  try {
    return (
      peer.query("SELECT v FROM rows ORDER BY rowid").all() as Array<{
        v: string;
      }>
    ).map((row) => row.v);
  } finally {
    peer.close();
  }
}

function registerRows(api: VexPluginAPI) {
  api.registerTable("rows", {
    columns: { v: { type: "string", index: true } },
  });
}

function makePlugin(gate: {
  started: PromiseWithResolvers<void>;
  release: Promise<void>;
}) {
  return (api: VexPluginAPI) => {
    api.setName("tx");
    registerRows(api);
    api.registerMutation("write", {
      args: { v: "string" },
      async handler(ctx, args) {
        await ctx.db.table("rows").insert({ v: args.v });
      },
    });
    api.registerMutation("long", {
      args: {},
      async handler(ctx) {
        await ctx.db.table("rows").insert({ v: "long-before" });
        gate.started.resolve();
        await gate.release;
        await ctx.db.table("rows").insert({ v: "long-after" });
      },
    });
    api.registerMutation("longFail", {
      args: {},
      async handler(ctx) {
        await ctx.db.table("rows").insert({ v: "rolled-back" });
        gate.started.resolve();
        await gate.release;
        throw new Error("boom");
      },
    });
  };
}

function makeTimeoutPlugin(gate: { started: PromiseWithResolvers<void> }) {
  return (api: VexPluginAPI) => {
    api.setName("timeouttx");
    registerRows(api);
    api.registerMutation("tooSlow", {
      args: {},
      async handler(ctx) {
        await ctx.db.table("rows").insert({ v: "before-timeout" });
        gate.started.resolve();
        await sleep(40);
        await ctx.db.table("rows").insert({ v: "after-timeout" });
      },
    });
  };
}

function makeJobPlugin(gate: {
  started: PromiseWithResolvers<void>;
  release: Promise<void>;
}) {
  return (api: VexPluginAPI) => {
    api.setName("jobtx");
    registerRows(api);
    api.registerMutation("write", {
      args: { v: "string" },
      async handler(ctx, args) {
        await ctx.db.table("rows").insert({ v: args.v });
      },
    });
    api.registerJob("sweep", {
      schedule: "every 1h",
      async handler(ctx) {
        await ctx.db.table("rows").insert({ v: "job-before" });
        gate.started.resolve();
        await gate.release;
        await ctx.db.table("rows").insert({ v: "job-after" });
      },
    });
  };
}

async function settleState(
  promise: Promise<unknown>,
): Promise<"pending" | "settled"> {
  return Promise.race([
    promise.then(
      () => "settled" as const,
      () => "settled" as const,
    ),
    sleep(25).then(() => "pending" as const),
  ]);
}

async function buildStorage() {
  const storage = sqliteAdapter(dbPath);
  await storage.ensureTable("rows", {
    columns: { v: { type: "string", index: true } },
  });
  return storage;
}

describe("SQLite transaction ownership", () => {
  test("concurrent mutations do not join an unrelated open transaction", async () => {
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const vex = await Vex.create({
      storage: sqliteAdapter(dbPath),
      plugins: [makePlugin({ started, release: release.promise })],
    });

    try {
      const long = vex.mutate("tx.long");
      await started.promise;

      const concurrent = vex.mutate("tx.write", { v: "concurrent" });

      expect(await settleState(concurrent)).toBe("pending");
      expect(peerValues()).toEqual([]);

      release.resolve();
      await long;
      await concurrent;

      expect(peerValues()).toEqual(["long-before", "long-after", "concurrent"]);
    } finally {
      await vex.close();
    }
  });

  test("a rolled-back long mutation cannot roll back a concurrent mutation", async () => {
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const vex = await Vex.create({
      storage: sqliteAdapter(dbPath),
      plugins: [makePlugin({ started, release: release.promise })],
    });

    try {
      const long = vex.mutate("tx.longFail");
      await started.promise;

      const concurrent = vex.mutate("tx.write", { v: "survives" });

      expect(await settleState(concurrent)).toBe("pending");
      expect(peerValues()).toEqual([]);

      release.resolve();
      await expect(long).rejects.toThrow("boom");
      await concurrent;

      expect(peerValues()).toEqual(["survives"]);
    } finally {
      await vex.close();
    }
  });

  test("direct adapter writes queue behind an unrelated open transaction", async () => {
    const storage = await buildStorage();
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();

    try {
      const long = storage.transaction(async () => {
        await storage.insert("rows", { v: "tx-before" });
        started.resolve();
        await release.promise;
        await storage.insert("rows", { v: "tx-after" });
      });
      await started.promise;

      const concurrent = storage.insert("rows", { v: "concurrent" });

      expect(await settleState(concurrent)).toBe("pending");
      expect(peerValues()).toEqual([]);

      release.resolve();
      await long;
      await concurrent;

      expect(peerValues()).toEqual(["tx-before", "tx-after", "concurrent"]);
    } finally {
      await storage.close();
    }
  });

  test("direct adapter queued writes run after a rollback, not inside it", async () => {
    const storage = await buildStorage();
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();

    try {
      const failing = storage.transaction(async () => {
        await storage.insert("rows", { v: "rolled-back" });
        started.resolve();
        await release.promise;
        throw new Error("rollback");
      });
      await started.promise;

      const concurrent = storage.insert("rows", { v: "survives" });

      expect(await settleState(concurrent)).toBe("pending");
      expect(peerValues()).toEqual([]);

      release.resolve();
      await expect(failing).rejects.toThrow("rollback");
      await concurrent;

      expect(peerValues()).toEqual(["survives"]);
    } finally {
      await storage.close();
    }
  });

  test("raw queries queue instead of reading dirty rows from an unrelated transaction", async () => {
    const storage = await buildStorage();
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();

    try {
      const long = storage.transaction(async () => {
        await storage.insert("rows", { v: "uncommitted" });
        started.resolve();
        await release.promise;
      });
      await started.promise;

      const read = storage.rawQuery<{ v: string }>(
        "SELECT v FROM rows ORDER BY rowid",
      );

      expect(await settleState(read)).toBe("pending");
      expect(peerValues()).toEqual([]);

      release.resolve();
      await long;
      expect((await read).map((row) => row.v)).toEqual(["uncommitted"]);
    } finally {
      await storage.close();
    }
  });

  test("raw exec writes queue behind unrelated transactions", async () => {
    const storage = await buildStorage();
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();

    try {
      const long = storage.transaction(async () => {
        await storage.insert("rows", { v: "tx" });
        started.resolve();
        await release.promise;
      });
      await started.promise;

      const raw = storage.rawExec(
        "INSERT INTO rows (v, _id) VALUES (?, ?)",
        "raw",
        "raw-id",
      );

      expect(await settleState(raw)).toBe("pending");
      expect(peerValues()).toEqual([]);

      release.resolve();
      await long;
      await raw;

      expect(peerValues()).toEqual(["tx", "raw"]);
    } finally {
      await storage.close();
    }
  });

  test("queued writers run FIFO after the transaction owner releases", async () => {
    const storage = await buildStorage();
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();

    try {
      const long = storage.transaction(async () => {
        await storage.insert("rows", { v: "tx" });
        started.resolve();
        await release.promise;
      });
      await started.promise;

      const a = storage.insert("rows", { v: "a" });
      const b = storage.insert("rows", { v: "b" });
      const c = storage.insert("rows", { v: "c" });

      expect(await settleState(Promise.all([a, b, c]))).toBe("pending");

      release.resolve();
      await long;
      await Promise.all([a, b, c]);

      expect(peerValues()).toEqual(["tx", "a", "b", "c"]);
    } finally {
      await storage.close();
    }
  });

  test("closing the adapter rejects queued work instead of leaking waiters", async () => {
    const storage = await buildStorage();
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();

    const long = storage.transaction(async () => {
      await storage.insert("rows", { v: "tx" });
      started.resolve();
      await release.promise;
    });
    await started.promise;

    const queued = storage.insert("rows", { v: "queued" });
    expect(await settleState(queued)).toBe("pending");

    await storage.close();

    await expect(queued).rejects.toThrow("SQLite adapter is closed");
    release.resolve();
    await expect(long).rejects.toThrow();
  });

  test("writes after close reject with a clear adapter error", async () => {
    const storage = await buildStorage();
    await storage.close();

    await expect(storage.insert("rows", { v: "after-close" })).rejects.toThrow(
      "SQLite adapter is closed",
    );
  });

  test("timed-out mutation handlers cannot keep writing through a closed owner", async () => {
    const started = Promise.withResolvers<void>();
    const vex = await Vex.create({
      storage: sqliteAdapter(dbPath),
      handlerTimeoutMs: 10,
      plugins: [makeTimeoutPlugin({ started })],
    });

    try {
      await expect(vex.mutate("timeouttx.tooSlow")).rejects.toThrow(
        "Handler timed out after 10ms",
      );
      await started.promise;
      await sleep(60);

      expect(peerValues()).toEqual([]);
    } finally {
      await vex.close();
    }
  });

  test("nested work in the same transaction owner does not deadlock", async () => {
    const storage = await buildStorage();
    try {
      await storage.transaction(async () => {
        await storage.insert("rows", { v: "outer" });
        await storage.transaction(async () => {
          await storage.insert("rows", { v: "inner" });
          const rows = await storage.rawQuery<{ v: string }>(
            "SELECT v FROM rows ORDER BY rowid",
          );
          expect(rows.map((row) => row.v)).toEqual(["outer", "inner"]);
        });
      });

      expect(peerValues()).toEqual(["outer", "inner"]);
    } finally {
      await storage.close();
    }
  });

  test("long jobs do not wrap their whole handler in a transaction", async () => {
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const vex = await Vex.create({
      storage: sqliteAdapter(dbPath),
      plugins: [makeJobPlugin({ started, release: release.promise })],
    });

    try {
      const job = vex.triggerJob("jobtx.sweep");
      await started.promise;

      expect(peerValues()).toEqual(["job-before"]);

      const concurrent = vex.mutate("jobtx.write", { v: "concurrent" });
      expect(await settleState(concurrent)).toBe("settled");
      expect(peerValues()).toEqual(["job-before", "concurrent"]);

      release.resolve();
      await job;

      expect(peerValues()).toEqual(["job-before", "concurrent", "job-after"]);
    } finally {
      await vex.close();
    }
  });
});
