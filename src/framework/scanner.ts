import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import type { MiddlewareFn, PluginDef, TableSchema } from "../core/types.js";
import {
  isJob,
  isMiddleware,
  isMutation,
  isQuery,
  isTable,
  isWebhook,
  untag,
} from "./define.js";

export interface ScanResult {
  plugins: PluginDef[];
  tableCount: number;
  queryCount: number;
  mutationCount: number;
  webhookCount: number;
  jobCount: number;
  middlewareCount: number;
}

let importVersion = 0;

async function importFresh(path: string): Promise<any> {
  return import(`${path}?v=${++importVersion}`);
}

function collectTsFiles(dir: string, root: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(full, root));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      results.push(full);
    }
  }
  return results;
}

function fileToPluginName(filePath: string, root: string): string {
  const rel = relative(root, filePath);
  return rel.replace(/\.ts$/, "").replace(/\//g, ".");
}

export async function scanDirectory(dir: string): Promise<ScanResult> {
  if (!existsSync(dir)) {
    throw new Error(`Directory not found: ${dir}`);
  }
  dir = realpathSync(dir);

  const allFiles = collectTsFiles(dir, dir).sort();

  const plugins: PluginDef[] = [];
  const globalMiddleware: MiddlewareFn[] = [];
  let tableCount = 0;
  let queryCount = 0;
  let mutationCount = 0;
  let webhookCount = 0;
  let jobCount = 0;
  let middlewareCount = 0;

  // schema.ts at root is special — only tables
  const schemaFile = allFiles.find((f) => relative(dir, f) === "schema.ts");
  const schemaTables: Record<string, TableSchema> = {};

  if (schemaFile) {
    const mod = await importFresh(schemaFile);
    for (const [name, value] of Object.entries(mod)) {
      if (isTable(value)) {
        schemaTables[name] = untag(value);
        tableCount++;
      }
    }
  }

  // middleware.ts at root is special — global middleware
  const middlewareFile = allFiles.find(
    (f) => relative(dir, f) === "middleware.ts",
  );
  if (middlewareFile) {
    const mod = await importFresh(middlewareFile);
    for (const [_, value] of Object.entries(mod)) {
      if (isMiddleware(value)) {
        globalMiddleware.push(value);
        middlewareCount++;
      }
    }
  }

  // All other .ts files become plugins
  // Name derived from path: messages.ts → "messages", api/users.ts → "api.users"
  const otherFiles = allFiles.filter(
    (f) => f !== schemaFile && f !== middlewareFile,
  );

  for (const file of otherFiles) {
    const pluginName = fileToPluginName(file, dir);
    const mod = await importFresh(file);

    const tables: Record<string, TableSchema> = {};
    const queries: PluginDef["queries"] = {};
    const mutations: PluginDef["mutations"] = {};
    const webhooks: PluginDef["webhooks"] = {};
    const jobs: PluginDef["jobs"] = {};

    for (const [exportName, value] of Object.entries(mod)) {
      if (isTable(value)) {
        tables[`${pluginName}_${exportName}`] = untag(value);
        tableCount++;
      } else if (isQuery(value)) {
        queries[exportName] = untag(value);
        queryCount++;
      } else if (isMutation(value)) {
        mutations[exportName] = untag(value);
        mutationCount++;
      } else if (isWebhook(value)) {
        webhooks[exportName] = untag(value);
        webhookCount++;
      } else if (isJob(value)) {
        jobs[exportName] = untag(value);
        jobCount++;
      } else if (isMiddleware(value)) {
        globalMiddleware.push(value);
        middlewareCount++;
      }
    }

    const hasContent =
      Object.keys(queries).length > 0 ||
      Object.keys(mutations).length > 0 ||
      Object.keys(webhooks).length > 0 ||
      Object.keys(jobs).length > 0 ||
      Object.keys(tables).length > 0;

    if (hasContent) {
      plugins.push({
        name: pluginName,
        tables,
        queries,
        mutations,
        jobs: Object.keys(jobs).length > 0 ? jobs : undefined,
        webhooks: Object.keys(webhooks).length > 0 ? webhooks : undefined,
      });
    }
  }

  if (Object.keys(schemaTables).length > 0) {
    plugins.unshift({
      name: "schema",
      tables: schemaTables,
      queries: {},
      mutations: {},
    });
  }

  // Attach global middleware to first plugin with queries or mutations
  if (globalMiddleware.length > 0) {
    const target = plugins.find(
      (p) =>
        Object.keys(p.queries).length > 0 ||
        Object.keys(p.mutations).length > 0,
    );
    if (target) target.middleware = globalMiddleware;
  }

  return {
    plugins,
    tableCount,
    queryCount,
    mutationCount,
    webhookCount,
    jobCount,
    middlewareCount,
  };
}
