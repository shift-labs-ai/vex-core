/**
 * Measures serialized query results: a hash for subscription change
 * detection, and a UTF-8 byte length for reactive budgets and traces.
 *
 * Bun hashes natively with `Bun.hash` (wyhash, ~30 GB/s). Elsewhere the
 * hash is SHA-1 from `node:crypto` (~2-3 GB/s), loaded on first use, so
 * on Cloudflare Workers the engine needs the `nodejs_compat` flag only
 * for subscriptions. No JavaScript hash comes close to `Bun.hash`, and
 * the WebAssembly ones that do cannot load on Workers, which refuse to
 * compile WebAssembly at runtime. Hashes are only compared within one
 * process, so the two need not agree.
 */

type NodeCrypto = typeof import("node:crypto");

export const hashResult: (serialized: string) => number =
  typeof Bun !== "undefined"
    ? (serialized) => Number(Bun.hash(serialized))
    : sha1;

let nodeCrypto: NodeCrypto | undefined;

function sha1(serialized: string): number {
  nodeCrypto ??= globalThis.process?.getBuiltinModule?.("node:crypto") as
    | NodeCrypto
    | undefined;
  if (!nodeCrypto) {
    throw new Error(
      "vex-core subscriptions need node:crypto outside Bun; on Cloudflare Workers, enable the nodejs_compat compatibility flag",
    );
  }
  // The first 52 bits, the most a number holds exactly.
  return Number.parseInt(
    nodeCrypto.createHash("sha1").update(serialized).digest("hex").slice(0, 13),
    16,
  );
}

const encoder = new TextEncoder();

export function utf8ByteLength(text: string): number {
  return globalThis.Buffer
    ? globalThis.Buffer.byteLength(text)
    : encoder.encode(text).length;
}
