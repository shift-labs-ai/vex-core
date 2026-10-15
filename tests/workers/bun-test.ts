/**
 * Stands in for "bun:test" under vitest in workerd.
 *
 * A Durable Object's storage is usable only from inside that object, so
 * each test runs, with its hooks, inside a fresh SQLite-backed object.
 * `objectStorage()` is that object's storage.
 */
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as vitest from "vitest";

export { describe, expect } from "vitest";

let stub: DurableObjectStub | undefined;
let storage: DurableObjectStorage | undefined;

vitest.beforeEach(() => {
  stub = env.STORE.get(env.STORE.newUniqueId());
});

function inObject(fn: () => unknown): () => Promise<unknown> {
  return () => {
    if (!stub) throw new Error("no Durable Object for this test");
    return runInDurableObject(stub, (_, state) => {
      storage = state.storage;
      return fn();
    });
  };
}

export function objectStorage(): DurableObjectStorage {
  if (!storage) throw new Error("objectStorage() is only usable in a test");
  return storage;
}

export const beforeEach = (fn: () => unknown) =>
  vitest.beforeEach(inObject(fn));
export const afterEach = (fn: () => unknown) => vitest.afterEach(inObject(fn));
export const test = (name: string, fn: () => unknown) =>
  vitest.test(name, inObject(fn));
