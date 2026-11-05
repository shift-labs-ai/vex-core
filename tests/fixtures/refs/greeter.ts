/** A plugin a test passes by module: its default export. */

import type { VexPluginAPI } from "../../../src/core/api.js";

export default function greeter(api: VexPluginAPI) {
  api.setName("greeter");
  api.registerQuery("hello", {
    args: {},
    handler: (ctx) => `hello from ${(ctx.env as { place?: string }).place}`,
  });
}
