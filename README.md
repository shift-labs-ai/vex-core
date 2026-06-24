# vex-core

Local-first reactive backend engine. Plugin architecture, SQLite storage, real-time subscriptions via SSE.

```
npm install vex-core
```

**Runtime requirements**

- Bun 1.3+ *or* Node 24+ — `vex-core/http` uses the Web platform's `URLPattern` global for route matching. Older runtimes need a polyfill (`urlpattern-polyfill` works).

Peer: `react` ^19 (only if you use `vex-core/client`).

## Quick start

```ts
import { Vex, sqliteAdapter } from "vex-core";

const vex = await Vex.create({
  storage: sqliteAdapter(".vex/data.db"),
  plugins: [
    (api) => {
      api.setName("counter");
      api.registerTable("counters", {
        columns: { key: { type: "string" }, value: { type: "number" } },
      });
      api.registerMutation("set", {
        args: { key: "string", value: "number" },
        async handler(ctx, args) {
          return ctx.db.table("counters").insert(args);
        },
      });
      api.registerQuery("list", {
        args: {},
        async handler(ctx) {
          return ctx.db.table("counters").all();
        },
      });
    },
  ],
});

await vex.mutate("counter.set", { key: "hits", value: 1 });
await vex.query("counter.list");

const unsub = await vex.subscribe("counter.list", {}, (rows) => {
  console.log("changed:", rows);
});
```

## Reactive safety

Explicit `query()` calls may return large results. `subscribe()` calls may not: reactive queries are re-run after writes, hashed, and delivered to callbacks, so Vex enforces row and byte budgets before accepting or continuing a subscription.

```ts
const vex = await Vex.create({
  storage,
  plugins,
  reactive: { maxRows: 500, maxBytes: 512 * 1024 },
});

api.registerQuery("list", {
  args: {},
  reactive: { maxRows: 100, maxBytes: 64 * 1024 },
  handler: (ctx) => ctx.db.table("items").limit(100).all(),
});

api.registerQuery("export", {
  args: {},
  reactive: false,
  handler: (ctx) => ctx.db.table("items").all(), // query() only, not subscribe()
});
```

Reactive metadata is recorded on spans: `resultRows`, `resultBytes`, `reactive`, `budget`, and `budgetExceeded`. Query-builder reads record dependency descriptors for table, filters, selected columns, ordering, and limits. Raw SQL is tracked conservatively by parsed `FROM`/`JOIN` tables; external API work and unbounded exports should stay outside reactive queries or be marked `reactive: false`.

## Query builder

Reads, filters, aggregations — pushed down to SQL.

```ts
ctx.db.table("orders").where("region", "=", "US").all();
ctx.db.table("orders").where("amount", ">", 100).select("id", "amount").first();

ctx.db.table("orders").count();
ctx.db.table("orders").sum("amount");
ctx.db.table("orders").avg("amount");

ctx.db.table("orders")
  .groupBy(["region", "product"], {
    revenue: ["sum", "amount"],
    count: "count",
  })
  .having("count", ">=", 10)
  .order("revenue", "desc")
  .limit(20);
```

## File-based conventions

Flat files, no config. Use `scanDirectory` to turn a folder into plugins.

```ts
// schema.ts
import { table } from "vex-core/framework";
export const todos = table({ text: "string", done: "boolean" });

// todos.ts
import { query, mutation } from "vex-core/framework";
export const list = query({}, async (ctx) => ctx.db.table("todos").all());
export const add = mutation({ text: "string" }, async (ctx, args) =>
  ctx.db.table("todos").insert({ text: args.text, done: false }),
);
```

```ts
import { scanDirectory } from "vex-core/framework";
import { Vex, sqliteAdapter } from "vex-core";

const { plugins } = await scanDirectory("./app");
const vex = await Vex.create({
  storage: sqliteAdapter(".vex/data.db"),
  plugins,
});
```

Also supported in files: `webhook(path, handler)`, `job(schedule, handler)`, `middleware(fn)`.

## HTTP

`vex-core/http` is a small, composable HTTP toolkit built around the Fetch API. A `Router` matches methods and paths (via `URLPattern`), middleware wraps the chain in classic onion order, handlers return `Response` (or `undefined` to fall through). Inspired by Vert.x Web and Koa; no dependencies beyond Bun/Node built-ins.

```ts
import {
  createRouter,
  vexHandler,
  cors,
  bearerAuth,
  accessLog,
  requestId,
  errorBoundary,
  staticFiles,
  sessions,
  HttpError,
} from "vex-core/http";

const app = createRouter()
  .use(errorBoundary())
  .use(requestId())
  .use(accessLog())
  .use(cors({ origin: "*" }))
  .use(bearerAuth({ token: process.env.VEX_TOKEN! }))
  .mount("/vex", vexHandler(vex))
  .use(staticFiles({ dir: "./dist/ui" }));

Bun.serve({ port: 3000, fetch: (req) => app.handle(req) });
```

### Router

```ts
createRouter({ prefix?: "/api" })
  .use(mw)                                   // global middleware
  .get("/users/:id", handler)                // also post/put/patch/delete/options/head/all
  .get("/users/:id", mw1, mw2, finalHandler) // handler chain — `undefined` = fall through
  .mount("/vex", subRouter)                  // strip prefix, dispatch to inner router
  .onError(handler)                          // catchall
  .onError((err) => err instanceof HttpError && err.status === 404, render404);
```

Path syntax is whatever [URLPattern](https://developer.mozilla.org/en-US/docs/Web/API/URLPattern) supports: `:param`, `*`, regex groups. Captures land in `ctx.params`.

### Context

Every middleware and handler receives a `RequestCtx`:

```ts
interface RequestCtx {
  req: Request;
  url: URL;
  params: Record<string, string>;
  state: Record<string, unknown>;   // scratchpad: request id, parsed body, logger bindings
  signal: AbortSignal;
  user?: VexUser | null;             // set by auth middleware
  session?: Session;                 // set by sessions middleware
  span?: Span;                       // set by tracer middleware
}
```

### HttpError

```ts
throw HttpError.badRequest("Missing id");
throw HttpError.unauthorized();
throw HttpError.notFound();
throw HttpError.tooManyRequests(30);           // Retry-After: 30
throw new HttpError(418, "I'm a teapot", { body: { code: "TEAPOT" } });
```

The router catches any thrown error, renders `HttpError` via `.toResponse()`, wraps everything else as a 500.

### Vex dispatcher

```ts
vexHandler(vex, opts?)   // a Router; mount anywhere
```

Exposes, relative to wherever it's mounted:

```
POST /query              { name, args? }
POST /mutate             { name, args? }
GET  /subscribe          ?name=...&args=... (SSE)
ALL  /webhook/*          user-defined webhooks
```

### Middleware catalog

| Middleware    | What it does |
|---------------|--------------|
| `errorBoundary({ devStackTraces, logger })` | Catches thrown errors, renders `HttpError`, wraps everything else as 500. |
| `requestId({ header, generator })`          | Read or mint `X-Request-Id`; stash on `ctx.state.requestId`; echo on response. |
| `accessLog({ logger, skipPaths })`          | One line per request: `GET /path -> 200 (12ms)`. |
| `cors({ origin, credentials, allowedHeaders, maxAge })` | Fetch-standard CORS. Downgrades `*` to request origin when `credentials: true`. |
| `bearerAuth({ token, publicPaths, loginPage })` | Single-token HTTP gate: `Authorization: Bearer` OR session cookie. Built-in `/login` + `/logout`; per-IP rate limit on failures. |
| `bodyParser({ limit, json, urlencoded, text })` | Parse request body into `ctx.state.body`. |
| `rateLimit({ requests, window, key })`      | 429 + `Retry-After` + `X-RateLimit-*`. |
| `staticFiles({ dir, index, spaFallback, immutablePrefix })` | Serve built assets. Fallback-on-404 semantics: explicit routes win, static serves what's left. SPA-friendly. |
| `sessions({ storage, cookieName, maxAge, rolling })` | Server-side session store on any `StorageAdapter` (SQLite/custom). `ctx.session.get/set/delete/destroy`. |

### Sessions

Backed by any vex-core `StorageAdapter`. One row per session, cookie holds the id, data is a JSON blob with sliding expiry.

```ts
import { sessions } from "vex-core/http";
import { sqliteAdapter } from "vex-core";

const store = sqliteAdapter("./sessions.db");

app.use(sessions({ storage: store, maxAge: 86400 * 7 }))
   .post("/login", async (ctx) => {
     const { email } = (await ctx.req.json()) as { email: string };
     ctx.session?.set("email", email);
     return new Response("ok");
   })
   .get("/me", (ctx) => Response.json({ email: ctx.session?.get("email") ?? null }))
   .post("/logout", async (ctx) => {
     await ctx.session?.destroy();
     return new Response("ok");
   });
```

## React client

```tsx
import { VexProvider, useQuery, useMutation } from "vex-core/client";

function App() {
  return (
    <VexProvider basePath="/vex">
      <Todos />
    </VexProvider>
  );
}

function Todos() {
  const { data: todos, isLoading } = useQuery("todos.list");
  const { mutate: addTodo } = useMutation("todos.add");
  // ...
}
```

SSE-backed — data updates automatically on mutations that touch the underlying tables.

## Observability

Every engine operation is a span. Pass a `tracer` to `Vex.create` to capture queries, mutations, handler timings, tables touched, invalidated subscriptions, and errors. See `src/core/tracer.ts` for the `Tracer` and `Span` interfaces.

Spans are written to the internal `_spans` table. Core does **not** prune it — retention policy is app-specific. For a long-running server, register a cron that deletes old rows:

```ts
api.registerJob("spanRetention", {
  schedule: "every 1h",
  async handler(ctx) {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days
    await ctx.db.table("_spans").where("startTime", "<", cutoff).delete();
  },
});
```

Without this, `_spans` grows unbounded.

## Exports

| Entry | Contents |
|-------|----------|
| `vex-core` | `Vex`, `sqliteAdapter`, `id`, core types, tracer, auth helpers |
| `vex-core/framework` | `table`, `query`, `mutation`, `webhook`, `job`, `middleware`, `scanDirectory` |
| `vex-core/http` | `Router`, `createRouter`, `HttpError`, `compose`, `vexHandler`, plus middleware (`cors`, `bearerAuth`, `bodyParser`, `accessLog`, `requestId`, `rateLimit`, `staticFiles`, `errorBoundary`, `sessions`) |
| `vex-core/client` | `VexProvider`, `useQuery`, `useMutation` |
| `vex-core/adapters/sqlite` | `sqliteAdapter` |

## License

MIT
