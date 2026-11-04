/**
 * A handler's args are typed from its declaration (TypeBox schemas):
 * declared args have their schema's type, optional ones may be absent,
 * and an undeclared one does not exist.
 */

import type { VexPluginAPI } from "../../src/core/api.js";
import { mutation, query } from "../../src/framework/define.js";
import { Type } from "../../src/portable.js";

declare const api: VexPluginAPI;

api.registerQuery("q", {
  args: { s: Type.String(), n: Type.Optional(Type.Number()) },
  handler: (_ctx, args) => {
    const s: string = args.s;
    const n: number | undefined = args.n;
    // @ts-expect-error an undeclared arg does not exist
    void args.missing;
    // @ts-expect-error a string is not a number
    const wrong: number = args.s;
    return [s, n, wrong];
  },
});

api.registerMutation("m", {
  args: { ids: Type.Array(Type.String()) },
  handler: (_ctx, args) => {
    const first: string | undefined = args.ids[0];
    // @ts-expect-error ids are strings
    const bad: number[] = args.ids;
    return [first, bad];
  },
});

api.registerAction("a", {
  args: {},
  handler: (_ctx, args) => {
    // @ts-expect-error no args were declared
    void args.anything;
    return null;
  },
});

// Only a schema `Type` builds is one: the old declarations are not.
api.registerQuery("old", {
  // @ts-expect-error a type's name is not a schema
  args: { s: "string" },
  handler: () => null,
});
api.registerTable("old", {
  columns: {
    // @ts-expect-error a plain object is not a schema
    n: { type: "number", optional: true },
  },
});

// A file's definitions are typed from their args as a plugin's are.
query({ id: Type.String() }, (_ctx, args) => {
  const id: string = args.id;
  // @ts-expect-error an undeclared arg does not exist
  void args.other;
  return id;
});
mutation({ n: Type.Optional(Type.Number()) }, (_ctx, args) => {
  // @ts-expect-error an optional arg may be absent
  const n: number = args.n;
  return n;
});
