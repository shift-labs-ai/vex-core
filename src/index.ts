// Adapters
export { sqliteAdapter } from "./adapters/sqlite.js";

// Core
export type { AccessReader, TableAccessPolicy } from "./core/access.js";
export { UNRESTRICTED } from "./core/access.js";
export type { PluginFunction, VexPluginAPI } from "./core/api.js";
export { createPluginAPI, resolvePlugin } from "./core/api.js";
// Config
export { config } from "./core/config.js";
export type { VexOptions } from "./core/engine.js";
export { Vex } from "./core/engine.js";
export { id } from "./core/id.js";
// Rate limiting
export type {
  RateLimit,
  RateLimitDecision,
  RateLimiterOptions,
} from "./core/rate-limit.js";
export {
  isRateLimitExceeded,
  RateLimitExceededError,
  RateLimiter,
} from "./core/rate-limit.js";
export type { StorageAdapter } from "./core/storage.js";
export type {
  ExecContext,
  Span,
  SpanHandle,
  Tracer,
  TraceStart,
} from "./core/tracer.js";
export { createRootSpan, noopExecCtx } from "./core/tracer.js";
export type {
  AggDef,
  CallContext,
  ColumnDef,
  ColumnType,
  Filter,
  GroupByBuilder,
  JobDef,
  MiddlewareFn,
  MiddlewareInfo,
  MutationContext,
  MutationDef,
  MutationTable,
  PluginDef,
  QueryBuilder,
  QueryContext,
  QueryDef,
  ReactiveBudget,
  TableSchema,
  VexUser,
  WebhookDef,
  WebhookRequest,
  WebhookResponse,
} from "./core/types.js";
