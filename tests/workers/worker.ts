import { DurableObject } from "cloudflare:workers";
import { durableObjectAdapter, Vex, type VexPluginAPI } from "vex-core";
import { cors, createRouter, sessions, vexHandler } from "vex-core/http";

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

function tickerPlugin(api: VexPluginAPI) {
  api.setName("ticker");
  api.registerTable("ticks", { columns: { at: { type: "number" } } });
  api.registerJob("tick", {
    schedule: "every 1s",
    async handler(ctx) {
      await ctx.db.table("ticks").insert({ at: Date.now() });
    },
  });
  api.registerQuery("count", {
    args: {},
    async handler(ctx) {
      return ctx.db.table("ticks").count();
    },
  });
}

/** The README's alarm-driven jobs example. */
export class Jobs extends DurableObject {
  vex = Vex.create({
    storage: durableObjectAdapter(this.ctx.storage),
    plugins: [tickerPlugin],
    jobScheduler: "external",
  }).then(async (vex) => {
    await this.scheduleJobs(vex);
    return vex;
  });

  async alarm() {
    const vex = await this.vex;
    await vex.runDueJobs();
    await this.scheduleJobs(vex);
  }

  async scheduleJobs(vex: Vex) {
    const next = await vex.nextJobRun();
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }

  async fetch() {
    const vex = await this.vex;
    return Response.json(await vex.query("ticker.count"));
  }
}

/** Vex over HTTP, with sessions stored in the same object. */
export class Api extends DurableObject {
  storage = durableObjectAdapter(this.ctx.storage);
  router = Vex.create({ storage: this.storage, plugins: [counterPlugin] }).then(
    (vex) =>
      createRouter()
        .use(cors())
        .use(sessions({ storage: this.storage }))
        .post("/login", async (ctx) => {
          ctx.session?.set("user", await ctx.req.text());
          return new Response("ok");
        })
        .get("/me", (ctx) => Response.json(ctx.session?.get("user") ?? null))
        .mount("/vex", vexHandler(vex)),
  );

  async fetch(request: Request) {
    return (await this.router).handle(request);
  }
}

export default {
  fetch: () => new Response(null, { status: 404 }),
};
