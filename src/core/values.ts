/**
 * The values that cross an operation's boundary: the args a call
 * brings, checked against what the operation declares, and the result
 * it answers, which is JSON or refused.
 */

import Type, { type Static, type TObject, type TSchema } from "typebox";
import { Compile } from "typebox/compile";
import { HttpError } from "../http/error.js";

/**
 * A schema as `Type` builds it. Each TypeBox kind carries its `~kind`;
 * a string or a plain object (`"string"`, `{ type: "number" }`) does
 * not, so neither is one, though `TSchema` alone would take either.
 */
export type Schema = TSchema & { readonly "~kind": string };

/**
 * What an operation takes: each arg's name and its schema, a TypeBox
 * type (JSON Schema that infers as TypeScript). The handler's args are
 * `ArgsOf` the shape.
 */
export type ArgsShape = Record<string, Schema>;

/** The args a handler receives for `S`. */
export type ArgsOf<S extends ArgsShape> = Static<TObject<S>>;

/** An operation's args, checked: what its handler is given. */
export type ArgsCheck = (args: unknown) => Readonly<Record<string, any>>;

/**
 * The check for an operation's args, compiled once: an object of
 * exactly the declared args (none undeclared), each matching its
 * schema, every value JSON. It answers a deep-frozen copy, so nothing
 * that runs before the handler can change what it was checked as.
 */
export function compileArgs(
  kind: string,
  name: string,
  shape: unknown,
): ArgsCheck {
  if (!isPlainObject(shape)) {
    throw new Error(
      `${kind} ${name} declares no args: give an object of schemas, { name: Type.String() } ({} for none)`,
    );
  }
  for (const [arg, schema] of Object.entries(shape)) {
    if (!isPlainObject(schema)) {
      throw new Error(
        `${kind} ${name} declares arg ${JSON.stringify(arg)} as ${JSON.stringify(schema)}: declare it with a schema, such as Type.String()`,
      );
    }
  }
  const compiled = Compile(
    Type.Object(shape as ArgsShape, { additionalProperties: false }),
  );
  const takes =
    Object.keys(shape)
      .map((k) => JSON.stringify(k))
      .join(", ") || "none";
  return (args) => {
    const given = args === undefined ? {} : args;
    if (!isPlainObject(given)) {
      throw new ArgsError(`${kind} ${name} takes an object of args`);
    }
    // An undefined value is an arg not given: the wire has none.
    const present: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(given)) {
      if (value !== undefined) present[key] = value;
    }
    if (!compiled.Check(present)) {
      // An undeclared key is reported twice (its false schema, and the
      // object's additionalProperties): once is enough.
      const problems = [...compiled.Errors(present)]
        .filter((error) => error.message !== "schema is false")
        .map((error) => argProblem(error));
      throw new ArgsError(
        `${kind} ${name} ${[...new Set(problems)].join("; ")} (it takes ${takes})`,
      );
    }
    return deepFreeze(jsonCopy(present, `${kind} ${name} args`));
  };
}

/** A TypeBox error as the caller is told it. */
function argProblem(error: {
  keyword: string;
  instancePath: string;
  params: Record<string, any>;
  message: string;
}): string {
  const path = error.instancePath.split("/").filter(Boolean);
  if (error.keyword === "additionalProperties") {
    const extra = error.params.additionalProperties ?? path[0];
    return (Array.isArray(extra) ? extra : [extra])
      .map((key: string) => `takes no arg ${JSON.stringify(key)}`)
      .join("; ");
  }
  if (error.keyword === "required") {
    const missing = error.params.requiredProperties ?? [];
    return (Array.isArray(missing) ? missing : [missing])
      .map((m: string) => `needs arg ${JSON.stringify(m)}`)
      .join("; ");
  }
  const at =
    path.length > 0
      ? `arg ${JSON.stringify(path[0])}${path.length > 1 ? ` at /${path.slice(1).join("/")}` : ""}`
      : "its args";
  return `takes ${at}: ${error.message}`;
}

/** The check for an operation's answer against its `returns` schema. */
export function compileReturns(
  kind: string,
  name: string,
  schema: TSchema | undefined,
): ((value: unknown) => void) | undefined {
  if (schema === undefined) return undefined;
  const compiled = Compile(schema);
  return (value) => {
    if (compiled.Check(value)) return;
    const [error] = [...compiled.Errors(value)];
    throw new TypeError(
      `${kind} ${name} answers ${error ? `${error.instancePath || "its value"}: ${error.message}` : "against its returns schema"}`,
    );
  };
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
