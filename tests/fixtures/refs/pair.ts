/** Two plugins a test passes by one module: an array default export. */

import type { VexPluginAPI } from "../../../src/core/api.js";

export default [
  (api: VexPluginAPI) => {
    api.setName("one");
    api.registerQuery("n", { args: {}, handler: () => 1 });
  },
  {
    name: "two",
    tables: {},
    queries: { n: { args: {}, handler: () => 2 } },
    mutations: {},
  },
];
