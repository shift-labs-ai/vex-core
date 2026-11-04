import type { PluginFunction } from "./api.js";
import type { StorageAdapter } from "./storage.js";
import type { QueryDependency } from "./trace-metadata.js";
import type { PluginDef, ReactiveBudget, VexUser } from "./types.js";

/**
 * Subscription evaluation off the main thread.
 *
 * A pool of workers, each running a read-only engine over the same
 * database with the same plugins, runs a subscription's query and
 * answers with its result, measured, and the tables and dependencies
 * the run recorded. The main thread keeps everything else: which
 * subscriptions a write affects, their runs' single flight, delivery.
 *
 * The module `EvaluationOptions.module` names is imported by each
 * worker; its default export builds what a worker's engine needs,
 * from `EvaluationOptions.setup`:
 *
 *   export default ({ path }): EvaluationSetup => ({
 *     plugins: [...],
 *     storage: sqliteAdapter(path, { readonly: true }),
 *   });
 */
export interface EvaluationOptions {
  /** How many workers evaluate; none evaluates on the main thread. */
  workers: number;
  /** The module whose default export is an `EvaluationSetup` factory. */
  module: string | URL;
  /** What the factory is called with; it crosses to each worker. */
  setup?: unknown;
}

/** What a worker's engine is built from (`EvaluationOptions.module`). */
export interface EvaluationSetup {
  plugins: Array<PluginFunction<any> | PluginDef<any>>;
  storage: StorageAdapter;
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
  hash: number;
  resultRows: number | undefined;
  resultBytes: number;
  tables: string[];
  dependencies: QueryDependency[];
}

/** The engine's settings a worker's engine shares. */
export interface EvaluationInit {
  module: string;
  setup: unknown;
  handlerTimeoutMs: number;
  reactive: Required<ReactiveBudget>;
}

export type WorkerInbound =
  | { type: "init"; init: EvaluationInit }
  | { type: "run"; id: number; request: EvaluationRequest };

export type WorkerOutbound =
  | { type: "ready" }
  | { type: "failed"; error: string }
  | { type: "done"; id: number; evaluation: Evaluation }
  | { type: "error"; id: number; error: string };

/** Whether `value` can cross to a worker as it is. */
export function transferable(value: unknown): boolean {
  try {
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
}

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
    // A worker's engine is guarded as the main thread's: the guards
    // load before anything else in it (`guards.ts`).
    const worker = new Worker(this.script, {
      preload: [new URL("../guard.js", import.meta.url).href],
    } as WorkerOptions);
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
          return booted(new Error(message.error));
        case "done":
        case "error": {
          const run = member.run;
          if (run?.id !== message.id) return;
          member.run = null;
          if (message.type === "done") run.pending.resolve(message.evaluation);
          else run.pending.reject(new Error(message.error));
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
