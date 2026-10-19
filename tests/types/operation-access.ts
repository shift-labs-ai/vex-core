/**
 * Compile-time tests for operation access (`OperationAccess`), checked
 * by `bun run typecheck`. Every `@ts-expect-error` must be an error:
 * one that compiles fails the check, so each line below proves a
 * mistake does not build.
 */

import type { PluginFunction, VexPluginAPI } from "../../src/core/api.js";
import { Vex } from "../../src/core/engine.js";
import type { StorageAdapter } from "../../src/core/storage.js";
import type { MiddlewareFn } from "../../src/core/types.js";

declare const storage: StorageAdapter;

/** An app's declaration. */
type Access = { permission: string } | "system";

// ─── An app that chooses a declaration ───

export const declared: PluginFunction<Access> = (api) => {
  api.setName("declared");
  api.registerQuery("list", {
    args: {},
    access: { permission: "notes.read" },
    handler: () => [],
  });
  api.registerMutation("compact", {
    args: {},
    access: "system",
    handler: () => null,
  });

  // A query without a declaration does not build.
  // @ts-expect-error access is required
  api.registerQuery("open", { args: {}, handler: () => [] });

  // Nor does a mutation.
  // @ts-expect-error access is required
  api.registerMutation("open", { args: {}, handler: () => null });

  api.registerQuery("wrong", {
    args: {},
    // @ts-expect-error a declaration of another shape
    access: { role: "admin" },
    handler: () => [],
  });

  api.use((_ctx, info, next) => {
    // Middleware is told the declaration, which may be missing at runtime.
    // @ts-expect-error A | undefined, never assumed present
    const access: Access = info.access;
    if (info.type !== "webhook" && info.access !== undefined) {
      const present: Access = info.access;
      void present;
    }
    void access;
    return next();
  });
};

export const requiring = Vex.create<Access>({ storage, plugins: [declared] });

// The engine's declaration is named, never inferred: an engine created
// without one does not take on a plugin's.
// @ts-expect-error the engine declares nothing; the plugin requires Access
Vex.create({ storage, plugins: [declared] });

// A plugin written against an API that requires nothing is not accepted
// by an engine that requires a declaration.
function undeclared(api: VexPluginAPI) {
  api.setName("undeclared");
  api.registerQuery("open", { args: {}, handler: () => [] });
}
// @ts-expect-error its operations declare nothing
Vex.create<Access>({ storage, plugins: [undeclared] });

// Nor is middleware written for an engine without declarations.
declare const plainMiddleware: MiddlewareFn;
Vex.create<Access>({
  storage,
  plugins: [
    (api) => {
      api.setName("mw");
      // @ts-expect-error it cannot handle a declaration
      api.use(plainMiddleware);
    },
  ],
});

// ─── An app that chooses none ───

export const plain = Vex.create({
  storage,
  plugins: [
    (api) => {
      api.setName("plain");
      api.registerQuery("hello", { args: {}, handler: () => "hi" });
      api.registerQuery("odd", {
        args: {},
        // @ts-expect-error there is no declaration to give
        access: "system",
        handler: () => "hi",
      });
    },
  ],
});
