/**
 * The transports ask of the engine only its calls (`VexCalls`), so
 * they serve what stands in front of one as they serve the engine:
 * here, something that answers a name the engine does not have as one
 * it has, in a shape of that name's own.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { sqliteAdapter } from "../../src/adapters/sqlite.js";
import { Vex } from "../../src/core/engine.js";
import type { VexCalls } from "../../src/core/types.js";
import { vexHandler, vexWebSocket } from "../../src/http/index.js";

let vex: Vex;
let server: Server;
/** Each call as the engine was asked it. */
const asked: string[] = [];

/** `items.all` is answered as `items.list`, shaped `{ items }`. */
const now = (name: string) => (name === "items.all" ? "items.list" : name);
const shaped = (name: string, rows: unknown) =>
  name === "items.all" ? { items: rows } : rows;

beforeAll(async () => {
  vex = await Vex.create({
    storage: sqliteAdapter(":memory:"),
    plugins: [
      {
        name: "items",
        tables: { items: { columns: { name: { type: "string" } } } },
        queries: {
          list: {
            args: {},
            handler: async (ctx) =>
              (await ctx.db.table("items").order("name").all()).map(
                (row) => row.name,
              ),
          },
        },
        mutations: {
          create: {
            args: { name: "string" },
            handler: (ctx, args) =>
              ctx.db.table("items").insert({ name: args.name }),
          },
        },
        actions: {
          count: {
            args: {},
            handler: async (ctx) => (await ctx.query("items.list")).length,
          },
        },
      },
    ],
  });
  vex.use((_ctx, info, next) => {
    asked.push(`${info.type} ${info.name}`);
    return next();
  });
  await vex.mutate("items.create", { name: "ant" });

  const inFront: VexCalls = {
    query: async (name, args, callCtx) =>
      shaped(name, await vex.query(now(name), args, callCtx)) as any,
    mutate: (name, args, callCtx) => vex.mutate(now(name), args, callCtx),
    action: (name, args, callCtx) => vex.action(now(name), args, callCtx),
    // A callback it leaves alone reaches the engine as the socket
    // made it.
    subscribe: (name, args, callback, callCtx) =>
      vex.subscribe(
        now(name),
        args,
        name === now(name) ? callback : (rows) => callback(shaped(name, rows)),
        callCtx,
      ),
  };
  const app = vexHandler({
    ...inFront,
    handleWebhook: (req) => vex.handleWebhook(req),
  });
  const socket = vexWebSocket(inFront);
  server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      return new URL(req.url).pathname === "/subscribe"
        ? socket.upgrade(req, srv)
        : app.handle(req);
    },
    websocket: {
      open: socket.open as any,
      message: socket.message as any,
      close: socket.close as any,
    },
  });
});

afterAll(async () => {
  server.stop(true);
  await vex.close();
});

async function post(path: string, body: unknown) {
  const res = await fetch(`http://localhost:${server.port}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** A socket, with every frame it has heard and a wait for the next. */
async function connect() {
  const ws = new WebSocket(`ws://localhost:${server.port}/subscribe`);
  const frames: any[] = [];
  let heard = () => {};
  ws.addEventListener("message", (event) => {
    frames.push(JSON.parse(event.data as string));
    heard();
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("no socket")), {
      once: true,
    });
  });
  return {
    frames,
    send: (frame: unknown) => ws.send(JSON.stringify(frame)),
    close: () => ws.close(),
    async until(done: () => boolean) {
      const deadline = Date.now() + 2000;
      while (!done()) {
        if (Date.now() > deadline) {
          throw new Error(`still waiting: ${JSON.stringify(frames)}`);
        }
        await new Promise<void>((resolve) => {
          heard = resolve;
          setTimeout(resolve, 50);
        });
      }
    },
  };
}

describe("what stands in front of the engine", () => {
  test("the dispatcher answers a call through it, and the engine is asked the call it has", async () => {
    asked.length = 0;
    expect(await post("/query", { name: "items.all" })).toEqual({
      status: 200,
      body: { data: { items: ["ant"] } },
    });
    expect(await post("/query", { name: "items.list" })).toEqual({
      status: 200,
      body: { data: ["ant"] },
    });
    expect(await post("/action", { name: "items.count" })).toMatchObject({
      body: { data: 1 },
    });
    expect(asked).toEqual([
      "query items.list",
      "query items.list",
      "action items.count",
      "query items.list",
    ]);
    // The engine itself has no such name.
    await expect(vex.query("items.all")).rejects.toThrow(
      "Query not found: items.all",
    );
  });

  test("a socket's calls and subscriptions go through it, each delivery in the shape it gives", async () => {
    const ws = await connect();
    try {
      ws.send({ type: "query", id: "q", name: "items.all" });
      ws.send({ type: "subscribe", id: "old", name: "items.all" });
      ws.send({ type: "subscribe", id: "new", name: "items.list" });
      const data = (id: string) =>
        ws.frames.filter((f) => f.id === id).map((f) => f.data);
      await ws.until(
        () => data("q").length + data("old").length + data("new").length === 3,
      );
      expect(ws.frames.find((f) => f.id === "q")).toMatchObject({
        type: "result",
        data: { items: ["ant"] },
      });

      // Both subscribe to one query: a write reaches each, shaped for
      // the name it came by.
      ws.send({
        type: "mutate",
        id: "m",
        name: "items.create",
        args: { name: "bee" },
      });
      await ws.until(
        () => data("old").length === 2 && data("new").length === 2,
      );
      expect(data("old")).toEqual([
        { items: ["ant"] },
        { items: ["ant", "bee"] },
      ]);
      expect(data("new")).toEqual([["ant"], ["ant", "bee"]]);
      expect(vex.describeSubscriptions()).toMatchObject({
        total: 2,
        unique: 1,
      });

      ws.send({ type: "unsubscribe", id: "old" });
      ws.send({ type: "unsubscribe", id: "new" });
      ws.send({ type: "ping", id: "p" });
      await ws.until(() => ws.frames.some((f) => f.id === "p"));
      expect(vex.activeSubscriptionCount()).toBe(0);
    } finally {
      ws.close();
    }
  });
});
