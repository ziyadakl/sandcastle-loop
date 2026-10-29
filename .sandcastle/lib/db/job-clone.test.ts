/**
 * Pure-logic tests for per-job database clones (Piece B, issue #908).
 *
 * Naming, URL construction and the reap predicate need no Postgres — that's
 * the whole point of keeping them as pure functions. `cloneJobDatabase`,
 * `dropJobDatabase` and `sweepOrphanedJobDatabases` are exercised here only
 * through the injected `_exec` seam (a fake `psql`), the same discipline
 * `drizzle-applier.test.ts` uses for `applyMigrationsBetween` — no real
 * database is touched by this file. Isolation against a REAL database is
 * proven separately (see the session report / docs/reference/database.md)
 * with actual `psql` output, not simulated here.
 */
import { describe, expect, it, vi } from "vitest";

import type { ExecRunner } from "./psql-exec.js";
import {
  cloneJobDatabase,
  createOnceGate,
  DEFAULT_CLONE_MAX_ATTEMPTS,
  dropJobDatabase,
  isJobDatabaseName,
  jobDatabaseName,
  JOB_DB_PREFIX,
  parseJobDatabasePid,
  sanitizeForIdentifier,
  sweepOrphanedJobDatabases,
  withDatabaseName,
  withJobDbCleanupOnFailure,
} from "./job-clone.js";

const ADMIN_URL = "postgres://postgres:postgres@localhost:55432/postgres";

// ---------------------------------------------------------------------------
// sanitizeForIdentifier / jobDatabaseName
// ---------------------------------------------------------------------------

describe("sanitizeForIdentifier", () => {
  it("lower-cases and collapses non-alphanumerics into single underscores", () => {
    expect(sanitizeForIdentifier("agent/issue-761")).toBe("agent_issue_761");
  });

  it("trims leading/trailing underscores produced by leading/trailing punctuation", () => {
    expect(sanitizeForIdentifier("--weird--")).toBe("weird");
  });

  it("falls back to 'job' for an input with no alphanumeric characters", () => {
    expect(sanitizeForIdentifier("///")).toBe("job");
    expect(sanitizeForIdentifier("")).toBe("job");
  });
});

describe("jobDatabaseName", () => {
  it("always starts with the reap-recognisable prefix", () => {
    const name = jobDatabaseName("agent/issue-761", { pid: 4242, unique: "ab12cd" });
    expect(name.startsWith(JOB_DB_PREFIX)).toBe(true);
    expect(name).toBe("sc_job_agent_issue_761_4242_ab12cd");
  });

  it("produces only [a-z0-9_] — a safe, unquoted Postgres identifier", () => {
    const name = jobDatabaseName("Weird Branch/Name!!", {
      pid: 1,
      unique: "x",
    });
    expect(name).toMatch(/^[a-z0-9_]+$/);
  });

  it("stays within Postgres's 63-byte identifier limit for a very long label", () => {
    const longLabel = "agent/" + "issue-".repeat(30) + "999";
    const name = jobDatabaseName(longLabel, { pid: 99999, unique: "zzzzzz" });
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name.startsWith(JOB_DB_PREFIX)).toBe(true);
    // The uniqueness suffix must survive truncation intact — it's what
    // keeps two jobs from colliding, and truncating INTO it would defeat
    // the entire point.
    expect(name.endsWith("_99999_zzzzzz")).toBe(true);
  });

  it("two calls for the same label with different pid/unique never collide", () => {
    const a = jobDatabaseName("agent/issue-1", { pid: 100, unique: "aaa" });
    const b = jobDatabaseName("agent/issue-1", { pid: 200, unique: "bbb" });
    expect(a).not.toBe(b);
  });

  it("with no opts, two calls still produce different names (pid/random default)", () => {
    const a = jobDatabaseName("agent/issue-1");
    const b = jobDatabaseName("agent/issue-1");
    // Same process => same pid; the random `unique` component must differ.
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// isJobDatabaseName — the reap predicate
// ---------------------------------------------------------------------------

describe("isJobDatabaseName", () => {
  it("is true for a name jobDatabaseName actually produces", () => {
    // Proves the instrument before trusting its negatives, per CLAUDE.md:
    // a predicate that always says false would pass every negative test
    // below for the wrong reason.
    const real = jobDatabaseName("agent/issue-1", { pid: 1, unique: "a" });
    expect(isJobDatabaseName(real)).toBe(true);
  });

  it("is false for the databases this mechanism must never touch", () => {
    expect(isJobDatabaseName("postgres")).toBe(false);
    expect(isJobDatabaseName("app_test_template")).toBe(false);
    expect(isJobDatabaseName("template0")).toBe(false);
    expect(isJobDatabaseName("template1")).toBe(false);
  });

  it("is false for a name that merely contains the prefix, not starts with it", () => {
    expect(isJobDatabaseName("not_sc_job_but_similar")).toBe(false);
  });
});

describe("parseJobDatabasePid — issue #915 fix (pid-liveness gating input)", () => {
  it("extracts the pid jobDatabaseName actually embedded, for a real produced name", () => {
    const real = jobDatabaseName("agent/issue-761", { pid: 4242, unique: "ab12cd" });
    expect(parseJobDatabasePid(real)).toBe(4242);
  });

  it("extracts correctly even when the label itself looks like a trailing pid/unique segment", () => {
    // "issue_761" inside the label must not be mistaken for the real
    // trailing `_<pid>_<unique>` — the ACTUAL pid (4242) is what's appended
    // last by jobDatabaseName.
    const real = jobDatabaseName("agent/issue-761", { pid: 4242, unique: "ab12cd" });
    expect(real).toBe("sc_job_agent_issue_761_4242_ab12cd");
    expect(parseJobDatabasePid(real)).toBe(4242);
  });

  it("returns null for a name with no parseable trailing _<pid>_<unique>", () => {
    expect(parseJobDatabasePid("sc_job_weird")).toBeNull();
    expect(parseJobDatabasePid("sc_job_")).toBeNull();
  });

  it("returns null (never a false pid) for a non-job-shaped string", () => {
    expect(parseJobDatabasePid("postgres")).toBeNull();
    expect(parseJobDatabasePid("app_test_template")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// withDatabaseName
// ---------------------------------------------------------------------------

describe("withDatabaseName", () => {
  it("replaces only the database name, keeping host/port/credentials", () => {
    const out = withDatabaseName(
      "postgres://postgres:postgres@localhost:55432/postgres",
      "sc_job_foo_1_ab",
    );
    expect(out).toBe(
      "postgres://postgres:postgres@localhost:55432/sc_job_foo_1_ab",
    );
  });

  it("works against the container-reachable host aliases sandboxTestDbHost returns", () => {
    expect(
      withDatabaseName(
        "postgres://postgres:postgres@host.docker.internal:55432/postgres",
        "sc_job_x_1_a",
      ),
    ).toBe(
      "postgres://postgres:postgres@host.docker.internal:55432/sc_job_x_1_a",
    );
    expect(
      withDatabaseName(
        "postgres://postgres:postgres@172.17.0.1:55432/postgres",
        "sc_job_x_1_a",
      ),
    ).toBe("postgres://postgres:postgres@172.17.0.1:55432/sc_job_x_1_a");
  });
});

// ---------------------------------------------------------------------------
// cloneJobDatabase — production guard + retry-on-busy, via fake psql
// ---------------------------------------------------------------------------

function fakePsqlExec(
  handler: (args: readonly string[]) => { stdout: string; stderr: string; exitCode: number },
): { exec: ExecRunner; calls: string[][] } {
  const calls: string[][] = [];
  const exec: ExecRunner = async (bin, args) => {
    expect(bin).toBe("psql");
    calls.push([...args]);
    return handler(args);
  };
  return { exec, calls };
}

describe("cloneJobDatabase", () => {
  it("REFUSES a non-disposable adminUrl before running anything", async () => {
    const { exec, calls } = fakePsqlExec(() => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    await expect(
      cloneJobDatabase({
        adminUrl: "postgresql://u:p@db.abc.supabase.co:5432/postgres",
        templateDb: "app_test_template",
        jobDb: "sc_job_x_1_a",
        _exec: exec,
      }),
    ).rejects.toThrow(/refusing to use/);
    expect(calls).toEqual([]);
  });

  it("REFUSES an unsafe template/job database name without running anything", async () => {
    const { exec, calls } = fakePsqlExec(() => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    await expect(
      cloneJobDatabase({
        adminUrl: ADMIN_URL,
        templateDb: "app_test_template",
        jobDb: "sc_job_x; DROP TABLE deals;--",
        _exec: exec,
      }),
    ).rejects.toThrow(/not a safe Postgres identifier/);
    expect(calls).toEqual([]);
  });

  it("issues CREATE DATABASE ... TEMPLATE with the given names on success", async () => {
    const { exec, calls } = fakePsqlExec(() => ({
      stdout: "CREATE DATABASE",
      stderr: "",
      exitCode: 0,
    }));
    await cloneJobDatabase({
      adminUrl: ADMIN_URL,
      templateDb: "app_test_template",
      jobDb: "sc_job_x_1_a",
      _exec: exec,
    });
    expect(calls).toHaveLength(1);
    const stmt = calls[0]!.find((a) => a.includes("CREATE DATABASE"));
    expect(stmt).toBe(
      'CREATE DATABASE "sc_job_x_1_a" TEMPLATE "app_test_template"',
    );
  });

  it("retries when the template reports it is busy, then succeeds", async () => {
    let attempt = 0;
    const { exec, calls } = fakePsqlExec(() => {
      attempt += 1;
      if (attempt < 3) {
        return {
          stdout: "",
          stderr:
            'ERROR:  source database "app_test_template" is being accessed by other users',
          exitCode: 1,
        };
      }
      return { stdout: "CREATE DATABASE", stderr: "", exitCode: 0 };
    });
    await cloneJobDatabase({
      adminUrl: ADMIN_URL,
      templateDb: "app_test_template",
      jobDb: "sc_job_x_1_a",
      maxAttempts: 5,
      _exec: exec,
    });
    expect(calls).toHaveLength(3);
  });

  it("does NOT retry a non-busy failure (e.g. missing template) and throws immediately", async () => {
    const { exec, calls } = fakePsqlExec(() => ({
      stdout: "",
      stderr: 'ERROR:  database "app_test_template" does not exist',
      exitCode: 1,
    }));
    await expect(
      cloneJobDatabase({
        adminUrl: ADMIN_URL,
        templateDb: "app_test_template",
        jobDb: "sc_job_x_1_a",
        maxAttempts: 5,
        _exec: exec,
      }),
    ).rejects.toThrow(/does not exist/);
    expect(calls).toHaveLength(1);
  });

  // -------------------------------------------------------------------
  // Issue #915 fix — the template can stay busy for TENS OF SECONDS while
  // a migration applies to it (this project's applier shells `psql -c
  // <statement>` once PER STATEMENT, not one held-open `drizzle-kit
  // migrate` session — but a migration with many statements, or one slow
  // one, keeps SOME connection attached to the template across that whole
  // span). The OLD default (3 attempts, ~1.5s total) could not survive
  // that. Proven here: a template that stays busy for MORE than the old
  // 3-attempt ceiling still succeeds under the new default.
  // -------------------------------------------------------------------
  describe("the default retry budget survives tens-of-seconds template contention (issue #915 fix)", () => {
    it("the default is 40, not 3", () => {
      expect(DEFAULT_CLONE_MAX_ATTEMPTS).toBe(40);
    });

    it("PROVES THE INSTRUMENT: with the OLD default (maxAttempts=3), 10 consecutive busy responses exhaust the budget and throw", async () => {
      const { exec } = fakePsqlExec(() => ({
        stdout: "",
        stderr:
          'ERROR:  source database "app_test_template" is being accessed by other users',
        exitCode: 1,
      }));
      await expect(
        cloneJobDatabase({
          adminUrl: ADMIN_URL,
          templateDb: "app_test_template",
          jobDb: "sc_job_x_1_a",
          maxAttempts: 3, // the OLD default, explicit so this test can't silently start using the new one
          _exec: exec,
          _sleep: async () => {},
        }),
      ).rejects.toThrow(/after 3 attempt\(s\)/);
    });

    it("succeeds past the old 3-attempt ceiling using the NEW default — 10 busy responses, then the template frees up", async () => {
      let attempt = 0;
      const { exec, calls } = fakePsqlExec(() => {
        attempt += 1;
        if (attempt <= 10) {
          return {
            stdout: "",
            stderr:
              'ERROR:  source database "app_test_template" is being accessed by other users',
            exitCode: 1,
          };
        }
        return { stdout: "CREATE DATABASE", stderr: "", exitCode: 0 };
      });
      const sleeps: number[] = [];
      await cloneJobDatabase({
        adminUrl: ADMIN_URL,
        templateDb: "app_test_template",
        jobDb: "sc_job_x_1_a",
        // No maxAttempts override — proves the DEFAULT actually carries
        // this, not just a caller-supplied larger number.
        _exec: exec,
        _sleep: async (ms) => {
          sleeps.push(ms);
        },
      });
      expect(calls).toHaveLength(11);
      // Every real second of "the template is busy" is honored (no
      // real setTimeout wait, since _sleep is injected) — but the schedule
      // itself is still exercised: capped linear backoff, never exceeding
      // CLONE_BACKOFF_CAP_MS (2000).
      expect(sleeps).toHaveLength(10);
      expect(Math.max(...sleeps)).toBeLessThanOrEqual(2000);
      expect(sleeps[0]).toBe(500);
      expect(sleeps[1]).toBe(1000);
      expect(sleeps[3]).toBe(2000); // capped by attempt 4 (500*4=2000)
      expect(sleeps[9]).toBe(2000); // stays capped, doesn't keep growing
    });

    it("the injected _sleep is never called on the real setTimeout path — production default calls the real timer", async () => {
      vi.useFakeTimers();
      try {
        let attempt = 0;
        const { exec } = fakePsqlExec(() => {
          attempt += 1;
          if (attempt === 1) {
            return {
              stdout: "",
              stderr:
                'ERROR:  source database "app_test_template" is being accessed by other users',
              exitCode: 1,
            };
          }
          return { stdout: "CREATE DATABASE", stderr: "", exitCode: 0 };
        });
        const promise = cloneJobDatabase({
          adminUrl: ADMIN_URL,
          templateDb: "app_test_template",
          jobDb: "sc_job_x_1_a",
          _exec: exec,
          // No _sleep override — proves the REAL setTimeout-based sleep is
          // what runs when nothing overrides it.
        });
        await vi.advanceTimersByTimeAsync(500);
        await promise;
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// dropJobDatabase
// ---------------------------------------------------------------------------

describe("dropJobDatabase", () => {
  it("REFUSES a non-disposable adminUrl before running anything", async () => {
    const { exec, calls } = fakePsqlExec(() => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    await expect(
      dropJobDatabase({
        adminUrl: "postgresql://u:p@db.abc.supabase.co:5432/postgres",
        jobDb: "sc_job_x_1_a",
        _exec: exec,
      }),
    ).rejects.toThrow(/refusing to use/);
    expect(calls).toEqual([]);
  });

  it("terminates connections THEN drops, in that order", async () => {
    const { exec, calls } = fakePsqlExec(() => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    await dropJobDatabase({ adminUrl: ADMIN_URL, jobDb: "sc_job_x_1_a", _exec: exec });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.join(" ")).toContain("pg_terminate_backend");
    expect(calls[1]!.join(" ")).toContain('DROP DATABASE IF EXISTS "sc_job_x_1_a"');
  });

  it("throws with the psql error when the drop itself fails", async () => {
    let call = 0;
    const { exec } = fakePsqlExec(() => {
      call += 1;
      if (call === 1) return { stdout: "", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "ERROR:  permission denied", exitCode: 1 };
    });
    await expect(
      dropJobDatabase({ adminUrl: ADMIN_URL, jobDb: "sc_job_x_1_a", _exec: exec }),
    ).rejects.toThrow(/permission denied/);
  });
});

// ---------------------------------------------------------------------------
// sweepOrphanedJobDatabases
// ---------------------------------------------------------------------------

describe("sweepOrphanedJobDatabases", () => {
  it("REFUSES a non-disposable adminUrl before listing anything", async () => {
    const { exec, calls } = fakePsqlExec(() => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    await expect(
      sweepOrphanedJobDatabases({
        adminUrl: "postgresql://u:p@db.abc.supabase.co:5432/postgres",
        _exec: exec,
      }),
    ).rejects.toThrow(/refusing to use/);
    expect(calls).toEqual([]);
  });

  // `_isPidAlive: () => false` below simulates "every embedded pid is dead"
  // — i.e. these fixture names really ARE orphans, matching the ORIGINAL
  // intent of each of these tests before pid-liveness gating existed (issue
  // #915 fix). The NEW behavior — a name whose pid IS alive is left alone —
  // gets its own describe block further down, since that is precisely the
  // case none of these tests exercised before.
  const allDead = () => false;

  it("lists via LIKE 'sc_job_%', then drops only what it listed", async () => {
    const dbNames = ["sc_job_a_1_x", "sc_job_b_2_y"];
    const { exec, calls } = fakePsqlExec((args) => {
      if (args.includes("-t")) {
        // the list query
        return { stdout: dbNames.join("\n") + "\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const result = await sweepOrphanedJobDatabases({
      adminUrl: ADMIN_URL,
      _exec: exec,
      _isPidAlive: allDead,
    });
    expect(result.dropped).toEqual(dbNames);
    expect(result.failed).toEqual([]);
    expect(result.skippedAlive).toEqual([]);
    // 1 list call + (terminate + drop) per database
    expect(calls).toHaveLength(1 + dbNames.length * 2);
  });

  it("never touches a name the LIKE query didn't return, even if the query were somehow wrong", async () => {
    // Defense in depth: filter client-side too via isJobDatabaseName, so a
    // hypothetical LIKE-escaping bug can't turn into dropping an unrelated
    // database. Simulate the query "leaking" a non-job row.
    const { exec, calls } = fakePsqlExec((args) => {
      if (args.includes("-t")) {
        return {
          stdout: "sc_job_a_1_x\napp_test_template\npostgres\n",
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const result = await sweepOrphanedJobDatabases({
      adminUrl: ADMIN_URL,
      _exec: exec,
      _isPidAlive: allDead,
    });
    expect(result.dropped).toEqual(["sc_job_a_1_x"]);
    // 1 list call + 1 (terminate + drop) for the single real job db.
    expect(calls).toHaveLength(3);
  });

  it("continues past one database's drop failure and reports it in `failed`", async () => {
    const { exec } = fakePsqlExec((args) => {
      if (args.includes("-t")) {
        return {
          stdout: "sc_job_a_1_x\nsc_job_b_2_y\n",
          stderr: "",
          exitCode: 0,
        };
      }
      if (args.some((a) => a.includes('"sc_job_a_1_x"'))) {
        return { stdout: "", stderr: "ERROR:  permission denied", exitCode: 1 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const result = await sweepOrphanedJobDatabases({
      adminUrl: ADMIN_URL,
      _exec: exec,
      _isPidAlive: allDead,
    });
    expect(result.dropped).toEqual(["sc_job_b_2_y"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.name).toBe("sc_job_a_1_x");
    expect(result.failed[0]!.error).toMatch(/permission denied/);
  });

  it("returns an empty result (not an error) when there is nothing to reap", async () => {
    const { exec } = fakePsqlExec(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    const result = await sweepOrphanedJobDatabases({
      adminUrl: ADMIN_URL,
      _exec: exec,
      _isPidAlive: allDead,
    });
    expect(result).toEqual({ dropped: [], failed: [], skippedAlive: [] });
  });

  // ---------------------------------------------------------------------
  // Issue #915 fix — the sweep used to drop EVERY `sc_job_%` database with
  // no regard for whether its owning process was still running. This
  // project uses git worktrees routinely, so two CHECKOUTS on one machine
  // share ONE local Postgres on port 55432, each running its own
  // orchestrator process with its own `.loop.lock` (per-checkout, not
  // cluster-wide) — checkout B's startup sweep used to drop checkout A's
  // still-live job databases. Proven here with a REAL psql-shaped fixture
  // (not a mocked violation) and the `_isPidAlive` seam standing in for the
  // real `process.kill(pid, 0)` check.
  // ---------------------------------------------------------------------
  describe("pid-liveness gating (issue #915 fix)", () => {
    it("PROVES THE INSTRUMENT: leaves alone a name whose embedded pid is reported alive", async () => {
      const { exec, calls } = fakePsqlExec((args) => {
        if (args.includes("-t")) {
          return { stdout: "sc_job_a_1_x\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      });
      const result = await sweepOrphanedJobDatabases({
        adminUrl: ADMIN_URL,
        _exec: exec,
        _isPidAlive: (pid) => pid === 1, // pid 1 (from "sc_job_a_1_x") is "alive"
      });
      expect(result.dropped).toEqual([]);
      expect(result.skippedAlive).toEqual(["sc_job_a_1_x"]);
      expect(result.failed).toEqual([]);
      // Only the list call — no terminate/drop was ever attempted against a
      // database this sweep believes is still in use.
      expect(calls).toHaveLength(1);
    });

    it("drops a name whose embedded pid is reported dead, in the SAME sweep that skips a live one — proves the filter is per-name, not all-or-nothing", async () => {
      const { exec, calls } = fakePsqlExec((args) => {
        if (args.includes("-t")) {
          return {
            stdout: "sc_job_alive_111_x\nsc_job_dead_222_y\n",
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      });
      const result = await sweepOrphanedJobDatabases({
        adminUrl: ADMIN_URL,
        _exec: exec,
        _isPidAlive: (pid) => pid === 111,
      });
      expect(result.dropped).toEqual(["sc_job_dead_222_y"]);
      expect(result.skippedAlive).toEqual(["sc_job_alive_111_x"]);
      // 1 list call + (terminate + drop) for the ONE dead database only.
      expect(calls).toHaveLength(3);
    });

    it("treats a name whose pid cannot be parsed as alive — never drops what it can't positively prove is orphaned", async () => {
      const { exec, calls } = fakePsqlExec((args) => {
        if (args.includes("-t")) {
          // Malformed relative to jobDatabaseName's own contract (no
          // trailing _<pid>_<unique>) but still matches isJobDatabaseName's
          // prefix check — must not be dropped on a guess.
          return { stdout: "sc_job_weird\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      });
      const result = await sweepOrphanedJobDatabases({
        adminUrl: ADMIN_URL,
        _exec: exec,
        _isPidAlive: () => {
          throw new Error("must not be called — the name never parsed a pid");
        },
      });
      expect(result.dropped).toEqual([]);
      expect(result.skippedAlive).toEqual(["sc_job_weird"]);
      expect(calls).toHaveLength(1);
    });

    it("defaults to the REAL process.kill(pid, 0) check when _isPidAlive is not injected — proves against THIS process's own real, currently-alive pid", async () => {
      const { exec } = fakePsqlExec((args) => {
        if (args.includes("-t")) {
          return {
            stdout: `sc_job_x_${process.pid}_abc\n`,
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      });
      // No _isPidAlive override — production default path.
      const result = await sweepOrphanedJobDatabases({
        adminUrl: ADMIN_URL,
        _exec: exec,
      });
      expect(result.dropped).toEqual([]);
      expect(result.skippedAlive).toEqual([`sc_job_x_${process.pid}_abc`]);
    });
  });
});

// ---------------------------------------------------------------------------
// createOnceGate — issue #915 fix (the startup-sweep race)
// ---------------------------------------------------------------------------

describe("createOnceGate", () => {
  it("PROVES THE INSTRUMENT: two calls in immediate succession still only invoke fn once", async () => {
    let calls = 0;
    let resolveFn: (() => void) | undefined;
    const gated = createOnceGate(async () => {
      calls += 1;
      await new Promise<void>((resolve) => {
        resolveFn = resolve;
      });
      return "done";
    });

    // Two callers arrive before the first has resolved — the exact race
    // that used to let a second concurrent createSandbox skip the wait and
    // clone straight into the sweep's path.
    const p1 = gated();
    const p2 = gated();
    expect(calls).toBe(1); // fn was invoked exactly once, synchronously, by the FIRST call

    resolveFn?.();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe("done");
    expect(r2).toBe("done");
    expect(calls).toBe(1); // still once, after both resolved
  });

  it("a THIRD call after the first has already resolved still gets the cached result, without calling fn again", async () => {
    let calls = 0;
    const gated = createOnceGate(async () => {
      calls += 1;
      return calls;
    });
    expect(await gated()).toBe(1);
    expect(await gated()).toBe(1);
    expect(await gated()).toBe(1);
    expect(calls).toBe(1);
  });

  it("a rejection is shared too — every waiting caller sees the SAME rejection, fn is not retried", async () => {
    let calls = 0;
    const gated = createOnceGate(async () => {
      calls += 1;
      throw new Error("sweep failed");
    });
    const p1 = gated();
    const p2 = gated();
    await expect(p1).rejects.toThrow("sweep failed");
    await expect(p2).rejects.toThrow("sweep failed");
    await expect(gated()).rejects.toThrow("sweep failed"); // a later call too
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// withJobDbCleanupOnFailure — issue #915 fix (the leak-on-throw)
// ---------------------------------------------------------------------------

describe("withJobDbCleanupOnFailure", () => {
  it("PROVES THE INSTRUMENT: on success, returns the handle and NEVER touches the database", async () => {
    const { exec, calls } = fakePsqlExec(() => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    const result = await withJobDbCleanupOnFailure(
      { adminUrl: ADMIN_URL, jobDb: "sc_job_x_1_a", _exec: exec },
      async () => "the real handle",
      () => {
        throw new Error("must not be called — createHandle succeeded");
      },
    );
    expect(result).toBe("the real handle");
    expect(calls).toEqual([]);
  });

  it("drops the job database and RETHROWS the original error when createHandle throws", async () => {
    const { exec, calls } = fakePsqlExec(() => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    const dropFailures: Error[] = [];
    await expect(
      withJobDbCleanupOnFailure(
        { adminUrl: ADMIN_URL, jobDb: "sc_job_x_1_a", _exec: exec },
        async () => {
          throw new Error("provider.createSandbox failed: worktree corrupt");
        },
        (err) => dropFailures.push(err),
      ),
    ).rejects.toThrow("provider.createSandbox failed: worktree corrupt");
    // terminate + drop, for the leaked clone
    expect(calls).toHaveLength(2);
    expect(calls[1]!.join(" ")).toContain('DROP DATABASE IF EXISTS "sc_job_x_1_a"');
    expect(dropFailures).toEqual([]);
  });

  it("if the drop ALSO fails, the ORIGINAL error still wins — the drop failure only reaches onDropFailure, never replaces or masks it", async () => {
    const { exec } = fakePsqlExec(() => ({
      stdout: "",
      stderr: "ERROR:  permission denied",
      exitCode: 1,
    }));
    const dropFailures: Error[] = [];
    await expect(
      withJobDbCleanupOnFailure(
        { adminUrl: ADMIN_URL, jobDb: "sc_job_x_1_a", _exec: exec },
        async () => {
          throw new Error("the real failure");
        },
        (err) => dropFailures.push(err),
      ),
    ).rejects.toThrow("the real failure");
    expect(dropFailures).toHaveLength(1);
    expect(dropFailures[0]!.message).toMatch(/permission denied/);
  });
});
