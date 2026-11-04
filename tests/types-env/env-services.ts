/**
 * An app types its settings and capabilities once, by augmenting
 * `VexEnv` and `VexServices`; every context reads `env` as declared,
 * and only an action's holds `services`.
 */

import type { VexPluginAPI } from "../../src/core/api.js";
import type { VexOptions } from "../../src/core/engine.js";
import type { StorageAdapter } from "../../src/core/storage.js";
import { Type } from "../../src/portable.js";

declare const storage: StorageAdapter;
const hostManager = { spawn: async (_name: string) => {} };

// Declared fields are required: an engine is never built without them.
export const full: VexOptions = {
  storage,
  plugins: [],
  env: { sessionRoot: "/data" },
  services: { hostManager },
};
// @ts-expect-error: the env the app declared is missing
export const noEnv: VexOptions = {
  storage,
  plugins: [],
  services: { hostManager },
};
// @ts-expect-error: the services the app declared are missing
export const noServices: VexOptions = {
  storage,
  plugins: [],
  env: { sessionRoot: "/data" },
};
export const wrongEnv: VexOptions = {
  storage,
  plugins: [],
  // @ts-expect-error: env holds the types the app declared
  env: { sessionRoot: 1 },
  services: { hostManager },
};

declare module "../../src/core/types.js" {
  interface VexEnv {
    sessionRoot: string;
  }
  interface VexServices {
    hostManager: { spawn(name: string): Promise<void> };
  }
}

export function plugin(api: VexPluginAPI) {
  const root: string = api.env.sessionRoot;
  void root;
  api.registerQuery("q", {
    args: {},
    handler: (ctx) => {
      const r: string = ctx.env.sessionRoot;
      // @ts-expect-error: env holds only what the app declares
      ctx.env.undeclared;
      // @ts-expect-error: env is read, never written
      ctx.env.sessionRoot = "/elsewhere";
      // @ts-expect-error: a query holds no services
      ctx.services;
      return r;
    },
  });
  api.registerMutation("m", {
    args: {},
    handler: (ctx) => {
      // @ts-expect-error: a mutation holds no services
      ctx.services;
      return ctx.env.sessionRoot;
    },
  });
  api.registerAction("a", {
    args: { name: Type.String() },
    handler: async (ctx, args) => {
      await ctx.services.hostManager.spawn(args.name);
      // @ts-expect-error: services hold only what the app declares
      ctx.services.undeclared;
      return ctx.env.sessionRoot;
    },
  });
}
