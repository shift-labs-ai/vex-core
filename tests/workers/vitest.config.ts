import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Runs tests/workers/ inside workerd. The storage suites import
// "bun:test", which resolves to ./bun-test.ts here.
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: fileURLToPath(new URL("./worker.ts", import.meta.url)),
      miniflare: {
        compatibilityDate: "2026-10-01",
        // Subscriptions and vex-core/http use node:crypto outside Bun.
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: {
          STORE: { className: "TestStore", useSQLite: true },
          APP: { className: "App", useSQLite: true },
          JOBS: { className: "Jobs", useSQLite: true },
          API: { className: "Api", useSQLite: true },
        },
      },
    }),
  ],
  resolve: {
    alias: {
      "bun:test": fileURLToPath(new URL("./bun-test.ts", import.meta.url)),
    },
  },
  test: {
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["**/*.test.ts"],
  },
});
