/**
 * What can be said about a raw SQL statement from its text alone, and
 * only what can be said soundly.
 *
 * Which tables a statement *writes* is never read from its text: the
 * adapters' triggers record that exactly (see `sqlite-core.ts`). Which
 * tables it *reads* has no exact source here — neither `bun:sqlite` nor
 * a Durable Object's SQL API exposes SQLite's authorizer — so
 * `tablesRead` over-approximates: every known table the statement
 * names, through any view it names. A name in a string literal or a
 * column of the same name counts too; a table it reads is never left
 * out.
 */

/** `sql` from its first token, past leading whitespace and comments. */
export function sqlAfterLeadingComments(sql: string): string {
  let offset = 0;
  while (offset < sql.length) {
    while (/\s/.test(sql[offset] ?? "")) offset++;
    if (sql.startsWith("--", offset)) {
      const newline = sql.indexOf("\n", offset + 2);
      if (newline === -1) return "";
      offset = newline + 1;
      continue;
    }
    if (sql.startsWith("/*", offset)) {
      const end = sql.indexOf("*/", offset + 2);
      if (end === -1) return "";
      offset = end + 2;
      continue;
    }
    break;
  }
  return sql.slice(offset);
}

/** The statement's first keyword, upper-cased; "" when there is none. */
export function leadingSqlKeyword(sql: string): string {
  return (
    sqlAfterLeadingComments(sql)
      .match(/^[a-z]+/i)?.[0]
      .toUpperCase() ?? ""
  );
}

/**
 * True when the statement cannot write: it starts with SELECT, VALUES
 * or EXPLAIN. A WITH statement can end in INSERT, UPDATE or DELETE, so
 * it is not one.
 */
export function isReadOnlyStatement(sql: string): boolean {
  return ["SELECT", "VALUES", "EXPLAIN"].includes(leadingSqlKeyword(sql));
}

/** A view: its name and the `CREATE VIEW` statement that defines it. */
export interface ViewDefinition {
  name: string;
  sql: string;
}

const IDENTIFIER_CHAR = /[\p{L}\p{N}_$]/u;

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
