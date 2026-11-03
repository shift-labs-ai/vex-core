import { leadingSqlKeyword, sqlAfterLeadingComments } from "./sql-text.js";
import { buildWhereClause, quoteIdent } from "./sql-where.js";
import type { Filter } from "./types.js";

/**
 * A raw read held to rows: the statement rewritten so that, inside
 * it, each table named in `over` is the rows its filters match and
 * nothing else. A common table expression of the table's own name,
 * selecting from the base table under its schema (`main`) with the
 * filters as its WHERE, shadows the table for the statement; it is
 * not materialized, so each reference keeps the base table's indexes.
 *
 *   WITH "messages" AS NOT MATERIALIZED
 *     (SELECT * FROM main."messages" WHERE "sessionId" IN (?, ?))
 *   <the statement>
 *
 * The declaration is thus enforced, never trusted: a statement cannot
 * read a row the filters reject, so the dependency recorded over the
 * table, the filters, holds by construction. A statement naming a
 * held table under its schema (`main.messages`) would read past the
 * expression, and is refused; so is anything but a read.
 */
export function holdStatement(
  sql: string,
  over: Record<string, Filter[]>,
  params: any[],
): { sql: string; params: any[] } {
  const statement = sqlAfterLeadingComments(sql);
  const keyword = leadingSqlKeyword(statement);
  if (keyword !== "SELECT" && keyword !== "WITH") {
    throw new Error(`sqlOver holds a read; got ${keyword || "no statement"}`);
  }
  const expressions: string[] = [];
  const bound: any[] = [];
  for (const [table, filters] of Object.entries(over)) {
    if (qualified(table).test(statement)) {
      throw new Error(
        `sqlOver cannot hold ${JSON.stringify(table)}: the statement names it under its schema`,
      );
    }
    const where = buildWhereClause(filters);
    expressions.push(
      `${quoteIdent(table)} AS NOT MATERIALIZED (SELECT * FROM main.${quoteIdent(table)} ${where.sql})`,
    );
    bound.push(...where.params);
  }
  if (expressions.length === 0) return { sql, params };
  const held =
    keyword === "WITH"
      ? statement.replace(
          /^WITH(\s+RECURSIVE)?\b/i,
          (match) => `${match} ${expressions.join(", ")},`,
        )
      : `WITH ${expressions.join(", ")} ${statement}`;
  return { sql: held, params: [...bound, ...params] };
}

/**
 * `main.table` as a statement may write it, each name bare or in any
 * quoting SQLite reads: double quotes, brackets, backticks.
 */
function qualified(table: string): RegExp {
  const name = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const spelled = (word: string) =>
    `(?:"${word}"|\\[${word}\\]|\`${word}\`|\\b${word}\\b)`;
  return new RegExp(`${spelled("main")}\\s*\\.\\s*${spelled(name)}`, "i");
}
