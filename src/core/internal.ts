import type { StoredTableSchema } from "./types.js";

/** The tables the engine keeps, as storage keeps them. */

export const INTERNAL_TABLES: Record<string, StoredTableSchema> = {
  // Each migration applied, by id (VexOptions.migrations).
  _migrations: {
    columns: {
      migrationId: { type: "string", index: true },
      appliedAt: { type: "number" },
    },
    unique: [["migrationId"]],
  },
  _spans: {
    columns: {
      traceId: { type: "string", index: true },
      spanId: { type: "string" },
      parentSpanId: { type: "string", optional: true },
      app: { type: "string" },
      type: { type: "string" },
      name: { type: "string" },
      startTime: { type: "number", index: true },
      duration: { type: "number" },
      status: { type: "string" },
      error: { type: "string", optional: true },
      meta: { type: "string", optional: true },
    },
  },
  // Each scheduled function (ctx.scheduler): what runs, when, as whom.
  _scheduled: {
    columns: {
      name: { type: "string" },
      kind: { type: "string" },
      args: { type: "json" },
      caller: { type: "json", optional: true },
      runAt: { type: "number", index: true },
      status: { type: "string", index: true },
      error: { type: "string", optional: true },
      createdAt: { type: "number" },
      finishedAt: { type: "number", optional: true },
    },
  },
  _jobs: {
    columns: {
      name: { type: "string", index: true },
      plugin: { type: "string" },
      schedule: { type: "string" },
      description: { type: "string", optional: true },
      enabled: { type: "number" },
      timeoutMs: { type: "number", optional: true },
      retries: { type: "number" },
      retryDelayMs: { type: "number", optional: true },
      lastRun: { type: "number", optional: true },
      lastStatus: { type: "string", optional: true },
      lastError: { type: "string", optional: true },
      lastDurationMs: { type: "number", optional: true },
      nextRun: { type: "number", optional: true },
      runs: { type: "number" },
    },
    unique: [["name"]],
  },
};
