import { durableObjectAdapter } from "../../src/adapters/durable-object.js";
import { changeTrackingSuite } from "../change-tracking-suite.js";
import { objectStorage } from "./bun-test.js";

// Each test runs in a fresh Durable Object, so on an empty database.
changeTrackingSuite("durable-object", () =>
  durableObjectAdapter(objectStorage()),
);
