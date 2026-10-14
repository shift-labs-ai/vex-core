import { DurableObject } from "cloudflare:workers";
import { durableObjectAdapter, Vex, type VexPluginAPI } from "vex-core";

/**
 * A bare SQLite-backed Durable Object. The tests reach its storage
 * through `runInDurableObject`.
 */
export class TestStore extends DurableObject {}

function counterPlugin(api: VexPluginAPI) {
  api.setName("counter");
  api.registerTable("counters", {
    columns: { key: { type: "string" }, value: { type: "number" } },
  });
  api.registerMutation("set", {
    args: { key: "string", value: "number" },
    async handler(ctx, args) {
      return ctx.db.table("counters").insert(args);
    },
  });
  api.registerQuery("list", {
    args: {},
    async handler(ctx) {
      return ctx.db.table("counters").all();
    },
  });
}

/** The README's Durable Object example, served over real requests. */
export class App extends DurableObject {
  vex = Vex.create({
    storage: durableObjectAdapter(this.ctx.storage),
    plugins: [counterPlugin],
  });

  async fetch() {
    const vex = await this.vex;
    await vex.mutate("counter.set", { key: "hits", value: 1 });
    return Response.json(await vex.query("counter.list"));
  }
}

export default {
  fetch: () => new Response(null, { status: 404 }),
};
