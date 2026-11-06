/** What an evaluation worker builds its engine from, for the tests. */

import { sqliteAdapter } from "../../src/adapters/sqlite.js";
import type { EvaluationSetup } from "../../src/core/evaluation.js";
import { evaluationPlugin } from "./evaluation-plugin.js";

export default ({ path }: { path: string }): EvaluationSetup => ({
  plugins: [evaluationPlugin],
  storage: sqliteAdapter(path, { readonly: true }),
});
