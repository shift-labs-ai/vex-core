/**
 * The clock, randomness and timers the engine itself uses, as the
 * runtime gives them: what a handler is refused (`guards.ts`), the
 * engine still uses here, on its own behalf. A function a guard has
 * already wrapped is unwrapped, so this holds whenever it loads.
 */

const ORIGINAL = Symbol.for("vex.original");

function original<F>(fn: F): F {
  return ((fn as any)?.[ORIGINAL] as F | undefined) ?? fn;
}

const dateNow = original(Date.now).bind(Date);
const perfNow = original(performance.now).bind(performance);
const mathRandom = original(Math.random).bind(Math);
const getRandomValues = original(crypto.getRandomValues).bind(crypto);
const timeout = original(globalThis.setTimeout).bind(globalThis);
const interval = original(globalThis.setInterval).bind(globalThis);

/** Milliseconds since the epoch, as `Date.now` gives them. */
export function now(): number {
  return dateNow();
}

/** A monotonic clock in milliseconds, as `performance.now` gives it. */
export function monotonic(): number {
  return perfNow();
}

/** A uniform float in [0, 1). */
export function random(): number {
  return mathRandom();
}

/** `bytes` random bytes. */
export function randomBytes(bytes: number): Uint8Array {
  return getRandomValues(new Uint8Array(bytes));
}

/** `setTimeout`, as the engine schedules its own work. */
export const setTimeout: typeof globalThis.setTimeout = ((
  fn: () => void,
  ms?: number,
) => timeout(fn, ms)) as typeof globalThis.setTimeout;

/** `setInterval`, as the engine schedules its own work. */
export const setInterval: typeof globalThis.setInterval = ((
  fn: () => void,
  ms?: number,
) => interval(fn, ms)) as typeof globalThis.setInterval;
