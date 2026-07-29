import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteAdapter } from "../src/adapters/sqlite.js";

type Scenario =
  | "statements-uncached"
  | "statements-uncached-overflow"
  | "statements-cached"
  | "statements-cached-overflow"
  | "reactive-current-16"
  | "reactive-reused-16"
  | "reactive-current-64"
  | "reactive-reused-64";

interface MemorySnapshot {
  rss: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
  maxRss: number;
}

interface ChildResult {
  scenario: Scenario;
  before: MemorySnapshot;
  after: MemorySnapshot;
  delta: MemorySnapshot;
}

const childScenario = process.env.BENCH_MEMORY_CHILD as Scenario | undefined;
const repetitions = positiveIntegerEnv("BENCH_REPETITIONS", 7);

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

async function snapshot(): Promise<MemorySnapshot> {
  Bun.gc(true);
  await new Promise((resolve) => setImmediate(resolve));
  Bun.gc(true);
  const memory = process.memoryUsage();
  return {
    rss: memory.rss,
    heapUsed: memory.heapUsed,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
    maxRss: process.resourceUsage().maxRSS,
  };
}

function subtract(
  after: MemorySnapshot,
  before: MemorySnapshot,
): MemorySnapshot {
  return {
    rss: after.rss - before.rss,
    heapUsed: after.heapUsed - before.heapUsed,
    external: after.external - before.external,
    arrayBuffers: after.arrayBuffers - before.arrayBuffers,
    maxRss: after.maxRss - before.maxRss,
  };
}

async function statementScenario(
  cached: boolean,
  overflow: boolean,
): Promise<Omit<ChildResult, "scenario">> {
  const root = mkdtempSync(join(tmpdir(), "vex-memory-statements-"));
  const path = join(root, "bench.db");
  let adapter: ReturnType<typeof sqliteAdapter> | undefined;
  const directConnections: Database[] = [];
  try {
    const setup = new Database(path);
    setup.exec("PRAGMA journal_mode = WAL");
    setup.exec(
      "CREATE TABLE records (_id TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    setup.query("INSERT INTO records VALUES (?, ?)").run("row", "value");
    setup.close();

    const readShapes = overflow ? 4_096 : 256;
    const writeShapes = overflow ? 512 : 64;
    let run: () => Promise<void>;
    if (cached) {
      adapter = sqliteAdapter(path);
      await adapter.ensureTable("records", {
        columns: { value: { type: "string" } },
      });
      run = async () => {
        for (let index = 0; index < readShapes; index++) {
          await adapter!.rawQuery(
            `SELECT value FROM records WHERE _id = ? /* read-${index} */`,
            "row",
          );
        }
        for (let index = 0; index < writeShapes; index++) {
          await adapter!.rawExec(
            `UPDATE records SET value = ? WHERE _id = ? /* write-${index} */`,
            "value",
            "row",
          );
        }
      };
    } else {
      const writer = new Database(path);
      directConnections.push(writer);
      for (let index = 0; index < 4; index++) {
        directConnections.push(new Database(path, { readonly: true }));
      }
      run = async () => {
        for (let index = 0; index < readShapes; index++) {
          directConnections[(index % 4) + 1]
            .prepare(
              `SELECT value FROM records WHERE _id = ? /* read-${index} */`,
            )
            .all("row");
        }
        for (let index = 0; index < writeShapes; index++) {
          writer
            .prepare(
              `UPDATE records SET value = ? WHERE _id = ? /* write-${index} */`,
            )
            .run("value", "row");
        }
      };
    }

    const before = await snapshot();
    await run();
    const after = await snapshot();
    return { before, after, delta: subtract(after, before) };
  } finally {
    await adapter?.close();
    for (const connection of directConnections) connection.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function makeReactiveResult(): Record<string, unknown>[] {
  return Array.from({ length: 1_000 }, (_, index) => ({
    _id: `row-${index}`,
    score: index,
    payload: "x".repeat(256),
    metadata: { source: "benchmark", position: index },
  }));
}

async function reactiveScenario(
  reused: boolean,
  subscribers: number,
): Promise<Omit<ChildResult, "scenario">> {
  const result = makeReactiveResult();
  const ids = Array.from({ length: subscribers }, (_, index) => `sub-${index}`);
  const iterations = subscribers === 64 ? 30 : 100;
  const encoder = new TextEncoder();
  const before = await snapshot();

  const checksum = await (async () => {
    let value = 0;
    for (let iteration = 0; iteration < iterations; iteration++) {
      const serialized = JSON.stringify(result);
      value = (value + Number(Bun.hash(serialized))) >>> 0;
      value = (value + encoder.encode(serialized).byteLength) >>> 0;
      for (const id of ids) {
        const frame = reused
          ? `{"type":"data","id":${JSON.stringify(id)},"data":${serialized}}`
          : JSON.stringify({ type: "data", id, data: result });
        value = (value + encoder.encode(frame).byteLength) >>> 0;
      }
    }
    return value;
  })();

  if (!Number.isFinite(checksum)) throw new Error("invalid checksum");
  const after = await snapshot();
  return { before, after, delta: subtract(after, before) };
}

async function runChild(scenario: Scenario): Promise<ChildResult> {
  let result: Omit<ChildResult, "scenario">;
  switch (scenario) {
    case "statements-uncached":
      result = await statementScenario(false, false);
      break;
    case "statements-uncached-overflow":
      result = await statementScenario(false, true);
      break;
    case "statements-cached":
      result = await statementScenario(true, false);
      break;
    case "statements-cached-overflow":
      result = await statementScenario(true, true);
      break;
    case "reactive-current-16":
      result = await reactiveScenario(false, 16);
      break;
    case "reactive-reused-16":
      result = await reactiveScenario(true, 16);
      break;
    case "reactive-current-64":
      result = await reactiveScenario(false, 64);
      break;
    case "reactive-reused-64":
      result = await reactiveScenario(true, 64);
      break;
  }
  return { scenario, ...result };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function mib(bytes: number): string {
  const value = bytes / (1024 * 1024);
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`.padStart(8);
}

if (childScenario) {
  console.log(JSON.stringify(await runChild(childScenario)));
} else {
  const scenarios: Scenario[] = [
    "statements-uncached",
    "statements-uncached-overflow",
    "statements-cached",
    "statements-cached-overflow",
    "reactive-current-16",
    "reactive-reused-16",
    "reactive-current-64",
    "reactive-reused-64",
  ];
  const allResults: Record<Scenario, ChildResult[]> = Object.fromEntries(
    scenarios.map((scenario) => [scenario, []]),
  ) as Record<Scenario, ChildResult[]>;

  for (const scenario of scenarios) {
    for (let repetition = 0; repetition < repetitions; repetition++) {
      const child = Bun.spawn([process.execPath, import.meta.path], {
        env: { ...process.env, BENCH_MEMORY_CHILD: scenario },
        stdout: "pipe",
        stderr: "inherit",
      });
      const output = await new Response(child.stdout).text();
      const exitCode = await child.exited;
      if (exitCode !== 0) {
        throw new Error(`${scenario} child exited with ${exitCode}`);
      }
      allResults[scenario].push(JSON.parse(output.trim()) as ChildResult);
    }
  }

  console.log(
    `Memory impact benchmark: ${repetitions} isolated processes per scenario`,
  );
  console.log(
    "scenario                     | retained RSS | retained heap | retained external | peak RSS",
  );
  for (const scenario of scenarios) {
    const samples = allResults[scenario];
    console.log(
      `${scenario.padEnd(28)} | ${mib(median(samples.map((r) => r.delta.rss)))} MiB | ${mib(median(samples.map((r) => r.delta.heapUsed)))} MiB | ${mib(median(samples.map((r) => r.delta.external)))} MiB | ${mib(median(samples.map((r) => r.delta.maxRss)))} MiB`,
    );
  }

  console.log("\nJSON");
  console.log(JSON.stringify(allResults, null, 2));
}
