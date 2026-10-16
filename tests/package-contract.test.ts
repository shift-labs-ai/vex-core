import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ANY_TABLE, type Changes } from "../src/index.js";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { engines?: Record<string, string> };

describe("package runtime contract", () => {
  test("declares Bun as its only supported runtime", () => {
    expect(packageJson.engines).toEqual({ bun: ">=1.3.0" });
  });
});

describe("package exports", () => {
  test("give a custom StorageAdapter what takeChanges reports", () => {
    const changes: Changes = { tables: [ANY_TABLE], unattributed: [ANY_TABLE] };
    expect(changes.tables).toEqual(["*"]);
  });
});
