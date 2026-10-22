import { describe, expect, test } from "bun:test";
import {
  cors,
  createRouter,
  errorBoundary,
  HttpError,
  type Middleware,
} from "../../src/http/index.js";

describe("router — matching", () => {
  test("GET exact path", async () => {
    const app = createRouter().get("/hello", () => new Response("hi"));
    const res = await app.handle(new Request("http://x/hello"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hi");
  });

  test("method discrimination", async () => {
    const app = createRouter()
      .get("/p", () => new Response("get"))
      .post("/p", () => new Response("post"));
    const a = await app.handle(new Request("http://x/p"));
    const b = await app.handle(new Request("http://x/p", { method: "POST" }));
    expect(await a.text()).toBe("get");
    expect(await b.text()).toBe("post");
  });

  test(":param capture", async () => {
    const app = createRouter().get("/users/:id", (ctx) =>
      Response.json({ id: ctx.params.id }),
    );
    const res = await app.handle(new Request("http://x/users/42"));
    expect(await res.json()).toEqual({ id: "42" });
  });

  test("wildcard capture under mount", async () => {
    const inner = createRouter().all("/webhook/*", (ctx) =>
      Response.json({ rest: ctx.params["0"] }),
    );
    const app = createRouter().mount("/vex", inner);
    const res = await app.handle(
      new Request("http://x/vex/webhook/github/push"),
    );
    expect(await res.json()).toEqual({ rest: "github/push" });
  });

  test("unmatched path yields 404", async () => {
    const app = createRouter().get("/a", () => new Response("a"));
    const res = await app.handle(new Request("http://x/missing"));
    expect(res.status).toBe(404);
  });

  test("handler can fall through by returning undefined", async () => {
    const app = createRouter()
      .get(
        "/pick",
        () => undefined,
        () => new Response("second"),
      )
      .get("/pick", () => new Response("third"));
    const res = await app.handle(new Request("http://x/pick"));
    expect(await res.text()).toBe("second");
  });
});

describe("router — middleware", () => {
  test("middleware wraps the chain (onion order)", async () => {
    const calls: string[] = [];
    const tag =
      (name: string): Middleware =>
      async (_c, next) => {
        calls.push(`>${name}`);
        const r = await next();
        calls.push(`<${name}`);
        return r;
      };
    const app = createRouter()
      .use(tag("a"))
      .use(tag("b"))
      .get("/", () => {
        calls.push("h");
        return new Response("ok");
      });
    await app.handle(new Request("http://x/"));
    expect(calls).toEqual([">a", ">b", "h", "<b", "<a"]);
  });

  test("short-circuit middleware prevents handler", async () => {
    let handlerRan = false;
    const app = createRouter()
      .use(async () => new Response("blocked", { status: 418 }))
      .get("/", () => {
        handlerRan = true;
        return new Response("ok");
      });
    const res = await app.handle(new Request("http://x/"));
    expect(res.status).toBe(418);
    expect(handlerRan).toBe(false);
  });
});

describe("router — mount", () => {
  test("prefix strips before inner dispatch", async () => {
    const inner = createRouter().get("/ping", (ctx) =>
      Response.json({ path: ctx.url.pathname }),
    );
    const app = createRouter().mount("/api", inner);
    const res = await app.handle(new Request("http://x/api/ping"));
    // The outer ctx's url.pathname reports the original path; the
    // inner router saw `/ping` after rewrite.
    expect(await res.json()).toEqual({ path: "/ping" });
  });

  test("non-matching prefix falls through to 404", async () => {
    const inner = createRouter().get("/ping", () => new Response("pong"));
    const app = createRouter().mount("/api", inner);
    const res = await app.handle(new Request("http://x/other"));
    expect(res.status).toBe(404);
  });

  test("root mount (empty prefix) routes every request through inner", async () => {
    const inner = createRouter().get("/hello", () => new Response("hi"));
    const app = createRouter().mount("", inner);
    const res = await app.handle(new Request("http://x/hello"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hi");
  });

  test('root mount via "/" normalizes to empty prefix', async () => {
    const inner = createRouter().get("/hello", () => new Response("hi"));
    const app = createRouter().mount("/", inner);
    const res = await app.handle(new Request("http://x/hello"));
    expect(res.status).toBe(200);
  });

  test("parent routes registered before a root-mount still win", async () => {
    const inner = createRouter().get("/health", () => new Response("INNER"));
    const app = createRouter()
      .get("/health", () => new Response("PARENT"))
      .mount("", inner);
    const res = await app.handle(new Request("http://x/health"));
    expect(await res.text()).toBe("PARENT");
  });

  test("a mount that matches nothing falls through to later matchers", async () => {
    const inner = createRouter().get("/known", () => new Response("yes"));
    const app = createRouter()
      .mount("", inner)
      .get("/fallback", () => new Response("fell through"));
    const res = await app.handle(new Request("http://x/fallback"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("fell through");
  });

  test("it falls through however its middleware renders or decorates the miss", async () => {
    const inner = createRouter()
      .use(cors())
      .use(errorBoundary({ logger: () => {} }))
      .get("/known", () => new Response("yes"));
    const app = createRouter()
      .mount("", inner)
      .get("/fallback", () => new Response("fell through"));
    const res = await app.handle(new Request("http://x/fallback"));
    expect(await res.text()).toBe("fell through");
  });

  test("a 404 a mounted route answers is final: a refusal keeps its body", async () => {
    const inner = createRouter().get("/item", () => {
      throw new HttpError(404, "Item not found", {
        body: { error: "Item not found", code: "not_found" },
      });
    });
    const app = createRouter()
      .mount("", inner)
      .get("/item", () => new Response("someone else's item"));
    const res = await app.handle(new Request("http://x/item"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "Item not found",
      code: "not_found",
    });
  });

  test("a miss its error handler answers with something else (an app shell) is final", async () => {
    const inner = createRouter()
      .onError(
        (err) => err instanceof HttpError && err.status === 404,
        () => new Response("app shell"),
      )
      .get("/known", () => new Response("yes"));
    const app = createRouter()
      .mount("", inner)
      .get("/elsewhere", () => new Response("later route"));
    const res = await app.handle(new Request("http://x/elsewhere"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("app shell");
  });

  test("a mounted function falls through on any 404: it cannot say it matched", async () => {
    const app = createRouter()
      .mount("", () => new Response("nope", { status: 404 }))
      .get("/fallback", () => new Response("fell through"));
    const res = await app.handle(new Request("http://x/fallback"));
    expect(await res.text()).toBe("fell through");
  });
});

describe("router — routes()", () => {
  test("lists every route by method and full path, through mounted routers", () => {
    const api = createRouter({ prefix: "/v1" })
      .get("/items/:id", () => new Response("item"))
      .post("/items", () => new Response("made"));
    const app = createRouter()
      .get("/health", () => new Response("ok"))
      .mount("/api", api)
      .mount("", createRouter().all("/hooks/*", () => new Response("hook")))
      .mount("/raw", () => new Response("raw"));
    expect(app.routes()).toEqual([
      { kind: "route", method: "GET", path: "/health" },
      { kind: "route", method: "GET", path: "/api/v1/items/:id" },
      { kind: "route", method: "POST", path: "/api/v1/items" },
      { kind: "route", method: "ALL", path: "/hooks/*" },
      { kind: "mount", path: "/raw" },
    ]);
  });
});

describe("router — error handling", () => {
  test("HttpError renders via toResponse()", async () => {
    const app = createRouter().get("/x", () => {
      throw HttpError.forbidden("nope");
    });
    const res = await app.handle(new Request("http://x/x"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "nope" });
  });

  test("unclassified errors become 500", async () => {
    const app = createRouter().get("/x", () => {
      throw new Error("boom");
    });
    const res = await app.handle(new Request("http://x/x"));
    expect(res.status).toBe(500);
  });

  test("onError receives the thrown value", async () => {
    const app = createRouter()
      .onError((_ctx, err) => {
        return Response.json(
          { caught: err instanceof Error ? err.message : String(err) },
          { status: 500 },
        );
      })
      .get("/x", () => {
        throw new Error("boom");
      });
    const res = await app.handle(new Request("http://x/x"));
    expect(await res.json()).toEqual({ caught: "boom" });
  });

  test("predicate routing for onError", async () => {
    const app = createRouter()
      .onError(
        (err) => err instanceof HttpError && err.status === 404,
        () => new Response("custom 404", { status: 404 }),
      )
      .get("/x", () => {
        throw HttpError.notFound();
      });
    const res = await app.handle(new Request("http://x/x"));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("custom 404");
  });
});

describe("router — body is consumable by handler", () => {
  test("handler reads JSON body after mount/rewrite", async () => {
    const inner = createRouter().post("/echo", async (ctx) => {
      const body = await ctx.req.json();
      return Response.json(body);
    });
    const app = createRouter().mount("/api", inner);
    const res = await app.handle(
      new Request("http://x/api/echo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ n: 1 }),
      }),
    );
    expect(await res.json()).toEqual({ n: 1 });
  });
});
