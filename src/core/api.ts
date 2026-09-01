import type {
  DispatchFn,
  JobDef,
  MiddlewareFn,
  MutationDef,
  PluginDef,
  QueryDef,
  TableSchema,
  WebhookDef,
} from "./types.js";

export interface VexPluginAPI {
  setName(name: string): void;
  registerTable(name: string, schema: TableSchema): void;
  registerQuery(name: string, def: QueryDef): void;
  registerMutation(name: string, def: MutationDef): void;
  registerJob(name: string, def: JobDef): void;
  registerWebhook(name: string, def: WebhookDef): void;
  use(fn: MiddlewareFn): void;
  useDispatch(fn: DispatchFn): void;
}

export type PluginFunction = (api: VexPluginAPI) => void;

export function createPluginAPI(): {
  api: VexPluginAPI;
  resolve: () => PluginDef;
} {
  let name = "unknown";
  const tables: Record<string, TableSchema> = {};
  const queries: Record<string, QueryDef> = {};
  const mutations: Record<string, MutationDef> = {};
  const jobs: Record<string, JobDef> = {};
  const webhooks: Record<string, WebhookDef> = {};
  const middleware: MiddlewareFn[] = [];
  const dispatch: DispatchFn[] = [];

  const api: VexPluginAPI = {
    setName(n: string) {
      name = n;
    },
    registerTable(tableName: string, schema: TableSchema) {
      tables[tableName] = schema;
    },
    registerQuery(queryName: string, def: QueryDef) {
      queries[queryName] = def;
    },
    registerMutation(mutationName: string, def: MutationDef) {
      mutations[mutationName] = def;
    },
    registerJob(jobName: string, def: JobDef) {
      jobs[jobName] = def;
    },
    registerWebhook(webhookName: string, def: WebhookDef) {
      webhooks[webhookName] = def;
    },
    use(fn: MiddlewareFn) {
      middleware.push(fn);
    },
    useDispatch(fn: DispatchFn) {
      dispatch.push(fn);
    },
  };

  function resolve(): PluginDef {
    return {
      name,
      tables,
      queries,
      mutations,
      jobs,
      webhooks,
      middleware: middleware.length > 0 ? middleware : undefined,
      dispatch: dispatch.length > 0 ? dispatch : undefined,
    };
  }

  return { api, resolve };
}

export function resolvePlugin(input: PluginFunction | PluginDef): PluginDef {
  if (typeof input === "function") {
    const { api, resolve } = createPluginAPI();
    input(api);
    return resolve();
  }
  return input;
}
