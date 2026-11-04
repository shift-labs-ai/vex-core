/**
 * The package root's exports that load without Bun-only modules, so a
 * Cloudflare Worker can import them. Under the "workerd" export
 * condition the package root resolves here, without the Bun SQLite
 * adapter or the `.env` loader. What runs on Workers: README, "Cloudflare
 * Durable Objects".
 */

export type { Static } from "typebox";
// The schema language: TypeBox, re-exported so an app holds the
// engine's own version.
export { default as Type } from "typebox";
// Adapters
export type { DurableObjectSqlStorage } from "./adapters/durable-object.js";
export { durableObjectAdapter } from "./adapters/durable-object.js";
// Core
export type {
  AccessReader,
  Narrowing,
  TableAccessPolicy,
} from "./core/access.js";
export { narrowingDrift, UNRESTRICTED } from "./core/access.js";
export type { PluginFunction, VexPluginAPI } from "./core/api.js";
export { createPluginAPI, resolvePlugin } from "./core/api.js";
export type { OperationDescription, VexOptions } from "./core/engine.js";
// The engine, and what a query answering from untracked state throws
// (`purityCheck`).
export { PurityError, Vex } from "./core/engine.js";
export type {
  EvaluationOptions,
  EvaluationSetup,
} from "./core/evaluation.js";
// What a handler calling the engine past its context throws.
export { ReentryError } from "./core/frames.js";
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
export type {
  Changes,
  ReadOnlyRead,
  StorageAdapter,
} from "./core/storage.js";
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
  ActionContext,
  ActionDef,
  AggDef,
  CallContext,
  ColumnDef,
  ColumnType,
  DescribedColumn,
  Filter,
  GroupByBuilder,
  Hold,
  JobDef,
  MiddlewareFn,
  MiddlewareInfo,
  Migration,
  MigrationContext,
  MutationContext,
  MutationDef,
  MutationTable,
  PluginDef,
  PublishedTable,
  QueryBuilder,
  QueryContext,
  QueryDef,
  ReactiveBudget,
  SubscribeContext,
  TableSchema,
  VexEnv,
  VexServices,
  VexUser,
  WebhookDef,
  WebhookRequest,
  WebhookResponse,
} from "./core/types.js";
export type { ArgsOf, ArgsShape, Schema } from "./core/values.js";
// What a call whose args its declaration refuses throws.
export { ArgsError } from "./core/values.js";
