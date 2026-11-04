/** A plugin that builds on the main thread and refuses to in a worker. */

import { isMainThread } from "node:worker_threads";
import type { VexPluginAPI } from "../../../src/core/api.js";

export default function mainOnly(api: VexPluginAPI) {
  if (!isMainThread) throw new Error("this plugin builds on the main thread");
  api.setName("mainOnly");
  api.registerQuery("n", { args: {}, handler: () => 1 });
}
