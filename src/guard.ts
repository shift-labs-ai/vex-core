/**
 * The handler guards, installed before anything else loads:
 * `bun --preload vex-core/guard`, or `preload = ["vex-core/guard"]` in
 * bunfig.toml (under `[test]` too). An engine refuses to start without
 * them (`guards.ts`).
 */

import { createRequire } from "node:module";
import "./core/ambient.js";
import { installGuards } from "./core/guards.js";

installGuards(createRequire(import.meta.url));
