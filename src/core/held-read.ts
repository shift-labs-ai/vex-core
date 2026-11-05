import { leadingSqlKeyword, sqlAfterLeadingComments } from "./sql-text.js";
import { buildWhereClause, quoteIdent } from "./sql-where.js";
import type { Reads } from "./types.js";

/**
 * A raw read held to rows: the statement rewritten so that, inside
 * it, each table `over` holds is the rows its filters match and
 * nothing else, and only the columns its `reads` name when given. A
 * common table expression of the table's own name, selecting from
 * the base table under its schema (`main`) with the filters as its
 * WHERE, shadows the table for the statement; it is not
 * materialized, so each reference keeps the base table's indexes.
 *
 *   WITH "messages" AS NOT MATERIALIZED
 *     (SELECT "_id", "text" FROM main."messages" WHERE "sessionId" IN (?, ?))
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
  over: Reads,
  params: any[],
): { sql: string; params: any[] } {
  const statement = sqlAfterLeadingComments(sql);
  const keyword = leadingSqlKeyword(statement);
  if (keyword !== "SELECT" && keyword !== "WITH") {
    throw new Error(
      `ctx.db.sql holds a read; got ${keyword || "no statement"}`,
    );
  }
  const expressions: string[] = [];
  const bound: any[] = [];
  for (const [table, hold] of Object.entries(over)) {
    if (hold === "all") continue;
    if (qualified(table).test(statement)) {
      throw new Error(
        `ctx.db.sql cannot hold ${JSON.stringify(table)}: the statement names it under its schema`,
      );
    }
    const { where: filters, reads } = Array.isArray(hold)
      ? { where: hold, reads: null }
      : hold;
    const where = buildWhereClause(filters);
    // The row id rides along: what a result is told apart by.
    const columns = reads
      ? [...new Set(["_id", ...reads])].map(quoteIdent).join(", ")
      : "*";
    expressions.push(
      `${quoteIdent(table)} AS NOT MATERIALIZED (SELECT ${columns} FROM main.${quoteIdent(table)} ${where.sql})`,
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
