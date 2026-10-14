import { durableObjectAdapter } from "../../src/adapters/durable-object.js";
import { adapterSuite, sqliteSchemaSuite } from "../storage-suites.js";
import { objectStorage } from "./bun-test.js";

// Each test runs in a fresh Durable Object, so on an empty database.
const create = async () => durableObjectAdapter(objectStorage());

adapterSuite("durable-object", create);
sqliteSchemaSuite("durable-object", create);
