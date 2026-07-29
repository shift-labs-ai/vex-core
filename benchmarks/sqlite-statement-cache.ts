import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { sqliteAdapter } from "../src/adapters/sqlite.js";

const rows = positiveIntegerEnv("BENCH_ROWS", 20_000);
const iterations = positiveIntegerEnv("BENCH_ITERATIONS", 20_000);
const scanIterations = positiveIntegerEnv("BENCH_SCAN_ITERATIONS", 500);
const rounds = positiveIntegerEnv("BENCH_ROUNDS", 7);
const cacheSize = positiveIntegerEnv("BENCH_CACHE_SIZE", 64);
const shapeCount = positiveIntegerEnv("BENCH_SHAPES", 32);

interface Result {
  name: string;
  operations: number;
  medianMs: number;
  p95Ms: number;
  nsPerOperation: number;
  operationsPerSecond: number;
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function summarize(
  name: string,
  operations: number,
  samples: number[],
): Result {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
  const medianMs = percentile(0.5);
  return {
    name,
    operations,
    medianMs,
    p95Ms: percentile(0.95),
    nsPerOperation: (medianMs * 1_000_000) / operations,
    operationsPerSecond: operations / (medianMs / 1000),
  };
}

async function measure(
  name: string,
  operations: number,
  fn: () => void | Promise<void>,
): Promise<Result> {
  await fn();
  const samples: number[] = [];
  for (let round = 0; round < rounds; round++) {
    const started = performance.now();
    await fn();
    samples.push(performance.now() - started);
  }
  return summarize(name, operations, samples);
}

class StatementLru {
  private readonly statements = new Map<
    string,
    ReturnType<Database["prepare"]>
  >();

  constructor(private readonly capacity: number) {}

  get(db: Database, sql: string): ReturnType<Database["prepare"]> {
    const existing = this.statements.get(sql);
    if (existing) {
      this.statements.delete(sql);
      this.statements.set(sql, existing);
      return existing;
    }
    const statement = db.prepare(sql);
    this.statements.set(sql, statement);
    if (this.statements.size > this.capacity) {
      const oldest = this.statements.keys().next().value;
      if (oldest !== undefined) {
        this.statements.get(oldest)?.finalize();
        this.statements.delete(oldest);
      }
    }
    return statement;
  }

  close(): void {
    for (const statement of this.statements.values()) statement.finalize();
    this.statements.clear();
  }
}

function printResult(result: Result): void {
  console.log(
    `${result.name.padEnd(31)} ${result.nsPerOperation.toFixed(0).padStart(9)} ns/op  ${Math.round(result.operationsPerSecond).toLocaleString().padStart(12)} ops/s  median ${result.medianMs.toFixed(2).padStart(8)}ms  p95 ${result.p95Ms.toFixed(2).padStart(8)}ms`,
  );
}

const root = mkdtempSync(join(tmpdir(), "vex-statement-cache-"));
const path = join(root, "bench.db");
const writer = new Database(path);
let adapter: ReturnType<typeof sqliteAdapter> | undefined;

const results: Result[] = [];
try {
  writer.exec("PRAGMA journal_mode = WAL");
  writer.exec(
    "CREATE TABLE records (_id TEXT PRIMARY KEY, bucket INTEGER, score INTEGER, payload TEXT)",
  );
  const insert = writer.prepare(
    "INSERT INTO records (_id, bucket, score, payload) VALUES (?, ?, ?, ?)",
  );
  const insertMany = writer.transaction(() => {
    for (let index = 0; index < rows; index++) {
      insert.run(
        `row-${index}`,
        index % 100,
        index,
        `payload-${index}-${"x".repeat(32)}`,
      );
    }
  });
  insertMany();
  insert.finalize();

  const direct = new Database(path, { readonly: true });
  const lru = new StatementLru(cacheSize);
  try {
    const pointSql = "SELECT score, payload FROM records WHERE _id = ?";
    const scanSql = "SELECT SUM(score) AS total FROM records WHERE score >= ?";

    results.push(
      await measure("direct prepare: point", iterations, () => {
        for (let index = 0; index < iterations; index++) {
          direct.prepare(pointSql).get(`row-${index % rows}`);
        }
      }),
    );
    results.push(
      await measure("direct Database.query: point", iterations, () => {
        for (let index = 0; index < iterations; index++) {
          direct.query(pointSql).get(`row-${index % rows}`);
        }
      }),
    );
    results.push(
      await measure("direct bounded LRU: point", iterations, () => {
        for (let index = 0; index < iterations; index++) {
          lru.get(direct, pointSql).get(`row-${index % rows}`);
        }
      }),
    );

    results.push(
      await measure("direct prepare: aggregate", scanIterations, () => {
        for (let index = 0; index < scanIterations; index++) {
          direct.prepare(scanSql).get(index % rows);
        }
      }),
    );
    results.push(
      await measure("direct Database.query: aggregate", scanIterations, () => {
        for (let index = 0; index < scanIterations; index++) {
          direct.query(scanSql).get(index % rows);
        }
      }),
    );
    results.push(
      await measure("direct bounded LRU: aggregate", scanIterations, () => {
        for (let index = 0; index < scanIterations; index++) {
          lru.get(direct, scanSql).get(index % rows);
        }
      }),
    );

    const dynamicIterations = Math.min(iterations, 5_000);
    results.push(
      await measure("direct prepare: unique raw", dynamicIterations, () => {
        for (let index = 0; index < dynamicIterations; index++) {
          direct
            .prepare(`${pointSql} /* unique-${index} */`)
            .get(`row-${index % rows}`);
        }
      }),
    );
    results.push(
      await measure("direct bounded LRU: unique raw", dynamicIterations, () => {
        for (let index = 0; index < dynamicIterations; index++) {
          lru
            .get(direct, `${pointSql} /* unique-${index} */`)
            .get(`row-${index % rows}`);
        }
      }),
    );
  } finally {
    lru.close();
    direct.close();
  }

  writer.close();
  adapter = sqliteAdapter(path);
  await adapter.ensureTable("records", {
    columns: {
      bucket: { type: "number", index: true },
      score: { type: "number", index: true },
      payload: { type: "string" },
    },
  });

  results.push(
    await measure("adapter rawQuery: point", iterations, async () => {
      for (let index = 0; index < iterations; index++) {
        await adapter!.rawQuery(
          "SELECT score, payload FROM records WHERE _id = ?",
          `row-${index % rows}`,
        );
      }
    }),
  );
  results.push(
    await measure("adapter query builder: point", iterations, async () => {
      for (let index = 0; index < iterations; index++) {
        await adapter!
          .query("records")
          .where("_id", "=", `row-${index % rows}`)
          .first();
      }
    }),
  );
  results.push(
    await measure("adapter rawQuery: aggregate", scanIterations, async () => {
      for (let index = 0; index < scanIterations; index++) {
        await adapter!.rawQuery(
          "SELECT SUM(score) AS total FROM records WHERE score >= ?",
          index % rows,
        );
      }
    }),
  );
  results.push(
    await measure(
      `adapter rawQuery: ${shapeCount} shapes`,
      iterations,
      async () => {
        for (let index = 0; index < iterations; index++) {
          await adapter!.rawQuery(
            `SELECT score FROM records WHERE _id = ? /* shape-${index % shapeCount} */`,
            `row-${index % rows}`,
          );
        }
      },
    ),
  );
  const dynamicIterations = Math.min(iterations, 5_000);
  results.push(
    await measure(
      "adapter rawQuery: unique raw",
      dynamicIterations,
      async () => {
        for (let index = 0; index < dynamicIterations; index++) {
          await adapter!.rawQuery(
            `SELECT score FROM records WHERE _id = ? /* unique-${index} */`,
            `row-${index % rows}`,
          );
        }
      },
    ),
  );

  const writeIterations = Math.min(iterations, 10_000);
  results.push(
    await measure("adapter update", writeIterations, async () => {
      for (let index = 0; index < writeIterations; index++) {
        await adapter!.update(`records`, `row-${index % rows}`, {
          score: index,
        });
      }
    }),
  );
  results.push(
    await measure("adapter rawExec: update", writeIterations, async () => {
      for (let index = 0; index < writeIterations; index++) {
        await adapter!.rawExec(
          "UPDATE records SET score = ? WHERE _id = ?",
          index,
          `row-${index % rows}`,
        );
      }
    }),
  );

  console.log(
    `SQLite statement cache benchmark: ${rows.toLocaleString()} rows, ${rounds} rounds, ${iterations.toLocaleString()} point ops, ${scanIterations.toLocaleString()} aggregate ops, LRU ${cacheSize}`,
  );
  for (const result of results) printResult(result);
  console.log("\nJSON");
  console.log(JSON.stringify(results, null, 2));
} finally {
  await adapter?.close();
  try {
    writer.close();
  } catch {}
  rmSync(root, { recursive: true, force: true });
}
