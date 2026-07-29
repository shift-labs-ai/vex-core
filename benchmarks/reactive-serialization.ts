import { performance } from "node:perf_hooks";

const rowCounts = listEnv("BENCH_ROWS", [10, 100, 1_000]);
const subscriberCounts = listEnv("BENCH_SUBSCRIBERS", [1, 4, 16]);
const payloadBytes = positiveIntegerEnv("BENCH_PAYLOAD_BYTES", 64);
const targetBytesPerRound = positiveIntegerEnv(
  "BENCH_TARGET_BYTES_PER_ROUND",
  20 * 1024 * 1024,
);
const rounds = positiveIntegerEnv("BENCH_ROUNDS", 7);

interface Measurement {
  medianMs: number;
  p95Ms: number;
  nsPerEvaluation: number;
  evaluationsPerSecond: number;
}

interface ScenarioResult {
  rows: number;
  subscribers: number;
  resultBytes: number;
  iterations: number;
  current: Measurement;
  reused: Measurement;
  speedup: number;
}

function positiveIntegerEnv(name: string, fallback: number): number {
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

function summarize(samples: number[], iterations: number): Measurement {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
  const medianMs = percentile(0.5);
  return {
    medianMs,
    p95Ms: percentile(0.95),
    nsPerEvaluation: (medianMs * 1_000_000) / iterations,
    evaluationsPerSecond: iterations / (medianMs / 1_000),
  };
}

function makeResult(rowCount: number): Record<string, unknown>[] {
  return Array.from({ length: rowCount }, (_, index) => ({
    _id: `row-${index}`,
    scope: `scope-${index % 10}`,
    score: index,
    active: index % 2 === 0,
    payload: "x".repeat(payloadBytes),
    metadata: { source: "benchmark", position: index },
  }));
}

function currentFrames(
  result: unknown,
  subscriberIds: string[],
): { hash: number; bytes: number; frames: string[] } {
  const json = JSON.stringify(result);
  return {
    hash: Number(Bun.hash(json)),
    bytes: new TextEncoder().encode(json).byteLength,
    frames: subscriberIds.map((id) =>
      JSON.stringify({ type: "data", id, data: result }),
    ),
  };
}

function reusedFrames(
  result: unknown,
  subscriberIds: string[],
): { hash: number; bytes: number; frames: string[] } {
  const json = JSON.stringify(result);
  return {
    hash: Number(Bun.hash(json)),
    bytes: new TextEncoder().encode(json).byteLength,
    frames: subscriberIds.map(
      (id) => `{"type":"data","id":${JSON.stringify(id)},"data":${json}}`,
    ),
  };
}

let checksum = 0;
async function measure(
  iterations: number,
  fn: () => { hash: number; bytes: number; frames: string[] },
): Promise<Measurement> {
  fn();
  const samples: number[] = [];
  for (let round = 0; round < rounds; round++) {
    const started = performance.now();
    for (let iteration = 0; iteration < iterations; iteration++) {
      const output = fn();
      checksum = (checksum + output.hash + output.bytes) >>> 0;
      for (const frame of output.frames) {
        checksum = (checksum + frame.length) >>> 0;
      }
    }
    samples.push(performance.now() - started);
  }
  return summarize(samples, iterations);
}

function validateEquivalent(
  current: ReturnType<typeof currentFrames>,
  reused: ReturnType<typeof reusedFrames>,
): void {
  if (current.hash !== reused.hash || current.bytes !== reused.bytes) {
    throw new Error("measurement changed while reusing serialized data");
  }
  if (
    current.frames.length !== reused.frames.length ||
    current.frames.some((frame, index) => frame !== reused.frames[index])
  ) {
    throw new Error("reused WebSocket frame differs from JSON.stringify");
  }
}

function fmt(value: number): string {
  return value.toFixed(0).padStart(10);
}

const results: ScenarioResult[] = [];
console.log(
  `Reactive serialization benchmark: payload ${payloadBytes} bytes, ${rounds} rounds, ~${Math.round(targetBytesPerRound / (1024 * 1024))} MiB serialized per strategy/round`,
);
console.log(
  " rows subscribers result KiB | current ns/eval | reused ns/eval | speedup",
);

for (const rows of rowCounts) {
  const result = makeResult(rows);
  const resultJson = JSON.stringify(result);
  const resultBytes = new TextEncoder().encode(resultJson).byteLength;
  for (const subscribers of subscriberCounts) {
    const subscriberIds = Array.from(
      { length: subscribers },
      (_, index) => `sub-${index}`,
    );
    const current = () => currentFrames(result, subscriberIds);
    const reused = () => reusedFrames(result, subscriberIds);
    validateEquivalent(current(), reused());

    const bytesPerEvaluation = resultBytes * (subscribers + 1);
    const iterations = Math.max(
      10,
      Math.min(10_000, Math.floor(targetBytesPerRound / bytesPerEvaluation)),
    );

    // Alternate which strategy goes first across scenarios to avoid a
    // systematic temperature or CPU-frequency advantage.
    const currentFirst = results.length % 2 === 0;
    const first = await measure(iterations, currentFirst ? current : reused);
    const second = await measure(iterations, currentFirst ? reused : current);
    const currentMeasurement = currentFirst ? first : second;
    const reusedMeasurement = currentFirst ? second : first;
    const scenario: ScenarioResult = {
      rows,
      subscribers,
      resultBytes,
      iterations,
      current: currentMeasurement,
      reused: reusedMeasurement,
      speedup:
        currentMeasurement.nsPerEvaluation / reusedMeasurement.nsPerEvaluation,
    };
    results.push(scenario);
    console.log(
      `${String(rows).padStart(5)} ${String(subscribers).padStart(11)} ${(resultBytes / 1024).toFixed(1).padStart(10)} |${fmt(currentMeasurement.nsPerEvaluation)} |${fmt(reusedMeasurement.nsPerEvaluation)} | ${scenario.speedup.toFixed(2)}x`,
    );
  }
}

console.log(`\nchecksum ${checksum}`);
console.log("\nJSON");
console.log(JSON.stringify(results, null, 2));
