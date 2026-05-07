/**
 * Drizzle migration auto-applier tests.
 *
 * We mock both `git diff` and `psql` invocations via the `_exec` injection
 * seam — no real shell, no real database. The fake migrations are written
 * to a tmp dir so reading them goes through the real `fs.readFile`.
 */

import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  applyMigrationsBetween,
  classifyPsqlErrors,
  isDrizzleMigrationPath,
  splitSqlStatements,
  BENIGN_ALREADY_EXISTS_REGEX,
  type ExecRunner,
} from "../src/migrations/drizzle-applier.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ExecCall {
  bin: string;
  args: readonly string[];
}

function recordingExec(handler: {
  git?: (args: readonly string[]) => { stdout: string; exitCode?: number };
  psql?: (
    args: readonly string[],
  ) => { stdout?: string; stderr?: string; exitCode?: number };
}): { exec: ExecRunner; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec: ExecRunner = async (bin, args) => {
    calls.push({ bin, args: [...args] });
    if (bin === "git" && handler.git) {
      const r = handler.git(args);
      return { stdout: r.stdout, stderr: "", exitCode: r.exitCode ?? 0 };
    }
    if (bin === "psql" && handler.psql) {
      const r = handler.psql(args);
      return {
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
        exitCode: r.exitCode ?? 0,
      };
    }
    throw new Error(`unmocked exec: ${bin} ${args.join(" ")}`);
  };
  return { exec, calls };
}

async function makeRepoWithMigrations(
  files: Record<string, string>,
): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-mig-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
  }
  return root;
}

// ---------------------------------------------------------------------------
// Path classifier
// ---------------------------------------------------------------------------

describe("isDrizzleMigrationPath", () => {
  it("accepts numeric-prefix .sql under any /migrations/ segment", () => {
    expect(
      isDrizzleMigrationPath("packages/db/migrations/0001_init.sql"),
    ).toBe(true);
    expect(isDrizzleMigrationPath("apps/api/migrations/0042_add_users.sql")).toBe(
      true,
    );
  });
  it("rejects /meta/ paths and non-numeric prefixes", () => {
    expect(
      isDrizzleMigrationPath("packages/db/migrations/meta/_journal.json"),
    ).toBe(false);
    expect(
      isDrizzleMigrationPath("packages/db/migrations/meta/snap.sql"),
    ).toBe(false);
    expect(
      isDrizzleMigrationPath("packages/db/migrations/seed.sql"),
    ).toBe(false);
  });
  it("rejects non-.sql files even if under /migrations/", () => {
    expect(
      isDrizzleMigrationPath("packages/db/migrations/0001_init.ts"),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Statement splitter
// ---------------------------------------------------------------------------

describe("splitSqlStatements", () => {
  it("splits trivial statements on ;", () => {
    const stmts = splitSqlStatements(
      "CREATE TABLE foo (id int);\nALTER TABLE foo ADD COLUMN bar text;\n",
    );
    expect(stmts).toEqual([
      "CREATE TABLE foo (id int)",
      "ALTER TABLE foo ADD COLUMN bar text",
    ]);
  });
  it("does not split inside single-quoted strings", () => {
    const stmts = splitSqlStatements(
      `INSERT INTO t (msg) VALUES ('hi; you'); SELECT 1;`,
    );
    expect(stmts).toEqual([
      "INSERT INTO t (msg) VALUES ('hi; you')",
      "SELECT 1",
    ]);
  });
  it("preserves $$-quoted function bodies as one statement", () => {
    const sql = `
CREATE FUNCTION add_one(x int) RETURNS int AS $$
  BEGIN
    -- a; semicolon inside the body
    RETURN x + 1;
  END;
$$ LANGUAGE plpgsql;
SELECT add_one(2);
`;
    const stmts = splitSqlStatements(sql);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain("LANGUAGE plpgsql");
    expect(stmts[0]).toContain("RETURN x + 1");
    expect(stmts[1]).toBe("SELECT add_one(2)");
  });
  it("preserves $tag$-quoted bodies", () => {
    const sql = `CREATE FUNCTION f() RETURNS void AS $body$ SELECT 1; SELECT 2; $body$ LANGUAGE sql;`;
    const stmts = splitSqlStatements(sql);
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toContain("$body$ SELECT 1; SELECT 2; $body$");
  });
});

// ---------------------------------------------------------------------------
// Benign-error classifier
// ---------------------------------------------------------------------------

describe("classifyPsqlErrors", () => {
  it("treats `ERROR: relation \"x\" already exists` as benign", () => {
    const r = classifyPsqlErrors(`ERROR:  relation "users" already exists`);
    expect(r.benign).toHaveLength(1);
    expect(r.real).toHaveLength(0);
  });
  it("treats `duplicate key value violates unique constraint` as REAL", () => {
    const r = classifyPsqlErrors(
      `ERROR:  duplicate key value violates unique constraint "users_pkey"`,
    );
    expect(r.real).toHaveLength(1);
    expect(r.benign).toHaveLength(0);
  });
  it("strips the `psql:<file>:<line>:` prefix before classifying", () => {
    const r = classifyPsqlErrors(
      `psql:0001_init.sql:42: ERROR:  type "user_role" already exists`,
    );
    expect(r.benign).toHaveLength(1);
    expect(r.real).toHaveLength(0);
  });
  it("regex itself is anchored — won't match arbitrary already-exists text", () => {
    expect(
      BENIGN_ALREADY_EXISTS_REGEX.test(
        `ERROR:  the file "x" already exists on disk`,
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyMigrationsBetween — end-to-end
// ---------------------------------------------------------------------------

describe("applyMigrationsBetween", () => {
  it("happy path: 3 statements applied across 1 migration", async () => {
    const root = await makeRepoWithMigrations({
      "packages/db/migrations/0001_init.sql": [
        "CREATE TABLE users (id int);",
        "CREATE INDEX users_id_idx ON users (id);",
        "INSERT INTO users (id) VALUES (1);",
      ].join("\n"),
    });

    const { exec, calls } = recordingExec({
      git: () => ({
        stdout: "packages/db/migrations/0001_init.sql\n",
      }),
      psql: () => ({ stdout: "", exitCode: 0 }),
    });

    const result = await applyMigrationsBetween(root, "preSha", "postSha", {
      databaseUrl: "postgres://test",
      _exec: exec,
    });

    expect(result.applied).toBe(3);
    expect(result.benignSkipped).toBe(0);
    expect(result.realErrors).toHaveLength(0);

    // Verify execFile invariants: psql called via -X, ON_ERROR_STOP=1, -c
    const psqlCalls = calls.filter((c) => c.bin === "psql");
    expect(psqlCalls).toHaveLength(3);
    for (const c of psqlCalls) {
      expect(c.args).toContain("-X");
      expect(c.args).toContain("ON_ERROR_STOP=1");
      // url last positional arg
      expect(c.args.at(-1)).toBe("postgres://test");
    }
  });

  it("benign error skipped: implementer already applied; re-apply hits already-exists", async () => {
    const root = await makeRepoWithMigrations({
      "packages/db/migrations/0002_add_orders.sql":
        "CREATE TABLE orders (id int);",
    });

    const { exec } = recordingExec({
      git: () => ({
        stdout: "packages/db/migrations/0002_add_orders.sql\n",
      }),
      psql: () => ({
        stderr: 'ERROR:  relation "orders" already exists',
        exitCode: 3,
      }),
    });

    const result = await applyMigrationsBetween(root, "preSha", "postSha", {
      databaseUrl: "postgres://test",
      _exec: exec,
    });

    expect(result.applied).toBe(0);
    expect(result.benignSkipped).toBe(1);
    expect(result.realErrors).toHaveLength(0);
  });

  it("real error reported: duplicate key conflict on an INSERT", async () => {
    const root = await makeRepoWithMigrations({
      "packages/db/migrations/0003_seed.sql": [
        "CREATE TABLE roles (id int PRIMARY KEY);",
        "INSERT INTO roles (id) VALUES (1);",
      ].join("\n"),
    });

    const { exec } = recordingExec({
      git: () => ({
        stdout: "packages/db/migrations/0003_seed.sql\n",
      }),
      psql: (args) => {
        const stmt = args[args.indexOf("-c") + 1] ?? "";
        if (stmt.startsWith("CREATE TABLE")) {
          return { exitCode: 0 };
        }
        return {
          stderr:
            'ERROR:  duplicate key value violates unique constraint "roles_pkey"',
          exitCode: 3,
        };
      },
    });

    const result = await applyMigrationsBetween(root, "preSha", "postSha", {
      databaseUrl: "postgres://test",
      _exec: exec,
    });

    expect(result.applied).toBe(1);
    expect(result.benignSkipped).toBe(0);
    expect(result.realErrors).toHaveLength(1);
    expect(result.realErrors[0]!.file).toBe(
      "packages/db/migrations/0003_seed.sql",
    );
    expect(result.realErrors[0]!.stmt).toContain("INSERT INTO roles");
    expect(result.realErrors[0]!.msg).toContain("duplicate key value");
  });

  it("preSha === postSha: no git diff invoked, returns empty result", async () => {
    const root = await makeRepoWithMigrations({});
    const { exec, calls } = recordingExec({
      git: () => ({ stdout: "", exitCode: 0 }),
    });
    const result = await applyMigrationsBetween(root, "abc", "abc", {
      databaseUrl: "postgres://test",
      _exec: exec,
    });
    expect(result.applied).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("filters non-migration .sql additions (e.g. seed.sql)", async () => {
    const root = await makeRepoWithMigrations({
      "scripts/seed.sql": "INSERT INTO foo VALUES (1);",
      "packages/db/migrations/0004_x.sql": "CREATE TABLE x (id int);",
    });
    const { exec, calls } = recordingExec({
      git: () => ({
        stdout: [
          "scripts/seed.sql",
          "packages/db/migrations/0004_x.sql",
        ].join("\n"),
      }),
      psql: () => ({ exitCode: 0 }),
    });

    const result = await applyMigrationsBetween(root, "pre", "post", {
      databaseUrl: "postgres://test",
      _exec: exec,
    });

    expect(result.applied).toBe(1);
    // Only one psql call — seed.sql was filtered out
    expect(calls.filter((c) => c.bin === "psql")).toHaveLength(1);
  });
});
