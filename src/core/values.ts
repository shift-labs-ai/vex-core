/**
 * The values that cross an operation's boundary: the args a call
 * brings, checked against what the operation declares, and the result
 * it answers, which is JSON or refused.
 */

import { HttpError } from "../http/error.js";

/** The type of a declared arg; `?` lets it be absent or null. */
export type ArgType =
  | "string"
  | "number"
  | "boolean"
  | "json"
  | "string?"
  | "number?"
  | "boolean?"
  | "json?";

/** What an operation declares it takes: each arg's name and type. */
export type ArgsDecl = Record<string, ArgType>;

const ARG_TYPES: ReadonlySet<string> = new Set<ArgType>([
  "string",
  "number",
  "boolean",
  "json",
  "string?",
  "number?",
  "boolean?",
  "json?",
]);

/** Refuses a declaration naming a type the engine cannot check. */
export function assertArgsDecl(
  kind: string,
  name: string,
  decl: unknown,
): asserts decl is ArgsDecl {
  if (!isPlainObject(decl)) {
    throw new Error(
      `${kind} ${name} declares no args: give an object, { name: type } ({} for none)`,
    );
  }
  for (const [arg, type] of Object.entries(decl)) {
    if (typeof type !== "string" || !ARG_TYPES.has(type)) {
      throw new Error(
        `${kind} ${name} declares arg ${JSON.stringify(arg)} as ${JSON.stringify(type)}: an arg is ${[...ARG_TYPES].map((t) => JSON.stringify(t)).join(", ")}`,
      );
    }
  }
}

/**
 * The args `args` are, as `decl` declares them: each declared arg of
 * its type (an optional one absent or null), no undeclared one, and
 * every value JSON. The answer is a deep-frozen copy, so nothing that
 * runs before the handler can change what it was checked as.
 */
export function checkArgs(
  kind: string,
  name: string,
  decl: ArgsDecl,
  args: unknown,
): Readonly<Record<string, any>> {
  const given = args === undefined ? {} : args;
  if (!isPlainObject(given)) {
    throw new ArgsError(`${kind} ${name} takes an object of args`);
  }
  for (const key of Object.keys(given)) {
    if (!(key in decl) && given[key] !== undefined) {
      throw new ArgsError(
        `${kind} ${name} takes no arg ${JSON.stringify(key)}: it takes ${
          Object.keys(decl)
            .map((k) => JSON.stringify(k))
            .join(", ") || "none"
        }`,
      );
    }
  }
  const checked: Record<string, any> = {};
  for (const [key, declared] of Object.entries(decl)) {
    const optional = declared.endsWith("?");
    const type = optional ? declared.slice(0, -1) : declared;
    const value = given[key];
    if (value === undefined || value === null) {
      if (optional) {
        if (value === null) checked[key] = null;
        continue;
      }
      throw new ArgsError(
        `${kind} ${name} needs arg ${JSON.stringify(key)} (${type})`,
      );
    }
    const ok =
      type === "string"
        ? typeof value === "string"
        : type === "number"
          ? typeof value === "number" && Number.isFinite(value)
          : type === "boolean"
            ? typeof value === "boolean"
            : true;
    if (!ok) {
      throw new ArgsError(
        `${kind} ${name} takes arg ${JSON.stringify(key)} as ${type}; got ${describe(value)}`,
      );
    }
    checked[key] =
      type === "json"
        ? jsonCopy(value, `${kind} ${name} arg ${JSON.stringify(key)}`)
        : value;
  }
  return deepFreeze(checked);
}

/** Args refused at the boundary: the caller's mistake, answered 400. */
export class ArgsError extends HttpError {
  constructor(message: string) {
    super(400, message);
  }
}

/**
 * `value` as JSON, refused when it holds anything that is not JSON
 * data: a `Date`, `Map`, `Set`, class instance, typed array, function,
 * symbol, bigint, non-finite number or cycle. `exact` is whether the
 * value is its own JSON reading (no `undefined` property or element,
 * no `-0`), so a reader may be handed it as it is.
 */
export function serializeJson(
  value: unknown,
  what: string,
): { serialized: string | undefined; exact: boolean } {
  const walk = { exact: true, what };
  check(value, "", 0, walk);
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    if (error instanceof TypeError && /cyclic|circular/i.test(error.message)) {
      throw new TypeError(`${what} holds a cycle, which JSON cannot say`);
    }
    throw error;
  }
  return { serialized, exact: walk.exact };
}

// Deeper than this is a cycle or near enough: the walk stops and
// `JSON.stringify` decides (it refuses a cycle).
const MAX_DEPTH = 512;

function check(
  value: unknown,
  key: string,
  depth: number,
  walk: { exact: boolean; what: string },
): void {
  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(
          `${walk.what} holds ${value}, which JSON cannot say${at(key)}`,
        );
      }
      if (value === 0 && 1 / value < 0) walk.exact = false;
      return;
    case "undefined":
      // Dropped from an object, null in an array: not as given.
      if (depth > 0) walk.exact = false;
      return;
    case "object": {
      if (value === null || depth > MAX_DEPTH) return;
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          check(value[i], key, depth + 1, walk);
        }
        return;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError(
          `${walk.what} holds ${describe(value)}${at(key)}: answer plain data (an ISO string for a date, an object or array for a collection)`,
        );
      }
      for (const k in value) {
        if (k === "toJSON") walk.exact = false;
        check((value as Record<string, unknown>)[k], k, depth + 1, walk);
      }
      return;
    }
    default:
      throw new TypeError(
        `${walk.what} holds ${describe(value)}${at(key)}, which JSON cannot say`,
      );
  }
}

/** `value` as JSON reads it back, refused as {@link serializeJson} refuses. */
export function jsonCopy<T>(value: T, what: string): T {
  const { serialized, exact } = serializeJson(value, what);
  if (exact) return structuredClone(value);
  return serialized === undefined ? (undefined as T) : JSON.parse(serialized);
}

function isPlainObject(value: unknown): value is Record<string, any> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") {
    const ctor = Object.getPrototypeOf(value)?.constructor?.name;
    return ctor && ctor !== "Object" ? `a ${ctor}` : "an object";
  }
  if (typeof value === "function") return "a function";
  return `${typeof value} ${String(value)}`;
}

function at(key: string): string {
  return key === "" ? "" : ` (at ${JSON.stringify(key)})`;
}
