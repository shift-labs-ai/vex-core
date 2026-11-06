import type { TableSchema } from "./types.js";

/**
 * Built-in tables and queries managed by the engine itself.
 * These are not plugins — they're infrastructure the engine needs to operate.
 */

export const INTERNAL_TABLES: Record<string, TableSchema> = {
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
