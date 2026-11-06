/** What an equivalence-fuzz evaluation worker builds its engine from. */

import { sqliteAdapter } from "../../src/adapters/sqlite.js";
import type { EvaluationSetup } from "../../src/core/evaluation.js";
import { equivalencePlugin } from "./equivalence-plugin.js";

export default ({ path }: { path: string }): EvaluationSetup => ({
  plugins: [equivalencePlugin],
  storage: sqliteAdapter(path, { readonly: true }),
});
