/**
 * An evaluation worker (`EvaluationPool`): a read-only engine, built
 * from the setup module the pool names, that runs the subscription
 * queries posted to it and answers each with its evaluation.
 */

import { Vex } from "./engine.js";
import type {
  EvaluationSetup,
  WorkerInbound,
  WorkerOutbound,
} from "./evaluation.js";

declare const self: Worker;

const post = (message: WorkerOutbound) => self.postMessage(message);

let engine: Promise<Vex> | null = null;

self.addEventListener("message", (event: MessageEvent) => {
  const message = event.data as WorkerInbound;
  if (message.type === "init") {
    engine = (async () => {
      const module = await import(message.init.module);
      const setup = module.default(message.init.setup) as EvaluationSetup;
      return Vex.create({
        plugins: setup.plugins,
        storage: setup.storage,
        handlerTimeoutMs: message.init.handlerTimeoutMs,
        reactive: message.init.reactive,
        jobScheduler: "external",
      });
    })();
    engine.then(
      () => post({ type: "ready" }),
      (error) => post({ type: "failed", error: describe(error) }),
    );
    return;
  }
  if (!engine) {
    post({ type: "error", id: message.id, error: "Worker not initialized" });
    return;
  }
  engine
    .then((vex) => vex.evaluate(message.request))
    .then(
      (evaluation) => post({ type: "done", id: message.id, evaluation }),
      (error) =>
        post({ type: "error", id: message.id, error: describe(error) }),
    );
});

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
