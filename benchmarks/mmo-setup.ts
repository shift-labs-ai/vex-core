/** What an evaluation worker of the MMO benchmark builds its engine from. */

import { sqliteAdapter } from "../src/adapters/sqlite.js";
import type { EvaluationSetup } from "../src/core/evaluation.js";
import { mmoPlugin } from "./mmo-plugin.js";

export default ({ path }: { path: string }): EvaluationSetup => ({
  plugins: [mmoPlugin],
  storage: sqliteAdapter(path, { readonly: true }),
});
