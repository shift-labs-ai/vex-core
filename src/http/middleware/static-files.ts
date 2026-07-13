/**
 * staticFiles — serve files from a directory. Safe by default:
 *   - Path-traversal guard: resolved paths must stay inside `dir`.
 *   - Immutable caching for anything under `immutablePrefix`
 *     (`/assets/` by default, the conventional Vite/webpack output).
 *   - SPA fallback: for extension-less GET requests with a non-matching
 *     file, serve `index` instead so client-side routers work.
 *   - Content-Type inferred by extension, falls back to
 *     application/octet-stream.
 *
 * Uses Bun.file for zero-copy streaming when available, with a buffered
 * readFile fallback when the file API is unavailable.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { normalize, resolve } from "node:path";
import type { Middleware } from "../types.js";

export interface StaticFilesOptions {
  /** Directory to serve from. Required. */
  dir: string;
  /** File to serve at the root and on SPA fallback. Default "index.html". */
  index?: string;
  /**
   * When the request path has no extension and no file matches, serve
   * `index`. Defaults to true (SPA-friendly).
   */
  spaFallback?: boolean;
  /**
   * URL prefix under which files are considered immutable (hashed).
   * Default "/assets/". Set to null to disable.
   */
  immutablePrefix?: string | null;
}

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

/**
 * Feature-detect Bun's file API without forcing a dependency.
 * Bun.file streams directly from disk without buffering.
 */
declare const Bun:
  | { file(p: string): { exists(): Promise<boolean>; size: number } & object }
  | undefined;

export function staticFiles(options: StaticFilesOptions): Middleware {
  const root = resolve(options.dir);
  const index = options.index ?? "index.html";
  const spaFallback = options.spaFallback ?? true;
  const immutablePrefix =
    options.immutablePrefix === undefined
      ? "/assets/"
      : options.immutablePrefix;

  const rootExists = existsSync(root);
  if (!rootExists) {
    // Don't throw — the server might start before assets are built.
    console.warn(
      `[staticFiles] directory not found: ${root}. Static requests will fall through.`,
    );
  }

  return async (ctx, next) => {
    // Let explicit routes win first. The downstream chain may:
    //   - return a non-404 Response — canonical, pass through;
    //   - return a 404 Response — we try to serve a file;
    //   - throw HttpError.notFound() — treat the same as a 404;
    //   - throw anything else — rethrow, it's a real error.
    let downstream: Response;
    try {
      downstream = await next();
    } catch (err) {
      const isNotFound =
        typeof err === "object" &&
        err !== null &&
        (err as { status?: unknown }).status === 404;
      if (!isNotFound) throw err;
      downstream = new Response("Not Found", { status: 404 });
    }
    if (downstream.status !== 404) return downstream;
    if (ctx.req.method !== "GET" && ctx.req.method !== "HEAD")
      return downstream;
    if (!rootExists) return downstream;

    const pathname = ctx.url.pathname;
    const direct = await serve(pathname, ctx.req.method, root, immutablePrefix);
    if (direct) return direct;

    if (spaFallback && !pathname.includes(".")) {
      const fallback = await serve(
        `/${index}`,
        ctx.req.method,
        root,
        immutablePrefix,
      );
      if (fallback) return fallback;
    }

    return downstream;
  };
}

async function serve(
  pathname: string,
  method: string,
  root: string,
  immutablePrefix: string | null,
): Promise<Response | null> {
  const rel = normalize(pathname === "/" ? "/index.html" : pathname).replace(
    /^\/+/,
    "",
  );
  const abs = resolve(root, rel);
  if (!abs.startsWith(root)) return null; // traversal guard

  const bunFile = tryBunFile(abs);
  if (bunFile && (await bunFile.exists())) {
    const cacheControl = cacheFor(abs, root, immutablePrefix);
    if (method === "HEAD") {
      return new Response(null, {
        headers: {
          "content-type": contentType(abs),
          "cache-control": cacheControl,
          "content-length": String(bunFile.size),
        },
      });
    }
    return new Response(bunFile as unknown as BodyInit, {
      headers: {
        "content-type": contentType(abs),
        "cache-control": cacheControl,
      },
    });
  }

  if (!existsSync(abs)) return null;
  try {
    const buf = await readFile(abs);
    if (method === "HEAD") {
      return new Response(null, {
        headers: {
          "content-type": contentType(abs),
          "cache-control": cacheFor(abs, root, immutablePrefix),
          "content-length": String(buf.byteLength),
        },
      });
    }
    return new Response(buf, {
      headers: {
        "content-type": contentType(abs),
        "cache-control": cacheFor(abs, root, immutablePrefix),
      },
    });
  } catch {
    return null;
  }
}

function tryBunFile(
  path: string,
): ({ exists(): Promise<boolean>; size: number } & object) | null {
  if (typeof Bun === "undefined" || !Bun?.file) return null;
  return Bun.file(path);
}

function contentType(abs: string): string {
  const ext = abs.slice(abs.lastIndexOf("."));
  return MIME[ext] ?? "application/octet-stream";
}

function cacheFor(
  abs: string,
  root: string,
  immutablePrefix: string | null,
): string {
  if (!immutablePrefix) return "no-cache";
  const assetDir = resolve(root, `.${immutablePrefix}`);
  if (abs.startsWith(`${assetDir}/`) || abs.startsWith(assetDir)) {
    return "public, max-age=31536000, immutable";
  }
  return "no-cache";
}
