/**
 * Engine hot-path micro-benchmarks (SHFT-969).
 *
 * Four candidates surfaced by a full reread, each measured against a
 * faithful replica of the current production code. Every optimized
 * variant is validated for output equivalence before timing:
 *
 *   A. Traced-query resultBytes: TextEncoder round trip vs Buffer.byteLength.
 *   B. deserializeRow: per-row schema iteration vs a precomputed transform
 *      plan that skips tables with no json/boolean columns.
 *   C. dependencyAffected: per-dependency writes.filter() vs one writes
 *      Map grouped by table per invalidation.
 *   D. trackQueryBuilder: fresh 20-closure wrapper per chained call vs a
 *      single wrapper with accumulated descriptor state.
 */

import { performance } from "node:perf_hooks";

const rounds = positiveIntegerEnv("BENCH_ROUNDS", 9);

interface Measurement {
  medianMs: number;
  p95Ms: number;
  nsPerOp: number;
}

interface ScenarioResult {
  section: string;
  scenario: string;
  iterations: number;
  current: Measurement;
  optimized: Measurement;
  speedup: number;
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function summarize(samples: number[], iterations: number): Measurement {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
  const medianMs = percentile(0.5);
  return {
    medianMs,
    p95Ms: percentile(0.95),
    nsPerOp: (medianMs * 1_000_000) / iterations,
  };
}

let checksum = 0;
function measure(iterations: number, fn: () => number): Measurement {
  fn();
  const samples: number[] = [];
  for (let round = 0; round < rounds; round++) {
    const started = performance.now();
    for (let iteration = 0; iteration < iterations; iteration++) {
      checksum = (checksum + fn()) >>> 0;
    }
    samples.push(performance.now() - started);
  }
  return summarize(samples, iterations);
}

const results: ScenarioResult[] = [];
function run(
  section: string,
  scenario: string,
  iterations: number,
  current: () => number,
  optimized: () => number,
): void {
  if (current() !== optimized()) {
    throw new Error(`${section} / ${scenario}: outputs differ`);
  }
  // Alternate which strategy goes first to avoid a systematic
  // temperature or CPU-frequency advantage.
  const currentFirst = results.length % 2 === 0;
  const first = measure(iterations, currentFirst ? current : optimized);
  const second = measure(iterations, currentFirst ? optimized : current);
  const currentMeasurement = currentFirst ? first : second;
  const optimizedMeasurement = currentFirst ? second : first;
  const scenarioResult: ScenarioResult = {
    section,
    scenario,
    iterations,
    current: currentMeasurement,
    optimized: optimizedMeasurement,
    speedup: currentMeasurement.nsPerOp / optimizedMeasurement.nsPerOp,
  };
  results.push(scenarioResult);
  console.log(
    `${section.padEnd(2)} ${scenario.padEnd(42)} |${currentMeasurement.nsPerOp.toFixed(0).padStart(10)} |${optimizedMeasurement.nsPerOp.toFixed(0).padStart(10)} | ${scenarioResult.speedup.toFixed(2)}x`,
  );
}

function makeRows(count: number, payloadBytes: number) {
  return Array.from({ length: count }, (_, index) => ({
    _id: `row-${index}`,
    scope: `scope-${index % 10}`,
    score: index,
    payload: "x".repeat(payloadBytes),
  }));
}

console.log(`Engine hot-path benchmark: ${rounds} rounds per strategy`);
console.log(
  "   scenario                                   | current ns | optimized  | speedup",
);

// ─── A. Traced-query resultBytes measurement ────────────────────────

{
  const encoder = new TextEncoder();
  for (const rows of [1, 10, 100, 1_000]) {
    const result = makeRows(rows, 64);
    run(
      "A",
      `resultBytes for ${rows} rows`,
      Math.max(50, Math.ceil(20_000 / rows)),
      () => encoder.encode(JSON.stringify(result)).byteLength,
      () => Buffer.byteLength(JSON.stringify(result) ?? "undefined"),
    );
  }
}

// ─── B. deserializeRow transform plan ───────────────────────────────

type ColumnDef = { type: string };
type Schema = { columns: Record<string, ColumnDef> };

// Faithful replica of shared.ts deserializeRow.
function deserializeRowCurrent(
  row: Record<string, any>,
  schema: Schema | undefined,
): Record<string, any> {
  if (!schema) return row;
  for (const [col, def] of Object.entries(schema.columns)) {
    if (!(col in row) || row[col] === null) continue;
    const type = def.type;
    if (type === "json" || type === "any") {
      if (typeof row[col] === "string") {
        try {
          row[col] = JSON.parse(row[col]);
        } catch {}
      }
    } else if (type === "boolean") {
      row[col] = row[col] === 1 || row[col] === true;
    }
  }
  return row;
}

// Candidate: precompute which columns need transformation per schema.
type TransformPlan = Array<{ col: string; kind: "json" | "boolean" }>;
const planCache = new WeakMap<Schema, TransformPlan>();
function transformPlan(schema: Schema): TransformPlan {
  let plan = planCache.get(schema);
  if (!plan) {
    plan = [];
    for (const [col, def] of Object.entries(schema.columns)) {
      if (def.type === "json" || def.type === "any") {
        plan.push({ col, kind: "json" });
      } else if (def.type === "boolean") {
        plan.push({ col, kind: "boolean" });
      }
    }
    planCache.set(schema, plan);
  }
  return plan;
}

function deserializeRowPlanned(
  row: Record<string, any>,
  schema: Schema | undefined,
): Record<string, any> {
  if (!schema) return row;
  const plan = transformPlan(schema);
  for (const { col, kind } of plan) {
    const value = row[col];
    if (!(col in row) || value === null) continue;
    if (kind === "json") {
      if (typeof value === "string") {
        try {
          row[col] = JSON.parse(value);
        } catch {}
      }
    } else {
      row[col] = value === 1 || value === true;
    }
  }
  return row;
}

{
  const plainSchema: Schema = {
    columns: {
      scope: { type: "string" },
      kind: { type: "string" },
      name: { type: "string" },
      score: { type: "number" },
      createdAt: { type: "number" },
      updatedAt: { type: "number" },
    },
  };
  const mixedSchema: Schema = {
    columns: {
      ...plainSchema.columns,
      active: { type: "boolean" },
      body: { type: "json" },
    },
  };
  const makeDbRows = (schema: Schema) =>
    Array.from({ length: 500 }, (_, index) => {
      const row: Record<string, any> = {
        _id: `row-${index}`,
        scope: `scope-${index % 10}`,
        kind: "benchmark",
        name: `name-${index}`,
        score: index,
        createdAt: index,
        updatedAt: index,
      };
      if (schema === mixedSchema) {
        row.active = index % 2;
        row.body = `{"position":${index}}`;
      }
      return row;
    });

  for (const [label, schema] of [
    ["500 rows, no transform columns", plainSchema],
    ["500 rows, boolean + json columns", mixedSchema],
  ] as const) {
    run(
      "B",
      label,
      200,
      () => {
        let total = 0;
        for (const row of makeDbRows(schema)) {
          total += Object.keys(deserializeRowCurrent(row, schema)).length;
        }
        return total;
      },
      () => {
        let total = 0;
        for (const row of makeDbRows(schema)) {
          total += Object.keys(deserializeRowPlanned(row, schema)).length;
        }
        return total;
      },
    );
  }
}

// ─── C. dependencyAffected write grouping ───────────────────────────

interface Dependency {
  table: string;
  raw?: boolean;
  filters?: Array<{ column: string; operator: string; value: any }>;
}
interface Write {
  table: string;
  raw?: boolean;
  values?: Record<string, any>;
}

function affectedWith(
  dependencies: Dependency[],
  changedSet: Set<string>,
  tableWritesOf: (table: string) => Write[],
): boolean {
  if (dependencies.length === 0) return true;
  for (const dep of dependencies) {
    if (dep.table === "*" && dep.raw) return true;
    if (!changedSet.has(dep.table)) continue;
    if (dep.raw) return true;
    const tableWrites = tableWritesOf(dep.table);
    if (
      tableWrites.length === 0 ||
      tableWrites.some((write) => write.raw || !write.values)
    )
      return true;
    const eqFilters = (dep.filters ?? []).filter(
      (filter) => filter.operator === "=",
    );
    if (eqFilters.length === 0) return true;
    if (
      tableWrites.some((write) =>
        eqFilters.every(
          (filter) =>
            !(filter.column in (write.values ?? {})) ||
            write.values?.[filter.column] === filter.value,
        ),
      )
    ) {
      return true;
    }
  }
  return false;
}

{
  const tables = ["entries", "messages", "sessions", "workspaces"];
  const writes: Write[] = Array.from({ length: 24 }, (_, index) => ({
    table: tables[index % tables.length],
    values: { scope: `scope-${index % 6}`, score: index },
  }));
  const subscriptions: Dependency[][] = Array.from(
    { length: 200 },
    (_, index) => [
      {
        table: tables[index % tables.length],
        filters: [
          { column: "scope", operator: "=", value: `scope-${index % 6}` },
        ],
      },
      { table: tables[(index + 1) % tables.length] },
      { table: "unrelated" },
    ],
  );
  const changedSet = new Set(tables);

  run(
    "C",
    "200 subs x 3 deps x 24 writes",
    200,
    () => {
      let affected = 0;
      for (const dependencies of subscriptions) {
        if (
          affectedWith(dependencies, changedSet, (table) =>
            writes.filter((write) => write.table === table),
          )
        ) {
          affected++;
        }
      }
      return affected;
    },
    () => {
      const byTable = new Map<string, Write[]>();
      for (const write of writes) {
        const group = byTable.get(write.table);
        if (group) group.push(write);
        else byTable.set(write.table, [write]);
      }
      const empty: Write[] = [];
      let affected = 0;
      for (const dependencies of subscriptions) {
        if (
          affectedWith(
            dependencies,
            changedSet,
            (table) => byTable.get(table) ?? empty,
          )
        ) {
          affected++;
        }
      }
      return affected;
    },
  );
}

// ─── D. trackQueryBuilder wrapper churn ─────────────────────────────

interface Descriptor {
  table: string;
  filters?: Array<{ column: string; operator: string; value: any }>;
  order?: { column: string; dir: string };
  limit?: number;
}

// Faithful shape replica: every chained call allocates a fresh wrapper
// object with one closure per method plus a spread-copied descriptor.
function chainWrapper(
  dependencies: Descriptor[],
  table: string,
  descriptor: Omit<Descriptor, "table"> = {},
) {
  const record = () => {
    dependencies.push({ table, ...descriptor });
    return dependencies.length;
  };
  return {
    where(column: string, operator: string, value: any) {
      return chainWrapper(dependencies, table, {
        ...descriptor,
        filters: [...(descriptor.filters ?? []), { column, operator, value }],
      });
    },
    order(column: string, dir: string) {
      return chainWrapper(dependencies, table, {
        ...descriptor,
        order: { column, dir },
      });
    },
    limit(n: number) {
      return chainWrapper(dependencies, table, { ...descriptor, limit: n });
    },
    all: record,
    first: record,
    count: record,
    sum: record,
    avg: record,
    min: record,
    max: record,
    distinct: record,
    countDistinct: record,
    groupBy: record,
    select: record,
    offset: record,
    delete: record,
  };
}

// Candidate: one wrapper per tracked builder, descriptor mutated in place.
function mutableWrapper(dependencies: Descriptor[], table: string) {
  const descriptor: Omit<Descriptor, "table"> = {};
  const record = () => {
    dependencies.push({ table, ...descriptor });
    return dependencies.length;
  };
  const wrapper = {
    where(column: string, operator: string, value: any) {
      descriptor.filters = [
        ...(descriptor.filters ?? []),
        { column, operator, value },
      ];
      return wrapper;
    },
    order(column: string, dir: string) {
      descriptor.order = { column, dir };
      return wrapper;
    },
    limit(n: number) {
      descriptor.limit = n;
      return wrapper;
    },
    all: record,
    first: record,
    count: record,
    sum: record,
    avg: record,
    min: record,
    max: record,
    distinct: record,
    countDistinct: record,
    groupBy: record,
    select: record,
    offset: record,
    delete: record,
  };
  return wrapper;
}

run(
  "D",
  "3 chained calls + terminal read",
  20_000,
  () => {
    const dependencies: Descriptor[] = [];
    return chainWrapper(dependencies, "entries")
      .where("scope", "=", "a")
      .where("kind", "=", "one")
      .order("score", "desc")
      .all();
  },
  () => {
    const dependencies: Descriptor[] = [];
    return mutableWrapper(dependencies, "entries")
      .where("scope", "=", "a")
      .where("kind", "=", "one")
      .order("score", "desc")
      .all();
  },
);

console.log(`\nchecksum ${checksum}`);
console.log("\nJSON");
console.log(JSON.stringify(results, null, 2));
