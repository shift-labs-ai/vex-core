/**
 * The package root's exports that load without Bun-only modules, so a
 * Cloudflare Worker can import them. Under the "workerd" export
 * condition the package root resolves here, without the Bun SQLite
 * adapter or the `.env` loader. What runs on Workers: README, "Cloudflare
 * Durable Objects".
 */

// Adapters
export type { DurableObjectSqlStorage } from "./adapters/durable-object.js";
export { durableObjectAdapter } from "./adapters/durable-object.js";

// Core
export type { AccessReader, TableAccessPolicy } from "./core/access.js";
export { UNRESTRICTED } from "./core/access.js";
export type { PluginFunction, VexPluginAPI } from "./core/api.js";
export { createPluginAPI, resolvePlugin } from "./core/api.js";
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
export type { Changes, StorageAdapter } from "./core/storage.js";
export { ANY_TABLE } from "./core/storage.js";
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
