import { describe, expect, test } from "bun:test";
import { hashResult, utf8ByteLength } from "../src/core/result-measure.js";

describe("result measurement", () => {
  test("equal results hash equal, different ones differ", () => {
    const a = JSON.stringify([{ name: "a", age: 1 }]);
    expect(hashResult(a)).toBe(hashResult(JSON.stringify(JSON.parse(a))));
    expect(hashResult(a)).not.toBe(hashResult(a.replace("1", "2")));
  });

  test("byte length is UTF-8 with and without Buffer", () => {
    const text = "héllo €𝄞";
    expect(utf8ByteLength(text)).toBe(14);
    const buffer = globalThis.Buffer;
    try {
      (globalThis as { Buffer?: unknown }).Buffer = undefined;
      expect(utf8ByteLength(text)).toBe(14);
    } finally {
      globalThis.Buffer = buffer;
    }
  });
});
