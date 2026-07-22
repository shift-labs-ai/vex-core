import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRouter,
  errorBoundary,
  serveDir,
  serveFile,
} from "../../src/http/index.js";

/**
 * serveDir / serveFile — explicit route handlers, not fallbacks.
 *
 * The namespace model: a router assigns each URL namespace exactly one
 * owner. `serveDir` owns an asset namespace (bytes or 404 — never HTML,
 * never fall-through). `serveFile` owns the document namespace (the SPA
 * shell for every client-routed URL, dotted or not). No Accept sniffing,
 * no extension heuristics, no 404-then-retry.
 */

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "vex-serve-static-"));
  writeFileSync(join(root, "index.html"), "<html>shell</html>");
  writeFileSync(join(root, "favicon.ico"), "icon-bytes");
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "assets", "app-abc123.js"), "console.log(1)");
  writeFileSync(join(root, "assets", "app-abc123.css"), "body{}");
  writeFileSync(join(root, "secret.txt"), "top secret");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The composition under test — the exact shape vex uses. */
function buildApp() {
  return createRouter()
    .use(errorBoundary({ logger: () => {} }))
    .get("/api/data", () => Response.json({ ok: true }))
    .get(
      "/assets/*",
      serveDir({
        dir: join(root, "assets"),
        stripPrefix: "/assets",
        cacheControl: "public, max-age=31536000, immutable",
      }),
    )
    .get("/favicon.ico", serveFile(join(root, "favicon.ico")))
    .get("/*", serveFile(join(root, "index.html")));
}

describe("serveDir — the asset namespace owner", () => {
  test("serves an existing file with its content type and cache policy", async () => {
    const res = await buildApp().handle(
      new Request("http://x/assets/app-abc123.js"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(await res.text()).toBe("console.log(1)");
  });

  test("a missing asset is a 404 — never the app shell", async () => {
    // The document route `/*` is registered after the asset route. If
    // serveDir fell through instead of owning its namespace, this would
    // deliver HTML into a <script> tag.
    const res = await buildApp().handle(new Request("http://x/assets/gone.js"));
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("<html>");
  });

  test("encoded traversal never leaks file contents through the app", async () => {
    // The WHATWG URL parser collapses %2e%2e into a dot-segment before
    // routing, so this lands on the document route — which serves the
    // shell, not the file. Assert the invariant that matters: the
    // secret is unreachable through any route.
    const res = await buildApp().handle(
      new Request("http://x/assets/%2e%2e/secret.txt"),
    );
    expect(await res.text()).not.toContain("top secret");
  });

  test("serveDir's own guard rejects a pathname that retains ..", async () => {
    // Defense in depth: if a runtime ever hands the handler an
    // un-collapsed path (proxy rewrite, exotic client), the resolve
    // guard must still hold. Drive the handler directly.
    const handler = serveDir({
      dir: join(root, "assets"),
      stripPrefix: "/assets",
    });
    const url = new URL("http://x/assets/placeholder");
    Object.defineProperty(url, "pathname", {
      value: "/assets/../secret.txt",
    });
    const req = new Request("http://x/assets/placeholder");
    const res = await handler({
      req,
      url,
      params: {},
      state: {},
      signal: req.signal,
    });
    expect(res?.status).toBe(404);
  });

  test("HEAD answers with headers and length but no body", async () => {
    const app = createRouter().head(
      "/assets/*",
      serveDir({ dir: join(root, "assets"), stripPrefix: "/assets" }),
    );
    const res = await app.handle(
      new Request("http://x/assets/app-abc123.css", { method: "HEAD" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("6");
    expect(await res.text()).toBe("");
  });

  test("cache policy defaults to no-cache", async () => {
    const app = createRouter().get(
      "/assets/*",
      serveDir({ dir: join(root, "assets"), stripPrefix: "/assets" }),
    );
    const res = await app.handle(new Request("http://x/assets/app-abc123.js"));
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });
});

describe("serveFile — the document namespace owner", () => {
  test("serves the shell at the root", async () => {
    const res = await buildApp().handle(new Request("http://x/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toBe("<html>shell</html>");
  });

  test("serves the shell for extension-less client routes", async () => {
    const res = await buildApp().handle(new Request("http://x/overview"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<html>shell</html>");
  });

  test("serves the shell for dotted client routes (SHFT-837)", async () => {
    const res = await buildApp().handle(
      new Request(
        "http://x/agents/ws1/knowledge/features/plain-stop-command.md",
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toBe("<html>shell</html>");
  });

  test("serves exact non-HTML files too (favicon route)", async () => {
    const res = await buildApp().handle(new Request("http://x/favicon.ico"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/x-icon");
    expect(await res.text()).toBe("icon-bytes");
  });

  test("explicit routes registered above still win", async () => {
    const res = await buildApp().handle(new Request("http://x/api/data"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("a missing file is a 404, not a crash", async () => {
    const app = createRouter()
      .use(errorBoundary({ logger: () => {} }))
      .get("/*", serveFile(join(root, "not-built.html")));
    const res = await app.handle(new Request("http://x/anything"));
    expect(res.status).toBe(404);
  });

  test("HEAD on the shell answers headers only", async () => {
    const app = createRouter().head("/*", serveFile(join(root, "index.html")));
    const res = await app.handle(
      new Request("http://x/overview", { method: "HEAD" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("18");
    expect(await res.text()).toBe("");
  });

  test("POST to a document URL is not owned by a GET shell route", async () => {
    const res = await buildApp().handle(
      new Request("http://x/overview", { method: "POST" }),
    );
    expect(res.status).toBe(404);
  });
});
