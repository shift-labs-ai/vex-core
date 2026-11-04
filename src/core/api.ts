import type {
  ActionDef,
  JobDef,
  MiddlewareFn,
  MutationDef,
  PluginDef,
  QueryDef,
  TableSchema,
  WebhookDef,
} from "./types.js";
import type { ArgsShape } from "./values.js";

/**
 * What a plugin registers through. `A` is the app's access declaration
 * (`OperationAccess`): a plugin written against an API that declares
 * none is not one an engine requiring a declaration accepts.
 */
export interface VexPluginAPI<A = undefined> {
  setName(name: string): void;
  registerTable(name: string, schema: TableSchema): void;
  registerQuery<S extends ArgsShape>(name: string, def: QueryDef<A, S>): void;
  registerMutation<S extends ArgsShape>(
    name: string,
    def: MutationDef<A, S>,
  ): void;
  registerAction<S extends ArgsShape>(name: string, def: ActionDef<A, S>): void;
  registerJob(name: string, def: JobDef): void;
  registerWebhook(name: string, def: WebhookDef): void;
  use(fn: MiddlewareFn<A>): void;
}

export type PluginFunction<A = undefined> = (api: VexPluginAPI<A>) => void;

export function createPluginAPI<A = undefined>(): {
  api: VexPluginAPI<A>;
  resolve: () => PluginDef<A>;
} {
  let name = "unknown";
  const tables: Record<string, TableSchema> = {};
  const queries: Record<string, QueryDef<A>> = {};
  const mutations: Record<string, MutationDef<A>> = {};
  const actions: Record<string, ActionDef<A>> = {};
  const jobs: Record<string, JobDef> = {};
  const webhooks: Record<string, WebhookDef> = {};
  const middleware: MiddlewareFn<A>[] = [];

  const api: VexPluginAPI<A> = {
    setName(n: string) {
      name = n;
    },
    registerTable(tableName: string, schema: TableSchema) {
      tables[tableName] = schema;
    },
    registerQuery<S extends ArgsShape>(queryName: string, def: QueryDef<A, S>) {
      queries[queryName] = def as QueryDef<A, any>;
    },
    registerMutation<S extends ArgsShape>(
      mutationName: string,
      def: MutationDef<A, S>,
    ) {
      mutations[mutationName] = def as MutationDef<A, any>;
    },
    registerAction<S extends ArgsShape>(
      actionName: string,
      def: ActionDef<A, S>,
    ) {
      actions[actionName] = def as ActionDef<A, any>;
    },
    registerJob(jobName: string, def: JobDef) {
      jobs[jobName] = def;
    },
    registerWebhook(webhookName: string, def: WebhookDef) {
      webhooks[webhookName] = def;
    },
    use(fn: MiddlewareFn<A>) {
      middleware.push(fn);
    },
  };

  function resolve(): PluginDef<A> {
    return {
      name,
      tables,
      queries,
      mutations,
      actions,
      jobs,
      webhooks,
      middleware: middleware.length > 0 ? middleware : undefined,
    };
  }

  return { api, resolve };
}

export function resolvePlugin<A = undefined>(
  input: PluginFunction<A> | PluginDef<A>,
): PluginDef<A> {
  if (typeof input === "function") {
    const { api, resolve } = createPluginAPI<A>();
    input(api);
    return resolve();
  }
  return input;
}
