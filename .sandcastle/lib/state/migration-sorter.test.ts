/**
 * The migration sorter (spec #1334 "Database changes"): which new migrations
 * hold the run's PR for the owner, read straight off the SQL.
 */
import { describe, expect, it } from "vitest";

import { defaultProjectConfig, resetProjectConfig, setProjectConfig } from "../project-config.js";

import { classifyMigrationSql, isMigrationSqlPath } from "./migration-sorter.js";

describe("isMigrationSqlPath", () => {
  it("reads a SQL file under the configured migrations folder as a migration, and nothing else", () => {
    expect(isMigrationSqlPath("packages/db/migrations/0142_add_wall.sql")).toBe(true);
    expect(isMigrationSqlPath("packages/db/migrations/meta/_journal.json")).toBe(false);
    expect(isMigrationSqlPath("packages/db/migrations/meta/0142_snapshot.sql")).toBe(false);
    expect(isMigrationSqlPath("apps/nextjs/src/x.sql")).toBe(false);
  });

  it("follows `migrations.dir` (a leading ./ and a trailing slash are tolerated)", () => {
    setProjectConfig({ ...defaultProjectConfig(), migrations: { dir: "./db/migrate/" } });
    expect(isMigrationSqlPath("db/migrate/001_init.sql")).toBe(true);
    expect(isMigrationSqlPath("packages/db/migrations/0142_add_wall.sql")).toBe(false);
  });

  it("is OFF by default: with no migrations folder configured nothing is a migration", () => {
    resetProjectConfig();
    expect(isMigrationSqlPath("packages/db/migrations/0142_add_wall.sql")).toBe(false);
    expect(isMigrationSqlPath("migrations/0001_init.sql")).toBe(false);
  });
});

/**
 * Spec #1334 "Database changes": a migration that deletes or rewrites data
 * already in the database holds the run's PR for the owner; one that only adds
 * (tables, columns, indexes, policies) does not. Owner decision: an UPDATE that
 * only fills a column added in the same migration, or only fills blanks
 * (`WHERE col IS NULL`), is a backfill and does not hold.
 */
describe("classifyMigrationSql", () => {
  const passes: readonly (readonly [string, string])[] = [
    ["a new table", "CREATE TABLE t (id uuid PRIMARY KEY);"],
    ["new indexes", "CREATE INDEX IF NOT EXISTS i ON t (a); CREATE UNIQUE INDEX u ON t (b);"],
    [
      "row-level security and a replaced policy",
      "ALTER TABLE t ENABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS p ON t; CREATE POLICY p ON t FOR UPDATE USING (true);",
    ],
    ["a new column with a default", "ALTER TABLE t ADD COLUMN IF NOT EXISTS c text NOT NULL DEFAULT 'x';"],
    [
      "null and default changes",
      "ALTER TABLE t ALTER COLUMN c SET NOT NULL; ALTER TABLE t ALTER COLUMN c DROP NOT NULL; ALTER TABLE t ALTER COLUMN c DROP DEFAULT;",
    ],
    [
      "a replaced constraint whose foreign key cascades",
      "ALTER TABLE t DROP CONSTRAINT IF EXISTS k; ALTER TABLE t ADD CONSTRAINT k FOREIGN KEY (a) REFERENCES u(id) ON DELETE CASCADE ON UPDATE CASCADE;",
    ],
    ["a new enum value", "ALTER TYPE e ADD VALUE IF NOT EXISTS 'v';"],
    [
      "dropping an index, a trigger and a function (no row is lost)",
      "DROP INDEX IF EXISTS i; DROP TRIGGER IF EXISTS g ON t; DROP FUNCTION f();",
    ],
    [
      "a trigger on update and an update grant",
      "CREATE TRIGGER g BEFORE UPDATE OF c ON t FOR EACH ROW EXECUTE FUNCTION f(); GRANT UPDATE ON t TO authenticated;",
    ],
    ["an insert that skips conflicts", "INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO NOTHING;"],
    ["scary words inside a string", "COMMENT ON COLUMN t.c IS 'a backfill will UPDATE t SET c and DELETE FROM t';"],
    ["scary words inside comments", "-- DROP TABLE t;\n/* DELETE FROM t; /* nested */ still comment */ SELECT 1;"],
    [
      "a row-level-security helper function that only reads",
      "CREATE OR REPLACE FUNCTION public.is_member(t uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT EXISTS (SELECT 1 FROM members m WHERE m.team_id = t) $$; CREATE POLICY p ON x USING (public.is_member(team_id));",
    ],
    [
      "a trigger function that only checks which operation fired it",
      "CREATE FUNCTION g() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP = 'UPDATE' THEN NEW.at := now(); END IF; RETURN NEW; END $$; CREATE TRIGGER g BEFORE UPDATE ON t FOR EACH ROW EXECUTE FUNCTION g();",
    ],
    ["a top-level SELECT that calls no function", "SELECT 1; SELECT EXISTS (SELECT 1 FROM t);"],
    [
      "a view and a policy whose definitions call functions (a definition is not a call)",
      "CREATE VIEW v AS SELECT lower(name) FROM t; CREATE POLICY p ON t USING (EXISTS (SELECT 1 FROM m WHERE public.is_member(m.team_id)));",
    ],
    ["filling a column added in the same file", "ALTER TABLE t ADD COLUMN c int; UPDATE t SET c = 0;"],
    ["filling blanks only", "UPDATE t SET c = 'x' WHERE c IS NULL;"],
    ["filling blanks through an alias", "UPDATE public.goals g SET team_id = 'x' WHERE g.team_id IS NULL;"],
    [
      "filling a column added in the same file, only where blank",
      "ALTER TABLE t ADD COLUMN c int; UPDATE t SET c = 0 WHERE c IS NULL;",
    ],
    [
      "drizzle's quoted identifiers and statement breakpoints",
      'ALTER TABLE "public"."t" ADD COLUMN "c" int;--> statement-breakpoint\nCREATE INDEX "i" ON "t" ("c");',
    ],
    ["renaming a constraint", "ALTER TABLE t RENAME CONSTRAINT k TO k2;"],
    ["an escaped string holding a semicolon", "SELECT E'it\\'s; DELETE FROM t';"],
    [
      "a WITH whose main statement is a blanks-only fill (its subquery functions are not calls)",
      "WITH m (a) AS (VALUES (1)) UPDATE t SET c = (SELECT COALESCE(m.a, 0) FROM m LIMIT 1) WHERE c IS NULL;",
    ],
  ];

  it.each(passes)("does not hold the run for %s", (_name, sql) => {
    expect(classifyMigrationSql(sql)).toEqual({ destructive: false, reasons: [] });
  });

  const holds: readonly (readonly [string, string, string])[] = [
    ["dropping a table", "DROP TABLE IF EXISTS public.money_goal CASCADE;", "drops the table public.money_goal"],
    ["dropping a column", "ALTER TABLE t DROP COLUMN IF EXISTS c;", "drops the column t.c"],
    ["dropping a column without the COLUMN word", "ALTER TABLE t DROP c;", "drops the column t.c"],
    ["a drop hidden in a multi-action alter", "ALTER TABLE t ADD COLUMN a int, DROP COLUMN b;", "drops the column t.b"],
    [
      "changing a column's type, drizzle style",
      'ALTER TABLE "public"."t" ALTER COLUMN "c" SET DATA TYPE "public"."e" USING "c"::"public"."e";',
      "changes the type of public.t.c",
    ],
    ["changing a column's type, short form", "ALTER TABLE t ALTER c TYPE bigint;", "changes the type of t.c"],
    ["renaming a column", "ALTER TABLE t RENAME COLUMN a TO b;", "renames t.a"],
    ["renaming a table", "ALTER TABLE t RENAME TO u;", "renames the table t"],
    ["renaming an enum value", "ALTER TYPE e RENAME VALUE 'a' TO 'b';", "renames a value of e"],
    ["emptying a table", "TRUNCATE t;", "empties the table t"],
    [
      "deleting rows",
      "DELETE FROM \"public\".\"client_invitations\" WHERE \"status\" = 'pending';",
      "deletes rows from public.client_invitations",
    ],
    [
      "deleting rows behind a WITH",
      "WITH r AS (SELECT id FROM t) DELETE FROM t WHERE id IN (SELECT id FROM r);",
      "deletes rows from t",
    ],
    [
      "rewriting every row",
      "UPDATE public.teams SET timezone = 'America/Toronto';",
      "rewrites existing rows of public.teams (timezone)",
    ],
    [
      "filling a column with the same name that was added to a different table",
      "ALTER TABLE a ADD COLUMN status text; UPDATE b SET status = 'x';",
      "rewrites existing rows of b (status)",
    ],
    ["a fill-blanks filter defeated by OR", "UPDATE t SET c = 1 WHERE c IS NULL OR d;", "rewrites existing rows of t (c)"],
    // Spec #1334 review fix: the backfill exemption reads only a WHERE that is
    // exactly `<col> IS NULL`, with no FROM; anything else might touch values.
    ["a fill-blanks filter that is negated", "UPDATE t SET c = 1 WHERE NOT c IS NULL;", "rewrites existing rows of t (c)"],
    ["a fill-blanks filter narrowed by AND", "UPDATE t SET c = 1 WHERE c IS NULL AND d;", "rewrites existing rows of t (c)"],
    [
      "a fill-blanks filter on a joined table",
      "UPDATE t SET c = u.c FROM u WHERE u.c IS NULL;",
      "rewrites existing rows of t (c)",
    ],
    [
      "filling blanks through an alias and a join",
      "UPDATE public.goals g SET team_id = up.team_id FROM up WHERE g.team_id IS NULL AND up.id = g.created_by;",
      "rewrites existing rows of public.goals (team_id)",
    ],
    [
      "filling a column added in the same file from a join",
      "ALTER TABLE t ADD COLUMN c int; UPDATE t SET c = u.c FROM u WHERE u.id = t.id;",
      "rewrites existing rows of t (c)",
    ],
    [
      "filling a column added in the same file under some other filter",
      "ALTER TABLE t ADD COLUMN c int; UPDATE t SET c = 0 WHERE d > 1;",
      "rewrites existing rows of t (c)",
    ],
    ["an update inside a DO block", "DO $$ BEGIN UPDATE t SET c = 1; END $$;", "rewrites existing rows of t (c)"],
    ["a delete inside a tagged DO block", "DO $body$ BEGIN DELETE FROM t; END $body$;", "deletes rows from t"],
    [
      "an insert that overwrites on conflict",
      "INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET b = 2;",
      "overwrites existing rows of t",
    ],
    ["dropping a type with everything that uses it", "DROP TYPE e CASCADE;", "drops the type e"],
    ["dropping a schema", "DROP SCHEMA s;", "drops the schema s"],
    // Spec #1334 review fix: data destroyed through a routine or a DO block is
    // invisible to a statement-by-statement read, so the sorter fails closed.
    ["calling a procedure", "CALL public.purge_old();", "calls the procedure public.purge_old"],
    [
      "a DO block, even one that looks harmless",
      "DO $$ BEGIN RAISE NOTICE 'x'; PERFORM 1; END $$;",
      "runs a DO block, which can change data in ways the sorter cannot read",
    ],
    [
      "a DO block whose drop is hidden inside an EXECUTE string",
      "DO $$ BEGIN EXECUTE 'DROP TABLE deals'; END $$;",
      "runs dynamic SQL (EXECUTE) inside a DO block",
    ],
    [
      "a function whose body deletes rows",
      "CREATE OR REPLACE FUNCTION f() RETURNS void LANGUAGE sql AS $$ DELETE FROM t WHERE old $$;",
      "defines the function f, whose body can delete or rewrite data",
    ],
    [
      "a procedure whose body runs dynamic SQL",
      "CREATE PROCEDURE p() LANGUAGE plpgsql AS $$ BEGIN EXECUTE format('TRUNCATE %I', 't'); END $$;",
      "defines the procedure p, whose body can delete or rewrite data",
    ],
    [
      "a function defined in the file and then called with SELECT",
      "CREATE FUNCTION purge() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$; SELECT purge();",
      "calls purge, which can change data in ways the sorter cannot read",
    ],
    [
      "a schema-qualified function defined in the file and then called with PERFORM",
      "CREATE FUNCTION public.purge() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$; PERFORM public.purge();",
      "calls public.purge, which can change data in ways the sorter cannot read",
    ],
    // Spec #1334 review fix: any top-level SELECT / PERFORM that calls a
    // function holds, wherever the function was defined.
    [
      "a SELECT of a function an earlier migration defined",
      "SELECT public.cleanup_ai_limit_hits();",
      "calls public.cleanup_ai_limit_hits, which can change data in ways the sorter cannot read",
    ],
    [
      "scheduling a cron job",
      "SELECT cron.schedule('purge', '0 3 * * *', 'DELETE FROM t');",
      "calls cron.schedule, which can change data in ways the sorter cannot read",
    ],
    [
      "resetting a sequence",
      "SELECT setval('s', 1);",
      "calls setval, which can change data in ways the sorter cannot read",
    ],
    [
      "a function call behind a WITH",
      "WITH x AS (SELECT 1) SELECT public.purge() FROM x;",
      "calls public.purge, which can change data in ways the sorter cannot read",
    ],
  ];

  it.each(holds)("holds the run for %s", (_name, sql, reason) => {
    const v = classifyMigrationSql(sql);
    expect(v.destructive).toBe(true);
    expect(v.reasons).toContain(reason);
  });

  it("still holds a plain DELETE with no routine or DO block around it (the probe works)", () => {
    expect(classifyMigrationSql("DELETE FROM deals;")).toEqual({
      destructive: true,
      reasons: ["deletes rows from deals"],
    });
  });

  it("exempts only the column that fills blanks, not a second column set beside it", () => {
    expect(classifyMigrationSql("UPDATE t SET c = 1, d = 2 WHERE c IS NULL;").reasons).toEqual([
      "rewrites existing rows of t (d)",
    ]);
  });

  it("reads every UPDATE in one statement, not just the first", () => {
    const v = classifyMigrationSql(
      "WITH a AS (UPDATE t SET c = 1 WHERE c IS NULL RETURNING id) UPDATE u SET d = 2 FROM a WHERE u.id = a.id;",
    );
    expect(v.reasons).toEqual(["rewrites existing rows of u (d)"]);
  });
});

/**
 * The same sorter over small, self-contained migrations, one per shape that a
 * real project's migrations took in practice (type changes, drops, backfills,
 * routines, DO blocks, `UPDATE … FROM` joins). Synthetic on purpose: the test
 * must not depend on any particular project's files.
 */
const HELD: Record<string, string> = {
  "type-change":
    "ALTER TABLE public.reset_log ALTER COLUMN kind TYPE text USING kind::text;",
  "answers-rewrite":
    "UPDATE public.form_answers SET answers = to_jsonb(true) WHERE answers = '\"on\"'::jsonb;",
  "drop-table": "DROP TABLE public.money_goal;",
  "assignee-rewrite":
    "UPDATE public.tasks SET assigned_to_id = creator_id WHERE assigned_to_id NOT IN (SELECT id FROM public.users);",
  "delete-rows": "DELETE FROM public.budget_tags WHERE owner_id IS NULL;",
  "cleanup-function": [
    "CREATE FUNCTION public.cleanup_ai_usage_events() RETURNS void LANGUAGE sql AS $$",
    "  DELETE FROM public.ai_usage_events WHERE created_at < now() - interval '90 days';",
    "$$;",
  ].join("\n"),
  "cleanup-function-and-cron": [
    "CREATE FUNCTION public.cleanup_ai_limit_hits() RETURNS void LANGUAGE sql AS $$",
    "  DELETE FROM public.ai_limit_hits WHERE created_at < now() - interval '30 days';",
    "$$;",
    "SELECT cron.schedule('cleanup-ai-limit-hits', '0 3 * * *', 'SELECT public.cleanup_ai_limit_hits()');",
  ].join("\n"),
  "trigger-function-with-update": [
    "CREATE FUNCTION public.sync_team_is_solo() RETURNS trigger LANGUAGE plpgsql AS $$",
    "BEGIN",
    "  UPDATE public.teams SET is_solo = true WHERE id = NEW.team_id;",
    "  RETURN NEW;",
    "END;",
    "$$;",
  ].join("\n"),
  "do-block": [
    "DO $$",
    "BEGIN",
    "  UPDATE public.task_templates SET group_id = NULL WHERE group_id = 0;",
    "END $$;",
  ].join("\n"),
  "function-call": "SELECT public.seed_default_task_groups(id) FROM public.teams;",
  "subselect-update":
    "UPDATE public.teams SET is_solo = true WHERE id IN (SELECT team_id FROM public.members GROUP BY team_id HAVING count(*) = 1);",
  "default-rewrite": "UPDATE public.teams SET timezone = 'America/Toronto' WHERE timezone = 'UTC';",
  "stale-delete":
    "DELETE FROM public.client_invitations WHERE expires_at < now() - interval '30 days';",
  "dedupe-delete":
    "DELETE FROM public.task_templates a USING public.task_templates b WHERE a.ctid < b.ctid AND a.name = b.name;",
  "join-backfill-assignee":
    "UPDATE public.tasks t SET assigned_to_id = tt.default_assignee FROM public.task_templates tt WHERE t.template_id = tt.id;",
  "join-backfill-team":
    "UPDATE public.staging_records s SET team_id = u.team_id FROM public.users u WHERE s.user_id = u.id;",
  "join-backfill-goals":
    "UPDATE public.goals g SET team_id = a.team_id FROM public.agents a WHERE g.agent_id = a.id;",
};

const SAFE: Record<string, string> = {
  "enum-column-index": [
    "CREATE TYPE public.fulfiller AS ENUM ('a', 'b');",
    "ALTER TABLE public.orders ADD COLUMN fulfiller public.fulfiller;",
    "CREATE INDEX orders_fulfiller_idx ON public.orders (fulfiller);",
  ].join("\n"),
  "table-rls-policy": [
    "CREATE TABLE public.notifications (id uuid PRIMARY KEY, team_id uuid NOT NULL);",
    "ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;",
    "CREATE POLICY notifications_team ON public.notifications USING (team_id = auth.team_id());",
  ].join("\n"),
  "add-column-and-fill": [
    "ALTER TABLE public.orders ADD COLUMN stamp integer;",
    "UPDATE public.orders SET stamp = 0;",
  ].join("\n"),
  trigger: [
    "CREATE TRIGGER orders_touch BEFORE UPDATE ON public.orders",
    "  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();",
  ].join("\n"),
  "read-only-function": [
    "CREATE FUNCTION public.is_member(t uuid) RETURNS boolean LANGUAGE sql STABLE AS $$",
    "  SELECT EXISTS (SELECT 1 FROM public.members WHERE team_id = t);",
    "$$;",
  ].join("\n"),
  "enum-value": "ALTER TYPE public.fulfiller ADD VALUE 'c';",
  "is-null-backfill": "UPDATE public.leads SET source_id = 1 WHERE source_id IS NULL;",
  "drop-policy-and-index": [
    "DROP POLICY orders_old ON public.orders;",
    "DROP INDEX public.orders_old_idx;",
  ].join("\n"),
};

describe("classifyMigrationSql on representative migrations", () => {
  it.each([
    ["type-change", "changes the type of"],
    ["answers-rewrite", "(answers)"],
    ["drop-table", "drops the table public.money_goal"],
    ["assignee-rewrite", "(assigned_to_id)"],
    ["delete-rows", "deletes rows from public.budget_tags"],
    ["cleanup-function", "defines the function public.cleanup_ai_usage_events"],
    ["cleanup-function-and-cron", "defines the function public.cleanup_ai_limit_hits"],
    ["trigger-function-with-update", "defines the function public.sync_team_is_solo"],
    ["do-block", "runs a DO block"],
    ["function-call", "calls public.seed_default_task_groups"],
    ["subselect-update", "(is_solo)"],
    ["default-rewrite", "(timezone)"],
    ["stale-delete", "deletes rows from public.client_invitations"],
    ["dedupe-delete", "deletes rows from"],
    ["join-backfill-assignee", "(assigned_to_id)"],
    // Backfills through `UPDATE … FROM`: the join decides which rows change,
    // so the backfill exemption no longer reads them as safe.
    ["join-backfill-team", "rewrites existing rows of public.staging_records (team_id)"],
    ["join-backfill-goals", "rewrites existing rows of public.goals (team_id)"],
    ["cleanup-function-and-cron", "calls cron.schedule"],
  ])("holds the run for %s", (name, reason) => {
    const v = classifyMigrationSql(HELD[name]!);
    expect(v.destructive).toBe(true);
    expect(v.reasons.join("\n")).toContain(reason);
  });

  it.each(Object.keys(SAFE))("does not hold the run for %s", (name) => {
    expect(classifyMigrationSql(SAFE[name]!)).toEqual({ destructive: false, reasons: [] });
  });
});
