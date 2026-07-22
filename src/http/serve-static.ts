/**
 * serveDir / serveFile — explicit static-serving route handlers.
 *
 * These are namespace owners, not fallbacks. A router assigns each URL
 * namespace exactly one owner:
 *
 *   .get("/assets/*", serveDir({ dir, stripPrefix: "/assets" }))  // bytes or 404
 *   .get("/favicon.ico", serveFile(faviconPath))                  // one file
 *   .get("/*", serveFile(indexPath))                              // the SPA shell
 *
 * `serveDir` maps the request path to a file under `dir` and answers
 * with the file or a 404 — it never falls through to a later route, so
 * a missing asset can never leak an HTML shell into a <script> tag.
 *
 * `serveFile` always answers with one fixed file. Registered as the
 * terminal GET route it owns the document namespace: every client-routed
 * URL — dotted or not — gets the app shell, deterministically. No
 * Accept sniffing, no extension heuristics.
 *
 * Uses Bun.file for zero-copy streaming when available, with a buffered
 * readFile fallback when the file API is unavailable.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { normalize, resolve } from "node:path";
import type { Handler } from "./types.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

export interface ServeDirOptions {
  /** Directory that owns this namespace. Required. */
  dir: string;
  /**
   * Route prefix to strip from the request path before resolving under
   * `dir` (e.g. "/assets" for `.get("/assets/*", …)` over `dist/assets`).
   * Default: strip nothing.
   */
  stripPrefix?: string;
  /** Cache-Control for served files. Default "no-cache". */
  cacheControl?: string;
}

/**
 * Own an asset namespace: serve the file under `dir` matching the
 * request path, or answer 404. Never falls through.
 */
export function serveDir(options: ServeDirOptions): Handler {
  const root = resolve(options.dir);
  const stripPrefix = options.stripPrefix ?? "";
  const cacheControl = options.cacheControl ?? "no-cache";

  return async (ctx) => {
    const pathname = decodePathname(ctx.url.pathname);
    if (pathname === null) return notFound();
    // A namespace owner verifies its namespace — a pathname outside the
    // prefix is a routing misconfiguration, answered as 404 rather than
    // silently resolving a garbled path.
    if (stripPrefix && !pathname.startsWith(`${stripPrefix}/`)) {
      return notFound();
    }
    const rel = pathname.slice(stripPrefix.length);
    const abs = resolve(root, normalize(rel).replace(/^[/\\]+/, ""));
    if (abs !== root && !abs.startsWith(`${root}/`)) return notFound();
    return (await sendFile(abs, ctx.req.method, cacheControl)) ?? notFound();
  };
}

export interface ServeFileOptions {
  /** Cache-Control for the served file. Default "no-cache". */
  cacheControl?: string;
}

/**
 * Own a document namespace: always answer with one fixed file (the SPA
 * shell, a favicon, …). 404 only when the file itself is absent on disk.
 */
export function serveFile(
  path: string,
  options: ServeFileOptions = {},
): Handler {
  const abs = resolve(path);
  const cacheControl = options.cacheControl ?? "no-cache";

  return async (ctx) =>
    (await sendFile(abs, ctx.req.method, cacheControl)) ?? notFound();
}

// ─── internals ─────────────────────────────────────────────────────

function notFound(): Response {
  return new Response("Not Found", { status: 404 });
}

/** Percent-decode a pathname; malformed escapes read as "no such path". */
function decodePathname(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

/**
 * Feature-detect Bun's file API without forcing a dependency.
 * Bun.file streams directly from disk without buffering.
 */
declare const Bun:
  | { file(p: string): { exists(): Promise<boolean>; size: number } & object }
  | undefined;

async function sendFile(
  abs: string,
  method: string,
  cacheControl: string,
): Promise<Response | null> {
  const headers = {
    "content-type": contentType(abs),
    "cache-control": cacheControl,
  };

  const bunFile = typeof Bun !== "undefined" ? Bun?.file(abs) : null;
  if (bunFile && (await bunFile.exists())) {
    if (method === "HEAD") {
      return new Response(null, {
        headers: { ...headers, "content-length": String(bunFile.size) },
      });
    }
    return new Response(bunFile as unknown as BodyInit, { headers });
  }

  if (!existsSync(abs)) return null;
  try {
    const buf = await readFile(abs);
    if (method === "HEAD") {
      return new Response(null, {
        headers: { ...headers, "content-length": String(buf.byteLength) },
      });
    }
    return new Response(buf, { headers });
  } catch {
    return null;
  }
}

function contentType(abs: string): string {
  const ext = abs.slice(abs.lastIndexOf("."));
  return MIME[ext] ?? "application/octet-stream";
}
