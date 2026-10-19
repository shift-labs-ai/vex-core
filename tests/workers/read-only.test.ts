import { durableObjectAdapter } from "../../src/adapters/durable-object.js";
import { readOnlySuite } from "../read-only-suite.js";
import { objectStorage } from "./bun-test.js";

// Each test runs in a fresh Durable Object, so on an empty database.
readOnlySuite("durable-object", async () =>
  durableObjectAdapter(objectStorage()),
);
