/**
 * The answers a router gives when nothing it holds matched. A mount
 * falls through to later matchers on these, and on no other 404: a
 * route that answered 404 (a refusal, a missing row) has answered.
 */
const UNMATCHED = new WeakSet<Response>();

/** Mark `response` as a router's no-match answer; answers it. */
export function unmatched(response: Response): Response {
  UNMATCHED.add(response);
  return response;
}

/** Whether `response` is a router's no-match answer. */
export function isUnmatched(response: Response): boolean {
  return UNMATCHED.has(response);
}

/**
 * Adds headers to a downstream response, for middleware that decorate
 * what the handler returned.
 *
 * The headers are set on the response itself. A response built from a
 * string, Blob or FormData carries its content type implicitly, outside
 * `response.headers`; rebuilding it from `response.body` loses that
 * type, and Bun then serves it as `application/octet-stream`.
 *
 * Responses whose headers are immutable under the Fetch standard (from
 * `fetch()` or `Response.redirect()`) are rebuilt instead. Their content
 * type, if any, is already explicit in their headers.
 */
export function withHeaders(
  response: Response,
  apply: (headers: Headers) => void,
): Response {
  try {
    apply(response.headers);
    return response;
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    const headers = new Headers(response.headers);
    apply(headers);
    const rebuilt = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
    return isUnmatched(response) ? unmatched(rebuilt) : rebuilt;
  }
}
