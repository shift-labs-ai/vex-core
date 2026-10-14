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
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}
