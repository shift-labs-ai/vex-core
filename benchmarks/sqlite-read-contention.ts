import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { sqliteAdapter } from "../src/adapters/sqlite.js";

const durationMs = Number(process.env.BENCH_DURATION_MS ?? 3_000);
const writerHoldMs = Number(process.env.BENCH_WRITER_HOLD_MS ?? 5);
const rowCount = Number(process.env.BENCH_ROWS ?? 10_000);
const maxLatencyRatio = Number(process.env.BENCH_MAX_LATENCY_RATIO ?? 2);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function percentile(sorted: number[], fraction: number): number {
  return (
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ??
    0
  );
}

async function measureReads(
  storage: ReturnType<typeof sqliteAdapter>,
  duration: number,
  targetId: string,
): Promise<{
  count: number;
  avg: number;
  p50: number;
  p99: number;
  max: number;
}> {
  const latencies: number[] = [];
  const deadline = performance.now() + duration;
  while (performance.now() < deadline) {
    const started = performance.now();
    await storage.rawQuery("SELECT value FROM bench WHERE _id = ?", targetId);
    latencies.push(performance.now() - started);
    await yieldToEventLoop();
  }

  latencies.sort((a, b) => a - b);
  return {
    count: latencies.length,
    avg: latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
    p50: percentile(latencies, 0.5),
    p99: percentile(latencies, 0.99),
    max: latencies.at(-1) ?? 0,
  };
}

function printResult(
  label: string,
  result: Awaited<ReturnType<typeof measureReads>>,
): void {
  console.log(
    `${label.padEnd(18)} ${result.count.toString().padStart(7)} reads  avg ${result.avg.toFixed(3).padStart(7)}ms  p50 ${result.p50.toFixed(3).padStart(7)}ms  p99 ${result.p99.toFixed(3).padStart(7)}ms  max ${result.max.toFixed(3).padStart(7)}ms`,
  );
}

if (!Number.isInteger(rowCount) || rowCount < 1) {
  throw new Error("BENCH_ROWS must be a positive integer");
}
if (!Number.isFinite(durationMs) || durationMs < 1) {
  throw new Error("BENCH_DURATION_MS must be a positive number");
}
if (!Number.isFinite(writerHoldMs) || writerHoldMs < 0) {
  throw new Error("BENCH_WRITER_HOLD_MS must be a non-negative number");
}
if (!Number.isFinite(maxLatencyRatio) || maxLatencyRatio <= 0) {
  throw new Error("BENCH_MAX_LATENCY_RATIO must be a positive number");
}

const tmp = mkdtempSync(join(tmpdir(), "vex-core-read-bench-"));
const path = join(tmp, "bench.db");
let storage: ReturnType<typeof sqliteAdapter> | undefined;

try {
  storage = sqliteAdapter(path);
  await storage.ensureTable("bench", {
    columns: { value: { type: "number", index: true } },
  });
  await storage.bulkInsert(
    "bench",
    Array.from({ length: rowCount }, (_, index) => ({
      _id: `row-${index}`,
      value: index,
    })),
  );
  storage.getChangedTables();

  console.log(
    `SQLite read contention: ${rowCount.toLocaleString()} rows, ${durationMs}ms phases, writer holds transactions ${writerHoldMs}ms`,
  );
  const targetId = `row-${Math.floor(rowCount / 2)}`;
  await measureReads(storage, Math.min(500, durationMs), targetId);
  const baseline = await measureReads(storage, durationMs, targetId);

  let stopWriter = false;
  let writerIterations = 0;
  const writer = (async () => {
    while (!stopWriter) {
      await storage.transaction(async () => {
        await storage.rawExec(
          "UPDATE bench SET value = value + 1 WHERE _id = ?",
          "row-0",
        );
        await sleep(writerHoldMs);
      });
      writerIterations++;
      await yieldToEventLoop();
    }
  })();

  let contended: Awaited<ReturnType<typeof measureReads>>;
  try {
    contended = await measureReads(storage, durationMs, targetId);
  } finally {
    stopWriter = true;
    await writer;
  }

  const latencyRatio = contended.avg / baseline.avg;
  printResult("baseline", baseline);
  printResult("writer active", contended);
  console.log(
    `relative            latency ${latencyRatio.toFixed(2)}x baseline  throughput ${(contended.count / baseline.count).toFixed(2)}x baseline  writer tx ${writerIterations}`,
  );
  if (latencyRatio > maxLatencyRatio) {
    throw new Error(
      `contended read latency ${latencyRatio.toFixed(2)}x exceeded the ${maxLatencyRatio.toFixed(2)}x limit`,
    );
  }
  console.log(
    `PASS                latency within ${maxLatencyRatio.toFixed(2)}x baseline`,
  );
} finally {
  await storage?.close();
  rmSync(tmp, { recursive: true, force: true });
}
