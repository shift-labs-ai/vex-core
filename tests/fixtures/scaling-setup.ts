/** What a scaling-matrix evaluation worker builds its engine from. */

import { sqliteAdapter } from "../../src/adapters/sqlite.js";
import type { EvaluationSetup } from "../../src/core/evaluation.js";
import { scalingPlugin } from "./scaling-plugin.js";

export default ({ path }: { path: string }): EvaluationSetup => ({
  plugins: [scalingPlugin],
  storage: sqliteAdapter(path, { readonly: true }),
});
