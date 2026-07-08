/**
 * vexWebSocket — multiplexed live channel for vex.
 *
 * Replaces the old SSE-based `/subscribe` (one connection per query)
 * and `/events` (blanket invalidation, force a refetch) with a single
 * WebSocket per client that carries every reactive read and (optionally)
 * one-shot RPC. The engine's `vex.subscribe()` machinery does the
 * actual work — table-precise re-runs, hash-deduped pushes — and this
 * module just frames it onto a wire protocol.
 *
 * Why one connection
 *   - HTTP/1.1 caps origins at ~6 simultaneous connections, which made
 *     per-query SSE impractical for SPAs with more than a handful of
 *     live queries. Even on HTTP/2 the per-subscription server cost
 *     (one ReadableStream + one engine subscriber + table tracking)
 *     adds up; multiplexing is just cheaper.
 *   - Server pushes precise data on each change. No "ping → refetch"
 *     dance, no client-side debounce, no stale-state windows.
 *
 * Wire protocol — all messages are JSON objects, one per ws.send().
 *
 *   Client → Server
 *     { type: "auth",        id, token }         first-frame bearer auth
 *     { type: "subscribe",   id, name, args? }   start a live query
 *     { type: "unsubscribe", id }                stop one
 *     { type: "query",       id, name, args? }   one-shot read
 *     { type: "mutate",      id, name, args? }   one-shot write
 *
 *   Server → Client
 *     { type: "data",   id, data }     subscribe initial + each update
 *     { type: "result", id, data }     query/mutate + auth completion
 *     { type: "error",  id, message }  per-id failure
 *
 * `id` is client-assigned and opaque to the server; the server only
 * uses it to route responses back to the right caller. Subscription
 * ids must be stable for the life of the subscription; query/mutate
 * ids are one-shot.
 *
 * Auth
 *   Two ways in, one resolution contract:
 *
 *   - Upgrade-time: the user is resolved from the upgrade request
 *     (cookies, bearer header - whatever `getUser` does) and pinned
 *     to the connection. This is the whole story for same-origin
 *     clients, whose browser attaches the session cookie.
 *   - First-frame bearer: browsers cannot attach an Authorization
 *     header to a WebSocket upgrade, and cross-origin surfaces
 *     (browser extensions, remote SPAs) don't get their cookie
 *     attached either. When the host provides `getUserFromToken`,
 *     an unauthenticated socket is admitted but refused service
 *     until its first `auth` frame resolves to a user; sockets
 *     that never authenticate are closed at `authTimeoutMs`.
 *
 *   Either way the user is pinned to the connection and every
 *   dispatched call inherits it. No per-message re-auth; if you
 *   want that, use HTTP RPC.
 *
 * Bun integration
 *   `vexWebSocket()` returns the four hooks Bun.serve needs:
 *   `upgrade(req, server)` for the fetch handler, plus
 *   `open` / `message` / `close` for the `websocket` config. The
 *   host wires them together — vex-core has no opinion about how
 *   you compose your server otherwise.
 */

import type { Server as BunServer, ServerWebSocket } from "bun";
import type { Vex } from "../core/engine.js";
import type { VexUser } from "../core/types.js";

// Bun's `Server` is generic over the websocket payload shape; we
// don't attach data on the server-handle side (everything we care
// about lives on the upgraded `ServerWebSocket`), so pin the
// generic to `unknown` for the upgrade entrypoint.
type Server = BunServer<unknown>;

/**
 * Per-connection state Bun pins to `ws.data`. Exported because it
 * appears in the public `VexWebSocketHandlers` shape — hosts that
 * declare `Bun.serve({ websocket })` with an explicit return type
 * need to be able to name it.
 */
export interface VexWebSocketConnectionState {
  user: VexUser | null;
  /** id → unsubscribe(). Drained on close. */
  subs: Map<string, () => void>;
  /**
   * In-flight `auth` frame resolution. Clients send auth as their
   * first frame but don't wait for the result before subscribing,
   * so guarded frames await this instead of racing it.
   */
  pendingAuth: Promise<void> | null;
  /** Deadline for sockets admitted unauthenticated. */
  authTimer: ReturnType<typeof setTimeout> | null;
}

/** Convenience alias for the typed `ServerWebSocket` Bun hands us. */
export type VexWebSocketConnection =
  ServerWebSocket<VexWebSocketConnectionState>;

// Internal short alias — keeps the implementation readable without
// repeating the long type name on every helper signature.
type VexWebSocket = VexWebSocketConnection;
type ConnectionState = VexWebSocketConnectionState;

export interface VexWebSocketOptions {
  /**
   * Resolve the user from the upgrade request. Default: try
   * `getUser(ctx)` if provided, else null. Called once per
   * connection at upgrade time; the result is pinned to the
   * connection until it closes.
   */
  getUser?: (
    req: Request,
  ) => VexUser | null | undefined | Promise<VexUser | null | undefined>;
  /**
   * Reject upgrades when `getUser` resolves to null. Hosts with an auth
   * boundary should enable this so WebSocket RPC follows the same
   * authenticated-user contract as HTTP RPC. Anonymous/local-dev servers can
   * leave it false or return a synthetic user from `getUser`.
   */
  requireUser?: boolean;
  /**
   * Resolve a bearer credential from an `auth` frame. Providing this
   * enables first-frame auth: with `requireUser`, sockets that fail
   * upgrade-time resolution are admitted unauthenticated instead of
   * rejected, and must authenticate before anything else is served.
   * Feed it the same resolution HTTP uses (e.g. wrap the token in a
   * synthetic `Authorization: Bearer` request) so every transport
   * accepts the same credentials.
   */
  getUserFromToken?: (
    token: string,
  ) => VexUser | null | undefined | Promise<VexUser | null | undefined>;
  /**
   * How long an unauthenticated socket may live before it is closed
   * (code 1008). Only applies when `requireUser` and `getUserFromToken`
   * are set and the upgrade did not authenticate. Default 10s.
   */
  authTimeoutMs?: number;
}

export interface VexWebSocketHandlers {
  /**
   * Try to upgrade the request to a WebSocket. Returns a Response
   * (typically 101 from Bun, or a 4xx if auth/upgrade fails) you
   * should return from your fetch handler. If the request isn't
   * actually a WebSocket upgrade, returns a 426.
   */
  upgrade(req: Request, server: Server): Response | Promise<Response>;
  open(ws: VexWebSocket): void;
  message(ws: VexWebSocket, raw: string | Buffer): void;
  close(ws: VexWebSocket): void;
}

const AUTH_TIMEOUT_DEFAULT_MS = 10_000;
const POLICY_VIOLATION_CLOSE_CODE = 1008;

export function vexWebSocket(
  vex: Vex,
  opts: VexWebSocketOptions = {},
): VexWebSocketHandlers {
  const getUser = opts.getUser ?? (() => null);
  const requireUser = opts.requireUser ?? false;
  const getUserFromToken = opts.getUserFromToken ?? null;
  const authTimeoutMs = opts.authTimeoutMs ?? AUTH_TIMEOUT_DEFAULT_MS;

  async function handleAuth(
    ws: VexWebSocket,
    frame: { id: string; token: string },
  ): Promise<void> {
    if (!getUserFromToken) {
      sendError(ws, frame.id, "Token auth is not enabled");
      return;
    }
    let user: VexUser | null = null;
    try {
      user = (await getUserFromToken(frame.token)) ?? null;
    } catch (err) {
      console.error("[vex-ws] getUserFromToken failed:", err);
    }
    if (!user) {
      // A bad credential is terminal for the connection: answering
      // the frame lets the client distinguish "rejected" from a
      // network drop, and the close stops it from streaming further
      // frames into an unauthenticated socket.
      sendError(ws, frame.id, "Unauthorized");
      ws.close(POLICY_VIOLATION_CLOSE_CODE, "authentication failed");
      return;
    }
    ws.data.user = user;
    if (ws.data.authTimer) {
      clearTimeout(ws.data.authTimer);
      ws.data.authTimer = null;
    }
    sendResult(ws, frame.id, { ok: true });
  }

  async function guardedDispatch(
    ws: VexWebSocket,
    frame: ClientFrame,
  ): Promise<void> {
    if (frame.type === "auth") {
      const pending = handleAuth(ws, frame);
      ws.data.pendingAuth = pending.then(() => {
        ws.data.pendingAuth = null;
      });
      return pending;
    }
    // Clients send auth first but don't wait for its result before
    // flushing subscribes - let an in-flight auth settle before
    // deciding this frame is unauthorized.
    if (ws.data.pendingAuth) await ws.data.pendingAuth;
    if (requireUser && !ws.data.user) {
      sendError(ws, frame.id, "Unauthorized");
      return;
    }
    return dispatch(vex, ws, frame);
  }

  return {
    async upgrade(req, server) {
      // Resolve auth before consuming the upgrade; once Bun upgrades
      // the request, the body is no longer available and we can't
      // return a clean 401.
      const user = (await getUser(req)) ?? null;
      if (requireUser && !user && !getUserFromToken) {
        return new Response("Unauthorized", {
          status: 401,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }

      const data: ConnectionState = {
        user,
        subs: new Map(),
        pendingAuth: null,
        authTimer: null,
      };

      const ok = server.upgrade(req, { data });
      if (ok) {
        // server.upgrade() returns true and Bun owns the response
        // from here. We must not return a Response — Bun's fetch
        // contract wants `undefined` in that case, but the typed
        // signature is `Response | Promise<Response>`. Returning a
        // dummy Response is the convention; Bun ignores it when
        // upgrade succeeded.
        return new Response(null, { status: 101 });
      }

      return new Response("WebSocket upgrade required", {
        status: 426,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    },

    open(ws) {
      // Sockets admitted without upgrade-time auth get a deadline:
      // authenticate via an `auth` frame or be closed. Without this,
      // idle unauthenticated connections would pile up for free.
      if (requireUser && !ws.data.user) {
        ws.data.authTimer = setTimeout(() => {
          ws.data.authTimer = null;
          if (!ws.data.user) {
            ws.close(POLICY_VIOLATION_CLOSE_CODE, "authentication timeout");
          }
        }, authTimeoutMs);
      }
    },

    message(ws, raw) {
      const text = typeof raw === "string" ? raw : raw.toString("utf-8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        // No `id` to address the error to — log and drop. Sending an
        // unaddressed error frame would confuse the client's id-based
        // dispatch.
        console.warn("[vex-ws] invalid JSON frame ignored");
        return;
      }
      const frame = parseFrame(parsed);
      if (!frame) return;
      void guardedDispatch(ws, frame);
    },

    close(ws) {
      if (ws.data.authTimer) {
        clearTimeout(ws.data.authTimer);
        ws.data.authTimer = null;
      }
      // Drain all subscriptions for this connection. Each entry
      // is a `vex.subscribe()` unsubscribe function; calling it
      // removes the engine-side subscription and stops further
      // re-runs from queueing.
      for (const off of ws.data.subs.values()) {
        try {
          off();
        } catch (err) {
          console.error("[vex-ws] unsubscribe on close failed:", err);
        }
      }
      ws.data.subs.clear();
    },
  };
}

// ─── Frame types ────────────────────────────────────────────────────

type ClientFrame =
  | { type: "auth"; id: string; token: string }
  | {
      type: "subscribe";
      id: string;
      name: string;
      args?: Record<string, unknown>;
    }
  | { type: "unsubscribe"; id: string }
  | { type: "query"; id: string; name: string; args?: Record<string, unknown> }
  | {
      type: "mutate";
      id: string;
      name: string;
      args?: Record<string, unknown>;
    };

/**
 * Validate-at-parse: anything that doesn't match a known frame shape
 * is dropped at the message boundary, so `dispatch` only ever sees a
 * tagged union TypeScript can narrow without casts. Drops with no
 * response: an unaddressed error frame would confuse the client.
 */
function parseFrame(value: unknown): ClientFrame | null {
  if (!value || typeof value !== "object") {
    console.warn("[vex-ws] non-object frame ignored");
    return null;
  }
  const f = value as Record<string, unknown>;
  if (typeof f.id !== "string") {
    console.warn("[vex-ws] frame missing string `id`; ignored");
    return null;
  }
  const id = f.id;
  const args =
    f.args && typeof f.args === "object"
      ? (f.args as Record<string, unknown>)
      : undefined;
  switch (f.type) {
    case "subscribe":
    case "query":
    case "mutate":
      if (typeof f.name !== "string") {
        console.warn(
          `[vex-ws] ${f.type} frame missing string \`name\`; ignored`,
        );
        return null;
      }
      return { type: f.type, id, name: f.name, args };
    case "unsubscribe":
      return { type: "unsubscribe", id };
    case "auth":
      if (typeof f.token !== "string") {
        console.warn("[vex-ws] auth frame missing string `token`; ignored");
        return null;
      }
      return { type: "auth", id, token: f.token };
    default:
      console.warn(`[vex-ws] unknown frame type: ${String(f.type)}; ignored`);
      return null;
  }
}

// ─── Dispatch ─────────────────────────────────────────────

async function dispatch(
  vex: Vex,
  ws: VexWebSocket,
  frame: ClientFrame,
): Promise<void> {
  // Exhaustiveness: `parseFrame` filters unknown shapes at the
  // message boundary, so the union is guaranteed closed here.
  // TS will surface a never-narrowing error if a new variant is
  // ever added to `ClientFrame` and forgotten in this switch.
  // (`auth` never reaches dispatch - `guardedDispatch` owns it.)
  switch (frame.type) {
    case "auth":
      return;
    case "subscribe":
      return handleSubscribe(vex, ws, frame);
    case "unsubscribe":
      return handleUnsubscribe(ws, frame);
    case "query":
      return handleQuery(vex, ws, frame);
    case "mutate":
      return handleMutate(vex, ws, frame);
  }
}

async function handleSubscribe(
  vex: Vex,
  ws: VexWebSocket,
  frame: { id: string; name: string; args?: Record<string, unknown> },
): Promise<void> {
  // Reject double-subscribe on the same id rather than silently
  // overwriting — a subscription leak is the kind of bug you want
  // surfaced loudly.
  if (ws.data.subs.has(frame.id)) {
    sendError(ws, frame.id, `Subscription id already active: ${frame.id}`);
    return;
  }

  // Bun delivers messages serially per connection, but our message
  // handler returns synchronously after kicking off `dispatch` — so
  // the second message arrives while the first's `await
  // vex.subscribe()` is still resolving. Reserving the id with a
  // placeholder up front lets the duplicate-id guard above fire
  // on the second frame, and lets the close handler see *something*
  // to drain if the socket dies mid-subscribe.
  const placeholder = () => {};
  ws.data.subs.set(frame.id, placeholder);

  let unsubscribe: (() => void) | null = null;
  try {
    unsubscribe = await vex.subscribe(
      frame.name,
      frame.args ?? {},
      (data) => {
        sendData(ws, frame.id, data);
      },
      ws.data.user ? { user: ws.data.user } : undefined,
    );
  } catch (err) {
    ws.data.subs.delete(frame.id);
    sendError(ws, frame.id, errorMessage(err));
    return;
  }

  // If the connection closed while we were registering, the close
  // handler already drained `subs`; clean up the engine-side
  // subscription that just landed.
  if (!ws.data.subs.has(frame.id)) {
    unsubscribe();
    return;
  }
  ws.data.subs.set(frame.id, unsubscribe);
}

function handleUnsubscribe(ws: VexWebSocket, frame: { id: string }): void {
  const off = ws.data.subs.get(frame.id);
  if (!off) return;
  ws.data.subs.delete(frame.id);
  try {
    off();
  } catch (err) {
    console.error(`[vex-ws] unsubscribe(${frame.id}) failed:`, err);
  }
}

async function handleQuery(
  vex: Vex,
  ws: VexWebSocket,
  frame: { id: string; name: string; args?: Record<string, unknown> },
): Promise<void> {
  try {
    const data = await vex.query(
      frame.name,
      frame.args ?? {},
      ws.data.user ? { user: ws.data.user } : undefined,
    );
    sendResult(ws, frame.id, data);
  } catch (err) {
    sendError(ws, frame.id, errorMessage(err));
  }
}

async function handleMutate(
  vex: Vex,
  ws: VexWebSocket,
  frame: { id: string; name: string; args?: Record<string, unknown> },
): Promise<void> {
  try {
    const data = await vex.mutate(
      frame.name,
      frame.args ?? {},
      ws.data.user ? { user: ws.data.user } : undefined,
    );
    sendResult(ws, frame.id, data);
  } catch (err) {
    sendError(ws, frame.id, errorMessage(err));
  }
}

// ─── Wire helpers ───────────────────────────────────────────────────

function send(ws: VexWebSocket, frame: Record<string, unknown>): void {
  // ws.send returns the number of bytes written or -1 if backpressured.
  // We don't queue or retry on backpressure — slow clients will lose
  // messages. The engine's per-query result hash means a missed
  // intermediate frame is recovered on the next push (final state is
  // eventually consistent), and queries/mutations have at-most-once
  // semantics anyway.
  try {
    ws.send(JSON.stringify(frame));
  } catch (err) {
    console.error("[vex-ws] send failed:", err);
  }
}

function sendData(ws: VexWebSocket, id: string, data: unknown): void {
  send(ws, { type: "data", id, data });
}

function sendResult(ws: VexWebSocket, id: string, data: unknown): void {
  send(ws, { type: "result", id, data });
}

function sendError(ws: VexWebSocket, id: string, message: string): void {
  send(ws, { type: "error", id, message });
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
