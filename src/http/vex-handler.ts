/**
 * vexHandler — the vex engine adapted as a Router.
 *
 * Exposes three routes relative to wherever it's mounted:
 *   POST /query      JSON body { name, args? } → { data } | { error }
 *   POST /mutate     JSON body { name, args? } → { data } | { error }
 *   ALL  /webhook/*  → vex.handleWebhook
 *
 * Reactive reads (the "live state" surface) are handled by
 * `vexWebSocket` over a WebSocket at whatever path the host wires
 * up — typically `/subscribe`. One connection per client multiplexes
 * many subscriptions plus one-shot query/mutate calls; see
 * `vex-websocket.ts` for the wire protocol.
 *
 * Why split HTTP and WS into two factories
 *   The Bun.serve API requires a `Server` reference to perform a
 *   WebSocket upgrade, and the Router abstraction here only sees
 *   `Request`. So vex-core ships HTTP one-shot RPC as a Router
 *   (mountable anywhere) and the live channel as a separate
 *   collection of `(upgrade, open, message, close)` hooks the host
 *   plumbs into Bun.serve directly.
 *
 * Bodies are read under a byte ceiling (body.ts): a request past
 * `maxBodyBytes` is answered 413 before it is buffered, never parsed
 * as `{}`. Webhooks share the ceiling unless `maxWebhookBodyBytes`
 * gives them their own.
 *
 * No CORS headers, no auth — those are separate middleware the caller
 * composes on top. This file is the dispatcher only.
 */

import type { Vex } from "../core/engine.js";
import type { VexUser } from "../core/types.js";
import { type ReadLimits, readText } from "./body.js";
import { createRouter, type Router } from "./router.js";
import type { Handler, RequestCtx } from "./types.js";

export interface VexHandlerOptions {
  /**
   * Read a VexUser off the ctx. Defaults to `ctx.user` — i.e. whatever
   * auth middleware put there. Override to pull from session, or to
   * ignore user attribution entirely by returning null.
   */
  getUser?: (ctx: RequestCtx) => VexUser | null | undefined;
  /**
   * The most bytes a `/query` or `/mutate` body may carry; a larger
   * one is refused 413 before it is buffered. Default 8 MiB.
   */
  maxBodyBytes?: number;
  /** The most bytes a `/webhook/*` body may carry. Defaults to
   *  `maxBodyBytes`. */
  maxWebhookBodyBytes?: number;
  /** How long reading a body may take before it is refused 408;
   *  none when absent. */
  bodyTimeoutMs?: number;
}

/** The default ceiling on a `/query`, `/mutate` or webhook body. */
export const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;

export function vexHandler(vex: Vex, opts: VexHandlerOptions = {}): Router {
  const getUser = opts.getUser ?? ((c: RequestCtx) => c.user ?? null);
  const rpcLimits: ReadLimits = {
    maxBytes: opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    timeoutMs: opts.bodyTimeoutMs,
  };
  const webhookLimits: ReadLimits = {
    maxBytes: opts.maxWebhookBodyBytes ?? rpcLimits.maxBytes,
    timeoutMs: opts.bodyTimeoutMs,
  };

  const router = createRouter();

  router.post("/query", makeQueryHandler(vex, getUser, rpcLimits));
  router.post("/mutate", makeMutateHandler(vex, getUser, rpcLimits));
  router.all("/webhook/*", makeWebhookHandler(vex, webhookLimits));

  return router;
}

// ─── handlers ────────────────────────────────────────────────────────

function makeQueryHandler(
  vex: Vex,
  getUser: (ctx: RequestCtx) => VexUser | null | undefined,
  limits: ReadLimits,
): Handler {
  return async (ctx: RequestCtx): Promise<Response> => {
    const body = await readRpcBody(ctx, limits);
    if (!body.name) {
      return json({ error: "Missing query name" }, 400);
    }
    try {
      const data = await vex.query(body.name, body.args ?? {}, {
        user: getUser(ctx),
      });
      return json({ data });
    } catch (err: unknown) {
      return json({ error: errorMessage(err) }, 500);
    }
  };
}

function makeMutateHandler(
  vex: Vex,
  getUser: (ctx: RequestCtx) => VexUser | null | undefined,
  limits: ReadLimits,
): Handler {
  return async (ctx: RequestCtx): Promise<Response> => {
    const body = await readRpcBody(ctx, limits);
    if (!body.name) {
      return json({ error: "Missing mutation name" }, 400);
    }
    try {
      const data = await vex.mutate(body.name, body.args ?? {}, {
        user: getUser(ctx),
      });
      return json({ data });
    } catch (err: unknown) {
      return json({ error: errorMessage(err) }, 500);
    }
  };
}

function makeWebhookHandler(vex: Vex, limits: ReadLimits): Handler {
  return async (ctx: RequestCtx): Promise<Response> => {
    // URLPattern's `*` capture for `/webhook/*` lands in params["0"].
    // The leading slash is not captured, so prepend one; an empty
    // capture (the bare `/webhook` case) maps to "/".
    const captured = ctx.params["0"] ?? "";
    const webhookPath = captured ? `/${captured}` : "/";

    const rawBody = await readText(ctx.req, limits);
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      body = rawBody;
    }

    const query: Record<string, string> = {};
    ctx.url.searchParams.forEach((v, k) => {
      query[k] = v;
    });

    const headers: Record<string, string> = {};
    ctx.req.headers.forEach((v, k) => {
      headers[k] = v;
    });

    try {
      const result = await vex.handleWebhook({
        body,
        rawBody,
        headers,
        method: ctx.req.method,
        path: webhookPath,
        query,
      });

      const status = result.status ?? 200;
      if (result.headers) {
        const respBody =
          typeof result.body === "string"
            ? result.body
            : JSON.stringify(result.body ?? null);
        return new Response(respBody, {
          status,
          headers: result.headers,
        });
      }
      return json(result.body ?? null, status);
    } catch (err: unknown) {
      return json({ error: errorMessage(err) }, 500);
    }
  };
}

// ─── helpers ─────────────────────────────────────────────────────────

/**
 * The `{ name, args? }` body of a /query or /mutate call; `{}` when it
 * is empty or does not parse, so the handler answers "Missing … name".
 * A body past the ceiling throws the 413 HttpError instead. When
 * `bodyParser` already read the body, its `rawBody` is parsed rather
 * than re-reading a consumed stream.
 */
async function readRpcBody(ctx: RequestCtx, limits: ReadLimits): Promise<any> {
  let text: string;
  if (ctx.req.bodyUsed) {
    const raw = ctx.state.rawBody;
    if (typeof raw !== "string") return {};
    text = raw;
  } else {
    text = await readText(ctx.req, limits);
  }
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
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
