/**
 * HttpError — the structured exception middleware and handlers can
 * throw to signal a specific HTTP response shape. Caught by the
 * default error boundary and rendered as JSON.
 *
 * The `body` can be anything JSON-serializable; convention is
 * `{ error: string, detail?: string, ...extras }` for machine readers.
 * Setting `headers` lets auth-style errors attach `WWW-Authenticate`
 * or rate-limit errors attach `Retry-After` without a custom class
 * per response shape.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Record<string, string>;
  readonly expose: boolean;

  constructor(
    status: number,
    message: string,
    opts: {
      body?: unknown;
      headers?: Record<string, string>;
      /** When false, the error's message is hidden from 5xx responses. */
      expose?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(
      message,
      opts.cause !== undefined ? { cause: opts.cause } : undefined,
    );
    this.name = "HttpError";
    this.status = status;
    this.body = opts.body !== undefined ? opts.body : { error: message };
    this.headers = opts.headers ?? {};
    // 4xx errors expose details by default; 5xx errors hide them.
    this.expose = opts.expose ?? (status >= 400 && status < 500);
  }

  /**
   * The body it answers with: its own, unless it is a 5xx whose
   * details stay hidden. HTTP renders it (`toResponse`); the
   * WebSocket's error frame carries it beside its status.
   */
  shownBody(): unknown {
    return this.expose || this.status < 500
      ? this.body
      : { error: "Internal Server Error" };
  }

  toResponse(): Response {
    const headers: Record<string, string> = {
      "content-type": "application/json; charset=utf-8",
      ...this.headers,
    };
    return new Response(JSON.stringify(this.shownBody()), {
      status: this.status,
      headers,
    });
  }

  static badRequest(message = "Bad Request", extras?: Record<string, unknown>) {
    return new HttpError(400, message, {
      body: { error: message, ...extras },
    });
  }
  static unauthorized(
    message = "Unauthorized",
    extras?: Record<string, unknown>,
  ) {
    return new HttpError(401, message, {
      body: { error: message, ...extras },
      headers: { "www-authenticate": 'Bearer realm="vex"' },
    });
  }
  static forbidden(message = "Forbidden") {
    return new HttpError(403, message);
  }
  static notFound(message = "Not Found") {
    return new HttpError(404, message);
  }
  static conflict(message = "Conflict") {
    return new HttpError(409, message);
  }
  static tooManyRequests(
    retryAfterSeconds: number,
    message = "Too Many Requests",
  ) {
    return new HttpError(429, message, {
      headers: { "retry-after": String(retryAfterSeconds) },
    });
  }
  static internal(message = "Internal Server Error", cause?: unknown) {
    return new HttpError(500, message, { cause, expose: false });
  }
}

/** True when the thrown value is an HttpError. */
export function isHttpError(e: unknown): e is HttpError {
  return e instanceof HttpError;
}

/** A thrown value's message, whatever was thrown. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
