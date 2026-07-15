/**
 * rateLimit — request-level rate limiting on the core `RateLimiter`
 * token bucket. Keyed by IP by default; pass a custom `key` to limit
 * by user, API key, route, or any combination. Pass a shared
 * `limiter` instance to share one budget across several routes (or
 * with non-HTTP consumers); otherwise the middleware owns a private
 * one built from `requests`/`window`.
 *
 * Every response carries the full `X-RateLimit-Limit` /
 * `-Remaining` / `-Reset` set so clients can self-throttle;
 * over-limit requests get a 429 with `Retry-After`. Rejections are
 * also recorded as an errored `rateLimit` child span on the request
 * trace when tracing middleware is composed upstream.
 *
 * Works in both router positions:
 *   - `router.use(rateLimit(…))` — classic onion middleware; success
 *     responses get the X-RateLimit headers.
 *   - `router.get(path, rateLimit(…), handler)` — a gate in a route
 *     handler chain: throws 429 on reject, falls through (returns
 *     `undefined`) on allow. In this position there is no response
 *     to decorate, so successful responses carry no rate headers.
 */

import type { RateLimitDecision } from "../../core/rate-limit.js";
import { RateLimiter } from "../../core/rate-limit.js";
import { HttpError } from "../error.js";
import type { Handler, Middleware, RequestCtx } from "../types.js";

export interface RateLimitOptions {
  /** Max requests per window. Required unless `limiter` is given. */
  requests?: number;
  /** Window size in seconds. Required unless `limiter` is given. */
  window?: number;
  /**
   * Shared limiter instance. Routes composing the same instance
   * share one budget; its `scope` labels errors and headers. When
   * given, `requests`/`window`/`resource` are ignored — the limiter
   * already carries them.
   */
  limiter?: RateLimiter;
  /**
   * Identity extractor. Default: first entry of X-Forwarded-For,
   * falling back to X-Real-IP, falling back to "unknown".
   */
  key?: (ctx: RequestCtx) => string;
  /**
   * Budget units this request consumes. A number, or a function of
   * the request for weighing expensive routes. Default 1.
   */
  cost?: number | ((ctx: RequestCtx) => number);
  /** Scope label shown in errors. Default "requests". */
  resource?: string;
}

/**
 * Usable as onion middleware (`use`) or as a route-chain gate
 * (handler position) — the router's two composition seams.
 */
export type RateLimitGate = Middleware & Handler;

export function rateLimit(options: RateLimitOptions = {}): RateLimitGate {
  const limiter = options.limiter ?? ownLimiter(options);
  const extractKey = options.key ?? defaultKey;

  const gate = async (
    ctx: RequestCtx,
    next?: () => Promise<Response>,
  ): Promise<Response | undefined> => {
    const identity = extractKey(ctx);
    const cost =
      typeof options.cost === "function"
        ? options.cost(ctx)
        : (options.cost ?? 1);
    const decision = limiter.tryConsume(identity, cost);

    if (!decision.allowed) {
      ctx.span?.child("rateLimit", decision.scope).end("error", {
        error: "rate limit exceeded",
        meta: {
          key: identity,
          scope: decision.scope,
          retryAfter: decision.retryAfter,
          cost: decision.cost,
        },
      });
      throw new HttpError(429, "Too Many Requests", {
        body: {
          error: "too_many_requests",
          retryAfter: decision.retryAfter,
          resource: decision.scope,
        },
        headers: {
          "retry-after": String(decision.retryAfter),
          ...rateHeaders(decision),
        },
      });
    }

    // Handler position: allowed → fall through to the next handler
    // in the route chain.
    if (!next) return undefined;

    const response = await next();
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(rateHeaders(decision))) {
      headers.set(name, value);
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
  return gate as RateLimitGate;
}

/** Private limiter from `requests`/`window`, with a background pruner. */
function ownLimiter(options: RateLimitOptions): RateLimiter {
  if (options.requests === undefined || options.window === undefined) {
    throw new Error(
      "rateLimit: pass either a shared `limiter` or both `requests` and `window`",
    );
  }
  const limiter = new RateLimiter({
    limit: { requests: options.requests, window: options.window },
    scope: options.resource ?? "requests",
  });
  // Periodic prune — cheap, runs every `window` seconds. Only for
  // limiters this middleware owns; shared limiters are the owner's
  // to prune (and `maxKeys` bounds them regardless).
  const pruneHandle = setInterval(
    () => limiter.prune(),
    Math.max(1_000, options.window * 1000),
  );
  // Don't keep the process alive just for the pruner.
  pruneHandle.unref?.();
  return limiter;
}

function rateHeaders(decision: RateLimitDecision): Record<string, string> {
  return {
    "x-ratelimit-limit": String(decision.limit.requests),
    "x-ratelimit-remaining": String(decision.remaining),
    "x-ratelimit-reset": String(decision.resetAfter),
  };
}

function defaultKey(ctx: RequestCtx): string {
  const xff = ctx.req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const real = ctx.req.headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}
