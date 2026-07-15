/**
 * bearerAuth — single-token HTTP gate with cookie fallback.
 *
 * Accepts `Authorization: Bearer <token>` (API clients) or a
 * session cookie (browsers). Unauthenticated requests get redirected
 * to `/login` (HTML accept) or 401 JSON (API accept). A minimal
 * login form is served at `/login` — one field, submit, success
 * sets the cookie. Rate-limited by IP (default 5 failures per 60s).
 *
 * Intended for the common case of "one shared token, a handful of
 * people should see this dashboard." Not multi-user; not per-route
 * permissions. For richer auth, compose with `vex-core` route
 * permission helpers at the plugin/middleware layer instead.
 */

import { timingSafeEqual } from "node:crypto";
import { RateLimiter } from "../../core/rate-limit.js";
import type { Middleware } from "../types.js";

export interface BearerAuthOptions {
  /** The shared secret. Required. */
  token: string;
  /**
   * Name of the browser cookie that carries the token. Default
   * `vex_auth`.
   */
  cookieName?: string;
  /** Cookie TTL in seconds. Default 30 days. */
  maxAge?: number;
  /**
   * HTTP paths (and their trailing-slash variants) that bypass the
   * gate. Default: `["/login", "/logout", "/health", "/favicon.ico"]`.
   */
  publicPaths?: string[];
  /**
   * "Realm" string advertised in `WWW-Authenticate` on 401 JSON
   * responses. Default "vex".
   */
  realm?: string;
  /**
   * Brand string rendered at the top of the login page. Default
   * "vex".
   */
  brand?: string;
  /** Max failed login POSTs per IP per window. Default 5. */
  maxFailures?: number;
  /** Rate-limit window in seconds. Default 60. */
  failureWindowSeconds?: number;
}

const DEFAULT_PUBLIC_PATHS = ["/login", "/logout", "/health", "/favicon.ico"];

export function bearerAuth(options: BearerAuthOptions): Middleware {
  const cookieName = options.cookieName ?? "vex_auth";
  const maxAge = options.maxAge ?? 60 * 60 * 24 * 30;
  const publicPaths = options.publicPaths ?? DEFAULT_PUBLIC_PATHS;
  const realm = options.realm ?? "vex";
  const brand = options.brand ?? "vex";
  const token = options.token;
  if (!token) throw new Error("bearerAuth: token is required");

  const limiter = new RateLimiter({
    limit: {
      requests: options.maxFailures ?? 5,
      window: options.failureWindowSeconds ?? 60,
    },
    scope: "login",
  });

  return async (ctx, next): Promise<Response> => {
    const path = ctx.url.pathname;

    // Internal endpoints.
    if (path === "/login") {
      if (ctx.req.method === "POST") {
        return handleLogin(ctx, token, cookieName, maxAge, limiter);
      }
      return handleLoginPage(ctx, brand);
    }
    if (path === "/logout") {
      return handleLogout(ctx, cookieName);
    }

    // Public paths bypass the gate entirely.
    if (publicPaths.some((p) => path === p || path === `${p}/`)) {
      return next();
    }

    if (isAuthenticated(ctx.req, token, cookieName)) {
      return next();
    }

    // Unauthenticated. Browsers go to /login; API clients get 401 JSON.
    if (wantsHtml(ctx.req)) {
      const loc = new URL("/login", ctx.url).toString();
      return new Response(null, { status: 303, headers: { location: loc } });
    }
    return new Response(
      JSON.stringify({
        error: "unauthorized",
        detail: "Missing or invalid bearer token.",
      }),
      {
        status: 401,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "www-authenticate": `Bearer realm="${realm}"`,
        },
      },
    );
  };
}

// ─── auth primitives ─────────────────────────────────────────────────

function isAuthenticated(
  req: Request,
  token: string,
  cookieName: string,
): boolean {
  const bearer = extractBearer(req);
  if (bearer && constantTimeEq(bearer, token)) return true;
  const cookie = extractCookie(req, cookieName);
  if (cookie && constantTimeEq(cookie, token)) return true;
  return false;
}

function extractBearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (!h) return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function extractCookie(req: Request, name: string): string | null {
  const cookie = req.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function wantsHtml(req: Request): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const accept = req.headers.get("accept") ?? "";
  return accept.includes("text/html");
}

function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}

function isSecureRequest(req: Request, url: URL): boolean {
  const proto = req.headers.get("x-forwarded-proto");
  if (proto) return proto.toLowerCase() === "https";
  return url.protocol === "https:";
}

function buildCookie(
  name: string,
  value: string,
  maxAge: number,
  secure: boolean,
): string {
  const attrs = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

function clearCookie(name: string, secure: boolean): string {
  const attrs = [
    `${name}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

// ─── request handlers ────────────────────────────────────────────────

async function handleLogin(
  ctx: { req: Request; url: URL },
  token: string,
  cookieName: string,
  maxAge: number,
  limiter: RateLimiter,
): Promise<Response> {
  // Peek first: an IP that already burned its failure budget is
  // blocked before we even read the body. Successful logins never
  // consume budget — only failures do, below — so legitimate users
  // logging in repeatedly can't lock themselves out.
  const ip = clientIp(ctx.req);
  const blocked = limiter.peek(ip);
  if (!blocked.allowed) {
    return new Response(renderLoginPage("Too many attempts. Try again soon."), {
      status: 429,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "retry-after": String(blocked.retryAfter),
      },
    });
  }

  const submitted = await readSubmittedToken(ctx.req);
  if (!submitted || !constantTimeEq(submitted, token)) {
    limiter.tryConsume(ip);
    return new Response(renderLoginPage("Invalid token."), {
      status: 401,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  const secure = isSecureRequest(ctx.req, ctx.url);
  return new Response(null, {
    status: 303,
    headers: {
      location: "/",
      "set-cookie": buildCookie(cookieName, token, maxAge, secure),
    },
  });
}

function handleLogout(
  ctx: { req: Request; url: URL },
  cookieName: string,
): Response {
  const secure = isSecureRequest(ctx.req, ctx.url);
  return new Response(null, {
    status: 303,
    headers: {
      location: "/login",
      "set-cookie": clearCookie(cookieName, secure),
    },
  });
}

function handleLoginPage(_ctx: { url: URL }, brand: string): Response {
  return new Response(renderLoginPage("", brand), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function readSubmittedToken(req: Request): Promise<string | null> {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const body = await req.text();
    return new URLSearchParams(body).get("token");
  }
  if (contentType.includes("application/json")) {
    try {
      const body = (await req.json()) as { token?: string };
      return body?.token ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

// ─── login page ──────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderLoginPage(message = "", brand = "vex"): string {
  const msg = message ? `<p class="msg">${escapeHtml(message)}</p>` : "";
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(brand)} — sign in</title>
<style>
  :root { color-scheme: dark; }
  html,body { margin:0; background:#050a14; color:#e2e8f0;
    font-family: ui-monospace, "JetBrains Mono", monospace; }
  body { min-height:100vh; display:grid; place-items:center; padding:2rem; }
  .card { width: min(420px, 100%); padding: 2.5rem 2rem;
    border: 1px solid rgba(255,255,255,0.08); border-radius: 16px;
    background: rgba(255,255,255,0.02); }
  h1 { margin:0 0 1.5rem; font-size: 22px; letter-spacing: -0.02em; }
  h1 small { color:#7dd3fc; font-weight: 400; }
  label { display:block; margin-bottom: 0.4rem; font-size: 13px;
    text-transform: uppercase; letter-spacing: 0.2em; color:#94a3b8; }
  input { width:100%; padding: 0.8rem 1rem; font: inherit;
    background:#0a1220; color:#e2e8f0; border: 1px solid rgba(255,255,255,0.1);
    border-radius: 10px; outline: none; }
  input:focus { border-color:#38bdf8; }
  button { margin-top: 1rem; width:100%; padding: 0.8rem 1rem; font: inherit;
    color:#050a14; background:#7dd3fc; border: 0; border-radius: 10px;
    cursor: pointer; font-weight: 600; }
  button:hover { background:#bae6fd; }
  .msg { margin: 1rem 0 0; padding: 0.65rem 0.9rem; font-size: 14px;
    background: rgba(251,113,133,0.1); color: #fda4af;
    border: 1px solid rgba(251,113,133,0.25); border-radius: 8px; }
</style>
</head><body>
<form class="card" method="POST" action="/login">
  <h1>${escapeHtml(brand)} <small>→ sign in</small></h1>
  <label for="token">access token</label>
  <input id="token" name="token" type="password" autocomplete="off" autofocus required>
  <button type="submit">open dashboard</button>
  ${msg}
</form></body></html>`;
}
