import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  isJob,
  isMiddleware,
  isMutation,
  isQuery,
  isTable,
  isWebhook,
  job,
  middleware,
  mutation,
  query,
  table,
  webhook,
} from "../src/framework/define.js";
import { scanDirectory } from "../src/framework/scanner.js";

// ─── define helpers ───

describe("define", () => {
  test("table() returns tagged table schema", () => {
    const t = table({ name: "string", age: "number" });
    expect(isTable(t)).toBe(true);
    expect(t.columns.name.type).toBe("string");
    expect(t.columns.age.type).toBe("number");
    expect("storage" in t).toBe(false);
  });

  test("table() with column options", () => {
    const t = table({ email: { type: "string", index: true, optional: true } });
    expect(t.columns.email).toEqual({
      type: "string",
      index: true,
      optional: true,
    });
  });

  test("table() takes table options and every column option", () => {
    const t = table(
      { title: { type: "string", default: "", renamedFrom: ["text"] } },
      { renamedFrom: ["chat_msgs"], unique: [["title"]] },
    );
    expect(t.renamedFrom).toEqual(["chat_msgs"]);
    expect(t.unique).toEqual([["title"]]);
    expect(t.columns.title).toEqual({
      type: "string",
      default: "",
      renamedFrom: ["text"],
    });
  });

  test("query() returns tagged query", () => {
    const handler = async () => [];
    const q = query({ limit: "number" }, handler);
    expect(isQuery(q)).toBe(true);
    expect(q.args).toEqual({ limit: "number" });
    expect(q.handler).toBe(handler);
  });

  test("mutation() returns tagged mutation", () => {
    const handler = async () => {};
    const m = mutation({ name: "string" }, handler);
    expect(isMutation(m)).toBe(true);
    expect(m.args).toEqual({ name: "string" });
  });

  test("webhook() simple form", () => {
    const handler = async () => ({ status: 200 });
    const w = webhook("/hook", handler);
    expect(isWebhook(w)).toBe(true);
    expect(w.path).toBe("/hook");
    expect(w.handler).toBe(handler);
    expect(w.method).toBeUndefined();
  });

  test("webhook() with options", () => {
    const verify = () => true;
    const handler = async () => ({});
    const w = webhook("/hook", { method: "POST", verify }, handler);
    expect(w.method).toBe("POST");
    expect(w.verify).toBe(verify);
    expect(w.handler).toBe(handler);
  });

  test("job() returns tagged job", () => {
    const handler = async () => {};
    const j = job("*/5 * * * *", handler);
    expect(isJob(j)).toBe(true);
    expect(j.schedule).toBe("*/5 * * * *");
  });

  test("middleware() returns tagged callable", () => {
    const fn = async (_ctx: any, _info: any, next: any) => next();
    const m = middleware(fn);
    expect(isMiddleware(m)).toBe(true);
    expect(typeof m).toBe("function");
  });

  test("type guards reject wrong kinds", () => {
    const q = query({}, async () => []);
    expect(isTable(q)).toBe(false);
    expect(isMutation(q)).toBe(false);
    expect(isQuery(null)).toBe(false);
    expect(isTable(undefined)).toBe(false);
    expect(isJob("string")).toBe(false);
  });
});

// ─── scanner ───

const TMP = join(import.meta.dir, ".tmp-scan");
const DEFINE = join(import.meta.dir, "../src/framework/define.js");

function writeFile(path: string, content: string) {
  const full = join(TMP, path);
  mkdirSync(join(full, ".."), { recursive: true });
  // Replace placeholder import with absolute path
  writeFileSync(full, content.replace(/@vex\/define/g, DEFINE));
}

describe("scanner", () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  test("scans schema.ts for tables", async () => {
    writeFile(
      "schema.ts",
      `import { table } from "@vex/define";
       export const users = table({ name: "string" });
       export const posts = table({ title: "string" });`,
    );
    const result = await scanDirectory(TMP);
    expect(result.tableCount).toBe(2);
    expect(result.plugins[0].name).toBe("schema");
    expect(result.plugins[0].tables).toHaveProperty("users");
    expect(result.plugins[0].tables).toHaveProperty("posts");
  });

  test("scans query and mutation files as plugins", async () => {
    writeFile(
      "todos.ts",
      `import { query, mutation } from "@vex/define";
       export const list = query({}, async () => []);
       export const create = mutation({ text: "string" }, async () => {});`,
    );
    const result = await scanDirectory(TMP);
    expect(result.queryCount).toBe(1);
    expect(result.mutationCount).toBe(1);
    const plugin = result.plugins.find((p) => p.name === "todos");
    expect(plugin).toBeDefined();
    expect(plugin!.queries).toHaveProperty("list");
    expect(plugin!.mutations).toHaveProperty("create");
  });

  test("subdirectories become dot-namespaced plugins", async () => {
    writeFile(
      "api/users.ts",
      `import { query } from "@vex/define";
       export const list = query({}, async () => []);`,
    );
    const result = await scanDirectory(TMP);
    const plugin = result.plugins.find((p) => p.name === "api.users");
    expect(plugin).toBeDefined();
    expect(plugin!.queries).toHaveProperty("list");
  });

  test("deeply nested files", async () => {
    writeFile(
      "api/v2/admin/stats.ts",
      `import { query } from "@vex/define";
       export const count = query({}, async () => 42);`,
    );
    const result = await scanDirectory(TMP);
    const plugin = result.plugins.find((p) => p.name === "api.v2.admin.stats");
    expect(plugin).toBeDefined();
  });

  test("middleware.ts applies globally to first plugin with handlers", async () => {
    writeFile(
      "schema.ts",
      `import { table } from "@vex/define";
       export const items = table({ name: "string" });`,
    );
    writeFile(
      "middleware.ts",
      `import { middleware } from "@vex/define";
       export const auth = middleware(async (ctx, info, next) => next());`,
    );
    writeFile(
      "items.ts",
      `import { query } from "@vex/define";
       export const list = query({}, async () => []);`,
    );
    const result = await scanDirectory(TMP);
    expect(result.middlewareCount).toBe(1);
    // Should be on items plugin, not schema
    const schema = result.plugins.find((p) => p.name === "schema");
    const items = result.plugins.find((p) => p.name === "items");
    expect(schema!.middleware).toBeUndefined();
    expect(items!.middleware).toHaveLength(1);
  });

  test("skips .test.ts files", async () => {
    writeFile(
      "todos.ts",
      `import { query } from "@vex/define";
       export const list = query({}, async () => []);`,
    );
    writeFile(
      "todos.test.ts",
      `import { query } from "@vex/define";
       export const shouldNotAppear = query({}, async () => []);`,
    );
    const result = await scanDirectory(TMP);
    expect(result.queryCount).toBe(1);
  });

  test("skips files with no vex exports", async () => {
    writeFile(
      "utils.ts",
      `export function add(a: number, b: number) { return a + b; }`,
    );
    const result = await scanDirectory(TMP);
    expect(result.plugins).toHaveLength(0);
  });

  test("throws on missing directory", async () => {
    expect(scanDirectory("/tmp/does-not-exist-vex")).rejects.toThrow(
      "Directory not found",
    );
  });

  test("webhooks and jobs get scanned", async () => {
    writeFile(
      "hooks.ts",
      `import { webhook, job } from "@vex/define";
       export const stripe = webhook("/stripe", async () => ({ status: 200 }));
       export const cleanup = job("0 * * * *", async () => {});`,
    );
    const result = await scanDirectory(TMP);
    expect(result.webhookCount).toBe(1);
    expect(result.jobCount).toBe(1);
    const plugin = result.plugins.find((p) => p.name === "hooks");
    expect(plugin!.webhooks!.stripe.path).toBe("/stripe");
    expect(plugin!.jobs!.cleanup.schedule).toBe("0 * * * *");
  });

  test("tables in non-schema files get prefixed with plugin name", async () => {
    writeFile(
      "chat.ts",
      `import { table, query } from "@vex/define";
       export const messages = table({ text: "string" });
       export const list = query({}, async () => []);`,
    );
    const result = await scanDirectory(TMP);
    const plugin = result.plugins.find((p) => p.name === "chat");
    expect(plugin!.tables).toHaveProperty("chat_messages");
  });

  test("definitions keep every option except the definition tag", async () => {
    writeFile(
      "chat.ts",
      `import { query, table } from "@vex/define";
       const access = { prepare: () => null, filter: () => true };
       export const messages = table(
         { text: { type: "string", renamedFrom: ["body"] } },
         { renamedFrom: ["chat_msgs"], unique: [["text"]], access },
       );
       export const exportAll = { ...query({}, async () => []), reactive: false };`,
    );
    const result = await scanDirectory(TMP);
    const plugin = result.plugins.find((p) => p.name === "chat")!;
    expect(isQuery(plugin.queries.exportAll)).toBe(false);
    expect(plugin.queries.exportAll.reactive).toBe(false);
    const schema = plugin.tables.chat_messages;
    expect(isTable(schema)).toBe(false);
    expect(schema.renamedFrom).toEqual(["chat_msgs"]);
    expect(schema.unique).toEqual([["text"]]);
    expect(schema.access).toBeDefined();
    expect(schema.columns.text.renamedFrom).toEqual(["body"]);
  });
});
