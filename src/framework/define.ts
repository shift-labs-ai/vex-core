import type {
  ActionContext,
  ColumnDef,
  MiddlewareFn,
  MutationContext,
  QueryContext,
  TableSchema,
  WebhookRequest,
  WebhookResponse,
} from "../core/types.js";
import type { ArgsOf, ArgsShape } from "../core/values.js";

const KIND = Symbol.for("vex.kind");

export interface VexTable extends TableSchema {
  [KIND]: "table";
}

/** A file's query: its args' schemas, and a handler typed from them. */
export interface VexQuery<S extends ArgsShape = any> {
  [KIND]: "query";
  args: S;
  handler: (ctx: QueryContext, args: ArgsOf<S>) => Promise<any> | any;
}

export interface VexMutation<S extends ArgsShape = any> {
  [KIND]: "mutation";
  args: S;
  handler: (ctx: MutationContext, args: ArgsOf<S>) => Promise<any> | any;
}

export interface VexAction<S extends ArgsShape = any> {
  [KIND]: "action";
  args: S;
  handler: (ctx: ActionContext, args: ArgsOf<S>) => Promise<any> | any;
}

export interface VexWebhook {
  [KIND]: "webhook";
  path: string;
  method?: "POST" | "GET" | "PUT" | "DELETE";
  verify?: (req: WebhookRequest) => boolean;
  handler: (
    ctx: ActionContext,
    req: WebhookRequest,
  ) => Promise<WebhookResponse | any> | WebhookResponse | any;
}

export interface VexJob {
  [KIND]: "job";
  schedule: string;
  handler: (ctx: ActionContext) => Promise<void> | void;
  description?: string;
  enabled?: boolean;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
}

/**
 * A table: a TypeBox schema per column. Its SQL name is its export
 * name in `schema.ts` and `<plugin>_<export>` in any other file;
 * `options.renamedFrom` lists previous SQL names.
 */
export function table(
  columns: Record<string, ColumnDef>,
  options: Omit<TableSchema, "columns"> = {},
): VexTable {
  return { [KIND]: "table", ...options, columns };
}

/** A definition without its kind tag: the plain def the engine registers. */
export function untag<T extends { [KIND]: string }>(
  def: T,
): Omit<T, typeof KIND> {
  const { [KIND]: _kind, ...plain } = def;
  return plain;
}

export function query<S extends ArgsShape>(
  args: S,
  handler: VexQuery<S>["handler"],
): VexQuery<S> {
  return { [KIND]: "query", args, handler };
}

export function mutation<S extends ArgsShape>(
  args: S,
  handler: VexMutation<S>["handler"],
): VexMutation<S> {
  return { [KIND]: "mutation", args, handler };
}

export function action<S extends ArgsShape>(
  args: S,
  handler: VexAction<S>["handler"],
): VexAction<S> {
  return { [KIND]: "action", args, handler };
}

export function webhook(
  path: string,
  handler: VexWebhook["handler"],
): VexWebhook;
export function webhook(
  path: string,
  options: { method?: VexWebhook["method"]; verify?: VexWebhook["verify"] },
  handler: VexWebhook["handler"],
): VexWebhook;
export function webhook(path: string, second: any, third?: any): VexWebhook {
  if (typeof second === "function") {
    return { [KIND]: "webhook", path, handler: second };
  }
  return { [KIND]: "webhook", path, ...second, handler: third };
}

export function job(schedule: string, handler: VexJob["handler"]): VexJob;
export function job(
  schedule: string,
  options: {
    description?: string;
    enabled?: boolean;
    timeoutMs?: number;
    retries?: number;
    retryDelayMs?: number;
  },
  handler: VexJob["handler"],
): VexJob;
export function job(schedule: string, second: any, third?: any): VexJob {
  if (typeof second === "function") {
    return { [KIND]: "job", schedule, handler: second };
  }
  return { [KIND]: "job", schedule, ...second, handler: third };
}

export function middleware(
  fn: MiddlewareFn,
): MiddlewareFn & { [KIND]: "middleware" } {
  return Object.assign(fn, { [KIND]: "middleware" as const });
}

export function isTable(v: any): v is VexTable {
  return v?.[KIND] === "table";
}
export function isQuery(v: any): v is VexQuery {
  return v?.[KIND] === "query";
}
export function isMutation(v: any): v is VexMutation {
  return v?.[KIND] === "mutation";
}
export function isAction(v: any): v is VexAction {
  return v?.[KIND] === "action";
}
export function isWebhook(v: any): v is VexWebhook {
  return v?.[KIND] === "webhook";
}
export function isJob(v: any): v is VexJob {
  return v?.[KIND] === "job";
}
export function isMiddleware(
  v: any,
): v is MiddlewareFn & { [KIND]: "middleware" } {
  return v?.[KIND] === "middleware";
}

/** The schema language args and returns are declared in. */
export { default as Type } from "typebox";
