/**
 * Request bodies under a byte ceiling (src/http/body.ts) and the four
 * places that read through it.
 *
 * The reader:
 *   - a body at the ceiling is read whole; one byte past is a 413
 *   - a refusal within the drain ceiling leaves the socket clean; one
 *     past it, or a declared length past it, closes the connection
 *   - `drainBytes: 0` never drains: refusing always closes
 *   - a producer that stalls past the deadline is a 408 that closes
 *   - a Content-Length that is not a byte count is a 400
 *   - one deadline covers a body's read and its drain
 *
 * The helpers: a refusal is the HttpError that says why, in
 * `{ error }`, carrying `Connection: close` exactly when bytes stay on
 * the socket.
 *
 * The sites: vexHandler's /query, /mutate and /webhook/*, bodyParser
 * (bytes, not UTF-16 units; chunked bodies counted as they stream),
 * and bearerAuth's unauthenticated login form.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sqliteAdapter } from "../../src/adapters/sqlite.js";
import { Vex } from "../../src/core/engine.js";
import { formatBytes } from "../../src/http/body.js";
import {
  bearerAuth,
  bodyParser,
  createRouter,
  DEFAULT_MAX_BODY_BYTES,
  discardBody,
  HttpError,
  readBody,
  readBoundedBody,
  readForm,
  readJson,
  readText,
  refuseBody,
  vexHandler,
} from "../../src/http/index.js";

function post(
  body: BodyInit | null,
  headers: Record<string, string> = {},
  url = "http://test/",
) {
  return new Request(url, { method: "POST", body, headers });
}

/** A body of `n` bytes with no declared length, as a chunked upload. */
function chunked(n: number): ReadableStream<Uint8Array> {
  return new Blob([new Uint8Array(n)]).stream();
}

/** A body that sends `first` and then never another byte. */
function stalling(first: Uint8Array): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) return new Promise(() => {});
      sent = true;
      controller.enqueue(first);
    },
  });
}

/** A body that counts how many bytes were pulled out of it. */
function counting(chunk: number, chunks: number) {
  const state = { pulled: 0 };
  let left = chunks;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (left-- <= 0) return controller.close();
      state.pulled += chunk;
      controller.enqueue(new Uint8Array(chunk));
    },
  });
  return { stream, state };
}

/** The HttpError `promise` rejects with. */
async function refusal(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("readBoundedBody", () => {
  test("reads a body at the ceiling whole, into its own ArrayBuffer", async () => {
    const read = await readBoundedBody(post(new Uint8Array(1000)), {
      maxBytes: 1000,
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.bytes).toBeInstanceOf(Uint8Array);
    expect(read.bytes.byteLength).toBe(1000);
    expect(read.bytes.buffer.byteLength).toBe(1000);
  });

  test("an absent body reads as empty", async () => {
    const read = await readBoundedBody(post(null), { maxBytes: 10 });
    expect(read.ok && read.bytes.byteLength).toBe(0);
  });

  test("one byte past the ceiling is a 413, drained clean within four times it", async () => {
    const read = await readBoundedBody(post(chunked(1001)), { maxBytes: 1000 });
    expect(read).toEqual({ ok: false, status: 413, closeConnection: false });
  });

  test("an undeclared body stops being buffered the moment it passes the ceiling", async () => {
    const { stream, state } = counting(1024, 1000);
    const read = await readBoundedBody(post(stream), {
      maxBytes: 4096,
      drainBytes: 0,
    });
    expect(read).toEqual({ ok: false, status: 413, closeConnection: true });
    // Five chunks crossed 4KB; the other 995 were never pulled.
    expect(state.pulled).toBeLessThanOrEqual(6 * 1024);
  });

  test("a declared length past the ceiling is refused before a byte is buffered", async () => {
    const { stream, state } = counting(1024, 100);
    const read = await readBoundedBody(
      post(stream, { "content-length": String(100 * 1024) }),
      { maxBytes: 1024 },
    );
    expect(read).toEqual({ ok: false, status: 413, closeConnection: true });
    expect(state.pulled).toBeLessThanOrEqual(1024);
  });

  test("past the drain ceiling the drain gives up and the connection closes", async () => {
    const read = await readBoundedBody(post(chunked(4001)), { maxBytes: 1000 });
    expect(read).toEqual({ ok: false, status: 413, closeConnection: true });
  });

  test("drainBytes 0 never drains: refusing closes", async () => {
    const read = await readBoundedBody(post(chunked(1001)), {
      maxBytes: 1000,
      drainBytes: 0,
    });
    expect(read).toEqual({ ok: false, status: 413, closeConnection: true });
  });

  test("a producer that stalls is a 408 that closes", async () => {
    const read = await readBoundedBody(post(stalling(new Uint8Array(10))), {
      maxBytes: 1000,
      timeoutMs: 50,
    });
    expect(read).toEqual({ ok: false, status: 408, closeConnection: true });
  });

  test("one deadline covers the read and the drain of a refused body", async () => {
    const started = Date.now();
    const read = await readBoundedBody(post(stalling(new Uint8Array(20))), {
      maxBytes: 10,
      timeoutMs: 300,
    });
    expect(read).toEqual({ ok: false, status: 413, closeConnection: true });
    // Two clocks would take twice the timeout.
    expect(Date.now() - started).toBeLessThan(550);
  });

  test("a Content-Length that is not a byte count is a 400", async () => {
    for (const value of ["lots", "-1", "1.5", "1e3"]) {
      const read = await readBoundedBody(
        post(stalling(new Uint8Array(10)), { "content-length": value }),
        { maxBytes: 1000 },
      );
      expect(!read.ok && read.status).toBe(400);
    }
  });
});

describe("discardBody", () => {
  test("drains a body within the ceiling and keeps the connection", async () => {
    expect(await discardBody(post(chunked(3000)), { maxBytes: 1000 })).toEqual({
      closeConnection: false,
    });
  });

  test("gives up on a declared length past the ceiling without reading", async () => {
    const { stream, state } = counting(1024, 1_000_000);
    expect(
      await discardBody(post(stream, { "content-length": "999999999" }), {
        maxBytes: 1000,
      }),
    ).toEqual({ closeConnection: true });
    expect(state.pulled).toBeLessThanOrEqual(1024);
  });

  test("a stalled producer cannot be drained: the connection closes", async () => {
    expect(
      await discardBody(post(stalling(new Uint8Array(10))), {
        maxBytes: 1000,
        timeoutMs: 50,
      }),
    ).toEqual({ closeConnection: true });
  });

  test("no body, or one already read, needs nothing", async () => {
    expect(await discardBody(post(null), { maxBytes: 1 })).toEqual({
      closeConnection: false,
    });
    const used = post("x");
    await used.text();
    expect(await discardBody(used, { maxBytes: 1 })).toEqual({
      closeConnection: false,
    });
  });
});

describe("helpers", () => {
  test("formatBytes rounds up so a size just past a limit never reads as it", () => {
    expect(formatBytes(200)).toBe("200B");
    expect(formatBytes(2048)).toBe("2KB");
    expect(formatBytes(2049)).toBe("3KB");
    expect(formatBytes(8 * 1024 * 1024)).toBe("8MB");
    expect(formatBytes(5 * 1024 * 1024 + 1)).toBe("5.1MB");
  });

  test("readBody refuses past the ceiling in the route's words, keeping a drained connection", async () => {
    const error = await refusal(
      readBody(post(chunked(11)), { maxBytes: 10, tooLarge: "Too big." }),
    );
    expect(error.status).toBe(413);
    expect(error.body).toEqual({ error: "Too big." });
    expect(error.headers.connection).toBeUndefined();
  });

  test("readBody names the ceiling when the route does not", async () => {
    const error = await refusal(
      readBody(post(chunked(2049)), { maxBytes: 2048 }),
    );
    expect(error.body).toEqual({
      error: "The request body exceeds the 2KB limit",
    });
  });

  test("a refusal that leaves bytes on the socket closes the connection", async () => {
    const error = await refusal(readBody(post(chunked(41)), { maxBytes: 10 }));
    expect(error.headers.connection).toBe("close");
    expect(error.toResponse().headers.get("connection")).toBe("close");
  });

  test("408 and 400 refusals say why", async () => {
    const stalled = await refusal(
      readBody(post(stalling(new Uint8Array(1))), {
        maxBytes: 10,
        timeoutMs: 30,
      }),
    );
    expect(stalled.status).toBe(408);
    expect(stalled.headers.connection).toBe("close");
    const invalid = await refusal(
      readBody(post("x", { "content-length": "nope" }), { maxBytes: 10 }),
    );
    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({ error: "Invalid Content-Length" });
  });

  test("refuseBody answers with the route's status and words, the body drained", async () => {
    const error = await refusal(
      refuseBody(post(chunked(30)), { maxBytes: 10 }, 415, "Not that."),
    );
    expect(error.status).toBe(415);
    expect(error.body).toEqual({ error: "Not that." });
    expect(error.headers.connection).toBeUndefined();
  });

  test("readText counts bytes, not UTF-16 units", async () => {
    // Four 4-byte code points: 16 bytes, but only 8 UTF-16 units.
    const emoji = "\u{1F600}".repeat(4);
    expect(await readText(post(emoji), { maxBytes: 16 })).toBe(emoji);
    const error = await refusal(readText(post(emoji), { maxBytes: 15 }));
    expect(error.status).toBe(413);
  });

  test("readText drops a leading BOM, as req.text() does", async () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]);
    expect(await readText(post(bom), { maxBytes: 10 })).toBe(
      await post(bom).text(),
    );
  });

  test("readJson parses, answers {} for nothing parseable, and refuses past its ceiling", async () => {
    const limits = { maxBytes: 64 };
    expect(await readJson(post('{"a":1}'), limits)).toEqual({ a: 1 });
    expect(await readJson(post("{"), limits)).toEqual({});
    expect(await readJson(post(null), limits)).toEqual({});
    const error = await refusal(readJson(post(chunked(65)), limits));
    expect(error.status).toBe(413);
  });

  test("readForm reads a multipart body under its ceiling, and null for anything else", async () => {
    const form = new FormData();
    form.append("name", "value");
    const request = new Request("http://test/", { method: "POST", body: form });
    expect((await readForm(request, { maxBytes: 1024 }))?.get("name")).toBe(
      "value",
    );
    expect(await readForm(post("plain"), { maxBytes: 1024 })).toBeNull();
    const big = new FormData();
    big.append("file", new Blob([new Uint8Array(2048)]), "f.bin");
    const error = await refusal(
      readForm(new Request("http://test/", { method: "POST", body: big }), {
        maxBytes: 1024,
      }),
    );
    expect(error.status).toBe(413);
  });
});

// ─── the sites ───────────────────────────────────────────────────────

describe("vexHandler", () => {
  let vex: Vex;
  const hooked: unknown[] = [];

  beforeAll(async () => {
    vex = await Vex.create({
      storage: sqliteAdapter(":memory:"),
      plugins: [
        {
          name: "echo",
          tables: {},
          queries: {
            size: {
              args: { text: "string" },
              handler: async (_ctx, args) => args.text.length,
            },
          },
          mutations: {
            size: {
              args: { text: "string" },
              handler: async (_ctx, args) => args.text.length,
            },
          },
          webhooks: {
            hook: {
              path: "/hook",
              handler: async (_ctx, req) => {
                hooked.push(req.rawBody);
                return { bytes: req.rawBody.length };
              },
            },
          },
        },
      ],
    });
  });

  afterAll(async () => {
    await vex.close();
  });

  const json = (body: unknown) => JSON.stringify(body);

  test("the default ceiling is 8 MiB", () => {
    expect(DEFAULT_MAX_BODY_BYTES).toBe(8 * 1024 * 1024);
  });

  test("/query and /mutate read under the ceiling", async () => {
    const app = vexHandler(vex, { maxBodyBytes: 256 });
    for (const verb of ["query", "mutate"]) {
      const res = await app.handle(
        post(
          json({ name: "echo.size", args: { text: "abc" } }),
          {},
          `http://x/${verb}`,
        ),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: 3 });
    }
  });

  test("a body past the ceiling is a 413, never parsed as {}", async () => {
    const app = vexHandler(vex, { maxBodyBytes: 256 });
    for (const verb of ["query", "mutate"]) {
      const big = json({ name: "echo.size", args: { text: "x".repeat(500) } });
      const declared = await app.handle(post(big, {}, `http://x/${verb}`));
      expect(declared.status).toBe(413);
      expect(await declared.json()).toEqual({
        error: "The request body exceeds the 256B limit",
      });
      const streamed = await app.handle(
        post(chunked(300), {}, `http://x/${verb}`),
      );
      expect(streamed.status).toBe(413);
    }
  });

  test("a body that names no call answers the missing-name 400", async () => {
    const app = vexHandler(vex);
    const res = await app.handle(post("{", {}, "http://x/query"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing query name" });
    for (const body of ["null", "[]", '{"name":42}', '{"name":""}']) {
      const res = await app.handle(post(body, {}, "http://x/mutate"));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Missing mutation name" });
    }
  });

  test("a stalled body is a 408 when a timeout is set", async () => {
    const app = vexHandler(vex, { bodyTimeoutMs: 30 });
    const res = await app.handle(
      post(stalling(new Uint8Array(4)), {}, "http://x/query"),
    );
    expect(res.status).toBe(408);
    expect(res.headers.get("connection")).toBe("close");
  });

  test("behind bodyParser, the body it already read is used for calls and webhooks", async () => {
    hooked.length = 0;
    const app = createRouter().use(bodyParser()).mount("/vex", vexHandler(vex));
    const headers = { "content-type": "application/json" };
    const res = await app.handle(
      post(
        json({ name: "echo.size", args: { text: "abcd" } }),
        headers,
        "http://x/vex/query",
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: 4 });
    const hook = await app.handle(
      post('{"b":2}', headers, "http://x/vex/webhook/hook"),
    );
    expect(await hook.json()).toEqual({ bytes: 7 });
    expect(hooked).toEqual(['{"b":2}']);
  });

  test("webhooks are refused past their ceiling before the handler runs", async () => {
    hooked.length = 0;
    const app = vexHandler(vex, {
      maxBodyBytes: 1024,
      maxWebhookBodyBytes: 64,
    });
    const ok = await app.handle(post('{"a":1}', {}, "http://x/webhook/hook"));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ bytes: 7 });
    const big = await app.handle(
      post(chunked(65), {}, "http://x/webhook/hook"),
    );
    expect(big.status).toBe(413);
    expect(hooked).toEqual(['{"a":1}']);
  });

  test("webhooks share the RPC ceiling unless given their own", async () => {
    const app = vexHandler(vex, { maxBodyBytes: 64 });
    const big = await app.handle(
      post(chunked(65), {}, "http://x/webhook/hook"),
    );
    expect(big.status).toBe(413);
  });
});

describe("bodyParser", () => {
  const app = (limit: number) =>
    createRouter()
      .use(bodyParser({ limit }))
      .post("/", (ctx) => Response.json({ body: ctx.state.body ?? null }))
      .post("/raw", async (ctx) =>
        Response.json({ bytes: (await ctx.req.arrayBuffer()).byteLength }),
      );

  test("counts a chunked body as it streams and refuses it past the limit", async () => {
    const res = await app(10).handle(
      post(chunked(11), { "content-type": "text/plain" }),
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "Payload too large" });
  });

  test("the limit is in bytes, not UTF-16 units", async () => {
    const emoji = "\u{1F600}".repeat(4); // 16 bytes, 8 units
    const over = await app(15).handle(
      post(emoji, { "content-type": "text/plain" }),
    );
    expect(over.status).toBe(413);
    const at = await app(16).handle(
      post(emoji, { "content-type": "text/plain" }),
    );
    expect(await at.json()).toEqual({ body: emoji });
  });

  test("parses JSON and forms under the limit", async () => {
    const j = await app(100).handle(
      post('{"a":1}', { "content-type": "application/json" }),
    );
    expect(await j.json()).toEqual({ body: { a: 1 } });
    const f = await app(100).handle(
      post("a=1&b=2", { "content-type": "application/x-www-form-urlencoded" }),
    );
    expect(await f.json()).toEqual({ body: { a: "1", b: "2" } });
  });

  test("an unparsed type declared past the limit is refused; one under it passes untouched", async () => {
    const big = await app(10).handle(
      post(
        new Uint8Array(20),
        { "content-type": "application/octet-stream", "content-length": "20" },
        "http://test/raw",
      ),
    );
    expect(big.status).toBe(413);
    const small = await app(10).handle(
      post(
        new Uint8Array(5),
        { "content-type": "application/octet-stream", "content-length": "5" },
        "http://test/raw",
      ),
    );
    expect(await small.json()).toEqual({ bytes: 5 });
  });
});

describe("bearerAuth login form", () => {
  const token = "s3cret";
  const app = () =>
    createRouter()
      .use(bearerAuth({ token }))
      .get("/", () => new Response("in"));
  const login = (body: BodyInit, headers: Record<string, string>) =>
    post(body, headers, "http://x/login");

  test("a token form or JSON body under the ceiling logs in", async () => {
    const res = await app().handle(
      login(`token=${token}`, {
        "content-type": "application/x-www-form-urlencoded",
      }),
    );
    expect(res.status).toBe(303);
    const jsonRes = await app().handle(
      login(JSON.stringify({ token }), { "content-type": "application/json" }),
    );
    expect(jsonRes.status).toBe(303);
  });

  test("a form past 16KB is refused 413 without being buffered", async () => {
    const res = await app().handle(
      login(chunked(17 * 1024), {
        "content-type": "application/x-www-form-urlencoded",
      }),
    );
    expect(res.status).toBe(413);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("a huge form closes the connection rather than draining it", async () => {
    const res = await app().handle(
      login(chunked(1024 * 1024), { "content-type": "application/json" }),
    );
    expect(res.status).toBe(413);
    expect(res.headers.get("connection")).toBe("close");
  });

  test("a refused form costs a failed attempt", async () => {
    const limited = createRouter()
      .use(bearerAuth({ token, maxFailures: 1, failureWindowSeconds: 60 }))
      .get("/", () => new Response("in"));
    const headers = {
      "content-type": "application/x-www-form-urlencoded",
      "x-forwarded-for": "203.0.113.9",
    };
    expect(
      (await limited.handle(login(chunked(17 * 1024), headers))).status,
    ).toBe(413);
    expect(
      (await limited.handle(login(`token=${token}`, headers))).status,
    ).toBe(429);
  });

  test("a body of another type submits no token, under the same ceiling", async () => {
    const res = await app().handle(
      login(chunked(1024), { "content-type": "text/plain" }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("connection")).toBeNull();
    const big = await app().handle(
      login(chunked(17 * 1024), { "content-type": "text/plain" }),
    );
    expect(big.status).toBe(413);
  });

  test("a non-string JSON token is a failed login, not a crash", async () => {
    const res = await app().handle(
      login(JSON.stringify({ token: 42 }), {
        "content-type": "application/json",
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe("over a socket", () => {
  test("a refused body is drained: the client reads the 413 and the connection serves the next request", async () => {
    const app = createRouter()
      .use(bodyParser({ limit: 1024 }))
      .post("/", (ctx) => Response.json({ body: ctx.state.body ?? null }));
    const server = Bun.serve({ port: 0, fetch: (req) => app.handle(req) });
    try {
      const url = `http://127.0.0.1:${server.port}/`;
      const refused = await fetch(url, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "x".repeat(2048),
      });
      expect(refused.status).toBe(413);
      expect(refused.headers.get("connection")).not.toBe("close");
      expect(await refused.json()).toEqual({ error: "Payload too large" });
      const next = await fetch(url, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "ok",
      });
      expect(await next.json()).toEqual({ body: "ok" });
    } finally {
      server.stop(true);
    }
  });
});
