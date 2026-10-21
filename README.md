# vex-core

Local-first reactive backend engine. Plugin architecture, SQLite storage, real-time subscriptions via SSE.

```
npm install vex-core
```

**Runtime requirement:** Bun 1.3+

`vex-core` intentionally targets Bun. Its SQLite adapter and WebSocket server use Bun runtime APIs. The engine, with queries, mutations, subscriptions and jobs, and the HTTP router also run inside a Cloudflare Durable Object; see [Cloudflare Durable Objects](#cloudflare-durable-objects).

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

## Cloudflare Durable Objects

`durableObjectAdapter` stores a Vex engine's tables in a SQLite-backed Durable Object's own database:

```ts
import { DurableObject } from "cloudflare:workers";
import { durableObjectAdapter, Vex } from "vex-core";

export class App extends DurableObject {
  vex = Vex.create({
    storage: durableObjectAdapter(this.ctx.storage),
    plugins: [counterPlugin],
  });

  async fetch() {
    const vex = await this.vex;
    await vex.mutate("counter.set", { key: "hits", value: 1 });
    return Response.json(await vex.query("counter.list"));
  }
}
```

The class needs a SQLite migration (`new_sqlite_classes`) in its Wrangler config. Under the `workerd` export condition, which Wrangler and Vite apply, `vex-core` resolves to an entry without the Bun-only `sqliteAdapter` and `config`.

The adapter shares its schema migrations, `renamedFrom` and writes with `sqliteAdapter`, and runs the same storage test suites in workerd. Each mutation runs in `ctx.storage.transaction()`, which rolls back the mutation's writes if it throws and holds the object's other requests until it settles. A transaction nested in another runs as a savepoint. `rawQuery` and `rawExec` go to the object's SQL API, which refuses `BEGIN`, `SAVEPOINT`, TEMP tables and most `PRAGMA`s.

Subscriptions work as on Bun. Outside Bun they hash results with SHA-1 from `node:crypto`. `vex-core/http` also runs in a Durable Object: its router, middleware, `sessions` (on `durableObjectAdapter`) and `vexHandler`, e.g. `fetch(request) { return router.handle(request); }`. Both need Node.js compatibility, which Wrangler turns on by default from compatibility date 2026-08-04; for earlier dates, add the `nodejs_compat` flag.

Jobs need the object's alarm: an idle Durable Object is evicted, and in-process timers with it. Each job's pending run is kept in `_jobs`, so an eviction loses none. With `jobScheduler: "external"` the engine starts no timers; the alarm runs the jobs that are due and schedules the next. Call `scheduleJobs` again after `addJob`, `removeJob` or `setJobEnabled`, which change when the next job is due:

```ts
export class App extends DurableObject {
  vex = Vex.create({
    storage: durableObjectAdapter(this.ctx.storage),
    plugins: [tickerPlugin],
    jobScheduler: "external",
  }).then(async (vex) => {
    await this.scheduleJobs(vex);
    return vex;
  });

  async alarm() {
    const vex = await this.vex;
    await vex.runDueJobs();
    await this.scheduleJobs(vex);
  }

  async scheduleJobs(vex: Vex) {
    const next = await vex.nextJobRun();
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }
}
```

Not supported on Workers:

- `vexWebSocket`: it is built on `Bun.serve` WebSockets. Durable Objects have their own WebSocket API.
- `serveDir`, `serveFile`, `scanDirectory` and `config`: they read the local filesystem, which a Worker does not have. Use Workers static assets and bindings instead.
- D1: it has no interactive transactions, so a mutation's writes could not roll back together.

## Renaming tables and columns

`registerTable` creates and migrates tables on startup: it adds new columns, rebuilds changed ones and reconciles indexes, but never drops anything. A renamed table or column therefore starts out empty unless its previous names are listed in `renamedFrom`:

```ts
api.registerTable("tasks", {
  renamedFrom: ["todos"],
  columns: {
    title: { type: "string", renamedFrom: ["text"] },
    done: { type: "boolean" },
  },
});

// File-based: table({ title: "string" }, { renamedFrom: ["chat_todos"] })
```

- A previous name that exists, where the current one does not, is renamed in place with its data and indexes.
- Where the current name exists, nothing changes. Keep every previous name listed: a database that is several versions behind migrates from whichever it has.
- A new database creates the table under its current names. In an existing table, a column whose current and previous names all match nothing fails startup.
- Where the current name and a previous one both exist, startup fails rather than guess.
- Table names, current and previous, are checked across the engine and all plugins before any table is migrated. Each table's renames share its migration savepoint, so a later failure for that table rolls them back.

An older build run against a migrated database recreates the previous names empty where it can, after which the newer build refuses to start. Roll back by restoring a backup, not by redeploying an older build.

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

Reactive metadata is recorded on spans: `resultRows`, `resultBytes`, `reactive`, `budget`, and `budgetExceeded`. Query-builder reads record dependency descriptors for table, filters, selected columns, ordering, and limits. External API work and unbounded exports should stay outside reactive queries or be marked `reactive: false`.

### Change tracking and raw SQL

SQLite reports what a statement reads and writes: its compiled program, as `EXPLAIN` lists it, opens a cursor on every table it touches, including the tables its triggers and foreign-key actions write. That depends only on the statement's text and the schema, never its parameters, so each text is compiled once, remembered until the schema changes, and every later run costs a cache lookup. Nothing is added to the database; no trigger runs per row.

- **Writes:** a write marks the tables it writes when it changed any row (counted for free: Bun's `run().changes`, a Durable Object cursor's `rowsWritten`). That covers the query builder and `ctx.db.sql` of any shape (`INSERT`, `UPDATE … FROM`, `REPLACE`, upserts, `WITH … DELETE`, several statements in one string), plus rows written by triggers and foreign-key cascades. Tables created by raw SQL are tracked by name like any other.
- **Transactions:** writes inside a transaction are reported when it commits, and a rolled-back one reports nothing.
- **Other connections:** on a file database, a commit by another connection or process (`PRAGMA data_version`) marks every table changed at the next invalidation.
- **Narrowing:** a subscription over a changed table re-runs unless an equality filter proves it could not have seen the change. Only values every touched row holds both before and after the write count as proof: an insert's row, an upsert's keys, the id of an update or delete. An update's new values do not, since the row may have just left the filtered set. A table changed by raw SQL, or by a write that ran a trigger or foreign-key action, proves nothing, and every subscription over it re-runs; narrowing on other tables is unaffected.
- **Raw reads:** a raw read depends on exactly the tables its program reads, through views, subqueries and covering indexes. A raw read that reads no table re-runs after any write.
- **Access policies:** raw SQL in a query context (`ctx.db.sql`) is refused when it reads a governed table, in any spelling or through any view. A literal or column that merely shares a governed table's name is not a read. Published SQL has its own rule (below).
- **Costs:** a statement's first run in a given schema compiles it once more for `EXPLAIN` (a few µs); after that, writes, reads and invalidation cost what they cost without tracking, within measurement noise. The query builder, bulk inserts and mutations run at parity with untracked writes; raw writes and raw reads run faster. On a Durable Object a single-statement write makes no more SQL calls, and bills no more rows, than without tracking; raw SQL of several statements reads `total_changes()` before and after.
- **Adapters:** a custom `StorageAdapter` reports changes through `takeChanges`; one that cannot tell which rows a write changed lists every changed table as unattributed, and `ANY_TABLE` when it cannot tell which tables. `tablesRead` is optional: without it, or when it cannot say (a virtual table, TEMP, an attached database), a raw read depends on every registered table it names, through named views. `readOnlyTables` is optional too: without it, `publishedSql` refuses everything.

### Published SQL

SQL that someone other than the app writes (an analyst, an agent) reads only what the app chose to publish. A table opts in; every other table is out of reach, so one nobody decided about is never readable this way:

```ts
api.registerTable("sessions", { columns: { /* … */ }, published: true });
api.registerTable("api_keys", { columns: { /* … */ } }); // not published

api.registerQuery("sql", {
  args: { sql: "string", params: "json" },
  reactive: false,
  handler: (ctx, args) => ctx.db.publishedSql(args.sql, ...(args.params ?? [])),
});
```

`ctx.db.publishedSql` runs a statement only when SQLite's compiled program for it shows:

- **one statement**, a `SELECT`, `VALUES` or `WITH`, that opens no cursor to write (a `WITH … DELETE` is refused);
- **published tables only**, however they are reached: by name, through a view, a CTE, a subquery, or an index that answers alone. `sqlite_schema` is never published;
- **no virtual tables** (`pragma_*` functions, `dbstat`) and **no other database** (TEMP, attached).

A published table with an access policy is read only for callers its policy leaves `UNRESTRICTED`, since raw SQL cannot apply the row filter; everyone else is refused. Storage that cannot show a statement's program (`StorageAdapter.readOnlyTables`) refuses every call. Results are reactive like any raw read: a subscription depends on exactly the tables the statement read. `ctx.db.publishedTables()` lists the dataset: each published table with every column a statement can read, `_id` included.

## Operation access

An app can make every query and mutation declare who may run it, so an operation without a declaration does not compile. Choose the declaration's shape as the engine's type parameter:

```ts
type Access = { permission: string } | "system";

const vex = await Vex.create<Access>({
  storage,
  plugins: [
    (api) => {
      api.setName("notes");
      api.registerQuery("list", {
        args: {},
        access: { permission: "notes.read" },
        handler: (ctx) => ctx.db.table("notes").all(),
      });
      // api.registerQuery("open", { args: {}, handler }) → compile error: access is required
    },
  ],
});
```

The engine decides nothing with it. It hands each call's declaration to middleware, where the app's own gate decides, and it describes each operation with its declaration (`describeQuery`, `describeMutation`, `introspect`), so the app can list what every operation needs:

```ts
vex.use((ctx, info, next) => {
  if (info.type === "webhook") return next();   // a webhook's verify decides
  if (info.access === undefined) throw new Error("Permission denied"); // a cast left it out
  return authorize(ctx.user, info.access, info.args).then(next);
});
```

Code that only calls the engine holds it as a bare `Vex`, which holds an engine of any declaration; code that reads the declarations names the type (`Vex<Access>`). The type parameter is never inferred, from the plugins or from where the engine goes.

Types vanish at runtime, so `info.access` is typed as possibly `undefined`: a gate must refuse what a cast let through. A plugin written against `VexPluginAPI` with no declaration is not accepted by an engine that requires one, and neither are file-based definitions (`vex-core/framework`), which declare none. Without a type parameter there is no declaration, and nothing changes.

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

`vex-core/http` is a small, composable HTTP toolkit built around the Fetch API. A `Router` matches methods and paths (via `URLPattern`), middleware wraps the chain in classic onion order, handlers return `Response` (or `undefined` to fall through). Inspired by Vert.x Web and Koa; no dependencies beyond Bun's built-ins.

```ts
import {
  createRouter,
  vexHandler,
  cors,
  bearerAuth,
  accessLog,
  requestId,
  errorBoundary,
  serveDir,
  serveFile,
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
  .get("/assets/*", serveDir({ dir: "./dist/ui/assets", stripPrefix: "/assets" }))
  .get("/*", serveFile("./dist/ui/index.html"));

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

Routes and mounts are tried in the order they were added. A mounted router that matches nothing lets later matchers try; a 404 one of its routes answers (a refusal, a missing row) is final. A mounted function, which cannot say whether it matched, lets later matchers try on any 404.

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

A query or mutation that throws an `HttpError` answers as it renders, its status, headers and body: a refusal reaches the caller as the 403 or 404 it is, with whatever its body carries (a `code`, the permission it lacked). Anything else thrown is a 500 carrying its message. The WebSocket's error frame carries the same: `{ type: "error", id, message, status?, body? }`, and `VexClient` rejects with a `VexCallError` holding `status` and `body`.

Request bodies are read under a byte ceiling: `vexHandler(vex, { maxBodyBytes, maxWebhookBodyBytes, bodyTimeoutMs })`. `maxBodyBytes` defaults to 8 MiB (`DEFAULT_MAX_BODY_BYTES`) and covers `/query` and `/mutate`. Webhooks use the same ceiling unless `maxWebhookBodyBytes` gives them their own. A body past the ceiling gets a 413 before it is buffered, and no query, mutation or webhook runs. With `bodyTimeoutMs` set, a body that stalls gets a 408. Mounted behind `bodyParser`, the dispatcher uses the body the parser already read.

### Request bodies under a byte ceiling

```ts
import { readBoundedBody, discardBody, readBody, readText, readJson, readForm, refuseBody } from "vex-core/http";

const read = await readBoundedBody(req, { maxBytes, drainBytes?, timeoutMs? });
// { ok: true, bytes: Uint8Array } | { ok: false, status: 400 | 408 | 413, closeConnection }
```

- A declared `Content-Length` past `maxBytes` is refused before any bytes are read. An undeclared (chunked) body is counted as it streams and refused as soon as it passes the ceiling.
- A refused body is drained up to `drainBytes` (default 4x `maxBytes`). That keeps a kept-alive socket clean, so the client reads the refusal instead of an ECONNRESET. If the body is past the drain ceiling, or past `timeoutMs` (one deadline covers both the read and the drain), `closeConnection` is true.
- `discardBody(req, limits)` refuses a body without reading it in (wrong content type, etc.) under the same drain rule.
- `readBody` / `readText` / `readJson` / `readForm` / `refuseBody` throw the `HttpError` that explains the refusal as `{ error }`, and add `Connection: close` exactly when bytes remain on the socket.

Web Streams only, so it runs in Bun and workerd alike.

### Middleware catalog

| Middleware    | What it does |
|---------------|--------------|
| `errorBoundary({ devStackTraces, logger })` | Catches thrown errors, renders `HttpError`, wraps everything else as 500. |
| `requestId({ header, generator })`          | Read or mint `X-Request-Id`; stash on `ctx.state.requestId`; echo on response. |
| `accessLog({ logger, skipPaths })`          | One line per request: `GET /path -> 200 (12ms)`. |
| `cors({ origin, credentials, allowedHeaders, maxAge })` | Fetch-standard CORS. Downgrades `*` to request origin when `credentials: true`. |
| `bearerAuth({ token, publicPaths, loginPage })` | Single-token HTTP gate: `Authorization: Bearer` OR session cookie. Built-in `/login` + `/logout`; per-IP rate limit on failures. The login form is read under a 16 KiB / 10 s ceiling, and a refused form counts as a failure. |
| `bodyParser({ limit, drainLimit, timeoutMs, json, urlencoded, text })` | Parse request body into `ctx.state.body`. `limit` is in bytes (default 1 MiB), enforced as the body streams; an oversized body gets a 413 and is drained. |
| `rateLimit({ requests, window, key, cost, limiter })` | Token-bucket limiting: 429 + `Retry-After`, full `X-RateLimit-*` on every response. Works as `use()` middleware or as a route-chain gate. |
| `sessions({ storage, cookieName, maxAge, rolling })` | Server-side session store on any `StorageAdapter` (SQLite/custom). `ctx.session.get/set/delete/destroy`. |

`cors`, `requestId`, `rateLimit` and `sessions` add their headers to the Response the handler returned, so a body's implicit content type (e.g. `text/plain` for `new Response("ok")`) is served as is. Return a new Response for every request, never a shared instance.

### Static serving — namespace owners, not fallbacks

`serveDir` and `serveFile` are plain route handlers. Give each URL
namespace exactly one owner and every request has one deterministic
path through the router — no Accept sniffing, no extension heuristics,
no 404-then-retry:

```ts
import { serveDir, serveFile } from "vex-core/http";

app
  // Asset namespace: bytes or 404 — a missing script can never
  // receive the HTML shell.
  .get("/assets/*", serveDir({
    dir: "./dist/ui/assets",
    stripPrefix: "/assets",
    cacheControl: "public, max-age=31536000, immutable",
  }))
  .get("/favicon.ico", serveFile("./dist/ui/favicon.ico"))
  // Document namespace: the terminal GET route owns every
  // client-routed URL — dotted or not — and serves the app shell.
  .get("/*", serveFile("./dist/ui/index.html"));
```

Both resolve paths inside their directory (traversal-guarded), infer
content type by extension, support HEAD, and default to `no-cache`.

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

## Rate limiting

`RateLimiter` is the core primitive — a token bucket (capacity `requests`, refilling at `requests / window` per second), keyed by caller identity, with cost-weighted consumption for expensive operations. One instance = one scope + one budget; share the instance to share the budget.

```ts
import { RateLimiter, RateLimitExceededError } from "vex-core";

const runs = new RateLimiter({
  limit: { requests: 30, window: 60 },
  scope: "agent-runs",
  onDecision: (d) => { if (!d.allowed) log.warn("rate limited", d); },
});

runs.tryConsume(userId);        // → { allowed, retryAfter, remaining, … }
runs.consume(userId, 5);        // throws RateLimitExceededError on reject
runs.peek(userId);              // report without spending budget
runs.stats();                   // { allowed, rejected, keys }
```

State is in-memory and bounded (`prune()` + a `maxKeys` cap with LRU-ish eviction). Per-key limits bound per-key abuse, not aggregate volume — cap aggregate volume with a second limiter on a constant key.

Over HTTP, the `rateLimit` middleware wraps the same primitive:

```ts
import { rateLimit } from "vex-core/http";

app.use(rateLimit({ requests: 100, window: 60 }));            // per-IP, all routes

const shared = new RateLimiter({ limit: { requests: 10, window: 60 }, scope: "expensive" });
app.get("/report", rateLimit({ limiter: shared, cost: () => 5 }), reportHandler)
   .get("/export", rateLimit({ limiter: shared, cost: () => 10 }), exportHandler);
```

Every response carries `X-RateLimit-Limit` / `-Remaining` / `-Reset`; rejections return the 429 body `{ error: "too_many_requests", retryAfter, resource }` and record an errored `rateLimit` child span when tracing is composed upstream.

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

A tracer can make one head-sampling decision for each root. Returning `false` prevents the entire trace from recording and skips result-size instrumentation for one-shot queries:

```ts
const tracer: Tracer = {
  shouldRecord: ({ traceId }) => sample(traceId),
  onSpan: (span) => persist(span),
};
```

Core metadata describes query and write structure without recording filter values, row values, handler arguments, or results. Core emits spans to the tracer but does not persist them automatically; it reserves the internal `_spans` table for apps that choose SQLite persistence. Retention remains app-specific. For a long-running server that writes `_spans`, register bounded cleanup:

```ts
api.registerJob("spanRetention", {
  schedule: "every 1h",
  async handler(ctx) {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days
    await ctx.db.sql(
      `DELETE FROM _spans WHERE _id IN (
         SELECT _id FROM _spans WHERE startTime < ? LIMIT 1000
       )`,
      cutoff,
    );
  },
});
```

Age retention alone is not a hard volume bound. Production sinks should also cap queued spans, individual span size, and total retained rows or bytes.

## Exports

| Entry | Contents |
|-------|----------|
| `vex-core` | `Vex`, `sqliteAdapter`, `durableObjectAdapter`, `id`, core types, tracer, `RateLimiter`. Under the `workerd` condition, everything but `sqliteAdapter` and `config` |
| `vex-core/framework` | `table`, `query`, `mutation`, `webhook`, `job`, `middleware`, `scanDirectory` |
| `vex-core/http` | `Router`, `createRouter`, `HttpError`, `compose`, `vexHandler`, static handlers (`serveDir`, `serveFile`), plus middleware (`cors`, `bearerAuth`, `bodyParser`, `accessLog`, `requestId`, `rateLimit`, `errorBoundary`, `sessions`) |
| `vex-core/client` | `VexProvider`, `useQuery`, `useMutation` |
| `vex-core/adapters/sqlite` | `sqliteAdapter` |
| `vex-core/adapters/durable-object` | `durableObjectAdapter` |

## License

MIT
