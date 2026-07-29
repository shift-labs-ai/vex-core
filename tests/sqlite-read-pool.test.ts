import { Database as BunDatabase } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import type { StorageAdapter } from "../src/core/storage.js";

let tmp = "";
let dbPath = "";
let storage: StorageAdapter | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "vex-core-read-pool-"));
  dbPath = join(tmp, "data.db");
});

afterEach(async () => {
  await storage?.close();
  storage = undefined;
  rmSync(tmp, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function settleState(
  promise: Promise<unknown>,
  timeoutMs = 250,
): Promise<"pending" | "settled"> {
  return Promise.race([
    promise.then(
      () => "settled" as const,
      () => "settled" as const,
    ),
    sleep(timeoutMs).then(() => "pending" as const),
  ]);
}

async function createRowsStorage(): Promise<StorageAdapter> {
  storage = sqliteAdapter(dbPath);
  await storage.ensureTable("rows", {
    columns: {
      value: { type: "number" },
      label: { type: "string", optional: true },
    },
  });
  return storage;
}

function peerRows(): Array<{ id: string; value: number }> {
  const peer = new BunDatabase(dbPath, { readonly: true });
  try {
    return peer
      .query("SELECT _id as id, value FROM rows ORDER BY _id")
      .all() as Array<{ id: string; value: number }>;
  } finally {
    peer.close();
  }
}

describe("SQLite read-only connection pool", () => {
  test("a brand-new file is readable before any table is created", async () => {
    storage = sqliteAdapter(dbPath);

    const rows = await storage.rawQuery<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );

    expect(rows).toEqual([]);
  });

  test("startup pragma failures close the writer and leave the path reusable", async () => {
    expect(() =>
      sqliteAdapter(dbPath, { busyTimeout: Number.NEGATIVE_INFINITY }),
    ).toThrow();

    storage = sqliteAdapter(dbPath);
    await storage.ensureTable("recovered", {
      columns: { value: { type: "number" } },
    });
    await storage.insert("recovered", { value: 1 });

    expect(await storage.query("recovered").count()).toBe(1);
  });

  test("more concurrent reads than the pool size drain without starvation", async () => {
    const adapter = await createRowsStorage();
    await adapter.insert("rows", { _id: "kept", value: 42 });

    const reads = await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        adapter.rawQuery<{ request: number; value: number }>(
          "SELECT ? as request, value FROM rows WHERE _id = ?",
          index,
          "kept",
        ),
      ),
    );

    expect(reads).toHaveLength(100);
    expect(reads.map(([row]) => row.request)).toEqual(
      Array.from({ length: 100 }, (_, index) => index),
    );
    expect(reads.every(([row]) => row.value === 42)).toBe(true);
  });

  test("failed reads release their connections to queued reads", async () => {
    const adapter = await createRowsStorage();
    await adapter.insert("rows", { _id: "kept", value: 42 });

    const attempts = await Promise.allSettled([
      ...Array.from({ length: 4 }, () =>
        adapter.rawQuery("SELECT * FROM missing_table"),
      ),
      ...Array.from({ length: 20 }, (_, index) =>
        adapter.rawQuery<{ request: number }>("SELECT ? as request", index),
      ),
    ]);

    expect(
      attempts.slice(0, 4).every((result) => result.status === "rejected"),
    ).toBe(true);
    const successful = attempts.slice(4);
    expect(successful.every((result) => result.status === "fulfilled")).toBe(
      true,
    );
    expect(
      successful.map((result) =>
        result.status === "fulfilled" ? result.value[0].request : null,
      ),
    ).toEqual(Array.from({ length: 20 }, (_, index) => index));

    expect(await adapter.query("rows").count()).toBe(1);
  });

  test("rawQuery write compatibility uses the writer on file databases", async () => {
    const adapter = await createRowsStorage();
    await adapter.insert("rows", { _id: "row", value: 1 });

    expect(
      await adapter.rawQuery(
        "UPDATE rows SET value = ? WHERE _id = ?",
        2,
        "row",
      ),
    ).toEqual([]);
    const updated = await adapter.rawQuery<{ value: number }>(
      "WITH next(value) AS (VALUES (?)) UPDATE rows SET value = (SELECT value FROM next) WHERE _id = ? RETURNING value",
      3,
      "row",
    );

    expect(updated).toEqual([{ value: 3 }]);
    expect(peerRows()).toEqual([{ id: "row", value: 3 }]);
  });

  test("connection-local temp tables keep subsequent reads on the writer", async () => {
    const adapter = await createRowsStorage();

    await adapter.rawExec("CREATE TABLE temp.scratch (value TEXT)");
    await adapter.rawExec("INSERT INTO scratch (value) VALUES ('kept')");

    expect(await adapter.rawQuery("SELECT value FROM scratch")).toEqual([
      { value: "kept" },
    ]);
    expect(await adapter.query("scratch").count()).toBe(1);
  });

  test("connection-local pragmas keep subsequent reads on the writer", async () => {
    const adapter = await createRowsStorage();

    await adapter.rawExec("PRAGMA case_sensitive_like = ON");

    expect(
      await adapter.rawQuery<{ matches: number }>(
        "SELECT 'A' LIKE 'a' as matches",
      ),
    ).toEqual([{ matches: 0 }]);
  });

  test("attached databases remain visible to subsequent reads", async () => {
    const adapter = await createRowsStorage();
    const attachedPath = join(tmp, "attached.db");
    const attached = new BunDatabase(attachedPath);
    try {
      attached.exec("CREATE TABLE attached_rows (value TEXT)");
      attached.query("INSERT INTO attached_rows VALUES (?)").run("visible");
    } finally {
      attached.close();
    }

    expect(
      await adapter.rawQuery("ATTACH DATABASE ? AS auxiliary", attachedPath),
    ).toEqual([]);

    expect(
      await adapter.rawQuery("SELECT value FROM auxiliary.attached_rows"),
    ).toEqual([{ value: "visible" }]);
  });

  test("rawQuery writes queue behind an unrelated transaction", async () => {
    const adapter = await createRowsStorage();
    await adapter.insert("rows", { _id: "row", value: 1 });
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    const transaction = adapter.transaction(async () => {
      await adapter.update("rows", "row", { value: 2 });
      started.resolve();
      await release.promise;
    });
    await started.promise;

    const rawWrite = adapter.rawQuery<{ value: number }>(
      "UPDATE rows SET value = ? WHERE _id = ? RETURNING value",
      3,
      "row",
    );

    expect(await settleState(rawWrite, 50)).toBe("pending");
    expect(peerRows()).toEqual([{ id: "row", value: 1 }]);

    release.resolve();
    await transaction;
    expect(await rawWrite).toEqual([{ value: 3 }]);
    expect(peerRows()).toEqual([{ id: "row", value: 3 }]);
  });

  test("rawQuery writes inside a transaction share its commit and rollback", async () => {
    const adapter = await createRowsStorage();
    await adapter.insert("rows", { _id: "row", value: 1 });

    await expect(
      adapter.transaction(async () => {
        const updated = await adapter.rawQuery<{ value: number }>(
          "UPDATE rows SET value = 2 WHERE _id = 'row' RETURNING value",
        );
        expect(updated).toEqual([{ value: 2 }]);
        expect(
          await adapter.rawQuery<{ value: number }>(
            "SELECT value FROM rows WHERE _id = 'row'",
          ),
        ).toEqual([{ value: 2 }]);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    expect(peerRows()).toEqual([{ id: "row", value: 1 }]);

    await adapter.transaction(() =>
      adapter.rawQuery(
        "UPDATE rows SET value = 3 WHERE _id = 'row' RETURNING value",
      ),
    );
    expect(peerRows()).toEqual([{ id: "row", value: 3 }]);
  });

  test("non-readonly SQL errors do not poison the pool", async () => {
    const adapter = await createRowsStorage();

    let queryError: unknown;
    try {
      await adapter.rawQuery("SELECT * FROM does_not_exist");
    } catch (error) {
      queryError = error;
    }
    expect(queryError).toBeInstanceOf(Error);
    expect((queryError as Error).message).toContain(
      "no such table: does_not_exist",
    );

    const reads = await Promise.all(
      Array.from({ length: 12 }, () =>
        adapter.rawQuery<{ ok: number }>("SELECT 1 as ok"),
      ),
    );
    expect(reads.every(([row]) => row.ok === 1)).toBe(true);
  });

  test("comment-prefixed SELECTs still bypass an unrelated transaction", async () => {
    const adapter = await createRowsStorage();
    await adapter.insert("rows", { _id: "committed", value: 1 });
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const transaction = adapter.transaction(async () => {
      await adapter.insert("rows", { _id: "uncommitted", value: 2 });
      started.resolve();
      await release.promise;
    });
    await started.promise;

    const read = adapter.rawQuery<{ id: string }>(
      "/* leading block */ -- leading line\n SELECT _id as id FROM rows",
    );
    expect(await settleState(read)).toBe("settled");
    expect(await read).toEqual([{ id: "committed" }]);

    release.resolve();
    await transaction;
  });

  test("CTE reads bypass an unrelated transaction", async () => {
    const adapter = await createRowsStorage();
    await adapter.insert("rows", { _id: "committed", value: 1 });
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const transaction = adapter.transaction(async () => {
      await adapter.insert("rows", { _id: "uncommitted", value: 2 });
      started.resolve();
      await release.promise;
    });
    await started.promise;

    const read = adapter.rawQuery<{ id: string }>(
      "WITH visible AS (SELECT _id as id FROM rows) SELECT id FROM visible",
    );
    expect(await settleState(read)).toBe("settled");
    expect(await read).toEqual([{ id: "committed" }]);

    release.resolve();
    await transaction;
  });

  test("a stale transaction context does not send late reads to the writer", async () => {
    const adapter = await createRowsStorage();
    await adapter.insert("rows", { _id: "committed", value: 1 });
    const runLateRead = Promise.withResolvers<void>();
    let lateRead: Promise<Array<{ id: string }>> = Promise.resolve([]);

    await adapter.transaction(() => {
      lateRead = runLateRead.promise.then(() =>
        adapter.rawQuery<{ id: string }>(
          "SELECT _id as id FROM rows ORDER BY _id",
        ),
      );
    });

    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const transaction = adapter.transaction(async () => {
      await adapter.insert("rows", { _id: "uncommitted", value: 2 });
      started.resolve();
      await release.promise;
    });
    await started.promise;

    runLateRead.resolve();
    expect(await settleState(lateRead)).toBe("settled");
    expect(await lateRead).toEqual([{ id: "committed" }]);

    release.resolve();
    await transaction;
  });

  test("all readers observe schema changes made after pool creation", async () => {
    const adapter = await createRowsStorage();
    await Promise.all(
      Array.from({ length: 8 }, () =>
        adapter.rawQuery("SELECT value FROM rows"),
      ),
    );

    await adapter.ensureTable("rows", {
      columns: {
        value: { type: "number" },
        label: { type: "string", optional: true },
        added: { type: "string", default: "default" },
      },
    });
    await adapter.insert("rows", { _id: "new", value: 1, added: "visible" });

    const reads = await Promise.all(
      Array.from({ length: 8 }, () =>
        adapter.rawQuery<{ added: string }>(
          "SELECT added FROM rows WHERE _id = 'new'",
        ),
      ),
    );
    expect(reads.every((rows) => rows[0].added === "visible")).toBe(true);
  });

  test("pooled readers ignore an uncommitted peer WAL write", async () => {
    const adapter = await createRowsStorage();
    await adapter.insert("rows", { _id: "row", value: 1 });

    const peer = new BunDatabase(dbPath);
    try {
      peer.exec("BEGIN IMMEDIATE");
      peer.query("UPDATE rows SET value = 2 WHERE _id = 'row'").run();

      expect(
        await adapter.rawQuery("SELECT value FROM rows WHERE _id = 'row'"),
      ).toEqual([{ value: 1 }]);

      peer.exec("COMMIT");
      expect(
        await adapter.rawQuery("SELECT value FROM rows WHERE _id = 'row'"),
      ).toEqual([{ value: 2 }]);
    } finally {
      if (peer.inTransaction) peer.exec("ROLLBACK");
      peer.close();
    }
  });

  test("commits from a peer WAL writer become visible to pooled readers", async () => {
    const adapter = await createRowsStorage();
    expect(await adapter.query("rows").count()).toBe(0);

    const peer = new BunDatabase(dbPath);
    try {
      peer.query("INSERT INTO rows (_id, value) VALUES (?, ?)").run("peer", 7);
    } finally {
      peer.close();
    }

    const reads = await Promise.all(
      Array.from({ length: 8 }, () =>
        adapter.rawQuery<{ value: number }>(
          "SELECT value FROM rows WHERE _id = 'peer'",
        ),
      ),
    );
    expect(reads.every((rows) => rows[0].value === 7)).toBe(true);
  });

  test("temporary and in-memory databases retain single-handle semantics", async () => {
    for (const path of [":memory:", ""]) {
      const adapter = sqliteAdapter(path);
      try {
        await adapter.ensureTable("items", {
          columns: { value: { type: "number" } },
        });
        await adapter.transaction(async () => {
          await adapter.insert("items", { value: 1 });
          expect(await adapter.query("items").count()).toBe(1);
        });
        expect(await adapter.query("items").count()).toBe(1);
      } finally {
        await adapter.close();
      }
    }
  });
});
