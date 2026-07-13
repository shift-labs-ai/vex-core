import { describe, expect, test } from "bun:test";
import {
  describeQueryDependencies,
  describeWrites,
} from "../src/core/trace-metadata.js";

describe("trace metadata", () => {
  test("describes query structure without filter values", () => {
    const secret = "workspace-secret-value";
    const metadata = describeQueryDependencies([
      {
        table: "documents",
        filters: [
          { column: "workspaceId", operator: "=", value: secret },
          { column: "createdAt", operator: ">", value: 123 },
        ],
        select: ["title", "createdAt"],
        order: { column: "createdAt", dir: "desc" },
        limit: 25,
        offset: 50,
      },
      { table: "*", raw: true },
    ]);

    expect(metadata).toEqual([
      {
        table: "documents",
        filters: [
          { column: "workspaceId", operator: "=" },
          { column: "createdAt", operator: ">" },
        ],
        select: ["title", "createdAt"],
        order: { column: "createdAt", dir: "desc" },
        limit: 25,
        offset: 50,
      },
      { table: "*", raw: true },
    ]);
    expect(JSON.stringify(metadata)).not.toContain(secret);
  });

  test("describes write structure without row values", () => {
    const secret = "knowledge-content-must-not-enter-a-span";
    const metadata = describeWrites([
      {
        table: "documents",
        values: { workspaceId: "workspace-secret", content: secret },
      },
      { table: "documents" },
      { table: "documents", raw: true },
    ]);

    expect(metadata).toEqual([
      { table: "documents", columns: ["content", "workspaceId"] },
      { table: "documents" },
      { table: "documents", raw: true },
    ]);
    expect(JSON.stringify(metadata)).not.toContain(secret);
  });
});
