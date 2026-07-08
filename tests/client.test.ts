import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import { Vex } from "../src/core/engine.js";
import {
  cors,
  createRouter,
  vexHandler,
  vexWebSocket,
} from "../src/http/index.js";

let vex: Vex;
let server: Server;
let base: string;

beforeAll(async () => {
  vex = await Vex.create({
    storage: sqliteAdapter(":memory:"),
    plugins: [
      {
        name: "items",
        tables: { items: { columns: { name: "string", value: "number" } } },
        queries: {
          list: {
            args: {},
            handler: async (ctx) => ctx.db.table("items").all(),
          },
          byName: {
            args: { name: "string" },
            handler: async (ctx, args) =>
              ctx.db.table("items").where("name", "=", args.name).all(),
          },
          viewer: {
            args: {},
            handler: async (ctx) => ctx.user?.id ?? null,
          },
        },
        mutations: {
          create: {
            args: { name: "string", value: "number" },
            handler: async (ctx, args) => ctx.db.table("items").insert(args),
          },
        },
      },
    ],
  });

  // The composed app dripyard-style: HTTP RPC on /vex/{query,mutate,
  // webhook}, the live channel on /vex/subscribe via WebSocket
  // upgrade. The router only owns HTTP; WS upgrade needs a `Server`
  // reference so it lives inline in the fetch handler.
  const app = createRouter().use(cors()).mount("/vex", vexHandler(vex));
  const vexWs = vexWebSocket(vex);

  server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/vex/subscribe") {
        return vexWs.upgrade(req, srv);
      }
      return app.handle(req);
    },
    websocket: {
      open: vexWs.open as any,
      message: vexWs.message as any,
      close: vexWs.close as any,
    },
  });
  base = `http://localhost:${server.port}`;
});

afterAll(async () => {
  server.stop(true);
  await vex.close();
});

describe("CORS and routing", () => {
  test("OPTIONS returns 204 with CORS headers", async () => {
    const res = await fetch(`${base}/vex/query`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain(
      "Content-Type",
    );
  });

  test("responses include CORS headers", async () => {
    const res = await fetch(`${base}/vex/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "items.list", args: {} }),
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  test("unknown path returns 404", async () => {
    const res = await fetch(`${base}/vex/nope`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Not Found");
  });
});

describe("query endpoint", () => {
  test("returns data for valid query", async () => {
    const res = await fetch(`${base}/vex/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "items.list", args: {} }),
    });
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.data).toEqual([]);
  });

  test("returns 400 for missing query name", async () => {
    const res = await fetch(`${base}/vex/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args: {} }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Missing query name");
  });

  test("returns error for unknown query", async () => {
    const res = await fetch(`${base}/vex/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "items.nope", args: {} }),
    });
    expect(res.ok).toBe(false);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});

describe("mutation endpoint", () => {
  test("creates item and returns id", async () => {
    const res = await fetch(`${base}/vex/mutate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "items.create",
        args: { name: "a", value: 1 },
      }),
    });
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(typeof body.data).toBe("string");
  });

  test("returns 400 for missing mutation name", async () => {
    const res = await fetch(`${base}/vex/mutate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args: {} }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Missing mutation name");
  });

  test("returns error for unknown mutation", async () => {
    const res = await fetch(`${base}/vex/mutate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "items.nope", args: {} }),
    });
    expect(res.ok).toBe(false);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});

// ─── WebSocket live channel ─────────────────────────────────────────
//
// Tiny test harness for driving the WS protocol — opens a connection,
// lets you send framed JSON, and resolves promises by `id` on the
// matching server response. Subscriptions also hand you a "next data"
// promise so tests can `await` the next push.

interface VexClient {
  sendRaw(text: string): void;
  send(frame: Record<string, unknown>): void;
  /** Resolve when a `result` or `error` for `id` arrives. */
  expectResult(id: string): Promise<{ data?: unknown; error?: string }>;
  /** Stream of `data` frames for this id. */
  onData(id: string, fn: (data: unknown) => void): () => void;
  close(): Promise<void>;
}

async function openClient(path = "/vex/subscribe"): Promise<VexClient> {
  const ws = new WebSocket(`ws://localhost:${server.port}${path}`);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("ws open failed")), {
      once: true,
    });
  });

  const pendingResults = new Map<
    string,
    (frame: { data?: unknown; error?: string }) => void
  >();
  const dataListeners = new Map<string, Set<(data: unknown) => void>>();

  ws.addEventListener("message", (ev) => {
    let frame: { type: string; id: string; data?: unknown; message?: string };
    try {
      frame = JSON.parse(ev.data as string);
    } catch {
      return;
    }
    if (frame.type === "result") {
      pendingResults.get(frame.id)?.({ data: frame.data });
      pendingResults.delete(frame.id);
    } else if (frame.type === "error") {
      pendingResults.get(frame.id)?.({ error: frame.message });
      pendingResults.delete(frame.id);
    } else if (frame.type === "data") {
      const subs = dataListeners.get(frame.id);
      if (subs) for (const fn of subs) fn(frame.data);
    }
  });

  return {
    sendRaw: (text) => ws.send(text),
    send: (frame) => ws.send(JSON.stringify(frame)),
    expectResult(id) {
      return new Promise((resolve) => pendingResults.set(id, resolve));
    },
    onData(id, fn) {
      let set = dataListeners.get(id);
      if (!set) {
        set = new Set();
        dataListeners.set(id, set);
      }
      set.add(fn);
      return () => {
        set?.delete(fn);
      };
    },
    async close() {
      ws.close();
      await new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve();
        ws.addEventListener("close", () => resolve(), { once: true });
      });
    },
  };
}

/**
 * Resolve when a subscription has emitted `count` `data` frames,
 * or `timeoutMs` elapses (in which case the promise resolves with
 * however many we collected so far). Used by tests that need to
 * await the initial frame plus N updates.
 */
function collectData(
  client: VexClient,
  id: string,
  count: number,
  timeoutMs = 1500,
): Promise<unknown[]> {
  return new Promise((resolve) => {
    const out: unknown[] = [];
    const off = client.onData(id, (data) => {
      out.push(data);
      if (out.length >= count) {
        off();
        resolve(out);
      }
    });
    setTimeout(() => {
      off();
      resolve(out);
    }, timeoutMs);
  });
}

describe("WebSocket live channel", () => {
  test("requireUser rejects unauthenticated upgrades", async () => {
    const secureWs = vexWebSocket(vex, { requireUser: true });
    const secureServer = Bun.serve({
      port: 0,
      fetch(req, srv) {
        return secureWs.upgrade(req, srv);
      },
      websocket: {
        open: secureWs.open as any,
        message: secureWs.message as any,
        close: secureWs.close as any,
      },
    });

    try {
      const ws = new WebSocket(`ws://localhost:${secureServer.port}`);
      const event = await new Promise<"open" | "error" | "close">(
        (resolve) => {
          ws.addEventListener("open", () => resolve("open"), { once: true });
          ws.addEventListener("error", () => resolve("error"), { once: true });
          ws.addEventListener("close", () => resolve("close"), { once: true });
        },
      );
      expect(event).not.toBe("open");
    } finally {
      secureServer.stop(true);
    }
  });

  test("requireUser allows authenticated upgrades and pins the user", async () => {
    const secureWs = vexWebSocket(vex, {
      requireUser: true,
      getUser: (req) =>
        new URL(req.url).searchParams.get("token") === "ok"
          ? { id: "user-1" }
          : null,
    });
    const secureServer = Bun.serve({
      port: 0,
      fetch(req, srv) {
        return secureWs.upgrade(req, srv);
      },
      websocket: {
        open: secureWs.open as any,
        message: secureWs.message as any,
        close: secureWs.close as any,
      },
    });

    try {
      const ws = new WebSocket(
        `ws://localhost:${secureServer.port}?token=ok`,
      );
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener("error", () => reject(new Error("ws rejected")), {
          once: true,
        });
      });

      const got = new Promise<any>((resolve) => {
        ws.addEventListener(
          "message",
          (ev) => resolve(JSON.parse(ev.data as string)),
          { once: true },
        );
      });
      ws.send(
        JSON.stringify({ type: "query", id: "who", name: "items.viewer" }),
      );
      expect(await got).toEqual({
        type: "result",
        id: "who",
        data: "user-1",
      });
      ws.close();
    } finally {
      secureServer.stop(true);
    }
  });

  test("requireUser + getUserFromToken admits the socket and authenticates on the first frame", async () => {
    // Browsers cannot attach an Authorization header to a WebSocket
    // upgrade, and cross-origin surfaces (browser extensions) don't
    // get their cookie attached either. `getUserFromToken` lets such
    // clients authenticate with their first frame instead.
    const secureWs = vexWebSocket(vex, {
      requireUser: true,
      getUserFromToken: (token) =>
        token === "good-token" ? { id: "token-user" } : null,
    });
    const secureServer = Bun.serve({
      port: 0,
      fetch(req, srv) {
        return secureWs.upgrade(req, srv);
      },
      websocket: {
        open: secureWs.open as any,
        message: secureWs.message as any,
        close: secureWs.close as any,
      },
    });

    try {
      const ws = new WebSocket(`ws://localhost:${secureServer.port}`);
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener("error", () => reject(new Error("ws rejected")), {
          once: true,
        });
      });

      const frames: any[] = [];
      ws.addEventListener("message", (ev) =>
        frames.push(JSON.parse(ev.data as string)),
      );
      // Auth frame first, then a query in the SAME tick - the query
      // must wait for the in-flight auth instead of racing it.
      ws.send(
        JSON.stringify({ type: "auth", id: "a-1", token: "good-token" }),
      );
      ws.send(
        JSON.stringify({ type: "query", id: "who", name: "items.viewer" }),
      );
      await Bun.sleep(100);

      expect(frames).toContainEqual({
        type: "result",
        id: "a-1",
        data: { ok: true },
      });
      expect(frames).toContainEqual({
        type: "result",
        id: "who",
        data: "token-user",
      });
      ws.close();
    } finally {
      secureServer.stop(true);
    }
  });

  test("a bad token gets an error frame and the server closes the socket", async () => {
    const secureWs = vexWebSocket(vex, {
      requireUser: true,
      getUserFromToken: (token) =>
        token === "good-token" ? { id: "token-user" } : null,
    });
    const secureServer = Bun.serve({
      port: 0,
      fetch(req, srv) {
        return secureWs.upgrade(req, srv);
      },
      websocket: {
        open: secureWs.open as any,
        message: secureWs.message as any,
        close: secureWs.close as any,
      },
    });

    try {
      const ws = new WebSocket(`ws://localhost:${secureServer.port}`);
      await new Promise<void>((resolve) =>
        ws.addEventListener("open", () => resolve(), { once: true }),
      );
      const frames: any[] = [];
      ws.addEventListener("message", (ev) =>
        frames.push(JSON.parse(ev.data as string)),
      );
      const closed = new Promise<CloseEvent>((resolve) =>
        ws.addEventListener("close", (ev) => resolve(ev as CloseEvent), {
          once: true,
        }),
      );
      ws.send(JSON.stringify({ type: "auth", id: "a-1", token: "nope" }));

      const closeEvent = await closed;
      expect(closeEvent.code).toBe(1008);
      expect(frames).toContainEqual({
        type: "error",
        id: "a-1",
        message: "Unauthorized",
      });
    } finally {
      secureServer.stop(true);
    }
  });

  test("frames before authentication are refused per-id", async () => {
    const secureWs = vexWebSocket(vex, {
      requireUser: true,
      getUserFromToken: () => ({ id: "token-user" }),
    });
    const secureServer = Bun.serve({
      port: 0,
      fetch(req, srv) {
        return secureWs.upgrade(req, srv);
      },
      websocket: {
        open: secureWs.open as any,
        message: secureWs.message as any,
        close: secureWs.close as any,
      },
    });

    try {
      const ws = new WebSocket(`ws://localhost:${secureServer.port}`);
      await new Promise<void>((resolve) =>
        ws.addEventListener("open", () => resolve(), { once: true }),
      );
      const got = new Promise<any>((resolve) =>
        ws.addEventListener(
          "message",
          (ev) => resolve(JSON.parse(ev.data as string)),
          { once: true },
        ),
      );
      ws.send(JSON.stringify({ type: "query", id: "q-1", name: "items.list" }));
      expect(await got).toEqual({
        type: "error",
        id: "q-1",
        message: "Unauthorized",
      });
      ws.close();
    } finally {
      secureServer.stop(true);
    }
  });

  test("sockets that never authenticate are closed at the deadline", async () => {
    const secureWs = vexWebSocket(vex, {
      requireUser: true,
      getUserFromToken: () => ({ id: "token-user" }),
      authTimeoutMs: 100,
    });
    const secureServer = Bun.serve({
      port: 0,
      fetch(req, srv) {
        return secureWs.upgrade(req, srv);
      },
      websocket: {
        open: secureWs.open as any,
        message: secureWs.message as any,
        close: secureWs.close as any,
      },
    });

    try {
      const ws = new WebSocket(`ws://localhost:${secureServer.port}`);
      await new Promise<void>((resolve) =>
        ws.addEventListener("open", () => resolve(), { once: true }),
      );
      const closed = new Promise<CloseEvent>((resolve) =>
        ws.addEventListener("close", (ev) => resolve(ev as CloseEvent), {
          once: true,
        }),
      );
      const closeEvent = await closed;
      expect(closeEvent.code).toBe(1008);
    } finally {
      secureServer.stop(true);
    }
  });

  test("requireUser without getUserFromToken still rejects at upgrade", async () => {
    // The pre-existing contract: hosts that don't opt into first-frame
    // auth keep the hard upgrade-time boundary.
    const secureWs = vexWebSocket(vex, { requireUser: true });
    const secureServer = Bun.serve({
      port: 0,
      fetch(req, srv) {
        return secureWs.upgrade(req, srv);
      },
      websocket: {
        open: secureWs.open as any,
        message: secureWs.message as any,
        close: secureWs.close as any,
      },
    });

    try {
      const ws = new WebSocket(`ws://localhost:${secureServer.port}`);
      const event = await new Promise<"open" | "error" | "close">(
        (resolve) => {
          ws.addEventListener("open", () => resolve("open"), { once: true });
          ws.addEventListener("error", () => resolve("error"), { once: true });
          ws.addEventListener("close", () => resolve("close"), { once: true });
        },
      );
      expect(event).not.toBe("open");
    } finally {
      secureServer.stop(true);
    }
  });

  test("a cookie-authenticated upgrade needs no auth frame even when token auth is enabled", async () => {
    const secureWs = vexWebSocket(vex, {
      requireUser: true,
      getUser: (req) =>
        new URL(req.url).searchParams.get("token") === "ok"
          ? { id: "upgrade-user" }
          : null,
      getUserFromToken: () => null,
      authTimeoutMs: 100,
    });
    const secureServer = Bun.serve({
      port: 0,
      fetch(req, srv) {
        return secureWs.upgrade(req, srv);
      },
      websocket: {
        open: secureWs.open as any,
        message: secureWs.message as any,
        close: secureWs.close as any,
      },
    });

    try {
      const ws = new WebSocket(`ws://localhost:${secureServer.port}?token=ok`);
      await new Promise<void>((resolve) =>
        ws.addEventListener("open", () => resolve(), { once: true }),
      );
      // Outlive the deadline: an upgrade-authenticated socket must not
      // be reaped for never sending an auth frame.
      await Bun.sleep(200);
      const got = new Promise<any>((resolve) =>
        ws.addEventListener(
          "message",
          (ev) => resolve(JSON.parse(ev.data as string)),
          { once: true },
        ),
      );
      ws.send(
        JSON.stringify({ type: "query", id: "who", name: "items.viewer" }),
      );
      expect(await got).toEqual({
        type: "result",
        id: "who",
        data: "upgrade-user",
      });
      ws.close();
    } finally {
      secureServer.stop(true);
    }
  });

  test("VexClient with a token authenticates before replaying subscriptions", async () => {
    const { VexClient } = await import("../src/client/client.js");
    const secureWs = vexWebSocket(vex, {
      requireUser: true,
      getUserFromToken: (token) =>
        token === "client-token" ? { id: "client-user" } : null,
    });
    const secureServer = Bun.serve({
      port: 0,
      fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname === "/subscribe") return secureWs.upgrade(req, srv);
        return new Response("nope", { status: 404 });
      },
      websocket: {
        open: secureWs.open as any,
        message: secureWs.message as any,
        close: secureWs.close as any,
      },
    });

    const client = new VexClient({
      basePath: `http://localhost:${secureServer.port}`,
      token: "client-token",
    });
    try {
      const first = new Promise<unknown>((resolve) => {
        client.subscribe("items.list", {}, resolve);
      });
      expect(Array.isArray(await first)).toBe(true);
      expect(await client.query("items.viewer")).toBe("client-user");
    } finally {
      client.close();
      secureServer.stop(true);
    }
  });

  test("subscribe pushes initial data on connect", async () => {
    const client = await openClient();
    try {
      const got = collectData(client, "init-1", 1);
      client.send({ type: "subscribe", id: "init-1", name: "items.list" });
      const frames = await got;
      expect(frames.length).toBe(1);
      expect(Array.isArray(frames[0])).toBe(true);
    } finally {
      await client.close();
    }
  });

  test("subscribe pushes update after a mutation", async () => {
    const client = await openClient();
    try {
      const got = collectData(client, "push-1", 2);
      client.send({ type: "subscribe", id: "push-1", name: "items.list" });
      // Give the server a beat to register the subscription before
      // firing the mutation. Without this race the mutation can
      // commit before vex.subscribe() finishes binding the callback.
      await Bun.sleep(50);
      await fetch(`${base}/vex/mutate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "items.create",
          args: { name: "ws-push", value: 77 },
        }),
      });
      const frames = (await got) as Array<Array<{ name: string }>>;
      expect(frames.length).toBeGreaterThanOrEqual(2);
      const last = frames[frames.length - 1];
      expect(last.some((it) => it.name === "ws-push")).toBe(true);
    } finally {
      await client.close();
    }
  });

  test("subscribe with args filters the result", async () => {
    const client = await openClient();
    try {
      // Seed via HTTP mutate so we know the row exists when we
      // subscribe. Subscribing with args runs the query once on
      // connect with those args.
      await fetch(`${base}/vex/mutate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "items.create",
          args: { name: "filtered-row", value: 42 },
        }),
      });

      const got = collectData(client, "f-1", 1);
      client.send({
        type: "subscribe",
        id: "f-1",
        name: "items.byName",
        args: { name: "filtered-row" },
      });
      const frames = (await got) as Array<Array<{ name: string; value: any }>>;
      expect(frames[0].length).toBe(1);
      expect(frames[0][0].name).toBe("filtered-row");
      expect(Number(frames[0][0].value)).toBe(42);
    } finally {
      await client.close();
    }
  });

  test("two subscriptions on one connection get independent ids", async () => {
    const client = await openClient();
    try {
      await fetch(`${base}/vex/mutate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "items.create",
          args: { name: "iso-row", value: 9 },
        }),
      });

      const allP = collectData(client, "all", 1);
      const oneP = collectData(client, "one", 1);
      client.send({ type: "subscribe", id: "all", name: "items.list" });
      client.send({
        type: "subscribe",
        id: "one",
        name: "items.byName",
        args: { name: "iso-row" },
      });

      const [all, one] = (await Promise.all([allP, oneP])) as Array<
        Array<{ name: string }>[]
      >;
      expect(all[0].length).toBeGreaterThan(one[0].length);
      expect(one[0].length).toBe(1);
      expect(one[0][0].name).toBe("iso-row");
    } finally {
      await client.close();
    }
  });

  test("unsubscribe stops further updates for that id", async () => {
    const client = await openClient();
    try {
      const initial = collectData(client, "drop", 1);
      client.send({ type: "subscribe", id: "drop", name: "items.list" });
      await initial;

      const before = vex.activeSubscriptionCount();
      client.send({ type: "unsubscribe", id: "drop" });
      // The unsubscribe is fire-and-forget on the wire; give the
      // server a tick to detach from the engine before we measure.
      await Bun.sleep(50);
      expect(vex.activeSubscriptionCount()).toBe(before - 1);

      const frames: unknown[] = [];
      client.onData("drop", (d) => frames.push(d));
      await fetch(`${base}/vex/mutate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "items.create",
          args: { name: "after-unsub", value: 1 },
        }),
      });
      await Bun.sleep(100);
      expect(frames).toHaveLength(0);
    } finally {
      await client.close();
    }
  });

  test("query frame round-trips data", async () => {
    const client = await openClient();
    try {
      const got = client.expectResult("q-1");
      client.send({ type: "query", id: "q-1", name: "items.list" });
      const result = await got;
      expect(result.error).toBeUndefined();
      expect(Array.isArray(result.data)).toBe(true);
    } finally {
      await client.close();
    }
  });

  test("mutate frame round-trips data and triggers active subscriptions", async () => {
    const client = await openClient();
    try {
      // First subscribe so we can observe the push.
      const sub = collectData(client, "obs", 2);
      client.send({ type: "subscribe", id: "obs", name: "items.list" });
      await Bun.sleep(50);

      // Mutate over the same WS.
      const result = client.expectResult("m-1");
      client.send({
        type: "mutate",
        id: "m-1",
        name: "items.create",
        args: { name: "ws-mutate", value: 5 },
      });
      const r = await result;
      expect(r.error).toBeUndefined();
      expect(typeof r.data).toBe("string"); // returned _id

      const frames = (await sub) as Array<Array<{ name: string }>>;
      expect(
        frames[frames.length - 1].some((it) => it.name === "ws-mutate"),
      ).toBe(true);
    } finally {
      await client.close();
    }
  });

  test("unknown query name responds with an error frame", async () => {
    const client = await openClient();
    try {
      const got = client.expectResult("e-1");
      client.send({ type: "query", id: "e-1", name: "items.nope" });
      const r = await got;
      expect(r.error).toBeDefined();
      expect(r.data).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  test("subscribing twice with the same id rejects the second", async () => {
    const client = await openClient();
    try {
      const first = collectData(client, "dupe", 1);
      client.send({ type: "subscribe", id: "dupe", name: "items.list" });
      await first;

      const dupErr = client.expectResult("dupe");
      client.send({ type: "subscribe", id: "dupe", name: "items.list" });
      const err = await dupErr;
      expect(err.error).toMatch(/already active/);
    } finally {
      await client.close();
    }
  });

  test("malformed JSON is silently dropped (no orphan error)", async () => {
    const client = await openClient();
    try {
      // No id to address the error to — server logs and ignores.
      // We assert that the connection survives and a subsequent
      // valid frame still works.
      client.sendRaw("not json");
      await Bun.sleep(50);
      const got = client.expectResult("after-bad");
      client.send({ type: "query", id: "after-bad", name: "items.list" });
      const r = await got;
      expect(r.error).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  test("connection close detaches all subscriptions", async () => {
    const client = await openClient();
    const before = vex.activeSubscriptionCount();
    const a = collectData(client, "a", 1);
    const b = collectData(client, "b", 1);
    client.send({ type: "subscribe", id: "a", name: "items.list" });
    client.send({ type: "subscribe", id: "b", name: "items.list" });
    await Promise.all([a, b]);
    expect(vex.activeSubscriptionCount()).toBe(before + 2);

    await client.close();
    // Bun's close callback runs synchronously after the socket
    // close event, but we still give it one tick.
    await Bun.sleep(50);
    expect(vex.activeSubscriptionCount()).toBe(before);
  });

  test("HTTP GET to /vex/subscribe without upgrade returns 426", async () => {
    const res = await fetch(`${base}/vex/subscribe`);
    expect(res.status).toBe(426);
    const body = await res.text();
    expect(body).toContain("WebSocket upgrade required");
  });
});
