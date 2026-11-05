/**
 * A file-based app as a plugin module: its default export is what
 * `scanDirectory` finds, so a worker that imports this module scans
 * the same files.
 */

import { fileURLToPath } from "node:url";
import { scanDirectory } from "../../../src/framework/index.js";

export default (
  await scanDirectory(fileURLToPath(new URL("./app", import.meta.url)))
).plugins;
