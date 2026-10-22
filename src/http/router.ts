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
 *   - Nested routers inherit their path scope and their parents'
 *     guards; parent middleware runs before the child's dispatch.
 *
 * Access
 *   - A router typed with an access type (`createRouter<A>()`) takes
 *     `{ access }` on every route, as its second argument: the
 *     compiler refuses a route without one. Untyped, routes take
 *     handlers alone.
 *   - `router.guard(fn)` runs once a route has matched and before its
 *     handlers, with the route and its `access` (absent on a route
 *     registered without one). Throwing refuses the request; the
 *     guard is the app's, so what an absent `access` means is too.
 *     Guards apply to mounted routers as well.
 *   - `routes()` lists every route with its `access`.
 */

import { compose } from "./compose.js";
import { HttpError, isHttpError } from "./error.js";
import { isUnmatched, unmatched } from "./response.js";
import type {
  ErrorHandler,
  Handler,
  MatchedRoute,
  Middleware,
  RequestCtx,
  RouteMethod,
} from "./types.js";

/** What a route declares beside its handlers. */
export interface RouteOptions<A> {
  /** What the route needs, as the router's guards read it. */
  readonly access: A;
}

/**
 * A route's arguments: its handlers alone on an untyped router, its
 * options and then its handlers on one typed with an access type.
 */
export type RouteArgs<A> = [A] extends [never]
  ? Handler[]
  : [RouteOptions<A>, Handler, ...Handler[]];

/** Runs between a route's match and its handlers; throwing refuses the request. */
export type RouteGuard<A = unknown> = (
  ctx: RequestCtx,
  route: MatchedRoute<A>,
) => void | Promise<void>;

type Matcher =
  | {
      kind: "route";
      /** The route as its guards and handlers see it, built once. */
      route: MatchedRoute;
      pattern: URLPattern;
      handlers: Handler[];
    }
  | {
      kind: "mount";
      prefix: string;
      inner: (
        req: Request,
        parent?: Partial<RequestCtx>,
        guards?: readonly RouteGuard[],
      ) => Promise<Response>;
      /** The Router mounted, which marks its no-match answer; absent for a function. */
      router?: Router<unknown>;
    };

/**
 * What a router serves, as `routes()` lists it: each route by method
 * and full path, and each mounted function by its prefix, which it
 * answers under without saying what.
 */
export type RouteEntry<A = unknown> =
  | {
      readonly kind: "route";
      readonly method: RouteMethod;
      readonly path: string;
      /** Absent on a route registered without any. */
      readonly access?: A;
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

export class Router<A = never> {
  private readonly prefix: string;
  private readonly middlewares: Middleware[] = [];
  private readonly matchers: Matcher[] = [];
  private readonly errorHandlers: RegisteredErrorHandler[] = [];
  private readonly guards: RouteGuard<A>[] = [];

  constructor(opts: RouterOptions = {}) {
    this.prefix = normalizePrefix(opts.prefix ?? "");
  }

  /** Add middleware that runs before route matching for this router. */
  use(mw: Middleware): this {
    this.middlewares.push(mw);
    return this;
  }

  /**
   * Run `guard` for every route this router, or a router mounted in
   * it, matches: after the match, before its handlers.
   */
  guard(guard: RouteGuard<A>): this {
    this.guards.push(guard);
    return this;
  }

  /** Register handlers for any method matching the path. */
  all(path: string, ...args: RouteArgs<A>): this {
    return this.route("ALL", path, args);
  }
  get(path: string, ...args: RouteArgs<A>): this {
    return this.route("GET", path, args);
  }
  post(path: string, ...args: RouteArgs<A>): this {
    return this.route("POST", path, args);
  }
  put(path: string, ...args: RouteArgs<A>): this {
    return this.route("PUT", path, args);
  }
  patch(path: string, ...args: RouteArgs<A>): this {
    return this.route("PATCH", path, args);
  }
  delete(path: string, ...args: RouteArgs<A>): this {
    return this.route("DELETE", path, args);
  }
  options(path: string, ...args: RouteArgs<A>): this {
    return this.route("OPTIONS", path, args);
  }
  head(path: string, ...args: RouteArgs<A>): this {
    return this.route("HEAD", path, args);
  }

  /**
   * Mount a sub-router (or any Request → Response function) at a
   * path prefix. The prefix is stripped from req.url before the
   * inner handler sees it; middleware on the outer router still runs
   * first.
   */
  mount(
    prefix: string,
    inner:
      | Router<A>
      | Router
      | ((req: Request) => Response | Promise<Response>),
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
      ...(inner instanceof Router ? { router: inner as Router<unknown> } : {}),
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
  routes(): RouteEntry<A>[] {
    return this.routesUnder("") as RouteEntry<A>[];
  }

  private routesUnder(base: string): RouteEntry[] {
    return this.matchers.flatMap((m): RouteEntry[] => {
      if (m.kind === "route") {
        return [
          { kind: "route", ...m.route, path: joinPath(base, m.route.path) },
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
   * thread the parent's ctx annotations and guards through.
   */
  async dispatch(
    req: Request,
    parent?: Partial<RequestCtx>,
    inherited: readonly RouteGuard[] = [],
  ): Promise<Response> {
    const ctx = buildCtx(req, {}, parent);
    const own = this.guards as RouteGuard[];
    const guards = inherited.length === 0 ? own : [...inherited, ...own];

    const terminal = async (c: RequestCtx): Promise<Response> => {
      const response = await this.match(c, req, guards);
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

  private route(method: RouteMethod, path: string, args: unknown[]): this {
    const [first, ...rest] = args;
    const declared =
      first !== null && typeof first === "object" && "access" in first;
    const handlers = (declared ? rest : args) as Handler[];
    if (handlers.length === 0) {
      throw new Error(`${method} ${path}: at least one handler required`);
    }
    const full = joinPath(this.prefix, path);
    // URLPattern lets us use `:param`, `*`, and regex groups. We pin
    // pathname matching; method and host are not part of the pattern.
    const pattern = new URLPattern({ pathname: full });
    this.matchers.push({
      kind: "route",
      route: {
        method,
        path: full,
        ...(declared
          ? { access: (first as RouteOptions<unknown>).access }
          : {}),
      },
      pattern,
      handlers,
    });
    return this;
  }

  private async match(
    ctx: RequestCtx,
    req: Request,
    guards: readonly RouteGuard[],
  ): Promise<Response | undefined> {
    const { pathname } = ctx.url;
    const method = req.method.toUpperCase() as RouteMethod;

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
        const response = await m.inner(rewritten, ctx, guards);
        const nothingMatched = m.router
          ? isUnmatched(response)
          : response.status === 404;
        if (nothingMatched) continue; // fall through
        return response;
      }

      const { route } = m;
      if (route.method !== "ALL" && route.method !== method) continue;
      const execResult = m.pattern.exec({ pathname });
      if (!execResult) continue;
      const params = extractParams(execResult);
      const routeCtx: RequestCtx = {
        ...ctx,
        params: { ...ctx.params, ...params },
        route,
      };
      for (const guard of guards) await guard(routeCtx, route);
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
export function createRouter<A = never>(opts?: RouterOptions): Router<A> {
  return new Router<A>(opts);
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
