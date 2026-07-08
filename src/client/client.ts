/**
 * VexClient — browser-side multiplex over the `/subscribe` WebSocket.
 *
 * Owns one connection for the lifetime of the app. Allocates an opaque
 * `id` per request, routes incoming `data` / `result` / `error` frames
 * back to the right callback. Exposes three primitives the hooks wrap:
 *
 *   subscribe(name, args, cb) → () => void   live query
 *   query(name, args) → Promise<T>           one-shot read
 *   mutate(name, args) → Promise<T>          one-shot write
 *
 * Lifecycle
 *   - Lazy connect: the WS opens on the first call. Until it's open,
 *     outgoing frames buffer in `pendingSends` and flush on `open`.
 *   - Reconnect with backoff: on unexpected close (anything other
 *     than a clean `client.close()`), schedule a retry with
 *     exponential backoff (100ms → 5s, ±25% jitter). Active
 *     subscriptions re-send their `subscribe` frames after the
 *     new connection opens, so the consumer doesn't have to know
 *     a reconnect happened — they just see a fresh `data` frame.
 *   - In-flight one-shots (query/mutate) waiting for a `result`
 *     when the socket dies are rejected with `connection lost`.
 *     The caller can retry; we don't auto-retry because mutations
 *     aren't necessarily idempotent.
 */

interface PendingResult<T = unknown> {
  resolve: (value: T) => void;
  reject: (err: Error) => void;
}

interface ActiveSubscription {
  id: string;
  name: string;
  args: Record<string, unknown>;
  callback: (data: unknown) => void;
  /**
   * Optional error sink. Called when the server emits an `error`
   * frame addressed to this subscription's id. The engine then
   * drops the subscription — no more `data` frames will arrive.
   */
  onError?: (err: Error) => void;
}

export interface VexClientOptions {
  /**
   * Mount path used for both HTTP RPC and WebSocket upgrade.
   * Defaults to `/vex`. Absolute URLs are honoured for cross-origin
   * deployments (e.g. `"https://api.example.com/vex"`).
   */
  basePath?: string;
  /**
   * Bearer credential for first-frame auth. Browsers cannot attach
   * an Authorization header to a WebSocket upgrade, so cross-origin
   * clients authenticate with an `auth` frame instead - sent first
   * on every (re)connect, before active subscriptions replay. A
   * function is resolved fresh per connect, so rotated credentials
   * are picked up on reconnect. Same-origin apps riding a session
   * cookie don't need this.
   */
  token?: string | (() => string | null);
  /**
   * Lower bound on reconnect backoff. Default 100ms.
   */
  minReconnectDelayMs?: number;
  /**
   * Upper bound on reconnect backoff. Default 5_000ms.
   */
  maxReconnectDelayMs?: number;
}

const SCHEME_HTTP = "http://";
const SCHEME_HTTPS = "https://";

export class VexClient {
  private readonly basePath: string;
  private readonly token: string | (() => string | null) | null;
  private readonly minDelay: number;
  private readonly maxDelay: number;
  private authId: string | null = null;

  private socket: WebSocket | null = null;
  private state: "idle" | "connecting" | "open" | "closed" = "idle";
  private nextId = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly subscriptions = new Map<string, ActiveSubscription>();
  private readonly pendingResults = new Map<string, PendingResult>();
  private readonly pendingSends: string[] = [];

  constructor(opts: VexClientOptions = {}) {
    this.basePath = opts.basePath ?? "/vex";
    this.token = opts.token ?? null;
    this.minDelay = opts.minReconnectDelayMs ?? 100;
    this.maxDelay = opts.maxReconnectDelayMs ?? 5_000;
  }

  /**
   * Subscribe to a live query. The callback fires once with the
   * initial result, then again on every change. Returns an unsubscribe
   * function — call it on cleanup.
   */
  subscribe<T = unknown>(
    name: string,
    args: Record<string, unknown>,
    callback: (data: T) => void,
    onError?: (err: Error) => void,
  ): () => void {
    const id = this.allocId("sub");
    const sub: ActiveSubscription = {
      id,
      name,
      args,
      callback: callback as (d: unknown) => void,
      onError,
    };
    this.subscriptions.set(id, sub);
    // Subscribe frames are NOT buffered through `pendingSends`.
    // The `open` handler iterates `subscriptions` and sends a
    // fresh subscribe frame for every active sub on connect (and
    // re-connect). If we also pushed to `pendingSends` here, the
    // open path would deliver each subscribe twice and the server
    // would reject the duplicate id. So: send immediately if the
    // socket is open, otherwise let `open` handle it.
    if (this.state === "open" && this.socket) {
      this.rawSend({ type: "subscribe", id, name, args });
    } else {
      this.ensureConnected();
    }
    return () => this.unsubscribe(id);
  }

  /** One-shot read. Resolves with the query result. */
  query<T = unknown>(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    return this.callOneShot<T>("query", name, args);
  }

  /** One-shot write. Resolves with the mutation result. */
  mutate<T = unknown>(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    return this.callOneShot<T>("mutate", name, args);
  }

  /**
   * Tear down the connection and reject all pending requests. Active
   * subscriptions are dropped silently — their callbacks just stop
   * firing. After close(), the client is dormant; calling subscribe
   * etc. on it again will reconnect.
   */
  close(): void {
    this.state = "closed";
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const pending of this.pendingResults.values()) {
      pending.reject(new Error("VexClient closed"));
    }
    this.pendingResults.clear();
    this.subscriptions.clear();
    this.pendingSends.length = 0;
    if (this.socket) {
      try {
        this.socket.close(1000, "client closed");
      } catch {
        /* already gone */
      }
      this.socket = null;
    }
    this.state = "idle";
  }

  // ─── Internals ──────────────────────────────────────────────────

  private allocId(prefix: string): string {
    this.nextId += 1;
    return `${prefix}-${this.nextId}`;
  }

  private callOneShot<T>(
    type: "query" | "mutate",
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.allocId(type);
      this.pendingResults.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.send({ type, id, name, args });
      this.ensureConnected();
    });
  }

  private unsubscribe(id: string): void {
    if (!this.subscriptions.has(id)) return;
    this.subscriptions.delete(id);
    // Best-effort: if the socket is open, tell the server. If it's
    // not, the server will drop the subscription on disconnect anyway,
    // so we don't need to queue an unsubscribe frame for later.
    if (this.state === "open") {
      this.send({ type: "unsubscribe", id });
    }
  }

  private ensureConnected(): void {
    if (this.state === "open" || this.state === "connecting") return;
    this.state = "connecting";
    this.openSocket();
  }

  private openSocket(): void {
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.wsUrl());
    } catch {
      // Synchronous failures (malformed URL, blocked by CSP) land
      // here; the close handler we'd normally rely on never fires
      // because we never opened. Schedule a retry directly.
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.state = "open";
      this.reconnectAttempt = 0;

      // Auth rides the first frame - before subscription replay and
      // the buffered-send flush, so the server never sees a guarded
      // frame from an unauthenticated socket. The server serializes
      // the in-flight auth against subsequent frames; we don't wait
      // for the result here.
      const token =
        typeof this.token === "function" ? this.token() : this.token;
      if (token) {
        this.authId = this.allocId("auth");
        this.rawSend({ type: "auth", id: this.authId, token });
      }

      // Re-send subscribe frames for every active subscription. The
      // server allocates fresh engine-side state; the client side
      // carries the same id so the existing callback wiring continues
      // to work without the consumer noticing the reconnect.
      for (const sub of this.subscriptions.values()) {
        this.rawSend({
          type: "subscribe",
          id: sub.id,
          name: sub.name,
          args: sub.args,
        });
      }
      // Flush whatever buffered up while we were connecting.
      while (this.pendingSends.length > 0) {
        const text = this.pendingSends.shift();
        if (text) socket.send(text);
      }
    });

    socket.addEventListener("message", (ev) => {
      this.handleFrame(ev.data);
    });

    socket.addEventListener("close", (ev) => {
      this.socket = null;
      // Any caller still waiting on a one-shot loses its transport.
      // We don't auto-retry — mutations aren't always idempotent
      // and the caller is in a better position to decide.
      for (const pending of this.pendingResults.values()) {
        pending.reject(new Error("connection lost"));
      }
      this.pendingResults.clear();

      if (this.state === "closed") return;
      // Code 1000 is a clean close from either side; if WE didn't
      // initiate it the server probably restarted, so reconnect.
      this.state = "idle";
      if (ev.code !== 1000) {
        this.scheduleReconnect();
      }
    });

    socket.addEventListener("error", () => {
      // The WebSocket spec doesn't surface useful detail on `error`;
      // the close event that follows is what actually matters. Don't
      // act here — let `close` drive the reconnect.
    });
  }

  private scheduleReconnect(): void {
    if (this.state === "closed") return;
    if (this.reconnectTimer) return;
    const base = Math.min(
      this.maxDelay,
      this.minDelay * 2 ** this.reconnectAttempt,
    );
    const jitter = base * (0.75 + Math.random() * 0.5);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // Only reconnect if there's still something to reconnect for.
      // A bare client with no subs and no pending one-shots can stay
      // dormant; new calls will trigger ensureConnected() again.
      if (
        this.subscriptions.size === 0 &&
        this.pendingResults.size === 0 &&
        this.pendingSends.length === 0
      ) {
        this.state = "idle";
        return;
      }
      this.state = "connecting";
      this.openSocket();
    }, jitter);
  }

  private handleFrame(raw: string | ArrayBuffer | Blob): void {
    if (typeof raw !== "string") return; // we only emit text frames
    let frame: { type: string; id: string; data?: unknown; message?: string };
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof frame.id !== "string") return;

    if (frame.type === "data") {
      const sub = this.subscriptions.get(frame.id);
      if (!sub) return;
      sub.callback(frame.data);
    } else if (frame.type === "result") {
      const pending = this.pendingResults.get(frame.id);
      if (!pending) return;
      this.pendingResults.delete(frame.id);
      pending.resolve(frame.data);
    } else if (frame.type === "error") {
      // A rejected auth frame is terminal: the server closes the
      // socket right after, and reconnecting with the same dead
      // credential would just loop. Tear down instead of retrying;
      // the app's auth layer owns recovery (re-login, re-pair).
      if (frame.id === this.authId) {
        console.error(
          `[vex-client] authentication rejected: ${frame.message ?? "Unauthorized"}`,
        );
        this.close();
        return;
      }
      // Errors target either a one-shot or a subscription. The id
      // disambiguates which side gets notified.
      const pending = this.pendingResults.get(frame.id);
      if (pending) {
        this.pendingResults.delete(frame.id);
        pending.reject(new Error(frame.message ?? "unknown error"));
        return;
      }
      const sub = this.subscriptions.get(frame.id);
      if (sub) {
        // The engine drops the subscription on its side after
        // emitting an error, so we mirror that locally and notify
        // the consumer's onError. We log too — a subscription
        // error usually points at a registration bug (unknown
        // query name, invalid args) the developer wants to see
        // even if the consumer didn't pass an onError.
        const err = new Error(frame.message ?? "subscription error");
        console.error(
          `[vex-client] subscription ${frame.id} (${sub.name}) errored:`,
          err.message,
        );
        this.subscriptions.delete(frame.id);
        sub.onError?.(err);
      }
    }
  }

  private send(frame: Record<string, unknown>): void {
    const text = JSON.stringify(frame);
    if (this.state === "open" && this.socket) {
      this.socket.send(text);
      return;
    }
    this.pendingSends.push(text);
  }

  private rawSend(frame: Record<string, unknown>): void {
    if (!this.socket) return;
    this.socket.send(JSON.stringify(frame));
  }

  private wsUrl(): string {
    if (this.basePath.startsWith(SCHEME_HTTP)) {
      return `ws://${this.basePath.slice(SCHEME_HTTP.length)}/subscribe`;
    }
    if (this.basePath.startsWith(SCHEME_HTTPS)) {
      return `wss://${this.basePath.slice(SCHEME_HTTPS.length)}/subscribe`;
    }
    // Relative basePath — derive scheme + host from `window`. The
    // hook is browser-only, so `window` is always defined by the
    // time we actually connect.
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}${this.basePath}/subscribe`;
  }
}
