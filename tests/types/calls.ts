/**
 * Compile-time tests for the engine's calls (`VexCalls`), checked by
 * `bun run typecheck`. Every `@ts-expect-error` must be an error.
 */

import type { Vex } from "../../src/core/engine.js";
import type { VexCalls } from "../../src/core/types.js";
import { vexHandler } from "../../src/http/vex-handler.js";
import { vexWebSocket } from "../../src/http/vex-websocket.js";

declare const engine: Vex;
declare const declaring: Vex<{ permission: string }>;

// An engine answers them, whatever it declares.
const calls: VexCalls = engine;
const alsoCalls: VexCalls = declaring;

// Something in front of an engine answers them too, and the
// transports take it as they take the engine.
const inFront: VexCalls = {
  query: (name, args, callCtx) => engine.query(`now.${name}`, args, callCtx),
  mutate: (name, args, callCtx) => engine.mutate(name, args, callCtx),
  action: (name, args, callCtx) => engine.action(name, args, callCtx),
  subscribe: (name, args, callback, callCtx) =>
    engine.subscribe(name, args, (data) => callback({ data }), callCtx),
};
vexWebSocket(inFront);
vexHandler({
  ...inFront,
  handleWebhook: (req) => engine.handleWebhook(req),
});

// One that leaves a call out is none.
const { subscribe: _subscribe, ...oneShot } = inFront;
// @ts-expect-error a socket subscribes
vexWebSocket(oneShot);
// @ts-expect-error the dispatcher serves webhooks
vexHandler(inFront);
// The dispatcher never subscribes.
vexHandler({ ...oneShot, handleWebhook: (req) => engine.handleWebhook(req) });

void [calls, alsoCalls, _subscribe];
