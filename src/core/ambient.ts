/**
 * The clock and the randomness the engine itself reads, captured when
 * this module loads: what a handler is refused (`guards.ts`), the
 * engine still reads here, on its own behalf.
 */

const dateNow = Date.now.bind(Date);
const mathRandom = Math.random.bind(Math);
const getRandomValues = crypto.getRandomValues.bind(crypto);

/** Milliseconds since the epoch, as `Date.now` gives them. */
export function now(): number {
  return dateNow();
}

/** A uniform float in [0, 1). */
export function random(): number {
  return mathRandom();
}

/** `bytes` random bytes. */
export function randomBytes(bytes: number): Uint8Array {
  return getRandomValues(new Uint8Array(bytes));
}
