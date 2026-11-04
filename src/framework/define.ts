import type {
  ActionContext,
  ColumnDef,
  ColumnType,
  MiddlewareFn,
  MutationContext,
  QueryContext,
  TableSchema,
  WebhookRequest,
  WebhookResponse,
} from "../core/types.js";
import type { ArgsShape } from "../core/values.js";

const KIND = Symbol.for("vex.kind");

export interface VexTable extends TableSchema {
  [KIND]: "table";
}

export interface VexQuery {
  [KIND]: "query";
  args: ArgsShape;
  handler: (ctx: QueryContext, args: Record<string, any>) => Promise<any> | any;
}

export interface VexMutation {
  [KIND]: "mutation";
  args: ArgsShape;
  handler: (
    ctx: MutationContext,
    args: Record<string, any>,
  ) => Promise<any> | any;
}

export interface VexAction {
  [KIND]: "action";
  args: ArgsShape;
  handler: (
    ctx: ActionContext,
    args: Record<string, any>,
  ) => Promise<any> | any;
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

type ColumnInput = string | (Omit<ColumnDef, "type"> & { type: string });

/**
 * A table. Its SQL name is its export name in `schema.ts` and
 * `<plugin>_<export>` in any other file; `options.renamedFrom` lists
 * previous SQL names.
 */
export function table(
  columns: Record<string, ColumnInput>,
  options: Omit<TableSchema, "columns"> = {},
): VexTable {
  const normalized: TableSchema["columns"] = {};
  for (const [name, def] of Object.entries(columns)) {
    normalized[name] =
      typeof def === "string"
        ? { type: def as ColumnType }
        : { ...def, type: def.type as ColumnType };
  }

  return { [KIND]: "table", ...options, columns: normalized };
}

/** A definition without its kind tag: the plain def the engine registers. */
export function untag<T extends { [KIND]: string }>(
  def: T,
): Omit<T, typeof KIND> {
  const { [KIND]: _kind, ...plain } = def;
  return plain;
}

export function query(args: ArgsShape, handler: VexQuery["handler"]): VexQuery {
  return { [KIND]: "query", args, handler };
}

export function mutation(
  args: ArgsShape,
  handler: VexMutation["handler"],
): VexMutation {
  return { [KIND]: "mutation", args, handler };
}

export function action(
  args: ArgsShape,
  handler: VexAction["handler"],
): VexAction {
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
