/**
 * An evaluation worker (`EvaluationPool`): a read-only engine over the
 * main engine's database, built from the main engine's own plugin
 * modules and env, that runs the queries posted to it and answers each
 * with its evaluation.
 */

import { sqliteAdapter } from "../adapters/sqlite.js";
import { Vex } from "./engine.js";
import {
  crossing,
  type EvaluationInit,
  type WorkerInbound,
  type WorkerOutbound,
} from "./evaluation.js";

declare const self: Worker;

const post = (message: WorkerOutbound) => self.postMessage(message);

let engine: Promise<Vex> | null = null;

/** The engine `init` describes: the main one's plugins, reading only. */
function build(init: EvaluationInit): Promise<Vex> {
  const { reader } = init;
  return Vex.create({
    plugins: init.plugins,
    storage: sqliteAdapter(reader.path, {
      readonly: true,
      ...(reader.busyTimeout !== undefined
        ? { busyTimeout: reader.busyTimeout }
        : {}),
      ...(reader.cacheSize !== undefined
        ? { cacheSize: reader.cacheSize }
        : {}),
    }),
    // A worker runs reads: it holds no services, whatever the app
    // declares of them.
    env: init.env,
    handlerTimeoutMs: init.handlerTimeoutMs,
    reactive: init.reactive,
    jobScheduler: "none",
  } as Parameters<typeof Vex.create>[0]);
}

self.addEventListener("message", (event: MessageEvent) => {
  const message = event.data as WorkerInbound;
  if (message.type === "init") {
    engine = build(message.init);
    engine.then(
      () => post({ type: "ready" }),
      (error) => post({ type: "failed", error: crossing(error) }),
    );
    return;
  }
  if (!engine) {
    post({
      type: "error",
      id: message.id,
      error: crossing(new Error("Worker not initialized")),
    });
    return;
  }
  engine
    .then((vex) => vex.evaluate(message.request))
    .then(
      (evaluation) => post({ type: "done", id: message.id, evaluation }),
      (error) =>
        post({ type: "error", id: message.id, error: crossing(error) }),
    );
});
