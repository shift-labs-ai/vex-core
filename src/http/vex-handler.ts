/**
 * vexHandler — the vex engine adapted as a Router.
 *
 * Exposes three routes relative to wherever it's mounted:
 *   POST /query      JSON body { name, args? } → { data } | { error }
 *   POST /mutate     JSON body { name, args? } → { data } | { error }
 *   ALL  /webhook/*  → vex.handleWebhook
 *
 * A call that throws an HttpError answers as it renders (its status,
 * headers and body: a refusal's 403 or 404 with its code); anything
 * else thrown is a 500 carrying its message.
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
 * `maxBodyBytes` is answered 413 before it is buffered, and no handler
 * runs. Webhooks share the ceiling unless `maxWebhookBodyBytes` gives
 * them their own. Behind `bodyParser`, the body it already read is
 * used as is.
 *
 * No CORS headers, no auth — those are separate middleware the caller
 * composes on top. This file is the dispatcher only.
 */

import type { Vex } from "../core/engine.js";
import type { VexUser } from "../core/types.js";
import { type ReadLimits, readText } from "./body.js";
import { errorMessage, isHttpError } from "./error.js";
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

  router.post(
    "/query",
    makeCallHandler(
      "query",
      (name, args, user) => vex.query(name, args, { user }),
      getUser,
      rpcLimits,
    ),
  );
  router.post(
    "/mutate",
    makeCallHandler(
      "mutation",
      (name, args, user) => vex.mutate(name, args, { user }),
      getUser,
      rpcLimits,
    ),
  );
  router.all("/webhook/*", makeWebhookHandler(vex, webhookLimits));

  return router;
}

// ─── handlers ────────────────────────────────────────────────────────

type Call = (
  name: string,
  args: Record<string, unknown>,
  user: VexUser | null | undefined,
) => Promise<unknown>;

/** `/query` or `/mutate`: a `{ name, args? }` body → `{ data }`. */
function makeCallHandler(
  kind: "query" | "mutation",
  call: Call,
  getUser: (ctx: RequestCtx) => VexUser | null | undefined,
  limits: ReadLimits,
): Handler {
  return async (ctx: RequestCtx): Promise<Response> => {
    const { name, args } = parseCall(await bodyText(ctx, limits));
    if (!name) return json({ error: `Missing ${kind} name` }, 400);
    try {
      return json({ data: await call(name, args, getUser(ctx)) });
    } catch (err: unknown) {
      return failure(err);
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

    const rawBody = await bodyText(ctx, limits);
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
      return failure(err);
    }
  };
}

// ─── helpers ─────────────────────────────────────────────────────────

/**
 * The request body as text, read once under `limits`. Behind
 * `bodyParser` the stream is already consumed, and its `rawBody` is
 * the body; a body consumed by anything else reads as empty.
 */
async function bodyText(ctx: RequestCtx, limits: ReadLimits): Promise<string> {
  if (!ctx.req.bodyUsed) return readText(ctx.req, limits);
  const raw = ctx.state.rawBody;
  return typeof raw === "string" ? raw : "";
}

/** A call's name and args; a body that is not a JSON object, or a
 *  name that is not a non-empty string, names nothing. `args` passes
 *  as sent: the engine validates it against the call's declaration. */
function parseCall(text: string): {
  name: string | null;
  args: Record<string, unknown>;
} {
  let body: { name?: unknown; args?: unknown } | null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  const name = body?.name;
  return {
    name: typeof name === "string" && name ? name : null,
    args: (body?.args ?? {}) as Record<string, unknown>,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** A thrown call: an HttpError as it renders, anything else a 500. */
function failure(err: unknown): Response {
  return isHttpError(err)
    ? err.toResponse()
    : json({ error: errorMessage(err) }, 500);
}
