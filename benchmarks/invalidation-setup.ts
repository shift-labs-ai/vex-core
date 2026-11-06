/** What an evaluation worker of the benchmark builds its engine from. */

import { sqliteAdapter } from "../src/adapters/sqlite.js";
import type { EvaluationSetup } from "../src/core/evaluation.js";
import { benchmarkPlugin } from "./invalidation-plugin.js";

export default ({ path }: { path: string }): EvaluationSetup => ({
  plugins: [benchmarkPlugin],
  storage: sqliteAdapter(path, { readonly: true }),
});
