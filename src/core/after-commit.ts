/**
 * The engine's runner for work that follows a commit
 * (`MutationContext.afterCommit`): released work runs on a later turn,
 * started one after another in the order released. A piece that
 * answers a promise is not waited for before the next starts; only
 * `settled` and `drain` wait for it. What work throws or rejects goes
 * to `onError` and stops nothing after it.
 *
 * One loop per runner, begun with it: work runs in the loop's async
 * context, not the releasing call's, so it sees nothing of that call's
 * transaction or async state. A loop waiting for work holds no timer,
 * so it never keeps a process alive.
 */

type Job = () => unknown;

/** Resolves once the current turn's microtasks have drained. */
export const nextTurn: () => Promise<void> =
  typeof setImmediate === "function"
    ? () => new Promise((resolve) => setImmediate(resolve))
    : () => new Promise((resolve) => setTimeout(resolve, 0));

export class AfterCommitRunner {
  private due: Job[] = [];
  private running = new Set<Promise<void>>();
  private wake: (() => void) | null = null;
  private idle: Array<() => void> = [];
  private closed = false;

  constructor(
    private readonly onError: (error: unknown) => void,
    private readonly onDropped: () => void,
  ) {
    void this.loop();
  }

  /** Run `job` on a later turn; dropped once the runner has closed. */
  release(job: Job): void {
    if (this.closed) {
      this.onDropped();
      return;
    }
    this.due.push(job);
    this.notify();
  }

  /**
   * Resolves once every job released so far, and every one those
   * release, has run and settled.
   */
  async settled(): Promise<void> {
    for (;;) {
      if (this.due.length > 0) {
        await new Promise<void>((resolve) => this.idle.push(resolve));
        continue;
      }
      if (this.running.size === 0) return;
      await Promise.all([...this.running]);
    }
  }

  /**
   * Settle what was released, then close: what is released after is
   * dropped. Resolves true once all of it settled, or false at
   * `timeoutMs` with some still running, which runs on unwaited.
   */
  async drain(timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      return await Promise.race([this.settled().then(() => true), deadline]);
    } finally {
      clearTimeout(timer);
      this.closed = true;
      this.due.length = 0;
      this.notify();
    }
  }

  private notify(): void {
    const resolve = this.wake;
    this.wake = null;
    resolve?.();
  }

  private async loop(): Promise<void> {
    for (;;) {
      if (this.due.length === 0) {
        for (const resolve of this.idle.splice(0)) resolve();
        if (this.closed) return;
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
        continue;
      }
      // A later turn than the one that released it: never inside the
      // releasing call's synchronous work.
      await nextTurn();
      for (const job of this.due.splice(0)) this.start(job);
    }
  }

  private start(job: Job): void {
    let result: unknown;
    try {
      result = job();
    } catch (error) {
      this.onError(error);
      return;
    }
    if (!isPromiseLike(result)) return;
    const settled = Promise.resolve(result).then(
      () => {},
      (error: unknown) => this.onError(error),
    );
    this.running.add(settled);
    void settled.finally(() => this.running.delete(settled));
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    !!value &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
