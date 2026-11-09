import { durableObjectAdapter } from "../../src/adapters/durable-object.js";
import type { StorageAdapter } from "../../src/core/storage.js";
import { afterCommitSuite } from "../after-commit-suite.js";
import { objectStorage } from "./bun-test.js";

/** A storage adapter written before `afterCommit`: every member but it. */
function withoutAfterCommit(adapter: StorageAdapter): StorageAdapter {
  const { afterCommit: _, ...rest } = adapter;
  return rest;
}

// Each test runs in a fresh Durable Object, so on an empty database;
// nested transactions there are savepoints.
afterCommitSuite(
  "durable-object",
  () => durableObjectAdapter(objectStorage()),
  { seesNesting: true },
);
afterCommitSuite(
  "durable-object, adapter without afterCommit",
  () => withoutAfterCommit(durableObjectAdapter(objectStorage())),
  { seesNesting: false, runs: 20 },
);
