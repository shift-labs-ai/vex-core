/**
 * The handler a call is running in, as async context: a query,
 * mutation or action handler (and the middleware around it) runs in
 * its frame, so a handler calling the engine directly, rather than
 * through its context, is refused. What a handler reads and writes
 * goes through its context, which tracks it, decides it and answers it
 * as its caller.
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

/** Refuses a direct call into the engine from inside a handler. */
export function refuseReentry(call: string): void {
  const frame = frames.getStore();
  if (frame) {
    throw new ReentryError(
      `${call} is refused inside ${frame.kind} ${frame.name}: call through the handler's context (ctx${frame.kind === "action" ? `.${call.split(".").pop()}` : ".db"})`,
    );
  }
}

/** A handler calling the engine past its context. */
export class ReentryError extends Error {
  override readonly name = "ReentryError";
}
