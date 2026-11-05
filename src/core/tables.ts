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
import {
  type ProblemWords,
  refuseUnlessSchema,
  schemaProblems,
  serializeJson,
} from "./values.js";

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

/** `schema` as storage keeps it; a column that is not a schema is refused. */
export function storedTable(
  name: string,
  schema: TableSchema,
): StoredTableSchema {
  const columns: Record<string, StoredColumn> = {};
  for (const [column, def] of Object.entries(schema.columns ?? {})) {
    refuseUnlessSchema(
      def,
      `table ${name} declares column ${JSON.stringify(column)}`,
    );
    columns[column] = {
      type: storageType(def),
      ...(nullable(def) ? { optional: true } : {}),
      ...(def.index ? { index: true } : {}),
      ...(def.default !== undefined ? { default: def.default } : {}),
      ...(def.renamedFrom ? { renamedFrom: def.renamedFrom } : {}),
    };
  }
  const { columns: _columns, ...rest } = schema;
  return { ...rest, columns };
}

/** How a row's columns are told apart in a write's refusal. */
const COLUMN_WORDS: ProblemWords = {
  undeclared: (column) => `has no column ${JSON.stringify(column)}`,
  missing: (column) => `needs column ${JSON.stringify(column)}`,
  refused: (path, message) =>
    `column ${JSON.stringify(path[0])}${path.length > 1 ? ` at /${path.slice(1).join("/")}` : ""}: ${message}`,
};

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
    const optional = nullable(def);
    // Null is how storage reads an empty optional column back.
    properties[column] = optional ? Type.Union([def, Type.Null()]) : def;
    if (!optional && def.default === undefined) required.push(column);
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
    const problems = schemaProblems(compiled, present, COLUMN_WORDS);
    throw new TypeError(`${kind} into ${name}: ${problems.join("; ")}`);
  };
  return {
    insert: (row) => check(whole, "insert", row),
    update: (data) => check(part, "update", data),
  };
}
