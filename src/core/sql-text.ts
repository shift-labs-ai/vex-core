/**
 * What can be said about raw SQL from its text alone.
 *
 * Which tables a statement reads or writes is not decided here: the
 * SQLite adapters ask SQLite, from the statement's compiled program
 * (`sqlite-core.ts`). This module splits text into statements and
 * classifies them, and holds `tablesRead`, the sound fallback for an
 * adapter that cannot compile: every known table a statement names,
 * through any view it names. A name in a string literal or a column of
 * the same name counts too; a table it reads is never left out.
 */

/**
 * Where the run of whitespace and comments starting at `offset` ends:
 * `offset` itself when there is none, `sql.length` when it runs to the
 * end (an unterminated comment included). Whitespace is SQLite's: space,
 * \t, \n, \f, \r.
 */
function spaceEnd(sql: string, offset: number): number {
  while (offset < sql.length) {
    const c = sql.charCodeAt(offset);
    if (c === 32 || c === 9 || c === 10 || c === 12 || c === 13) {
      offset++;
    } else if (c === 45 && sql.charCodeAt(offset + 1) === 45) {
      const newline = sql.indexOf("\n", offset + 2);
      offset = newline === -1 ? sql.length : newline + 1;
    } else if (c === 47 && sql.charCodeAt(offset + 1) === 42) {
      const end = sql.indexOf("*/", offset + 2);
      offset = end === -1 ? sql.length : end + 2;
    } else {
      break;
    }
  }
  return offset;
}

/** Where `sql`'s first token starts; -1 when it has none. */
function firstTokenOffset(sql: string): number {
  const offset = spaceEnd(sql, 0);
  return offset < sql.length ? offset : -1;
}

/** `sql` from its first token, past leading whitespace and comments. */
export function sqlAfterLeadingComments(sql: string): string {
  const offset = firstTokenOffset(sql);
  return offset === -1 ? "" : sql.slice(offset);
}

/** The statement's first keyword, upper-cased; "" when there is none. */
export function leadingSqlKeyword(sql: string): string {
  const start = firstTokenOffset(sql);
  if (start === -1) return "";
  let end = start;
  while (end < sql.length) {
    const letter = sql.charCodeAt(end) | 32;
    if (letter < 97 || letter > 122) break;
    end++;
  }
  return sql.slice(start, end).toUpperCase();
}

/**
 * What a statement is, from its first keyword: a `read` (SELECT, VALUES,
 * EXPLAIN) cannot write; a `write` (INSERT, UPDATE, DELETE, REPLACE)
 * changes rows and always sets SQLite's `changes()`; `with` may end in
 * either; anything else is `other` (schema, PRAGMA, transaction
 * control).
 */
export type StatementKind = "read" | "write" | "with" | "other";

export function statementKind(sql: string): StatementKind {
  switch (leadingSqlKeyword(sql)) {
    case "SELECT":
    case "VALUES":
    case "EXPLAIN":
      return "read";
    case "INSERT":
    case "UPDATE":
    case "DELETE":
    case "REPLACE":
      return "write";
    case "WITH":
      return "with";
    default:
      return "other";
  }
}

/** True when some statement in `sql` may change the schema. */
export function mayChangeSchema(sql: string): boolean {
  return /(?:^|;)\s*(?:CREATE|ALTER|DROP|REINDEX|VACUUM|ATTACH|DETACH)\b/i.test(
    sqlAfterLeadingComments(sql),
  );
}

// ─── tokens ──────────────────────────────────────────────────────────
// Enough of SQLite's tokenizer to know where strings, quoted
// identifiers, comments and bound parameters are.

interface Lexeme {
  kind: "semi" | "space" | "word" | "parameter" | "other";
  start: number;
  end: number;
}

const IDENTIFIER_START = /[\p{L}_]/u;
const IDENTIFIER_CHAR = /[\p{L}\p{N}_$]/u;

function* lex(sql: string): Generator<Lexeme> {
  let i = 0;
  while (i < sql.length) {
    const start = i;
    const c = sql[i];
    const space = spaceEnd(sql, i);
    if (space > i) {
      i = space;
      yield { kind: "space", start, end: i };
    } else if (c === ";") {
      i++;
      yield { kind: "semi", start, end: i };
    } else if (c === "'" || c === '"' || c === "`" || c === "[") {
      const end = sql.indexOf(c === "[" ? "]" : c, i + 1);
      i = end === -1 ? sql.length : end + 1;
      yield { kind: "other", start, end: i };
    } else if (c === "?") {
      i++;
      while (/[0-9]/.test(sql[i] ?? "")) i++;
      yield { kind: "parameter", start, end: i };
    } else if (
      (c === ":" || c === "@" || c === "$") &&
      IDENTIFIER_CHAR.test(sql[i + 1] ?? "")
    ) {
      i++;
      while (i < sql.length && IDENTIFIER_CHAR.test(sql[i])) i++;
      yield { kind: "parameter", start, end: i };
    } else if (IDENTIFIER_START.test(c)) {
      i++;
      while (i < sql.length && IDENTIFIER_CHAR.test(sql[i])) i++;
      yield { kind: "word", start, end: i };
    } else {
      i++;
      yield { kind: "other", start, end: i };
    }
  }
}

/**
 * How many values a statement binds, numbered as SQLite numbers them: a
 * bare `?` takes the next number, `?NNN` its own, and a named parameter
 * one number for all its uses.
 */
export function parameterCount(statement: string): number {
  let largest = 0;
  const named = new Set<string>();
  for (const lexeme of lex(statement)) {
    if (lexeme.kind !== "parameter") continue;
    const text = statement.slice(lexeme.start, lexeme.end);
    if (text === "?") largest++;
    else if (text[0] === "?")
      largest = Math.max(largest, Number(text.slice(1)));
    else if (!named.has(text)) {
      named.add(text);
      largest++;
    }
  }
  return largest;
}

// ─── statements ──────────────────────────────────────────────────────
// SQLite's own sqlite3_complete() state machine, which decides where a
// statement ends: at a semicolon outside strings, quoted identifiers and
// comments, and, in CREATE TRIGGER, only at the `END;` closing its body.

enum Token {
  Semi,
  Space,
  Other,
  Explain,
  Create,
  Temp,
  Trigger,
  End,
}

const START = 1;

// [state][token] → next state. States: 0 leading space, 1 start,
// 2 normal, 3 EXPLAIN, 4 CREATE, 5 in a trigger, 6 after a semicolon in
// a trigger, 7 after END in a trigger.
const TRANSITIONS: number[][] = [
  [1, 0, 2, 3, 4, 2, 2, 2],
  [1, 1, 2, 3, 4, 2, 2, 2],
  [1, 2, 2, 2, 2, 2, 2, 2],
  [1, 3, 3, 2, 4, 2, 2, 2],
  [1, 4, 2, 2, 2, 4, 5, 2],
  [6, 5, 5, 5, 5, 5, 5, 5],
  [6, 6, 5, 5, 5, 5, 5, 7],
  [1, 7, 5, 5, 5, 5, 5, 5],
];

const KEYWORDS: Record<string, Token> = {
  EXPLAIN: Token.Explain,
  CREATE: Token.Create,
  TEMP: Token.Temp,
  TEMPORARY: Token.Temp,
  TRIGGER: Token.Trigger,
  END: Token.End,
};

/** The statements in `sql`, without the semicolons that end them. */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let state = 0;
  let start = 0;
  let content = false;
  for (const lexeme of lex(sql)) {
    const token =
      lexeme.kind === "semi"
        ? Token.Semi
        : lexeme.kind === "space"
          ? Token.Space
          : lexeme.kind === "word"
            ? (KEYWORDS[sql.slice(lexeme.start, lexeme.end).toUpperCase()] ??
              Token.Other)
            : Token.Other;
    if (token !== Token.Space && token !== Token.Semi) content = true;
    state = TRANSITIONS[state][token];
    if (token === Token.Semi && state === START) {
      if (content) statements.push(sql.slice(start, lexeme.start).trim());
      start = lexeme.end;
      content = false;
    }
  }
  if (content) statements.push(sql.slice(start).trim());
  return statements;
}

/**
 * True when the statement can change rows: not schema, PRAGMA or
 * transaction control.
 */
export function changesRows(statement: string): boolean {
  return !NON_ROW_STATEMENTS.has(leadingSqlKeyword(statement));
}

const NON_ROW_STATEMENTS = new Set([
  "CREATE",
  "ALTER",
  "DROP",
  "PRAGMA",
  "BEGIN",
  "COMMIT",
  "END",
  "ROLLBACK",
  "SAVEPOINT",
  "RELEASE",
  "VACUUM",
  "REINDEX",
  "ANALYZE",
  "ATTACH",
  "DETACH",
]);

// ─── the text fallback ───────────────────────────────────────────────

/** A view: its name and the `CREATE VIEW` statement that defines it. */
export interface ViewDefinition {
  name: string;
  sql: string;
}

/** True when `name` occurs in `text` as a whole identifier (both
 *  lower-cased by the caller). */
function names(text: string, name: string): boolean {
  for (
    let at = text.indexOf(name);
    at !== -1;
    at = text.indexOf(name, at + 1)
  ) {
    const before = text[at - 1];
    const after = text[at + name.length];
    if (
      (before === undefined || !IDENTIFIER_CHAR.test(before)) &&
      (after === undefined || !IDENTIFIER_CHAR.test(after))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The tables in `tables` that `sql` may read: each one it names, and
 * each one named by a view it names, through views of views. Names
 * match case-insensitively as whole identifiers, quoted or not.
 */
export function tablesRead(
  sql: string,
  tables: Iterable<string>,
  views: ViewDefinition[] = [],
): string[] {
  const known = [...tables];
  const found = new Set<string>();
  const seenViews = new Set<string>();
  const pending = [sql.toLowerCase()];
  for (let text = pending.pop(); text !== undefined; text = pending.pop()) {
    for (const table of known) {
      if (names(text, table.toLowerCase())) found.add(table);
    }
    for (const view of views) {
      const name = view.name.toLowerCase();
      if (!seenViews.has(name) && names(text, name)) {
        seenViews.add(name);
        pending.push(view.sql.toLowerCase());
      }
    }
  }
  return [...found];
}
