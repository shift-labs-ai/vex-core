/**
 * Sessions middleware — server-side session store backed by any
 * `StorageAdapter` (SQLite or a custom one). The session id
 * lives in an HTTP-only cookie; session data lives in a row.
 *
 * Design
 *   - One row per session in the configured table (default
 *     `vex_sessions`). Columns: id (text pk), data (JSON blob),
 *     createdAt, expiresAt, rolledAt.
 *   - The cookie value is the session id (random, 32 bytes). The
 *     server-side row is the source of truth.
 *   - `ctx.session.get/set/delete` mutate an in-memory copy of the
 *     row's `data`. The middleware writes the copy back at the end
 *     of the request if it was touched, so N gets/sets within one
 *     request cost one DB write.
 *   - Idle timeout: every request rolls `expiresAt` forward by
 *     `maxAge` seconds (sliding expiration). Zero-read requests
 *     don't roll — pure-read endpoints don't keep sessions alive
 *     unless you mark them by touching session.data.
 *   - On request, expired sessions are deleted and treated as if
 *     no session existed.
 *
 * Not a replacement for
 *   - Signed/JWT cookies (zero DB round-trip; use those if you
 *     don't need server-side invalidation).
 *   - Distributed session stores (Redis etc.); this ships against
 *     whatever adapter vex-core's engine uses, which is fine for
 *     single-instance deployments.
 */

import { randomBytes } from "node:crypto";
import type { StorageAdapter } from "../../core/storage.js";
import { withHeaders } from "../response.js";
import type { Middleware, Session } from "../types.js";

export interface SessionOptions {
  /**
   * Storage adapter to persist sessions in. Typically the same one
   * your Vex instance uses. Passing a dedicated adapter is fine too
   * (e.g. a separate SQLite file).
   */
  storage: StorageAdapter;
  /** Cookie name. Default `vex_session`. */
  cookieName?: string;
  /** Session TTL in seconds. Default 7 days. */
  maxAge?: number;
  /** Table name in the storage adapter. Default `vex_sessions`. */
  table?: string;
  /**
   * When true, only issue `Secure` cookies (require HTTPS). Default
   * is to auto-detect via `X-Forwarded-Proto`, which works for
   * proxies (Render, Cloudflare) and localhost.
   */
  secure?: boolean | "auto";
  /** SameSite attribute. Default "Lax" (good enough for dashboards). */
  sameSite?: "Strict" | "Lax" | "None";
  /**
   * When true, every authenticated request rolls the expiry forward.
   * Default true (sliding). Set false for fixed-window sessions.
   */
  rolling?: boolean;
}

/**
 * Shape of a persisted session row. `data` is declared as `json` in
 * the table schema, which means the storage adapter may hand it back
 * to us already parsed (SQLite adapters auto-parse `json`
 * columns). We accept either and normalize in `readData` below.
 */
interface SessionRow {
  _id: string;
  id: string;
  data: string | Record<string, unknown> | null;
  createdAt: number;
  expiresAt: number;
  rolledAt: number;
}

function readData(raw: SessionRow["data"]): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === "object") return { ...(raw as Record<string, unknown>) };
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const DEFAULT_MAX_AGE = 60 * 60 * 24 * 7;

export function sessions(options: SessionOptions): Middleware {
  const cookieName = options.cookieName ?? "vex_session";
  const maxAge = options.maxAge ?? DEFAULT_MAX_AGE;
  const table = options.table ?? "vex_sessions";
  const secureOpt = options.secure ?? "auto";
  const sameSite = options.sameSite ?? "Lax";
  const rolling = options.rolling ?? true;
  const storage = options.storage;

  // Table bootstrap. Idempotent — ensureTable is a CREATE IF NOT EXISTS.
  const ensured = storage.ensureTable(table, {
    columns: {
      id: { type: "string", index: true },
      data: { type: "json" },
      createdAt: { type: "number" },
      expiresAt: { type: "number", index: true },
      rolledAt: { type: "number" },
    },
    unique: [["id"]],
  });
  // ensureTable may be sync or async — swallow here; first request
  // will see the table regardless.
  if (ensured && typeof (ensured as Promise<unknown>).then === "function") {
    (ensured as Promise<unknown>).catch((err) => {
      console.error(`[sessions] ensureTable failed: ${String(err)}`);
    });
  }

  return async (ctx, next) => {
    const inbound = extractCookie(ctx.req, cookieName);
    const now = Date.now();

    let row: SessionRow | null = null;
    if (inbound) row = await loadSession(storage, table, inbound, now);

    let data: Record<string, unknown> = row ? readData(row.data) : {};
    const originalData = JSON.stringify(data);
    let id = row?.id ?? "";
    let destroyed = false;

    const session: Session = {
      get id() {
        return id;
      },
      get data() {
        return data;
      },
      get<T = unknown>(key: string): T | undefined {
        return data[key] as T | undefined;
      },
      set(key: string, value: unknown): void {
        data[key] = value;
      },
      delete(key: string): void {
        delete data[key];
      },
      async destroy(): Promise<void> {
        destroyed = true;
        data = {};
        if (id) await deleteSession(storage, table, id);
      },
    };
    ctx.session = session;

    let response = await next();

    const mutated = JSON.stringify(data) !== originalData;

    // Three outcomes:
    //   1. destroyed → clear the cookie
    //   2. mutated or new data → create/update the row, set cookie
    //   3. rolling + existing id → touch the row's expiresAt
    if (destroyed) {
      response = attachCookie(
        response,
        clearCookie(cookieName, resolveSecure(ctx, secureOpt), sameSite),
      );
    } else if (mutated || (id === "" && hasContent(data))) {
      if (!id) id = newSessionId();
      await upsertSession(storage, table, id, data, now, maxAge);
      response = attachCookie(
        response,
        buildCookie(
          cookieName,
          id,
          maxAge,
          resolveSecure(ctx, secureOpt),
          sameSite,
        ),
      );
    } else if (rolling && id) {
      // Sliding expiry — only write a roll if the session's age since
      // the last roll is at least 10% of the TTL. Keeps write volume
      // sane on busy read endpoints. Clamp to 60s to avoid thrashing
      // at tiny maxAge values (tests typically use maxAge=60).
      const maxAgeMs = maxAge * 1000;
      const rollThreshold = Math.max(60_000, Math.floor(maxAgeMs / 10));
      if (row && now - row.rolledAt > rollThreshold) {
        await rollSession(storage, table, id, now, maxAge);
      }
    }
    return response;
  };
}

// ─── persistence ─────────────────────────────────────────────────────

async function loadSession(
  storage: StorageAdapter,
  table: string,
  id: string,
  now: number,
): Promise<SessionRow | null> {
  const row = (await storage
    .query(table)
    .where("id", "=", id)
    .first()) as SessionRow | null;
  if (!row) return null;
  if (row.expiresAt && row.expiresAt < now) {
    await deleteSession(storage, table, id);
    return null;
  }
  return row;
}

async function upsertSession(
  storage: StorageAdapter,
  table: string,
  id: string,
  data: Record<string, unknown>,
  now: number,
  maxAge: number,
): Promise<void> {
  await storage.upsert(
    table,
    { id },
    {
      data: JSON.stringify(data),
      createdAt: now,
      expiresAt: now + maxAge * 1000,
      rolledAt: now,
    },
  );
}

async function rollSession(
  storage: StorageAdapter,
  table: string,
  id: string,
  now: number,
  maxAge: number,
): Promise<void> {
  // Lightweight update — no need to rewrite `data`.
  const existing = (await storage
    .query(table)
    .where("id", "=", id)
    .first()) as SessionRow | null;
  if (!existing) return;
  await storage.update(table, existing._id, {
    expiresAt: now + maxAge * 1000,
    rolledAt: now,
  });
}

async function deleteSession(
  storage: StorageAdapter,
  table: string,
  id: string,
): Promise<void> {
  const existing = (await storage
    .query(table)
    .where("id", "=", id)
    .first()) as SessionRow | null;
  if (!existing) return;
  await storage.delete(table, existing._id);
}

// ─── cookie & helpers ────────────────────────────────────────────────

function extractCookie(req: Request, name: string): string | null {
  const cookie = req.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function newSessionId(): string {
  return randomBytes(32).toString("base64url");
}

function resolveSecure(
  ctx: { req: Request; url: URL },
  opt: boolean | "auto",
): boolean {
  if (opt === true) return true;
  if (opt === false) return false;
  const proto = ctx.req.headers.get("x-forwarded-proto");
  if (proto) return proto.toLowerCase() === "https";
  return ctx.url.protocol === "https:";
}

function buildCookie(
  name: string,
  value: string,
  maxAge: number,
  secure: boolean,
  sameSite: "Strict" | "Lax" | "None",
): string {
  const attrs = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${sameSite}`,
    `Max-Age=${maxAge}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

function clearCookie(
  name: string,
  secure: boolean,
  sameSite: "Strict" | "Lax" | "None",
): string {
  const attrs = [
    `${name}=`,
    "Path=/",
    "HttpOnly",
    `SameSite=${sameSite}`,
    "Max-Age=0",
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

function attachCookie(res: Response, setCookie: string): Response {
  return withHeaders(res, (headers) => {
    headers.append("set-cookie", setCookie);
  });
}

function hasContent(data: Record<string, unknown>): boolean {
  for (const _ in data) return true;
  return false;
}
