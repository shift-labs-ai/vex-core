/**
 * requestId — reads an inbound X-Request-Id (or configured header),
 * falls back to generating one, stashes it on `ctx.state.requestId`,
 * and adds it to the response. Downstream access logs, error pages,
 * and tracing all pick it up from ctx.state.
 */

import { id as generateId } from "../../core/id.js";
import { withHeaders } from "../response.js";
import type { Middleware } from "../types.js";

export interface RequestIdOptions {
  /** Header to read inbound / write outbound. Default `X-Request-Id`. */
  header?: string;
  /** Generator for missing ids. Default vex-core's id(12). */
  generator?: () => string;
}

export function requestId(options: RequestIdOptions = {}): Middleware {
  const header = options.header ?? "x-request-id";
  const gen = options.generator ?? (() => generateId(12));

  return async (ctx, next) => {
    const incoming = ctx.req.headers.get(header);
    const id = incoming && incoming.length > 0 ? incoming : gen();
    ctx.state.requestId = id;

    return withHeaders(await next(), (headers) => {
      if (!headers.has(header)) headers.set(header, id);
    });
  };
}
