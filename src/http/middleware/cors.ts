/**
 * CORS middleware.
 *
 * Follows the Fetch standard's CORS semantics:
 *   - OPTIONS preflight → 204 with Access-Control-Allow-* headers.
 *   - Non-preflight requests → the matching headers appended to
 *     whatever the downstream handler returned.
 *
 * Origin can be `*`, a single string, an array of allowlisted origins,
 * or a function that inspects the request origin and returns the
 * value to echo back. With `credentials: true` the `*` origin is
 * downgraded to the request's Origin header (CORS forbids `*` with
 * credentials — this silently does the right thing instead of 500ing).
 */

import { withHeaders } from "../response.js";
import type { Middleware } from "../types.js";

export interface CorsOptions {
  origin?: string | string[] | ((origin: string | null) => string | null);
  credentials?: boolean;
  allowedMethods?: string[];
  allowedHeaders?: string[];
  exposedHeaders?: string[];
  maxAge?: number;
}

const DEFAULTS: Required<
  Omit<CorsOptions, "origin" | "exposedHeaders" | "maxAge">
> = {
  credentials: false,
  allowedMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

export function cors(options: CorsOptions = {}): Middleware {
  const opts = { ...DEFAULTS, ...options };
  const originOpt: CorsOptions["origin"] = options.origin ?? "*";

  const resolveOrigin = (requestOrigin: string | null): string | null => {
    if (typeof originOpt === "function") return originOpt(requestOrigin);
    if (typeof originOpt === "string") {
      if (originOpt === "*" && opts.credentials && requestOrigin) {
        // credentials=true forbids `*`; echo the request origin instead.
        return requestOrigin;
      }
      return originOpt;
    }
    if (Array.isArray(originOpt)) {
      return requestOrigin && originOpt.includes(requestOrigin)
        ? requestOrigin
        : null;
    }
    return null;
  };

  return async (ctx, next) => {
    const requestOrigin = ctx.req.headers.get("origin");
    const origin = resolveOrigin(requestOrigin);
    const corsHeaders = new Headers();
    if (origin) corsHeaders.set("access-control-allow-origin", origin);
    if (opts.credentials)
      corsHeaders.set("access-control-allow-credentials", "true");
    if (options.exposedHeaders && options.exposedHeaders.length > 0) {
      corsHeaders.set(
        "access-control-expose-headers",
        options.exposedHeaders.join(", "),
      );
    }

    if (ctx.req.method === "OPTIONS") {
      // Preflight. We answer without consulting the downstream chain.
      corsHeaders.set(
        "access-control-allow-methods",
        opts.allowedMethods.join(", "),
      );
      corsHeaders.set(
        "access-control-allow-headers",
        opts.allowedHeaders.join(", "),
      );
      if (options.maxAge !== undefined) {
        corsHeaders.set("access-control-max-age", String(options.maxAge));
      }
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    return withHeaders(await next(), (headers) => {
      corsHeaders.forEach((v, k) => {
        headers.set(k, v);
      });
    });
  };
}
