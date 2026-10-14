import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import type { StorageAdapter } from "../src/core/storage.js";
import {
  adapterSuite,
  sqliteIndexNames,
  sqliteManagedIndexNames,
  sqliteSchemaSuite,
} from "./storage-suites.js";

setDefaultTimeout(15_000);

function tempSqlitePath(name: string): string {
  return join(tmpdir(), `vex-core-${name}-${Date.now()}-${Math.random()}.db`);
}

function cleanupSqlitePath(path: string): void {
  rmSync(path, { force: true });
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
}

const memory = async () => sqliteAdapter(":memory:");
adapterSuite("sqlite", memory);
sqliteSchemaSuite("sqlite", memory);

describe("sqlite file and connection options", () => {
  test("sqlite options apply busy timeout and cache size pragmas", async () => {
    const adapter = sqliteAdapter(":memory:", {
      busyTimeout: 1234,
      cacheSize: -2000,
    });
    const busyTimeout = await adapter.rawQuery<{ timeout: number }>(
      "PRAGMA busy_timeout",
    );
    const cacheSize = await adapter.rawQuery<{ cache_size: number }>(
      "PRAGMA cache_size",
    );

    expect(busyTimeout[0].timeout).toBe(1234);
    expect(cacheSize[0].cache_size).toBe(-2000);
    adapter.close();
  });

  test("sqlite options apply to every pooled read connection", async () => {
    const path = tempSqlitePath("pooled-options");
    let adapter: StorageAdapter | undefined;

    try {
      adapter = sqliteAdapter(path, {
        busyTimeout: 1234,
        cacheSize: -2000,
      });
      const pooledAdapter = adapter;
      const busyTimeouts = await Promise.all(
        Array.from({ length: 8 }, () =>
          pooledAdapter.rawQuery<{ timeout: number }>(
            "SELECT timeout FROM pragma_busy_timeout",
          ),
        ),
      );
      const cacheSizes = await Promise.all(
        Array.from({ length: 8 }, () =>
          pooledAdapter.rawQuery<{ cache_size: number }>(
            "SELECT cache_size FROM pragma_cache_size",
          ),
        ),
      );

      expect(busyTimeouts.every((rows) => rows[0].timeout === 1234)).toBe(true);
      expect(cacheSizes.every((rows) => rows[0].cache_size === -2000)).toBe(
        true,
      );
    } finally {
      await adapter?.close();
      cleanupSqlitePath(path);
    }
  });

  test("persistent sqlite files retain data across reopen", async () => {
    const path = tempSqlitePath("persistent-data");

    try {
      const first = sqliteAdapter(path);
      await first.ensureTable("items", {
        columns: { name: { type: "string" }, meta: { type: "json" } },
      });
      await first.insert("items", { name: "a", meta: { ok: true } });
      first.close();

      const second = sqliteAdapter(path);
      await second.ensureTable("items", {
        columns: { name: { type: "string" }, meta: { type: "json" } },
      });
      const row = await second.query("items").first<any>();
      expect(row.name).toBe("a");
      expect(row.meta).toEqual({ ok: true });
      second.close();
    } finally {
      cleanupSqlitePath(path);
    }
  });

  test("schema migration drops stale generated unique indexes", async () => {
    const path = tempSqlitePath("stale-unique-index");

    try {
      const first = sqliteAdapter(path);
      await first.ensureTable("secrets", {
        columns: {
          name: { type: "string" },
          workspaceId: { type: "string" },
        },
        unique: [["name"]],
      });
      await first.insert("secrets", { name: "gmail", workspaceId: "a" });
      await first.close();

      const second = sqliteAdapter(path);
      await second.ensureTable("secrets", {
        columns: {
          name: { type: "string" },
          workspaceId: { type: "string" },
        },
        unique: [["name", "workspaceId"]],
      });

      await second.insert("secrets", { name: "gmail", workspaceId: "b" });
      const indexes = await sqliteIndexNames(second, "secrets");
      expect(indexes).not.toContain("uq_secrets_name");
      expect(indexes).toContain("uq_secrets_name_workspaceId");
      expect(await sqliteManagedIndexNames(second, "secrets")).toEqual([
        "uq_secrets_name_workspaceId",
      ]);
      await second.close();
    } finally {
      cleanupSqlitePath(path);
    }
  });

  test("schema migration drops recorded explicit indexes when removed", async () => {
    const path = tempSqlitePath("explicit-index-removed");

    try {
      const first = sqliteAdapter(path);
      await first.ensureTable("items", {
        columns: {
          category: { type: "string" },
          value: { type: "number" },
        },
        indexes: [["items_category_value", ["category", "value"]]],
      });
      expect(await sqliteIndexNames(first, "items")).toContain(
        "items_category_value",
      );
      await first.close();

      const second = sqliteAdapter(path);
      await second.ensureTable("items", {
        columns: {
          category: { type: "string" },
          value: { type: "number" },
        },
      });
      expect(await sqliteIndexNames(second, "items")).not.toContain(
        "items_category_value",
      );
      expect(await sqliteManagedIndexNames(second, "items")).toEqual([]);
      await second.close();
    } finally {
      cleanupSqlitePath(path);
    }
  });
});
