/**
 * The handler a call is running in, as async context: a query,
 * mutation or action handler runs in its frame, so a handler calling
 * the engine directly, rather than through its context, is refused.
 * What a handler reads and writes goes through its context, which
 * tracks it, decides it and answers it as its caller. Middleware runs
 * outside the frame: it is the app's authority, and may ask the
 * engine how to decide.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** The kind of handler a frame runs. */
export type FrameKind = "query" | "mutation" | "action";

interface Frame {
  readonly kind: FrameKind;
  readonly name: string;
}

const frames = new AsyncLocalStorage<Frame>();

/** Runs `fn` as handler `name` of `kind`. */
export function inFrame<T>(kind: FrameKind, name: string, fn: () => T): T {
  return frames.run({ kind, name }, fn);
}

/** Runs `fn` outside any handler's frame: the engine's own work. */
export function outsideFrame<T>(fn: () => T): T {
  return frames.exit(fn);
}

/**
 * Refuses a direct call into the engine from inside a handler, naming
 * what the handler's context offers instead: an action's queries,
 * mutates and calls actions, a query's composes a query, and
 * otherwise it reads and writes through `ctx.db`. No handler
 * subscribes: its caller does.
 */
export function refuseReentry(call: string): void {
  const frame = frames.getStore();
  if (!frame) return;
  const verb = call.split(".").pop();
  const where = `${call} is refused inside ${frame.kind} ${frame.name}`;
  if (verb === "subscribe") {
    throw new ReentryError(`${where}: a handler subscribes to nothing`);
  }
  const path =
    frame.kind === "action" || (frame.kind === "query" && verb === "query")
      ? `ctx.${verb}`
      : "ctx.db";
  throw new ReentryError(
    `${where}: call through the handler's context (${path})`,
  );
}

/** A handler calling the engine past its context. */
export class ReentryError extends Error {
  override readonly name = "ReentryError";
}
