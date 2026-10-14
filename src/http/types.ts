/**
 * Core HTTP types for the vex-core router.
 *
 * The contract is intentionally small: a RequestCtx flows through the
 * middleware onion; middleware either returns a Response (short-circuits
 * the chain) or calls next() and returns its Response. Handlers may
 * return `undefined` to indicate "not mine, try the next matcher" —
 * that's the one deviation from pure onion semantics, and it's what
 * makes the `router.get(path, handler1, handler2, handler3)` chain
 * actually useful.
 */

import type { SpanHandle } from "../core/tracer.js";
import type { VexUser } from "../core/types.js";

/** Optional session interface — set by the sessions middleware when enabled. */
export interface Session {
  id: string;
  data: Record<string, unknown>;
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  destroy(): Promise<void>;
}

/**
 * The request context threaded through every middleware and handler.
 *
 * `state` is the free scratchpad for middleware to annotate things that
 * don't warrant a first-class property (request id, logger bindings,
 * parsed body, etc.). First-class properties exist for the things we
 * expect every non-trivial app to need: path params, user, span, session.
 */
export interface RequestCtx {
  readonly req: Request;
  readonly url: URL;
  readonly params: Record<string, string>;
  readonly state: Record<string, unknown>;
  readonly signal: AbortSignal;
  user?: VexUser | null;
  /**
   * The live span handle for the current request, set by whatever
   * tracing middleware the app composed. Middleware and handlers can
   * attach children via `ctx.span.child(type, name)`. Note this is
   * the *mutable handle*, not the emitted Span record — the record
   * only exists after `.end()` closes the span.
   */
  span?: SpanHandle;
  session?: Session;
}

/**
 * A handler returns a Response, or `undefined` to fall through to the
 * next matcher. This is what makes `router.get(p, mw1, mw2, handler)`
 * chains work — each step can pass or short-circuit.
 *
 * Return a new Response for every request, never a shared instance:
 * middleware such as `cors`, `requestId`, `rateLimit` and `sessions`
 * add their headers to the Response the handler returned.
 */
export type Handler = (
  ctx: RequestCtx,
) => Response | undefined | Promise<Response | undefined>;

/**
 * Middleware wraps the rest of the chain. Call next() to continue,
 * skip it to short-circuit. Must always return a Response — that's
 * the invariant that lets compose() return Response from any point
 * in the chain.
 */
export type Middleware = (
  ctx: RequestCtx,
  next: () => Promise<Response>,
) => Response | Promise<Response>;

/**
 * An error handler gets called when the chain throws an error (not
 * when a handler merely returns an error Response). Predicate-based
 * — the router walks its error handlers in registration order and
 * calls the first whose predicate matches.
 */
export type ErrorHandler = (
  ctx: RequestCtx,
  err: unknown,
) => Response | Promise<Response>;
