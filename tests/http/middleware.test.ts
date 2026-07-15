import { describe, expect, test } from "bun:test";
import { RateLimiter } from "../../src/core/rate-limit.js";
import type { SpanHandle } from "../../src/core/tracer.js";
import {
  accessLog,
  bearerAuth,
  bodyParser,
  cors,
  createRouter,
  errorBoundary,
  HttpError,
  rateLimit,
  requestId,
} from "../../src/http/index.js";

describe("cors", () => {
  test("OPTIONS preflight", async () => {
    const app = createRouter()
      .use(cors({ origin: "https://example.com" }))
      .get("/", () => new Response("ok"));
    const res = await app.handle(
      new Request("http://x/", { method: "OPTIONS" }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://example.com",
    );
  });

  test("allowlist rejects unknown origin", async () => {
    const app = createRouter()
      .use(cors({ origin: ["https://allowed.com"] }))
      .get("/", () => new Response("ok"));
    const res = await app.handle(
      new Request("http://x/", { headers: { origin: "https://bad.com" } }),
    );
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("credentials=true downgrades wildcard", async () => {
    const app = createRouter()
      .use(cors({ origin: "*", credentials: true }))
      .get("/", () => new Response("ok"));
    const res = await app.handle(
      new Request("http://x/", {
        headers: { origin: "https://site.com" },
      }),
    );
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://site.com",
    );
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });
});

describe("bodyParser", () => {
  test("parses JSON into ctx.state.body", async () => {
    const app = createRouter()
      .use(bodyParser())
      .post("/echo", (ctx) => Response.json(ctx.state.body));
    const res = await app.handle(
      new Request("http://x/echo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hello: "world" }),
      }),
    );
    expect(await res.json()).toEqual({ hello: "world" });
  });

  test("rejects oversized JSON", async () => {
    const app = createRouter()
      .use(bodyParser({ limit: 10 }))
      .post("/", () => new Response("ok"));
    const res = await app.handle(
      new Request("http://x/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": "1000",
        },
        body: "not really that long",
      }),
    );
    expect(res.status).toBe(413);
  });
});

describe("bearerAuth", () => {
  const token = "s3cret";
  const buildApp = () =>
    createRouter()
      .use(bearerAuth({ token }))
      .get("/private", () => new Response("private"))
      .get("/health", () => new Response("ok"));

  test("no token → 401 JSON for API clients", async () => {
    const res = await buildApp().handle(
      new Request("http://x/private", {
        headers: { accept: "application/json" },
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });

  test("no token → 303 redirect for HTML clients", async () => {
    const res = await buildApp().handle(
      new Request("http://x/private", {
        headers: { accept: "text/html" },
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/login");
  });

  test("valid bearer header passes", async () => {
    const res = await buildApp().handle(
      new Request("http://x/private", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("private");
  });

  test("valid cookie passes", async () => {
    const res = await buildApp().handle(
      new Request("http://x/private", {
        headers: { cookie: `vex_auth=${token}` },
      }),
    );
    expect(res.status).toBe(200);
  });

  test("/login POST with correct token sets cookie", async () => {
    const res = await buildApp().handle(
      new Request("http://x/login", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: `token=${token}`,
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie")).toContain("vex_auth=");
  });

  test("/login POST with bad token shows form with 401", async () => {
    const res = await buildApp().handle(
      new Request("http://x/login", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "token=wrong",
      }),
    );
    expect(res.status).toBe(401);
  });

  test("health path bypasses auth", async () => {
    const res = await buildApp().handle(new Request("http://x/health"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test("constant-time mismatched length rejects", async () => {
    const res = await buildApp().handle(
      new Request("http://x/private", {
        headers: { authorization: "Bearer short" },
      }),
    );
    expect(res.status).toBe(401);
  });

  test("only failed logins consume the failure budget", async () => {
    const app = createRouter()
      .use(bearerAuth({ token, maxFailures: 2, failureWindowSeconds: 60 }))
      .get("/private", () => new Response("private"));

    const login = (submitted: string) =>
      app.handle(
        new Request("http://x/login", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-forwarded-for": "3.3.3.3",
          },
          body: `token=${submitted}`,
        }),
      );

    // Successful logins never count against the failure budget.
    for (let i = 0; i < 5; i++) expect((await login(token)).status).toBe(303);

    // The budget still has its full two failures available…
    expect((await login("wrong")).status).toBe(401);
    expect((await login("wrong")).status).toBe(401);
    // …then the IP is blocked — even with the correct token.
    expect((await login("wrong")).status).toBe(429);
    expect((await login(token)).status).toBe(429);
  });
});

describe("requestId", () => {
  test("passes inbound id through", async () => {
    const app = createRouter()
      .use(requestId())
      .get("/", (ctx) => Response.json({ id: ctx.state.requestId }));
    const res = await app.handle(
      new Request("http://x/", {
        headers: { "x-request-id": "from-caller" },
      }),
    );
    expect(await res.json()).toEqual({ id: "from-caller" });
    expect(res.headers.get("x-request-id")).toBe("from-caller");
  });

  test("mints one when missing", async () => {
    const app = createRouter()
      .use(requestId())
      .get("/", (ctx) => Response.json({ id: ctx.state.requestId }));
    const res = await app.handle(new Request("http://x/"));
    const body = (await res.json()) as { id: string };
    expect(body.id.length).toBeGreaterThan(0);
    expect(res.headers.get("x-request-id")).toBe(body.id);
  });
});

describe("rateLimit", () => {
  test("blocks on over-limit with 429 + Retry-After", async () => {
    const app = createRouter()
      .use(rateLimit({ requests: 2, window: 60 }))
      .get("/", () => new Response("ok"));

    const make = () =>
      app.handle(
        new Request("http://x/", {
          headers: { "x-forwarded-for": "1.2.3.4" },
        }),
      );
    expect((await make()).status).toBe(200);
    expect((await make()).status).toBe(200);
    const blocked = await make();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeDefined();
  });

  test("different keys get separate budgets", async () => {
    const app = createRouter()
      .use(rateLimit({ requests: 1, window: 60 }))
      .get("/", () => new Response("ok"));

    const a1 = await app.handle(
      new Request("http://x/", { headers: { "x-forwarded-for": "1" } }),
    );
    const b1 = await app.handle(
      new Request("http://x/", { headers: { "x-forwarded-for": "2" } }),
    );
    expect(a1.status).toBe(200);
    expect(b1.status).toBe(200);
    const a2 = await app.handle(
      new Request("http://x/", { headers: { "x-forwarded-for": "1" } }),
    );
    expect(a2.status).toBe(429);
  });

  test("every response carries the full X-RateLimit header set", async () => {
    const app = createRouter()
      .use(errorBoundary())
      .use(rateLimit({ requests: 2, window: 60 }))
      .get("/", () => new Response("ok"));

    const make = () =>
      app.handle(
        new Request("http://x/", { headers: { "x-forwarded-for": "9" } }),
      );

    const ok = await make();
    expect(ok.headers.get("x-ratelimit-limit")).toBe("2");
    expect(ok.headers.get("x-ratelimit-remaining")).toBe("1");
    expect(Number(ok.headers.get("x-ratelimit-reset"))).toBeGreaterThan(0);

    await make();
    const blocked = await make();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeDefined();
    expect(blocked.headers.get("x-ratelimit-limit")).toBe("2");
    expect(blocked.headers.get("x-ratelimit-remaining")).toBe("0");
    const body = (await blocked.json()) as { error: string; resource: string };
    expect(body.error).toBe("too_many_requests");
  });

  test("a shared limiter pools the budget across routes", async () => {
    const limiter = new RateLimiter({
      limit: { requests: 2, window: 60 },
      scope: "api",
    });
    const app = createRouter()
      .use(errorBoundary())
      .get("/a", rateLimit({ limiter }), () => new Response("a"))
      .get("/b", rateLimit({ limiter }), () => new Response("b"));

    const get = (path: string) =>
      app.handle(
        new Request(`http://x${path}`, {
          headers: { "x-forwarded-for": "7" },
        }),
      );

    expect((await get("/a")).status).toBe(200);
    expect((await get("/b")).status).toBe(200);
    const blocked = await get("/a");
    expect(blocked.status).toBe(429);
    expect(((await blocked.json()) as { resource: string }).resource).toBe(
      "api",
    );
  });

  test("cost weighs expensive routes against the same budget", async () => {
    const app = createRouter()
      .use(errorBoundary())
      .use(rateLimit({ requests: 10, window: 60, cost: () => 6 }))
      .get("/", () => new Response("ok"));

    const make = () =>
      app.handle(
        new Request("http://x/", { headers: { "x-forwarded-for": "8" } }),
      );
    expect((await make()).status).toBe(200);
    expect((await make()).status).toBe(429);
  });

  test("rejections record an errored rateLimit child span", async () => {
    const ended: Array<{ status?: string; meta?: Record<string, unknown> }> =
      [];
    const fakeSpan: SpanHandle = {
      spanId: "root",
      end() {},
      child(type, name) {
        const record: { status?: string; meta?: Record<string, unknown> } = {};
        ended.push(record);
        return {
          spanId: `${type}:${name}`,
          end(status, opts) {
            record.status = status;
            record.meta = opts?.meta;
          },
          child() {
            throw new Error("unused");
          },
        };
      },
    };
    const app = createRouter()
      .use(errorBoundary())
      .use(async (ctx, next) => {
        ctx.span = fakeSpan;
        return next();
      })
      .use(rateLimit({ requests: 1, window: 60, resource: "login" }))
      .get("/", () => new Response("ok"));

    const make = () =>
      app.handle(
        new Request("http://x/", { headers: { "x-forwarded-for": "5" } }),
      );
    await make();
    expect(ended).toHaveLength(0); // allowed requests add no spans
    await make();
    expect(ended).toHaveLength(1);
    expect(ended[0].status).toBe("error");
    expect(ended[0].meta).toMatchObject({ scope: "login", key: "5" });
  });

  test("requires either a limiter or requests+window", () => {
    expect(() => rateLimit({ requests: 5 })).toThrow(/requests/);
    expect(() => rateLimit({})).toThrow(/requests/);
  });
});

describe("errorBoundary", () => {
  test("renders thrown HttpError", async () => {
    const app = createRouter()
      .use(errorBoundary())
      .get("/", () => {
        throw HttpError.badRequest("bad");
      });
    const res = await app.handle(new Request("http://x/"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad" });
  });

  test("hides details on 500 without devStackTraces", async () => {
    const app = createRouter()
      .use(errorBoundary({ logger: () => {} }))
      .get("/", () => {
        throw new Error("leak");
      });
    const res = await app.handle(new Request("http://x/"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Internal Server Error");
  });

  test("exposes stack on devStackTraces", async () => {
    const app = createRouter()
      .use(errorBoundary({ devStackTraces: true, logger: () => {} }))
      .get("/", () => {
        throw new Error("leak");
      });
    const res = await app.handle(new Request("http://x/"));
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toContain("leak");
  });
});

describe("accessLog", () => {
  test("logs method + path + status + duration", async () => {
    const lines: string[] = [];
    const app = createRouter()
      .use(accessLog({ logger: (line) => lines.push(line) }))
      .get("/hi", () => new Response("ok"));
    await app.handle(new Request("http://x/hi"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("GET /hi");
    expect(lines[0]).toContain("200");
    expect(lines[0]).toMatch(/\(\d+ms\)/);
  });

  test("logs error status on thrown", async () => {
    const lines: string[] = [];
    const app = createRouter()
      .use(errorBoundary({ logger: () => {} }))
      .use(accessLog({ logger: (line) => lines.push(line) }))
      .get("/hi", () => {
        throw new Error("boom");
      });
    await app.handle(new Request("http://x/hi"));
    expect(lines[0]).toContain("500");
    expect(lines[0]).toContain("error");
  });
});
