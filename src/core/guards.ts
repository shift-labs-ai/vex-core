/**
 * What a handler may reach beyond its context, decided here, once:
 * a query or mutation handler (and the middleware around it) runs in a
 * frame where every way to read the clock, draw randomness, do I/O,
 * schedule work or read the process's environment is refused, each
 * with the context's way to do what it wanted. Any handler calling the
 * engine directly, rather than through its context, is refused too.
 *
 * Globals are guarded wherever this module loads. A node built-in
 * module (`node:fs`, `node:crypto`, …) binds a named import the first
 * time it is imported, so its guard holds only when installed before
 * the app's modules load: `bun --preload vex-core/guard`. The engine
 * refuses to start without it (`assertGuarded`).
 *
 * The engine reads its own clock, randomness and timers through
 * `ambient.ts`, captured before anything here is installed.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** The kind of handler a frame runs. */
export type FrameKind = "query" | "mutation" | "action";

interface Frame {
  readonly kind: FrameKind;
  readonly name: string;
}

const frames = new AsyncLocalStorage<Frame>();
// Set while a guard calls a wrapper assigned over it: the wrapper's
// own call to the function it wrapped goes to the original.
const throughWrapper = new AsyncLocalStorage<boolean>();

/** Runs `fn` as handler `name` of `kind`. */
export function inFrame<T>(kind: FrameKind, name: string, fn: () => T): T {
  return frames.run({ kind, name }, fn);
}

/** Runs `fn` outside any handler's frame: the engine's own work. */
export function outsideFrame<T>(fn: () => T): T {
  return frames.exit(fn);
}

/**
 * Refuses a direct call into the engine from inside a handler: what a
 * handler reads and writes goes through its context, which tracks it,
 * decides it and answers it as its caller.
 */
export function refuseReentry(call: string): void {
  const frame = frames.getStore();
  if (frame) {
    throw new GuardError(
      `${call} is refused inside ${frame.kind} ${frame.name}: call through the handler's context (ctx${frame.kind === "action" ? `.${call.split(".").pop()}` : ".db"})`,
    );
  }
}

/** A refusal: what a handler reached for, and what to use instead. */
export class GuardError extends Error {
  override readonly name = "GuardError";
}

/** What a refused reach is, and the way the context offers instead. */
type Category = "time" | "random" | "io" | "timer" | "env";

const INSTEAD: Record<Category, Record<"query" | "mutation", string>> = {
  time: {
    query:
      "read the time with ctx.now(resolutionMs), which re-runs the query when it moves on",
    mutation: "read the time with ctx.now(), one value for the whole call",
  },
  random: {
    query:
      "randomness is a write: draw it in a mutation (ctx.random(), ctx.id()) and read it back",
    mutation: "use ctx.random() or ctx.id()",
  },
  io: {
    query:
      "I/O belongs in an action: do it there and write what it found through ctx.mutate",
    mutation:
      "I/O belongs in an action: do it there and write what it found through ctx.mutate",
  },
  timer: {
    query: "a handler answers when it is done: wait in an action",
    mutation: "a handler answers when it is done: wait in an action",
  },
  env: {
    query: "read configuration when the plugin registers and close over it",
    mutation: "read configuration when the plugin registers and close over it",
  },
};

function refusal(label: string, category: Category): GuardError | null {
  const frame = frames.getStore();
  if (!frame || frame.kind === "action") return null;
  return new GuardError(
    `${label} is refused in ${frame.kind} ${frame.name}: ${INSTEAD[category][frame.kind]}`,
  );
}

const GUARDED = Symbol.for("vex.guarded");
/** A guard's own function, for the engine's reads (`ambient.ts`). */
const ORIGINAL = Symbol.for("vex.original");

function guardFunction(
  owner: Record<string, any> | undefined,
  key: string,
  label: string,
  category: Category,
): void {
  if (!owner) return;
  const original = owner[key];
  if (typeof original !== "function" || original[GUARDED]) return;
  // What the guard calls through to: the original, or a wrapper a
  // library or instrumentation assigned since (the setter below).
  let inner: (...args: any[]) => any = original;
  const through = (call: () => any) =>
    inner === original ? call() : throughWrapper.run(true, call);
  const guarded = new Proxy(original, {
    apply(target, self, args) {
      // A wrapper calling the function it wrapped reaches the original.
      if (throughWrapper.getStore()) return Reflect.apply(target, self, args);
      const refused = refusal(label, category);
      if (refused) throw refused;
      return through(() => Reflect.apply(inner, self, args));
    },
    construct(target, args, newTarget) {
      if (throughWrapper.getStore()) {
        return Reflect.construct(target, args, newTarget);
      }
      const refused = refusal(label, category);
      if (refused) throw refused;
      return through(() =>
        Reflect.construct(
          inner,
          args,
          newTarget === guarded ? inner : newTarget,
        ),
      );
    },
    get(target, prop, receiver) {
      if (prop === GUARDED) return true;
      if (prop === ORIGINAL) return target;
      return Reflect.get(target, prop, receiver);
    },
  });
  // An accessor: reading it is always the guard, and assigning to it
  // (a library wrapping it) changes only what the guard calls through
  // to, so a wrapper never unguards it.
  try {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    Object.defineProperty(owner, key, {
      configurable: true,
      enumerable: descriptor?.enumerable ?? true,
      get: () => guarded,
      set: (fn: unknown) => {
        if (typeof fn === "function" && fn !== guarded) {
          inner = fn as (...args: any[]) => any;
        } else if (fn === guarded) {
          inner = original;
        }
      },
    });
  } catch {
    // A property that cannot become an accessor (the runtime's own,
    // such as Bun's) is assigned instead; one that cannot be assigned
    // either stays unguarded, and `assertGuarded` names it.
    try {
      owner[key] = guarded;
    } catch {}
  }
}

/** Every function an object exposes, guarded as `category`. */
function guardAll(
  owner: Record<string, any> | undefined,
  prefix: string,
  category: Category,
): void {
  if (!owner) return;
  for (const key of Object.keys(owner)) {
    if (typeof owner[key] === "function") {
      guardFunction(owner, key, `${prefix}.${key}`, category);
    }
  }
}

/**
 * The globals: looked up when called, so guarded wherever this runs.
 * Each `[owner, key, label, category]`; an owner a runtime lacks is
 * skipped.
 */
function globalInventory(): Array<
  [Record<string, any> | undefined, string, string, Category]
> {
  const g = globalThis as Record<string, any>;
  const bun = g.Bun as Record<string, any> | undefined;
  const proc = g.process as Record<string, any> | undefined;
  return [
    // The clock.
    [g.Date, "now", "Date.now", "time"],
    [g.performance, "now", "performance.now", "time"],
    [proc, "hrtime", "process.hrtime", "time"],
    [proc?.hrtime, "bigint", "process.hrtime.bigint", "time"],
    [proc, "uptime", "process.uptime", "time"],
    [bun, "nanoseconds", "Bun.nanoseconds", "time"],
    // Randomness.
    [g.Math, "random", "Math.random", "random"],
    [g.crypto, "getRandomValues", "crypto.getRandomValues", "random"],
    [g.crypto, "randomUUID", "crypto.randomUUID", "random"],
    [g.crypto?.subtle, "generateKey", "crypto.subtle.generateKey", "random"],
    [bun, "randomUUIDv7", "Bun.randomUUIDv7", "random"],
    // I/O.
    [g, "fetch", "fetch", "io"],
    [g, "WebSocket", "WebSocket", "io"],
    [g, "EventSource", "EventSource", "io"],
    [g, "XMLHttpRequest", "XMLHttpRequest", "io"],
    [g, "Worker", "Worker", "io"],
    [g, "BroadcastChannel", "BroadcastChannel", "io"],
    [bun, "file", "Bun.file", "io"],
    [bun, "write", "Bun.write", "io"],
    [bun, "spawn", "Bun.spawn", "io"],
    [bun, "spawnSync", "Bun.spawnSync", "io"],
    [bun, "connect", "Bun.connect", "io"],
    [bun, "listen", "Bun.listen", "io"],
    [bun, "serve", "Bun.serve", "io"],
    [bun, "udpSocket", "Bun.udpSocket", "io"],
    [bun, "$", "Bun.$", "io"],
    [bun, "SQL", "Bun.SQL", "io"],
    [bun, "S3Client", "Bun.S3Client", "io"],
    [bun, "RedisClient", "Bun.RedisClient", "io"],
    [bun?.dns, "lookup", "Bun.dns.lookup", "io"],
    [proc, "chdir", "process.chdir", "io"],
    [proc, "exit", "process.exit", "io"],
    [proc, "kill", "process.kill", "io"],
    // Work that outlives the handler.
    [g, "setTimeout", "setTimeout", "timer"],
    [g, "setInterval", "setInterval", "timer"],
    [g, "setImmediate", "setImmediate", "timer"],
    // The process's environment.
    [proc, "cwd", "process.cwd", "env"],
    [proc, "memoryUsage", "process.memoryUsage", "env"],
    [proc, "cpuUsage", "process.cpuUsage", "env"],
    [proc, "resourceUsage", "process.resourceUsage", "env"],
  ];
}

/**
 * The node built-in modules, whole or by function: bound when first
 * imported, so guarded only from a preload. Each `[module, keys or
 * "all", category]`.
 */
const MODULES: Array<[string, string[] | "all", Category]> = [
  ["node:fs", "all", "io"],
  ["node:fs/promises", "all", "io"],
  ["node:child_process", "all", "io"],
  ["node:net", "all", "io"],
  ["node:tls", "all", "io"],
  ["node:http", "all", "io"],
  ["node:https", "all", "io"],
  ["node:http2", "all", "io"],
  ["node:dgram", "all", "io"],
  ["node:dns", "all", "io"],
  ["node:dns/promises", "all", "io"],
  ["node:worker_threads", ["Worker"], "io"],
  [
    "node:crypto",
    [
      "randomBytes",
      "randomUUID",
      "randomInt",
      "randomFill",
      "randomFillSync",
      "getRandomValues",
      "generateKey",
      "generateKeySync",
      "generateKeyPair",
      "generateKeyPairSync",
      "generatePrime",
      "generatePrimeSync",
    ],
    "random",
  ],
  [
    "node:os",
    [
      "hostname",
      "loadavg",
      "freemem",
      "totalmem",
      "uptime",
      "networkInterfaces",
      "cpus",
      "userInfo",
      "homedir",
      "tmpdir",
    ],
    "env",
  ],
  ["node:timers", ["setTimeout", "setInterval", "setImmediate"], "timer"],
  ["node:timers/promises", "all", "timer"],
  ["node:perf_hooks", ["now"], "time"],
];

/** The module a guard checks to see that modules were guarded in time. */
const PROBE: [string, string] = ["node:fs", "readFileSync"];

let installed = false;

/**
 * Installs every guard: the globals, a `Date` refusing to be read
 * without a time, `process.env`, and, where `require` reaches them,
 * the node built-in modules. Idempotent.
 */
export function installGuards(
  requireModule?: (name: string) => Record<string, any>,
): void {
  if (installed) return;
  installed = true;
  for (const [owner, key, label, category] of globalInventory()) {
    guardFunction(owner, key, label, category);
  }
  guardDate();
  guardEnv();
  if (!requireModule) return;
  for (const [name, keys, category] of MODULES) {
    let mod: Record<string, any> | undefined;
    try {
      mod = requireModule(name);
    } catch {
      continue;
    }
    if (keys === "all") guardAll(mod, name, category);
    else
      for (const key of keys)
        guardFunction(mod, key, `${name}.${key}`, category);
    // `node:perf_hooks.performance.now` is the global's.
    if (name === "node:perf_hooks") {
      guardFunction(mod?.performance, "now", "performance.now", "time");
    }
  }
}

/** `Date()` and `new Date()` read the clock; `new Date(x)` does not. */
function guardDate(): void {
  const g = globalThis as Record<string, any>;
  const OriginalDate = g.Date as DateConstructor;
  if ((OriginalDate as any)[GUARDED]) return;
  g.Date = new Proxy(OriginalDate, {
    apply(target, self, args) {
      const refused = refusal("Date()", "time");
      if (refused) throw refused;
      return Reflect.apply(target, self, args);
    },
    construct(target, args, newTarget) {
      if (args.length === 0) {
        const refused = refusal("new Date()", "time");
        if (refused) throw refused;
      }
      return Reflect.construct(target, args, newTarget);
    },
    get(target, prop, receiver) {
      if (prop === GUARDED) return true;
      if (prop === ORIGINAL) return target;
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** Reading the environment is refused; the object stays the same. */
function guardEnv(): void {
  const proc = (globalThis as Record<string, any>).process;
  if (!proc?.env || proc.env[GUARDED]) return;
  const env = proc.env as Record<string, string | undefined>;
  const guarded = new Proxy(env, {
    get(target, prop, receiver) {
      if (prop === GUARDED) return true;
      if (typeof prop === "string") {
        const refused = refusal(`process.env.${prop}`, "env");
        if (refused) throw refused;
      }
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      const refused = refusal("process.env", "env");
      if (refused) throw refused;
      return Reflect.has(target, prop);
    },
    ownKeys(target) {
      const refused = refusal("process.env", "env");
      if (refused) throw refused;
      return Reflect.ownKeys(target);
    },
    // Writes are the process's own, outside any handler: assigned as
    // they always were (the runtime refuses a descriptor here).
    set(target, prop, value) {
      (target as Record<string | symbol, unknown>)[prop] = value;
      return true;
    },
    deleteProperty(target, prop) {
      delete (target as Record<string | symbol, unknown>)[prop];
      return true;
    },
  });
  try {
    proc.env = guarded;
  } catch {}
  const bun = (globalThis as Record<string, any>).Bun;
  if (bun && bun.env === env) {
    try {
      Object.defineProperty(bun, "env", { value: guarded, configurable: true });
    } catch {}
  }
}

/**
 * Throws unless every guard holds: the globals, and, where the runtime
 * has node's built-in modules, those as a named import sees them,
 * which only a guard installed before the app's modules loaded makes
 * so.
 */
export async function assertGuarded(): Promise<void> {
  const missing: string[] = [];
  for (const [owner, key, label] of globalInventory()) {
    if (owner && typeof owner[key] === "function" && !owner[key][GUARDED]) {
      missing.push(label);
    }
  }
  if (!(globalThis as any).Date[GUARDED]) missing.push("Date");
  if (typeof (globalThis as any).Bun !== "undefined") {
    const [name, key] = PROBE;
    const mod = (await import(name)) as Record<string, any>;
    if (!mod[key]?.[GUARDED]) missing.push(`${name} (as imported)`);
  }
  if (missing.length > 0) {
    throw new GuardError(
      `vex-core's handler guards are not installed (${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""}): run with \`bun --preload vex-core/guard\` (or bunfig.toml preload) so they load before the app`,
    );
  }
}
