/**
 * The migration sorter (spec #1334, "Database changes").
 *
 * Reads one migration's SQL and answers one question: does applying it delete
 * or rewrite data that is already in the database? If yes, the run's final
 * pull request waits for the owner; a migration that only ADDS (tables,
 * columns, indexes, policies, enum values) does not hold it.
 *
 * What holds: dropping a table, column, schema, type, domain or sequence;
 * changing a column's type; renaming a table, column or enum value; emptying a
 * table; deleting rows; updating existing rows; an insert that overwrites on
 * conflict; MERGE.
 *
 * Owner decisions (binding, spec #1334 follow-up):
 * - An UPDATE with no FROM clause whose WHERE is exactly `<col> IS NULL`, or
 *   that has no WHERE and sets a column ADDED earlier in the same migration,
 *   is a backfill: it writes no value anyone had, so it does not hold. Any
 *   other WHERE (`NOT c IS NULL`, `c IS NULL AND d`) or a FROM holds — the
 *   sorter does not try to prove what a filter or a join selects.
 * - Fail closed on anything run through a routine or a `DO` block (spec #1334
 *   review): every `DO` block holds, every `CALL` holds, a function or
 *   procedure whose body holds DELETE / TRUNCATE / DROP / UPDATE / EXECUTE /
 *   ALTER holds, and any top-level `SELECT` / `PERFORM` that calls a function
 *   holds, wherever the function was defined (`cron.schedule`, `setval`, a
 *   cleanup routine from an earlier migration). A statement-by-statement read
 *   cannot see what those do, and a migration is applied to production on
 *   push to main. DEFINING a routine that only reads (a row-level-security
 *   helper) still passes, and a `SELECT` inside a view or policy definition is
 *   not a call. Measured over the 135 migrations on main on 2026-10-11: 12
 *   held before this rule, 25 after; 7 of the 13 new holds are `DO` blocks
 *   that only create a type if missing. Narrowing the backfill exemption to
 *   no-FROM, exactly-`IS NULL` fills took it to 36: all 11 new holds are
 *   `UPDATE … FROM` backfills.
 * - Dropping a policy, index, trigger, function, view or constraint loses no
 *   row, so it does not hold.
 *
 * Pure: a string in, a verdict out. Comments, string literals and quoted
 * identifiers are lexed away first, so words inside them never count.
 */

import { escapeRegExp } from "../escape-regexp.js";
import { getProjectConfig } from "../project-config.js";

export interface MigrationVerdict {
  readonly destructive: boolean;
  /** Plain words, one per distinct finding, e.g. "drops the table public.money_goal". */
  readonly reasons: readonly string[];
}

/** A `.sql` file directly under the project's migrations folder
 *  (`migrations.dir` in `.sandcastle/project.json`; no folder configured means
 *  nothing is a migration). Anything in a subfolder (a journal or snapshot
 *  folder) describes migrations; it is not a migration itself. */
export const isMigrationSqlPath = (
  path: string,
  dir: string | undefined = getProjectConfig().migrations?.dir,
): boolean => {
  if (dir === undefined) return false;
  const prefix = `${dir.replace(/^\.\//, "").replace(/\/+$/, "")}/`;
  return path.startsWith(prefix) && /^[^/]+\.sql$/.test(path.slice(prefix.length));
};

export function classifyMigrationSql(sql: string): MigrationVerdict {
  const reasons = new Set<string>();
  classifyInto(sql, new Set<string>(), reasons);
  return { destructive: reasons.size > 0, reasons: [...reasons] };
}

// ---------------------------------------------------------------------------
// Lexing
// ---------------------------------------------------------------------------

interface Lexed {
  /** The SQL with comments removed, strings emptied, identifier quotes
   *  unwrapped and every dollar-quoted body replaced by a placeholder. */
  readonly code: string;
  readonly bodies: readonly string[];
}

const BODY_PLACEHOLDER = /\u0000(\d+)\u0000/g;
const isWordChar = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_]/.test(c);

function lex(sql: string): Lexed {
  let code = "";
  const bodies: string[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      code += " ";
      continue;
    }
    if (c === "/" && next === "*") {
      // Postgres block comments nest.
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql.startsWith("/*", i)) {
          depth += 1;
          i += 2;
        } else if (sql.startsWith("*/", i)) {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      code += " ";
      continue;
    }
    if (c === "'") {
      const escaped = /[Ee]/.test(sql[i - 1] ?? "") && !isWordChar(sql[i - 2]);
      if (escaped) code = code.slice(0, -1);
      i += 1;
      while (i < sql.length) {
        if (escaped && sql[i] === "\\") {
          i += 2;
        } else if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
        } else if (sql[i] === "'") {
          i += 1;
          break;
        } else {
          i += 1;
        }
      }
      code += "''";
      continue;
    }
    if (c === '"') {
      let ident = "";
      i += 1;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          ident += '"';
          i += 2;
        } else if (sql[i] === '"') {
          i += 1;
          break;
        } else {
          ident += sql[i];
          i += 1;
        }
      }
      code += ident;
      continue;
    }
    if (c === "$" && !isWordChar(sql[i - 1])) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))?.[0];
      if (tag !== undefined) {
        const close = sql.indexOf(tag, i + tag.length);
        const end = close === -1 ? sql.length : close;
        bodies.push(sql.slice(i + tag.length, end));
        code += ` \u0000${bodies.length - 1}\u0000 `;
        i = close === -1 ? sql.length : close + tag.length;
        continue;
      }
    }
    code += c;
    i += 1;
  }
  return { code, bodies };
}

/** Split on `sep` wherever the parenthesis depth is zero. */
function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === "(") depth += 1;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === sep && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** `text` with every parenthesised group blanked, so a search sees only the
 *  top level. */
function topLevelOnly(text: string): string {
  let out = "";
  let depth = 0;
  for (const c of text) {
    if (c === "(") {
      if (depth === 0) out += "(";
      depth += 1;
    } else if (c === ")") {
      depth = Math.max(0, depth - 1);
      if (depth === 0) out += ")";
    } else if (depth === 0) {
      out += c;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** A statement inside a `DO` body can follow a PL/pgSQL keyword rather than
 *  start the text after the previous `;`. */
const START = String.raw`(?:^|\b(?:BEGIN|THEN|ELSE|LOOP) )`;

const DROP_KIND = new RegExp(
  `${START}DROP (TABLE|SCHEMA|TYPE|DOMAIN|SEQUENCE) (?:IF EXISTS )?([^;]+?)(?: CASCADE| RESTRICT)?$`,
  "i",
);
const TRUNCATE = new RegExp(`${START}TRUNCATE (?:TABLE )?(?:ONLY )?([^;]+?)(?: CASCADE| RESTRICT| RESTART IDENTITY| CONTINUE IDENTITY)*$`, "i");
const RENAME_VALUE = new RegExp(`${START}ALTER TYPE (\\S+) RENAME VALUE\\b`, "i");
const ALTER_TABLE = new RegExp(`${START}ALTER TABLE (?:IF EXISTS )?(?:ONLY )?(\\S+) (.+)$`, "i");
const DELETE_FROM = /\bDELETE FROM (?:ONLY )?([\w.]+)/gi;
const UPDATE_HEAD = /\bUPDATE (?:ONLY )?([\w.]+)(?: (?:AS )?(\w+))? SET /gi;
const NOT_A_TABLE = new Set(["SET", "OF", "ON"]);

const names = (list: string): string[] =>
  list
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n !== "");

const ROUTINE_HEAD = /^CREATE (?:OR REPLACE )?(FUNCTION|PROCEDURE) ([\w.]+) ?\(/i;
const CALL = new RegExp(`${START}CALL ([\\w.]+)`, "i");
const SELECT_OR_PERFORM = new RegExp(`${START}(?:WITH|SELECT|PERFORM)\\b`, "i");
/** A `WITH` whose main statement changes rows is read by the DML rules, not as a SELECT. */
const TOP_LEVEL_DML = /\b(?:INSERT|UPDATE|DELETE|MERGE)\b/i;
/** Words that can sit before `(` in a SELECT without being a function call. */
const NOT_A_CALL = new Set(["AS", "EXISTS", "IN", "ANY", "ALL", "SOME", "VALUES", "FROM", "JOIN", "ON", "USING", "WHERE", "AND", "OR", "NOT", "SELECT"]);
/** A word in a routine body that can delete or rewrite data. `FOR UPDATE` (a
 *  row lock inside a read) is taken out first. */
const WRITING_WORD = /\b(?:DELETE|TRUNCATE|DROP|UPDATE|EXECUTE|ALTER)\b/i;

/** True when a routine body (or a body nested inside it) holds a writing word
 *  outside its comments and string literals. */
function bodyCanWrite(body: string): boolean {
  const { code, bodies } = lex(body);
  if (WRITING_WORD.test(code.replace(/\bFOR UPDATE\b/gi, " "))) return true;
  return bodies.some(bodyCanWrite);
}

function classifyInto(sql: string, added: Set<string>, reasons: Set<string>): void {
  const { code, bodies } = lex(sql);
  for (const raw of splitTopLevel(code, ";")) {
    const stmt = raw.replace(/\s+/g, " ").trim();
    if (stmt === "") continue;

    // Fail closed (spec #1334 review): a routine whose body can write is
    // treated as if it will run, because nothing here can prove it never does
    // during apply — a later statement, a trigger or a cron job can call it.
    const routine = ROUTINE_HEAD.exec(stmt);
    if (routine) {
      const routineBodies = [...stmt.matchAll(BODY_PLACEHOLDER)].map((m) => bodies[Number(m[1])] ?? "");
      const kind = routine[1]!.toLowerCase();
      if (routineBodies.length === 0) {
        reasons.add(`defines the ${kind} ${routine[2]} with a body the sorter cannot read`);
      } else if (routineBodies.some(bodyCanWrite)) {
        reasons.add(`defines the ${kind} ${routine[2]}, whose body can delete or rewrite data`);
      }
      continue;
    }
    if (/^DO\b/i.test(stmt)) {
      // Fail closed: every DO block holds. Its own statements are still read
      // below so the reason names what it does when it can be named.
      reasons.add("runs a DO block, which can change data in ways the sorter cannot read");
      for (const m of stmt.matchAll(BODY_PLACEHOLDER)) {
        const body = bodies[Number(m[1])] ?? "";
        // Read the RAW body: `EXECUTE 'DROP …'` hides its statement in a
        // string, which lexing would empty.
        if (/\bEXECUTE\b/i.test(body)) reasons.add("runs dynamic SQL (EXECUTE) inside a DO block");
        classifyInto(body, added, reasons);
      }
      continue;
    }
    // Any other dollar-quoted text is data, not statements.
    const s = stmt.replace(BODY_PLACEHOLDER, "''");

    const call = CALL.exec(s);
    if (call) reasons.add(`calls the procedure ${call[1]}`);
    if (SELECT_OR_PERFORM.test(s) && !TOP_LEVEL_DML.test(topLevelOnly(s))) {
      for (const m of s.matchAll(/\b([\w.]+) ?\(/g)) {
        const name = m[1]!;
        if (!NOT_A_CALL.has(name.toUpperCase())) {
          reasons.add(`calls ${name}, which can change data in ways the sorter cannot read`);
        }
      }
    }

    const drop = DROP_KIND.exec(s);
    if (drop) {
      for (const n of names(drop[2]!)) reasons.add(`drops the ${drop[1]!.toLowerCase()} ${n}`);
    }
    const truncate = TRUNCATE.exec(s);
    if (truncate) {
      for (const n of names(truncate[1]!)) reasons.add(`empties the table ${n}`);
    }
    const renameValue = RENAME_VALUE.exec(s);
    if (renameValue) reasons.add(`renames a value of ${renameValue[1]}`);
    const alter = ALTER_TABLE.exec(s);
    if (alter) alterTable(alter[1]!, alter[2]!, added, reasons);

    for (const m of s.matchAll(DELETE_FROM)) reasons.add(`deletes rows from ${m[1]}`);
    updates(s, added, reasons);
    if (/\bON CONFLICT\b.*\bDO UPDATE\b/i.test(s)) {
      const into = /\bINSERT INTO ([\w.]+)/i.exec(s);
      reasons.add(`overwrites existing rows of ${into?.[1] ?? "a table"}`);
    }
    const merge = new RegExp(`${START}MERGE INTO ([\\w.]+)`, "i").exec(s);
    if (merge) reasons.add(`overwrites existing rows of ${merge[1]}`);
  }
}

function alterTable(table: string, actions: string, added: Set<string>, reasons: Set<string>): void {
  if (/^RENAME CONSTRAINT\b/i.test(actions)) return;
  if (/^RENAME TO\b/i.test(actions)) {
    reasons.add(`renames the table ${table}`);
    return;
  }
  const rename = /^RENAME (?:COLUMN )?(\S+) TO\b/i.exec(actions);
  if (rename) {
    reasons.add(`renames ${table}.${rename[1]}`);
    return;
  }
  for (const part of splitTopLevel(actions, ",")) {
    const action = part.trim();
    const add = /^ADD (?:COLUMN )?(?:IF NOT EXISTS )?(\S+)/i.exec(action);
    if (add && !/^(?:CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE)$/i.test(add[1]!)) {
      added.add(columnKey(table, add[1]!));
      continue;
    }
    const drop = /^DROP (?:COLUMN )?(?:IF EXISTS )?(\S+)/i.exec(action);
    if (drop && !/^CONSTRAINT$/i.test(drop[1]!)) {
      reasons.add(`drops the column ${table}.${drop[1]}`);
      continue;
    }
    const type = /^ALTER (?:COLUMN )?(\S+) (?:SET DATA )?TYPE\b/i.exec(action);
    if (type) reasons.add(`changes the type of ${table}.${type[1]}`);
  }
}

/**
 * Every `UPDATE t SET …` in the statement (a CTE can hold more than one).
 * With a FROM clause nothing is exempt. Otherwise a set column is exempt when
 * the WHERE is exactly `col IS NULL` (optionally alias-qualified), or when
 * there is no WHERE and the column was added to THIS table earlier in this
 * migration (table and column both match — `ADD COLUMN status` on one table
 * never exempts `SET status` on another).
 */
function updates(s: string, added: Set<string>, reasons: Set<string>): void {
  for (const m of s.matchAll(UPDATE_HEAD)) {
    const table = m[1]!;
    if (NOT_A_TABLE.has(table.toUpperCase())) continue;
    const rest = s.slice(m.index + m[0].length);
    const setList = untilClause(rest, /^(?:FROM|WHERE|RETURNING)\b/i);
    const afterSet = rest.slice(setList.length);
    const hasFrom = /^ ?FROM /i.test(afterSet);
    const where = /^ ?WHERE /i.test(afterSet)
      ? untilClause(afterSet.replace(/^ ?WHERE /i, ""), /^RETURNING\b/i).trim()
      : "";
    const isBackfill = (col: string) =>
      !hasFrom &&
      (where === ""
        ? added.has(columnKey(table, col))
        : new RegExp(`^(?:\\w+\\.)?${escapeRegExp(col)} IS NULL$`, "i").test(where));

    const rewritten = setColumns(setList).filter((col) => !isBackfill(col));
    if (rewritten.length > 0) reasons.add(`rewrites existing rows of ${table} (${rewritten.join(", ")})`);
  }
}

/** The text from the start up to the first top-level clause matching `stop`,
 *  or a `)` that closes a group the text did not open (the end of a CTE). */
function untilClause(text: string, stop: RegExp): string {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === "(") depth += 1;
    else if (c === ")") {
      if (depth === 0) return text.slice(0, i);
      depth -= 1;
    } else if (depth === 0 && (i === 0 || text[i - 1] === " ") && stop.test(text.slice(i))) {
      return text.slice(0, i).trimEnd();
    }
  }
  return text;
}

/** Column names on the left of each `=` in a SET list, alias stripped,
 *  lower-cased. `(a, b) = (…)` names both. */
function setColumns(setList: string): string[] {
  const cols: string[] = [];
  for (const assignment of splitTopLevel(setList, ",")) {
    const left = assignment.split("=")[0]!.trim().replace(/^\(|\)$/g, "");
    for (const col of left.split(",")) {
      const name = col.trim().split(".").pop()!.toLowerCase();
      if (name !== "") cols.push(name);
    }
  }
  return cols;
}

/** `table.column`, lower-cased, with the default `public.` schema dropped so
 *  `ALTER TABLE public.t ADD c` and `UPDATE t SET c` name the same column. */
const columnKey = (table: string, column: string): string =>
  `${table.toLowerCase().replace(/^public\./, "")}.${column.toLowerCase()}`;
