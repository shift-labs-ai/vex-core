/**
 * A request body read under a byte ceiling. A body is never buffered
 * past its ceiling: a declared `Content-Length` over it is refused
 * before a byte is read, and an undeclared one is counted as it
 * streams in.
 *
 * A refused body is drained, not abandoned: unread bytes on a
 * kept-alive socket make Bun parse them as the next request, and that
 * request hangs. Answering with `Connection: close` instead is no
 * better for a client still writing: the close surfaces as ECONNRESET
 * on this request, so the client never reads why it was refused.
 * Draining keeps both sides honest. Only a body past the drain
 * ceiling, or a producer that stalls, is cut off; then the answer must
 * close the connection, which `closeConnection` says.
 *
 * Two layers:
 *   - `readBoundedBody` / `discardBody` answer a result and never
 *     throw for a refusal; for callers that render their own response.
 *   - `readBody` / `readText` / `readJson` / `readForm` / `refuseBody`
 *     throw the HttpError that says why, `{ error }` in the body and
 *     `Connection: close` exactly when bytes stay on the socket.
 *
 * Web Streams only (no Node `Buffer`), so it runs in Bun and workerd
 * alike.
 */

import { HttpError } from "./error.js";

export interface BodyLimits {
  /** The most bytes a body may carry. */
  maxBytes: number;
  /** The most bytes read and discarded to refuse one; 0 never drains.
   *  Defaults to four times `maxBytes`. */
  drainBytes?: number;
  /** How long reading the body may take, a refused one's drain
   *  included; none when absent. */
  timeoutMs?: number;
}

/** Why a body was refused, as an HTTP status. */
export type BodyRefusalStatus =
  | 400 // a Content-Length that is not a byte count
  | 408 // the producer stalled past the deadline
  | 413; // past the ceiling

export type BoundedBody =
  | { ok: true; bytes: Uint8Array<ArrayBuffer> }
  | { ok: false; status: BodyRefusalStatus; closeConnection: boolean };

const DRAIN_MULTIPLIER = 4;

class Stalled extends Error {}

type Reader = ReadableStreamDefaultReader<Uint8Array>;

function drainCeiling(limits: BodyLimits): number {
  return limits.drainBytes ?? limits.maxBytes * DRAIN_MULTIPLIER;
}

/** A deadline every read races; `clear` stops it. */
function deadline(timeoutMs: number | undefined) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired =
    timeoutMs === undefined
      ? new Promise<never>(() => {})
      : new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Stalled()), timeoutMs);
        });
  // A deadline nobody races any more must not surface as unhandled.
  expired.catch(() => {});
  return { expired, clear: () => clearTimeout(timer) };
}

/**
 * Read and discard the rest of `reader` up to `ceiling` bytes in all
 * (`readSoFar` included), until `expired`. True when the socket is
 * clean; false when bytes may remain on it, and the reader is
 * cancelled.
 */
async function drain(
  reader: Reader,
  readSoFar: number,
  ceiling: number,
  expired: Promise<never>,
): Promise<boolean> {
  let total = readSoFar;
  let clean = total <= ceiling;
  try {
    while (clean) {
      const { done, value } = await Promise.race([reader.read(), expired]);
      if (done) break;
      total += value.byteLength;
      clean = total <= ceiling;
    }
  } catch {
    clean = false;
  }
  if (!clean) void reader.cancel().catch(() => {});
  return clean;
}

function declaredLength(req: Request): number | null | "invalid" {
  const header = req.headers.get("content-length");
  if (header === null) return null;
  const trimmed = header.trim();
  if (!/^\d+$/.test(trimmed)) return "invalid";
  const bytes = Number(trimmed);
  return Number.isSafeInteger(bytes) ? bytes : "invalid";
}

/**
 * Refuse `req`'s body without keeping it: drain it under the drain
 * ceiling, or give up on one declared past it. Answers whether the
 * response must close the connection.
 */
export async function discardBody(
  req: Request,
  limits: BodyLimits,
): Promise<{ closeConnection: boolean }> {
  if (!req.body) return { closeConnection: false };
  if (req.bodyUsed) return { closeConnection: false };
  const reader = req.body.getReader();
  const declared = declaredLength(req);
  const ceiling = drainCeiling(limits);
  if (declared === "invalid" || (declared !== null && declared > ceiling)) {
    void reader.cancel().catch(() => {});
    return { closeConnection: true };
  }
  const clock = deadline(limits.timeoutMs);
  try {
    return {
      closeConnection: !(await drain(reader, 0, ceiling, clock.expired)),
    };
  } finally {
    clock.clear();
  }
}

/** Read `req`'s whole body, or refuse it once it is past `maxBytes`. */
export async function readBoundedBody(
  req: Request,
  limits: BodyLimits,
): Promise<BoundedBody> {
  if (!req.body) return { ok: true, bytes: new Uint8Array(0) };
  const declared = declaredLength(req);
  if (declared === "invalid") {
    const { closeConnection } = await discardBody(req, limits);
    return { ok: false, status: 400, closeConnection };
  }
  if (declared !== null && declared > limits.maxBytes) {
    const { closeConnection } = await discardBody(req, limits);
    return { ok: false, status: 413, closeConnection };
  }

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const clock = deadline(limits.timeoutMs);
  try {
    while (true) {
      const { done, value } = await Promise.race([
        reader.read(),
        clock.expired,
      ]);
      if (done) break;
      total += value.byteLength;
      if (total > limits.maxBytes) {
        const clean = await drain(
          reader,
          total,
          drainCeiling(limits),
          clock.expired,
        );
        return { ok: false, status: 413, closeConnection: !clean };
      }
      chunks.push(value);
    }
  } catch (error) {
    // A producer that stalls cannot be drained: the socket must close.
    if (!(error instanceof Stalled)) throw error;
    void reader.cancel().catch(() => {});
    return { ok: false, status: 408, closeConnection: true };
  } finally {
    clock.clear();
  }
  // Its own ArrayBuffer, never a view into a pooled one, so the bytes
  // pass as a body or a Blob part as they are.
  const bytes = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

// ─── HttpError-throwing helpers ──────────────────────────────────────

export interface ReadLimits extends BodyLimits {
  /** What a body past the ceiling is told; names the ceiling when
   *  absent. */
  tooLarge?: string;
}

const MB = 1024 * 1024;

/**
 * Bytes as a short figure for limit messages: `5.1MB`, `100KB`, `200B`.
 * Rounded up, so a size just past a limit never reads as the limit
 * itself ("5MB, over the 5MB limit").
 */
export function formatBytes(bytes: number): string {
  if (bytes >= MB) {
    const mb = bytes / MB;
    return `${mb >= 10 ? Math.ceil(mb) : Math.ceil(mb * 10) / 10}MB`;
  }
  if (bytes >= 1024) return `${Math.ceil(bytes / 1024)}KB`;
  return `${bytes}B`;
}

function bodyError(
  status: number,
  message: string,
  closeConnection: boolean,
): HttpError {
  return new HttpError(
    status,
    message,
    closeConnection ? { headers: { connection: "close" } } : {},
  );
}

function refusalMessage(status: BodyRefusalStatus, limits: ReadLimits) {
  switch (status) {
    case 400:
      return "Invalid Content-Length";
    case 408:
      return "The request body timed out";
    case 413:
      return (
        limits.tooLarge ??
        `The request body exceeds the ${formatBytes(limits.maxBytes)} limit`
      );
  }
}

/** `req`'s whole body, or the HttpError that refuses it. */
export async function readBody(
  req: Request,
  limits: ReadLimits,
): Promise<Uint8Array<ArrayBuffer>> {
  const read = await readBoundedBody(req, limits);
  if (read.ok) return read.bytes;
  throw bodyError(
    read.status,
    refusalMessage(read.status, limits),
    read.closeConnection,
  );
}

/** `req`'s body as UTF-8 text (a leading BOM dropped, as `req.text()`
 *  does), or the HttpError that refuses it. */
export async function readText(
  req: Request,
  limits: ReadLimits,
): Promise<string> {
  return new TextDecoder().decode(await readBody(req, limits));
}

/** `req`'s JSON body; `{}` when it is empty or does not parse. A body
 *  past the ceiling is refused, never read as `{}`. */
export async function readJson(req: Request, limits: ReadLimits): Promise<any> {
  const text = await readText(req, limits);
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** `req`'s multipart (or urlencoded) form; null when the body is not
 *  one. */
export async function readForm(
  req: Request,
  limits: ReadLimits,
): Promise<FormData | null> {
  const bytes = await readBody(req, limits);
  const contentType = req.headers.get("content-type") ?? "";
  return new Response(bytes, { headers: { "content-type": contentType } })
    .formData()
    .catch(() => null);
}

/** Refuse `req` without keeping its body: drained, so the client
 *  reads `message`, or the connection closes. */
export async function refuseBody(
  req: Request,
  limits: BodyLimits,
  status: number,
  message: string,
): Promise<never> {
  const { closeConnection } = await discardBody(req, limits);
  throw bodyError(status, message, closeConnection);
}
