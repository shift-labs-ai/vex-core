import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import type { VexPluginAPI } from "../src/core/api.js";
import { Vex } from "../src/core/engine.js";

const rowCount = integerEnv("BENCH_ROWS", 20_000);
const measuredIterations = integerEnv("BENCH_ITERATIONS", 30);
const warmupIterations = integerEnv("BENCH_WARMUP", 5);
const groupCounts = listEnv("BENCH_GROUPS", [1, 2, 4, 8, 16, 32]);
const workloads = workloadEnv();
const workerCount = integerEnv("BENCH_WORKERS", 4);

type Workload = "point" | "list" | "multi" | "aggregate" | "async";

interface Measurement {
  mean: number;
  median: number;
  p95: number;
  min: number;
  max: number;
}

interface ScenarioResult {
  workload: Workload;
  groups: number;
  invalidation: Measurement;
  directSerial: Measurement;
  directBounded: Measurement;
  directSpeedup: number;
}

function integerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function listEnv(name: string, fallback: number[]): number[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  const values = raw.split(",").map((value) => Number(value.trim()));
  if (values.some((value) => !Number.isInteger(value) || value < 1)) {
    throw new Error(
      `${name} must be a comma-separated list of positive integers`,
    );
  }
  return values;
}

function workloadEnv(): Workload[] {
  const raw = process.env.BENCH_WORKLOADS;
  if (!raw) return ["point", "list", "multi", "aggregate", "async"];
  const values = raw.split(",").map((value) => value.trim()) as Workload[];
  const valid = new Set<Workload>([
    "point",
    "list",
    "multi",
    "aggregate",
    "async",
  ]);
  if (values.some((value) => !valid.has(value))) {
    throw new Error(
      "BENCH_WORKLOADS must contain point,list,multi,aggregate,async",
    );
  }
  return values;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarize(samples: number[]): Measurement {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
  return {
    mean: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    median: percentile(0.5),
    p95: percentile(0.95),
    min: sorted[0],
    max: sorted.at(-1)!,
  };
}

async function boundedMap<T>(
  values: T[],
  concurrency: number,
  fn: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    while (next < values.length) {
      const value = values[next++];
      await fn(value);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, worker),
  );
}

function pluginFor(workload: Workload, onQuery: () => void) {
  return (api: VexPluginAPI) => {
    api.setName("bench");
    api.registerTable("records", {
      columns: {
        bucket: { type: "number", index: true },
        score: { type: "number", index: true },
        payload: { type: "string" },
      },
    });
    api.registerQuery("group", {
      args: { bucket: "number" },
      async handler(ctx, args) {
        onQuery();
        if (workload === "async") await sleep(5);
        const scoped = ctx.db
          .table("records")
          .where("bucket", "=", args.bucket);
        if (workload === "point" || workload === "async") {
          return scoped.limit(1).all();
        }
        if (workload === "list") {
          return scoped.order("score", "desc").limit(100).all();
        }
        if (workload === "aggregate") {
          return ctx.db.sql(
            "SELECT SUM(score) AS total FROM records WHERE score >= ?",
            args.bucket,
          );
        }
        return {
          count: await scoped.count(),
          rows: await ctx.db
            .table("records")
            .where("bucket", "=", args.bucket)
            .order("score", "desc")
            .limit(100)
            .all(),
          total: await ctx.db
            .table("records")
            .where("bucket", "=", args.bucket)
            .sum("score"),
        };
      },
    });
    api.registerMutation("toggle", {
      args: { score: "number" },
      async handler(ctx, args) {
        await ctx.db.table("records").update("target", { score: args.score });
      },
    });
  };
}

async function timed(fn: () => Promise<void>): Promise<number> {
  const started = performance.now();
  await fn();
  return performance.now() - started;
}

async function runScenario(
  root: string,
  workload: Workload,
  groups: number,
): Promise<ScenarioResult> {
  const path = join(root, `${workload}-${groups}.db`);
  const storage = sqliteAdapter(path);
  let queryRuns = 0;
  const vex = await Vex.create({
    plugins: [pluginFor(workload, () => queryRuns++)],
    storage,
  });
  try {
    await storage.bulkInsert(
      "records",
      Array.from({ length: rowCount }, (_, index) => ({
        _id: index === 0 ? "target" : `row-${index}`,
        bucket: index % groups,
        score: index,
        payload: `payload-${index}-${"x".repeat(32)}`,
      })),
    );
    storage.getChangedTables();

    const args = Array.from({ length: groups }, (_, bucket) => ({ bucket }));
    const unsubscribers = await Promise.all(
      args.map((groupArgs) =>
        vex.subscribe("bench.group", groupArgs, () => {}),
      ),
    );

    const directSerialSamples: number[] = [];
    const directBoundedSamples: number[] = [];
    const invalidationSamples: number[] = [];
    const totalIterations = warmupIterations + measuredIterations;

    for (let iteration = 0; iteration < totalIterations; iteration++) {
      const runSerial = () =>
        timed(async () => {
          for (const groupArgs of args) {
            await vex.query("bench.group", groupArgs);
          }
        });
      const runBounded = () =>
        timed(() =>
          boundedMap(args, workerCount, async (groupArgs) => {
            await vex.query("bench.group", groupArgs);
          }),
        );
      // Alternate order so the bounded case does not consistently benefit
      // from the serial case warming SQLite's page and statement caches.
      const serialFirst = iteration % 2 === 0;
      const firstMs = await (serialFirst ? runSerial() : runBounded());
      const secondMs = await (serialFirst ? runBounded() : runSerial());
      const serialMs = serialFirst ? firstMs : secondMs;
      const boundedMs = serialFirst ? secondMs : firstMs;

      const before = queryRuns;
      const invalidationMs = await timed(() =>
        vex.mutate("bench.toggle", { score: iteration % 2 }),
      );
      const reruns = queryRuns - before;
      if (reruns !== groups) {
        throw new Error(
          `${workload}/${groups}: expected ${groups} invalidation runs, got ${reruns}`,
        );
      }

      if (iteration >= warmupIterations) {
        directSerialSamples.push(serialMs);
        directBoundedSamples.push(boundedMs);
        invalidationSamples.push(invalidationMs);
      }
    }

    for (const unsubscribe of unsubscribers) unsubscribe();
    const directSerial = summarize(directSerialSamples);
    const directBounded = summarize(directBoundedSamples);
    return {
      workload,
      groups,
      invalidation: summarize(invalidationSamples),
      directSerial,
      directBounded,
      directSpeedup: directSerial.median / directBounded.median,
    };
  } finally {
    await vex.close();
  }
}

function fmt(value: number): string {
  return value.toFixed(2).padStart(8);
}

const root = mkdtempSync(join(tmpdir(), "vex-reactive-concurrency-"));
const results: ScenarioResult[] = [];
try {
  console.log(
    `Reactive group concurrency benchmark: ${rowCount.toLocaleString()} rows, ${measuredIterations} measured + ${warmupIterations} warmup iterations, ${workerCount} workers`,
  );
  console.log(
    "workload groups | invalidation median/p95 | direct serial median | direct bounded median | speedup",
  );
  for (const workload of workloads) {
    for (const groups of groupCounts) {
      const result = await runScenario(root, workload, groups);
      results.push(result);
      console.log(
        `${workload.padEnd(8)} ${String(groups).padStart(6)} |${fmt(result.invalidation.median)}/${fmt(result.invalidation.p95)} ms |${fmt(result.directSerial.median)} ms |${fmt(result.directBounded.median)} ms | ${result.directSpeedup.toFixed(2)}x`,
      );
    }
  }

  console.log("\nJSON");
  console.log(JSON.stringify(results, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}
