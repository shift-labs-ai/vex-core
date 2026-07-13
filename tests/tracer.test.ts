import { describe, expect, test } from "bun:test";
import { createRootSpan, type Span } from "../src/core/tracer.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("tracer", () => {
  test("head sampling drops a root and all of its children", () => {
    const spans: Span[] = [];
    const decisions: Array<{
      traceId: string;
      app: string;
      type: string;
      name: string;
    }> = [];
    const root = createRootSpan(
      {
        shouldRecord(trace) {
          decisions.push(trace);
          return false;
        },
        onSpan: (span) => spans.push(span),
      },
      "app",
      "query",
      "knowledge.read",
    );

    root.span.child("handler", "knowledge.read").end();
    root.span.end();

    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      app: "app",
      type: "query",
      name: "knowledge.read",
    });
    expect(decisions[0]?.traceId).not.toBe("");
    expect(spans).toEqual([]);
  });

  test("head sampling runs once and retained children inherit the decision", () => {
    const spans: Span[] = [];
    let decisions = 0;
    const root = createRootSpan(
      {
        shouldRecord() {
          decisions++;
          return true;
        },
        onSpan: (span) => spans.push(span),
      },
      "app",
      "query",
      "knowledge.read",
      "trace-from-caller",
    );

    root.span.child("handler", "knowledge.read").end();
    root.span.end();

    expect(decisions).toBe(1);
    expect(spans).toHaveLength(2);
    expect(spans.every((span) => span.traceId === "trace-from-caller")).toBe(
      true,
    );
  });

  test("records start time at span creation and duration in milliseconds", async () => {
    const spans: Span[] = [];
    const before = Date.now();
    const root = createRootSpan(
      { onSpan: (span) => spans.push(span) },
      "app",
      "agent",
      "run",
    );

    await sleep(20);
    root.span.end("ok");
    const after = Date.now();

    expect(spans).toHaveLength(1);
    const [span] = spans;
    expect(span.startTime).toBeGreaterThanOrEqual(before);
    expect(span.startTime).toBeLessThanOrEqual(after - 10);
    expect(span.duration).toBeGreaterThanOrEqual(10);
    expect(span.duration).toBeLessThan(1000);
  });
});
