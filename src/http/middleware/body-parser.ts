/**
 * Body parser middleware.
 *
 * Populates `ctx.state.body` (parsed) and `ctx.state.rawBody` (string)
 * based on Content-Type. Subsequent handlers read the already-parsed
 * body from state instead of re-awaiting req.json(), which matters
 * because Request bodies can only be consumed once.
 *
 * Respects a size limit in bytes (default 1 MiB), read through the
 * bounded body reader (../body.ts): a declared `Content-Length` past
 * it is refused 413 before a byte is read, an undeclared (chunked)
 * body is counted as it streams and refused the moment it passes, and
 * a refused body is drained so the client reads the 413 rather than a
 * reset. A body declared past the limit is refused even when its type
 * is not one this middleware parses.
 *
 * Not run: multipart/form-data. Streaming uploads belong to a future
 * middleware that can expose each part without buffering.
 */

import {
  declaredLength,
  type ReadLimits,
  readText,
  refuseBody,
} from "../body.js";
import { HttpError } from "../error.js";
import type { Middleware } from "../types.js";

export interface BodyParserOptions {
  /** Max bytes for any parsed body. Default 1 MiB. */
  limit?: number;
  /** Max bytes read and discarded to refuse an oversized body before
   *  the connection is closed instead. Default 4x `limit`. */
  drainLimit?: number;
  /** How long reading a body may take before it is refused 408; none
   *  when absent. */
  timeoutMs?: number;
  /** Parse application/json. Default true. */
  json?: boolean;
  /** Parse application/x-www-form-urlencoded. Default true. */
  urlencoded?: boolean;
  /** Parse text/* as a string. Default true. */
  text?: boolean;
}

const DEFAULT_LIMIT = 1024 * 1024;
const TOO_LARGE = "Payload too large";

export function bodyParser(options: BodyParserOptions = {}): Middleware {
  const limits: ReadLimits = {
    maxBytes: options.limit ?? DEFAULT_LIMIT,
    drainBytes: options.drainLimit,
    timeoutMs: options.timeoutMs,
    tooLarge: TOO_LARGE,
  };
  const parseJson = options.json ?? true;
  const parseUrl = options.urlencoded ?? true;
  const parseText = options.text ?? true;

  return async (ctx, next) => {
    if (
      ctx.req.method === "GET" ||
      ctx.req.method === "HEAD" ||
      ctx.req.method === "OPTIONS"
    ) {
      return next();
    }

    const contentType =
      ctx.req.headers.get("content-type")?.toLowerCase() ?? "";

    if (parseJson && contentType.startsWith("application/json")) {
      const raw = await readText(ctx.req, limits);
      ctx.state.rawBody = raw;
      try {
        ctx.state.body = raw.length > 0 ? JSON.parse(raw) : null;
      } catch {
        throw HttpError.badRequest("Invalid JSON body");
      }
      return next();
    }

    if (
      parseUrl &&
      contentType.startsWith("application/x-www-form-urlencoded")
    ) {
      const raw = await readText(ctx.req, limits);
      ctx.state.rawBody = raw;
      const parsed: Record<string, string> = {};
      for (const [k, v] of new URLSearchParams(raw)) parsed[k] = v;
      ctx.state.body = parsed;
      return next();
    }

    if (parseText && contentType.startsWith("text/")) {
      const raw = await readText(ctx.req, limits);
      ctx.state.rawBody = raw;
      ctx.state.body = raw;
      return next();
    }

    // A type left unparsed is still held to the limit when it declares
    // its length past it: refused, drained, before the handler runs.
    const declared = declaredLength(ctx.req);
    if (typeof declared === "number" && declared > limits.maxBytes) {
      await refuseBody(ctx.req, limits, 413, TOO_LARGE);
    }

    // Unknown or multipart — leave the Request untouched; handlers
    // that care can still call ctx.req.formData() / .arrayBuffer().
    return next();
  };
}
