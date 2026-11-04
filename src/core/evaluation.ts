import { HttpError, isHttpError } from "../http/error.js";
import type { StorageReader } from "./storage.js";
import type { QueryDependency } from "./trace-metadata.js";
import type { ReactiveBudget, VexEnv, VexUser } from "./types.js";

/**
 * Reads off the main thread.
 *
 * A pool of workers, each running a read-only engine over the same
 * database, built from the app's own plugins (each given by module,
 * `PluginModule`), its `env` and the storage's `reader()`, runs a
 * query and answers with its result, measured, and the tables and
 * dependencies the run recorded. The main thread keeps everything
 * else: which subscriptions a write affects, their runs' single
 * flight, delivery, writes, actions.
 *
 * A run's answer crosses back as a copy, which costs the main thread;
 * a run cheaper than that is cheaper here. So the pool takes a query's
 * runs, subscriptions' and one-shot calls' alike, once they cost more
 * than `offloadAboveMs`, measured over its recent runs wherever they
 * ran, and hands them back once they cost under half of it.
 */
export interface EvaluationOptions {
  /** How many workers read; none reads on the main thread. */
  workers: number;
  /**
   * The run time, in ms, past which a query's runs go to the pool
   * (2 unless set); 0 sends every run.
   */
  offloadAboveMs?: number;
}

/** A subscription's query, as a worker runs it. */
export interface EvaluationRequest {
  name: string;
  args: Record<string, any>;
  user: VexUser | null | undefined;
}

/** A run's answer: the result, measured, and what it read. */
export interface Evaluation {
  result: unknown;
  serialized: string | undefined;
  /** Whether `result` is its own JSON reading, so readers may share it. */
  exact: boolean;
  /** The caller's fields the run read. */
  callerReads: string[];
  hash: number;
  resultRows: number | undefined;
  resultBytes: number;
  tables: string[];
  dependencies: QueryDependency[];
  /** How long the run took where it ran, in ms. */
  durationMs: number;
}

/** What a worker's engine is built from: the main engine's own. */
export interface EvaluationInit {
  /** Each plugin's module, in the order the main engine registered. */
  plugins: string[];
  env: Readonly<VexEnv>;
  reader: StorageReader;
  handlerTimeoutMs: number;
  reactive: Required<ReactiveBudget>;
}

/**
 * An error as it crosses from a worker: its name and message, and an
 * HttpError's status, body and headers, so a refusal answers the
 * caller as it would from the main thread.
 */
export interface CrossedError {
  name: string;
  message: string;
  http?: {
    status: number;
    body: unknown;
    headers: Record<string, string>;
    expose: boolean;
  };
}

/** `error` as it crosses (`CrossedError`). */
export function crossing(error: unknown): CrossedError {
  if (isHttpError(error)) {
    return {
      name: error.name,
      message: error.message,
      http: {
        status: error.status,
        body: error.body,
        headers: error.headers,
        expose: error.expose,
      },
    };
  }
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Error", message: String(error) };
}

/** The error `crossed` describes, rebuilt on this side. */
export function crossed(crossed: CrossedError): Error {
  const error = crossed.http
    ? new HttpError(crossed.http.status, crossed.message, {
        body: crossed.http.body,
        headers: crossed.http.headers,
        expose: crossed.http.expose,
      })
    : new Error(crossed.message);
  error.name = crossed.name;
  return error;
}

export type WorkerInbound =
  | { type: "init"; init: EvaluationInit }
  | { type: "run"; id: number; request: EvaluationRequest };

export type WorkerOutbound =
  | { type: "ready" }
  | { type: "failed"; error: CrossedError }
  | { type: "done"; id: number; evaluation: Evaluation }
  | { type: "error"; id: number; error: CrossedError };

/** Whether this runtime can host evaluation workers. */
export function workersAvailable(): boolean {
  return typeof Worker === "function";
}

interface Pending {
  resolve: (evaluation: Evaluation) => void;
  reject: (error: Error) => void;
}

interface Member {
  worker: Worker;
  ready: Promise<void>;
  /** The run it is on, by id; one at a time, its CPU being the point. */
  run: { id: number; pending: Pending } | null;
}

/**
 * The pool: its workers spawn as it is made, each building its engine
 * at once, so the first run waits for no boot. A request goes to an
 * idle worker, or waits for one; each worker runs one request at a
 * time. A worker that dies fails what it was running and is replaced
 * on the next request.
 */
export class EvaluationPool {
  private readonly members: Member[] = [];
  private readonly queue: Array<{
    request: EvaluationRequest;
    pending: Pending;
  }> = [];
  private nextId = 0;
  private closed = false;

  constructor(
    private readonly script: URL,
    private readonly size: number,
    private readonly init: EvaluationInit,
  ) {
    for (let i = 0; i < size; i++) this.members.push(this.spawn());
  }

  run(request: EvaluationRequest): Promise<Evaluation> {
    if (this.closed) return Promise.reject(new Error("Evaluation pool closed"));
    return new Promise<Evaluation>((resolve, reject) => {
      this.queue.push({ request, pending: { resolve, reject } });
      this.dispatch();
    });
  }

  close(): void {
    this.closed = true;
    const error = new Error("Evaluation pool closed");
    for (const { pending } of this.queue.splice(0)) pending.reject(error);
    for (const member of this.members.splice(0)) {
      member.run?.pending.reject(error);
      member.worker.terminate();
    }
  }

  private dispatch(): void {
    while (this.queue.length > 0) {
      const member = this.idle();
      if (!member) return;
      const { request, pending } = this.queue.shift()!;
      const id = ++this.nextId;
      member.run = { id, pending };
      // A member whose boot fails leaves the pool (`spawn`), its run
      // failed with it.
      member.ready.then(
        () => member.worker.postMessage({ type: "run", id, request }),
        () => {},
      );
    }
  }

  /** An idle member, spawning one while the pool is short. */
  private idle(): Member | undefined {
    const idle = this.members.find((member) => member.run === null);
    if (idle) return idle;
    if (this.members.length >= this.size) return undefined;
    const member = this.spawn();
    this.members.push(member);
    return member;
  }

  private spawn(): Member {
    const worker = new Worker(this.script);
    let booted: (outcome: Error | null) => void = () => {};
    const member: Member = {
      worker,
      ready: new Promise<void>((resolve, reject) => {
        booted = (outcome) => (outcome ? reject(outcome) : resolve());
      }),
      run: null,
    };
    worker.addEventListener("message", (event: MessageEvent) => {
      const message = event.data as WorkerOutbound;
      switch (message.type) {
        case "ready":
          return booted(null);
        case "failed":
          return booted(crossed(message.error));
        case "done":
        case "error": {
          const run = member.run;
          if (run?.id !== message.id) return;
          member.run = null;
          if (message.type === "done") run.pending.resolve(message.evaluation);
          else run.pending.reject(crossed(message.error));
          return this.dispatch();
        }
      }
    });
    member.ready.catch((error: Error) => this.failed(member, error));
    worker.addEventListener("error", (event: ErrorEvent) => {
      this.failed(
        member,
        event.error instanceof Error
          ? event.error
          : new Error(event.message || "Evaluation worker failed"),
      );
    });
    worker.postMessage({ type: "init", init: this.init });
    return member;
  }

  /** A member that cannot go on: its run fails, and it leaves the pool. */
  private failed(member: Member, error: Error): void {
    const index = this.members.indexOf(member);
    if (index === -1) return;
    this.members.splice(index, 1);
    if (!this.closed) console.error("[vex] evaluation worker failed:", error);
    member.run?.pending.reject(error);
    member.run = null;
    member.worker.terminate();
    this.dispatch();
  }
}
