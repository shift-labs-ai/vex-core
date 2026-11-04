/**
 * A table as an app declares it (`TableSchema`: a TypeBox schema per
 * column) and as storage keeps it (`StoredTableSchema`: each column's
 * storage type), and the checks every write to it passes.
 */

import Type, { type TSchema } from "typebox";
import { Compile } from "typebox/compile";
import type {
  ColumnType,
  StoredColumn,
  StoredTableSchema,
  TableSchema,
} from "./types.js";
import { serializeJson } from "./values.js";

const OPTIONAL = "~optional";

/** Whether a column schema lets the column hold nothing. */
function nullable(schema: Record<string, any>): boolean {
  if (schema[OPTIONAL] === true) return true;
  const branches = schema.anyOf as Array<Record<string, any>> | undefined;
  return Array.isArray(branches) && branches.some((b) => b.type === "null");
}

/** The storage type a column schema is kept as. */
function storageType(schema: Record<string, any>): ColumnType {
  const branches = (
    schema.anyOf as Array<Record<string, any>> | undefined
  )?.filter((b) => b.type !== "null");
  const type = branches?.length === 1 ? branches[0]!.type : schema.type;
  if (type === "string") return "string";
  if (type === "number" || type === "integer") return "number";
  if (type === "boolean") return "boolean";
  return "json";
}

/** `schema` as storage keeps it; an undeclarable column is refused. */
export function storedTable(
  name: string,
  schema: TableSchema,
): StoredTableSchema {
  const columns: Record<string, StoredColumn> = {};
  for (const [column, def] of Object.entries(schema.columns ?? {})) {
    const d = def as Record<string, any>;
    if (d === null || typeof d !== "object") {
      throw new Error(
        `table ${name} declares column ${JSON.stringify(column)} as ${JSON.stringify(def)}: declare it with a schema, such as Type.String()`,
      );
    }
    if (d.type === "json" || d.type === "any" || "optional" in d) {
      throw new Error(
        `table ${name} declares column ${JSON.stringify(column)} in the old form (${JSON.stringify(d)}): declare it with a schema, such as Type.Unknown() for JSON, and Type.Optional(...) for an optional column`,
      );
    }
    columns[column] = {
      type: storageType(d),
      ...(nullable(d) ? { optional: true } : {}),
      ...(d.index ? { index: true } : {}),
      ...(d.default !== undefined ? { default: d.default } : {}),
      ...(d.renamedFrom ? { renamedFrom: d.renamedFrom } : {}),
    };
  }
  const { columns: _columns, ...rest } = schema;
  return { ...rest, columns };
}

/** The checks writes to a table pass. */
export interface RowChecks {
  /** A whole row, as `insert` writes it. */
  insert(row: Record<string, unknown>): void;
  /** Some of a row's columns, as `update` writes them. */
  update(data: Record<string, unknown>): void;
}

/**
 * The checks for writes to `name`: no undeclared column, each value
 * its column's schema allows, JSON values plain data; an insert gives
 * every column that has no default and may not be empty.
 */
export function rowChecks(name: string, schema: TableSchema): RowChecks {
  const properties: Record<string, TSchema> = { _id: Type.String() };
  const required: string[] = [];
  for (const [column, def] of Object.entries(schema.columns ?? {})) {
    const d = def as Record<string, any>;
    // Null is how storage reads an empty optional column back.
    properties[column] = nullable(d)
      ? Type.Union([def as TSchema, Type.Null()])
      : (def as TSchema);
    if (!nullable(d) && d.default === undefined) required.push(column);
  }
  const whole = Compile(
    Type.Object(
      Object.fromEntries(
        Object.entries(properties).map(([k, v]) => [
          k,
          k === "_id" || !required.includes(k) ? Type.Optional(v) : v,
        ]),
      ),
      { additionalProperties: false },
    ),
  );
  const part = Compile(
    Type.Object(
      Object.fromEntries(
        Object.entries(properties).map(([k, v]) => [k, Type.Optional(v)]),
      ),
      { additionalProperties: false },
    ),
  );
  const check = (
    compiled: ReturnType<typeof Compile>,
    kind: string,
    value: Record<string, unknown>,
  ) => {
    const present: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) present[k] = v;
    }
    serializeJson(present, `${kind} into ${name}`);
    if (compiled.Check(present)) return;
    const problems = [...compiled.Errors(present)]
      .filter((e) => e.message !== "schema is false")
      .map((e) => {
        if (e.keyword === "additionalProperties") {
          const extra = e.params.additionalProperties;
          return (Array.isArray(extra) ? extra : [extra])
            .map((c: string) => `has no column ${JSON.stringify(c)}`)
            .join("; ");
        }
        if (e.keyword === "required") {
          const missing = e.params.requiredProperties;
          return (Array.isArray(missing) ? missing : [missing])
            .map((c: string) => `needs column ${JSON.stringify(c)}`)
            .join("; ");
        }
        const column = e.instancePath.split("/").filter(Boolean)[0];
        return `column ${JSON.stringify(column)}: ${e.message}`;
      })
      // A nullable column's schema is a union: its branch errors and
      // the union's say one thing, the first branch's.
      .filter((problem, i, all) => {
        const column = problem.match(/^column ("[^"]*")/)?.[1];
        return (
          !column ||
          all.findIndex((p) => p.startsWith(`column ${column}`)) === i
        );
      });
    throw new TypeError(
      `${kind} into ${name}: ${[...new Set(problems)].join("; ")}`,
    );
  };
  return {
    insert: (row) => check(whole, "insert", row),
    update: (data) => check(part, "update", data),
  };
}
