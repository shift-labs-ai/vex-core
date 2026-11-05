/** A file-based plugin (`vex-core/framework`), scanned by `../scanned.ts`. */

import {
  mutation,
  query,
  Type,
  table,
} from "../../../../src/framework/index.js";

export const items = table({ text: Type.String() });

export const add = mutation({ text: Type.String() }, (ctx, args) =>
  ctx.db.table("todos_items").insert({ text: args.text }),
);

export const list = query({}, async (ctx) =>
  (await ctx.db.table("todos_items").order("text", "asc").all()).map(
    (row: { text: string }) => row.text,
  ),
);
