// Core
export { compose } from "./compose.js";
export { HttpError, isHttpError } from "./error.js";
export type {
  AccessLogMeta,
  AccessLogOptions,
} from "./middleware/access-log.js";
// Batteries
export { accessLog } from "./middleware/access-log.js";
export type { BearerAuthOptions } from "./middleware/bearer-auth.js";
export { bearerAuth } from "./middleware/bearer-auth.js";
export type { BodyParserOptions } from "./middleware/body-parser.js";
export { bodyParser } from "./middleware/body-parser.js";
export type { CorsOptions } from "./middleware/cors.js";
export { cors } from "./middleware/cors.js";
export type { ErrorBoundaryOptions } from "./middleware/error-boundary.js";
export { errorBoundary } from "./middleware/error-boundary.js";
export type { RateLimitOptions } from "./middleware/rate-limit.js";
export { rateLimit } from "./middleware/rate-limit.js";
export type { RequestIdOptions } from "./middleware/request-id.js";
export { requestId } from "./middleware/request-id.js";
export type { SessionOptions } from "./middleware/sessions.js";
export { sessions } from "./middleware/sessions.js";
export type { StaticFilesOptions } from "./middleware/static-files.js";
export { staticFiles } from "./middleware/static-files.js";
export type { RouterOptions } from "./router.js";
export { createRouter, Router } from "./router.js";
export type {
  ServeDirOptions,
  ServeFileOptions,
} from "./serve-static.js";
// Explicit static-serving route handlers (namespace owners, not fallbacks)
export { serveDir, serveFile } from "./serve-static.js";
export type {
  ErrorHandler,
  Handler,
  Middleware,
  RequestCtx,
  Session,
} from "./types.js";
export type { VexHandlerOptions } from "./vex-handler.js";
// Vex HTTP RPC dispatcher (Router you can mount anywhere)
export { vexHandler } from "./vex-handler.js";
export type {
  VexWebSocketConnection,
  VexWebSocketConnectionState,
  VexWebSocketHandlers,
  VexWebSocketOptions,
} from "./vex-websocket.js";
// Vex live channel (multiplexed subscribe + RPC over one WebSocket)
export { vexWebSocket } from "./vex-websocket.js";
