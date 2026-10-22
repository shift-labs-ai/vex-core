/**
 * Router — the central HTTP composition primitive.
 *
 * Inspired by Vert.x Web's `Router`, Express, and Koa. Takes Fetch-API
 * Request/Response and gives back the same. Matches on method + path
 * via `URLPattern` (so `:param` capture, wildcards, and regex-like
 * segments are all available for free). Handlers that return `undefined`
 * fall through to the next matching route — this is what makes
 * `router.get(path, mw1, mw2, finalHandler)` chains work.
 *
 * Error handling
 *   - Thrown HttpError renders as its response directly.
 *   - Other thrown errors fall to the router's onError handlers in
 *     registration order; if none match, a 500 is returned.
 *   - When a handler returns a Response with a status matching an
 *     onError predicate, the predicate does NOT fire — we don't want
 *     a `return notFound()` to re-enter the error pipeline.
 *
 * Composition
 *   - `router.mount(prefix, inner)` strips `prefix` from the pathname
 *     before dispatching to `inner`. Empty prefix (`""`, `"/"`) mounts
 *     at root — every request flows through the inner handler.
 *   - `router.use(mw)` adds middleware that runs before every matcher.
 *   - Dispatch is **registration-ordered**: routes and mounts are
 *     tried in the order they were added. A child router that matches
 *     nothing lets later routes try; this is how you can mix "engine
 *     at root" with a `/health` route above it. A 404 one of its
 *     routes answers (a refusal, a missing row) is final. A mounted
 *     function, which cannot say whether it matched, lets later
 *     routes try on any 404.
 *   - Nested routers inherit nothing except their path scope; parent
 *     middleware runs before the child's dispatch.
 */

import { compose } from "./compose.js";
import { HttpError, isHttpError } from "./error.js";
import { isUnmatched, unmatched } from "./response.js";
import type { ErrorHandler, Handler, Middleware, RequestCtx } from "./types.js";

/** An HTTP method a route answers; `ALL` answers every one. */
export type RouteMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "OPTIONS"
  | "HEAD"
  | "ALL";

type Method = RouteMethod;

type Matcher =
  | {
      kind: "route";
      method: Method;
      /** The full path it was registered at, prefix included. */
      path: string;
      pattern: URLPattern;
      handlers: Handler[];
    }
  | {
      kind: "mount";
      prefix: string;
      inner: (req: Request, parent?: Partial<RequestCtx>) => Promise<Response>;
      /** The Router mounted, which marks its no-match answer; absent for a function. */
      router?: Router;
    };

/**
 * What a router serves, as `routes()` lists it: each route by method
 * and full path, and each mounted function by its prefix, which it
 * answers under without saying what.
 */
export type RouteEntry =
  | {
      readonly kind: "route";
      readonly method: RouteMethod;
      readonly path: string;
    }
  | { readonly kind: "mount"; readonly path: string };

/**
 * What a router throws when nothing it holds matched: a 404 whose
 * rendering is marked unmatched, however a boundary renders it. An
 * error handler that answers the miss with something other than a
 * 404 (an app shell) has answered.
 */
class NoRoute extends HttpError {
  constructor() {
    super(404, "Not Found");
  }
  override toResponse(): Response {
    return unmatched(super.toResponse());
  }
}

interface RegisteredErrorHandler {
  predicate: (err: unknown, ctx: RequestCtx) => boolean;
  handler: ErrorHandler;
}

export interface RouterOptions {
  /** Prefix applied to every route added after construction. Defaults to "". */
  prefix?: string;
}

/**
 * Build a RequestCtx for the incoming Request. The URL is always
 * derived from `req` so mount-rewritten requests produce a fresh URL
 * reflecting the stripped prefix; middleware annotations (`state`,
 * `user`, `session`, `span`, `params`) carry across from the parent
 * when present.
 */
function buildCtx(
  req: Request,
  params: Record<string, string>,
  parent?: Partial<RequestCtx>,
): RequestCtx {
  return {
    req,
    url: new URL(req.url),
    params: { ...(parent?.params ?? {}), ...params },
    state: parent?.state ?? Object.create(null),
    signal: parent?.signal ?? req.signal,
    user: parent?.user,
    span: parent?.span,
    session: parent?.session,
  };
}

export class Router {
  private readonly prefix: string;
  private readonly middlewares: Middleware[] = [];
  private readonly matchers: Matcher[] = [];
  private readonly errorHandlers: RegisteredErrorHandler[] = [];

  constructor(opts: RouterOptions = {}) {
    this.prefix = normalizePrefix(opts.prefix ?? "");
  }

  /** Add middleware that runs before route matching for this router. */
  use(mw: Middleware): this {
    this.middlewares.push(mw);
    return this;
  }

  /** Register handlers for any method matching the path. */
  all(path: string, ...handlers: Handler[]): this {
    return this.route("ALL", path, handlers);
  }
  get(path: string, ...handlers: Handler[]): this {
    return this.route("GET", path, handlers);
  }
  post(path: string, ...handlers: Handler[]): this {
    return this.route("POST", path, handlers);
  }
  put(path: string, ...handlers: Handler[]): this {
    return this.route("PUT", path, handlers);
  }
  patch(path: string, ...handlers: Handler[]): this {
    return this.route("PATCH", path, handlers);
  }
  delete(path: string, ...handlers: Handler[]): this {
    return this.route("DELETE", path, handlers);
  }
  options(path: string, ...handlers: Handler[]): this {
    return this.route("OPTIONS", path, handlers);
  }
  head(path: string, ...handlers: Handler[]): this {
    return this.route("HEAD", path, handlers);
  }

  /**
   * Mount a sub-router (or any Request → Response function) at a
   * path prefix. The prefix is stripped from req.url before the
   * inner handler sees it; middleware on the outer router still runs
   * first.
   */
  mount(
    prefix: string,
    inner: Router | ((req: Request) => Response | Promise<Response>),
  ): this {
    const p = normalizePrefix(prefix);
    const innerFn =
      inner instanceof Router
        ? inner.dispatch.bind(inner)
        : async (req: Request) => inner(req);
    // Empty prefix (`""`, `"/"`) means "mount at root" — every request
    // flows through the inner handler. Still honors registration
    // order: if the inner matches nothing, later routes get a chance.
    this.matchers.push({
      kind: "mount",
      prefix: p,
      inner: innerFn,
      ...(inner instanceof Router ? { router: inner } : {}),
    });
    return this;
  }

  /**
   * Register an error handler. Predicate defaults to "any error".
   * Walk order is registration order; the first matching predicate
   * handles the error.
   */
  onError(handler: ErrorHandler): this;
  onError(
    predicate: (err: unknown, ctx: RequestCtx) => boolean,
    handler: ErrorHandler,
  ): this;
  onError(
    a: ErrorHandler | ((err: unknown, ctx: RequestCtx) => boolean),
    b?: ErrorHandler,
  ): this {
    if (b) {
      this.errorHandlers.push({
        predicate: a as (err: unknown, ctx: RequestCtx) => boolean,
        handler: b,
      });
    } else {
      this.errorHandlers.push({
        predicate: () => true,
        handler: a as ErrorHandler,
      });
    }
    return this;
  }

  /**
   * Every route this router serves, in the order it tries them, a
   * mounted router's under its prefix; a mounted function by its
   * prefix alone.
   */
  routes(): RouteEntry[] {
    return this.routesUnder("");
  }

  private routesUnder(base: string): RouteEntry[] {
    return this.matchers.flatMap((m): RouteEntry[] => {
      if (m.kind === "route") {
        return [
          { kind: "route", method: m.method, path: joinPath(base, m.path) },
        ];
      }
      const prefix = joinPath(base, m.prefix || "/");
      return m.router
        ? m.router.routesUnder(prefix === "/" ? "" : prefix)
        : [{ kind: "mount", path: prefix }];
    });
  }

  /** Dispatch a Request through this router. The top-level entry point. */
  async handle(req: Request): Promise<Response> {
    return this.dispatch(req);
  }

  /**
   * Internal dispatch. Separate from `handle` so mounted routers can
   * thread the parent's ctx annotations through.
   */
  async dispatch(
    req: Request,
    parent?: Partial<RequestCtx>,
  ): Promise<Response> {
    const ctx = buildCtx(req, {}, parent);

    const terminal = async (c: RequestCtx): Promise<Response> => {
      const response = await this.match(c, req);
      if (response) return response;
      throw new NoRoute();
    };

    const run =
      this.middlewares.length === 0
        ? terminal
        : compose(this.middlewares, terminal);

    // Single try/catch wrapping both middleware and route dispatch so
    // a throw anywhere in the chain is converted to a Response.
    try {
      return await run(ctx);
    } catch (err) {
      const response = await this.handleError(ctx, err);
      return err instanceof NoRoute && response.status === 404
        ? unmatched(response)
        : response;
    }
  }

  // ─── internals ───────────────────────────────────────────────────

  private route(method: Method, path: string, handlers: Handler[]): this {
    if (handlers.length === 0) {
      throw new Error(`${method} ${path}: at least one handler required`);
    }
    const full = joinPath(this.prefix, path);
    // URLPattern lets us use `:param`, `*`, and regex groups. We pin
    // pathname matching; method and host are not part of the pattern.
    const pattern = new URLPattern({ pathname: full });
    this.matchers.push({
      kind: "route",
      method,
      path: full,
      pattern,
      handlers,
    });
    return this;
  }

  private async match(
    ctx: RequestCtx,
    req: Request,
  ): Promise<Response | undefined> {
    const { pathname } = ctx.url;
    const method = req.method.toUpperCase() as Method;

    // Walk matchers in registration order. A mount that matched
    // nothing (or a route chain that returned undefined) falls
    // through to the next matcher, so you can stack
    // `app.get("/health", …)` above an `app.mount("", inner)` and
    // both work.
    for (const m of this.matchers) {
      if (m.kind === "mount") {
        const matches =
          m.prefix === "" ||
          pathname === m.prefix ||
          pathname.startsWith(`${m.prefix}/`);
        if (!matches) continue;
        const rewritten =
          m.prefix === "" ? req : rewriteRequestPath(req, ctx.url, m.prefix);
        const response = await m.inner(rewritten, ctx);
        const nothingMatched = m.router
          ? isUnmatched(response)
          : response.status === 404;
        if (nothingMatched) continue; // fall through
        return response;
      }

      if (m.method !== "ALL" && m.method !== method) continue;
      const execResult = m.pattern.exec({ pathname });
      if (!execResult) continue;
      const params = extractParams(execResult);
      const routeCtx: RequestCtx = {
        ...ctx,
        params: { ...ctx.params, ...params },
      };
      for (const handler of m.handlers) {
        const result = await handler(routeCtx);
        if (result instanceof Response) return result;
        // undefined → fall through to next handler in this route
      }
      // Every handler returned undefined. Fall through to the next
      // matching matcher instead of 404ing immediately.
    }

    return undefined;
  }

  private async handleError(ctx: RequestCtx, err: unknown): Promise<Response> {
    for (const { predicate, handler } of this.errorHandlers) {
      if (!predicate(err, ctx)) continue;
      try {
        return await handler(ctx, err);
      } catch (nested) {
        // Error handlers that themselves throw are a bug in user code.
        // Log loudly and fall through to the default response rather
        // than swallowing silently.
        console.error("[router] error handler threw:", nested);
        break;
      }
    }
    if (isHttpError(err)) return err.toResponse();
    return HttpError.internal(
      err instanceof Error ? err.message : String(err),
      err,
    ).toResponse();
  }
}

/** Shortcut: `createRouter(opts?)`. */
export function createRouter(opts?: RouterOptions): Router {
  return new Router(opts);
}

// ─── helpers ───────────────────────────────────────────────────────

function normalizePrefix(prefix: string): string {
  if (!prefix) return "";
  let p = prefix.startsWith("/") ? prefix : `/${prefix}`;
  while (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p === "/" ? "" : p;
}

function joinPath(prefix: string, path: string): string {
  if (!prefix) return path.startsWith("/") ? path : `/${path}`;
  if (!path || path === "/") return prefix;
  const tail = path.startsWith("/") ? path : `/${path}`;
  return prefix + tail;
}

function extractParams(match: URLPatternResult): Record<string, string> {
  const out: Record<string, string> = {};
  const groups = match.pathname.groups as Record<string, string | undefined>;
  for (const [k, v] of Object.entries(groups)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * Strip the mount prefix from the request URL before handing it to an
 * inner handler. Produces a new Request so headers/body/signal are
 * preserved, but the URL reflects what the inner handler expects to
 * see. The original Request is not mutated.
 */
function rewriteRequestPath(req: Request, url: URL, prefix: string): Request {
  const newUrl = new URL(url);
  newUrl.pathname = url.pathname.slice(prefix.length) || "/";
  // Bun's Request constructor accepts a URL + init; we carry the
  // method, headers, body, and signal forward. Body can only be
  // read once — Request-from-Request is a clone, so this is safe.
  return new Request(newUrl, req);
}
