import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RunIdentityArgs } from "./lib/telemetry/run-identity.js";
import type { Deps, SandcastleArgs } from "./main.mts";
import {
  GREEN_RUN,
  RED_RUN,
  checkRunStdout,
  commandWithNonce,
} from "./__fixtures__/check-evidence.js";
import { commitInto, git } from "./__fixtures__/git-repo.js";
import { collectSiblingBriefs } from "./lib/checkwriter/sibling-briefs.js";
import { SONNET_FIXTURE } from "./lib/cost/__fixtures__/expected.js";
import { GRADED_FIGURE_SENTINEL } from "./lib/harness/verdict.js";
import { isUsableIssueNumber } from "./lib/checkwriter/check-path.js";
import {
  configureGh,
  createMemo,
  planDeterministic,
  STAGING_BRANCH,
} from "./lib/state/index.js";
import { SandcastleStatusSchema } from "./lib/status/schema.js";
import { createStatusStore } from "./lib/status/store.js";
import { REWORK_STORE_RELATIVE_PATH } from "./lib/telemetry/rework-store.js";
import { SANDBOX_AGENT_SETTINGS_RELPATH } from "./lib/sandbox-agent-settings.js";
import { resolveRunIdentity } from "./lib/telemetry/run-identity.js";
import {
  __resetTransientStateForTests,
  blockedByGate,
  branchHasCommitsAheadOfBase,
  branchHasShippableContent,
  buildBlockedByNote,
  buildContainerEnv,
  buildDefaultDeps,
  commitReworkStore,
  decideFirstPassReviewerModel,
  DEFAULT_BASH_TIMEOUT_MS,
  defaultArgs,
  fastForwardIntegration,
  finalizeMergedAccounting,
  HELP_TEXT,
  selectMergeBatch,
  parseSandcastleArgs,
  preflight,
  recordReworkOutcome,
  releaseHeldLabelsOnShutdown,
  reworkTipIsAmendable,
  roleModelsFor,
  runMain,
  runWithRateLimitFallback,
  SANDBOX_DB_TCP_PROBE_SCRIPT,
  SANDBOX_DEV_BIND_PROBE_SCRIPT,
  sandboxTestDbEnv,
  sandboxTestDbHost,
  shipAfterMigrations,
  shipTimeAccounting,
  testDbAdminUrl,
  TestDatabaseSetupError,
  runTestDatabaseSetup,
} from "./main.mts";
import { defaultProjectConfig, setProjectConfig } from "./lib/project-config.js";
import { SHIP_INPUT_DEFAULTS } from "./__fixtures__/ship-input.mts";
import { budgetModels, codexModels, models, opus5Models } from "./models.js";
import { makeArgs, makeDeps, readyIssues } from "./__fixtures__/scripted-run.mts";
import { ALREADY_BUILT_ON_STAGING_MARKER } from "./lib/pipeline/already-built.js";

// ---------------------------------------------------------------------------
// Regression tests for the "loop finishes the job" gap: `finishRun` (the
// push-branch + open-run-PR step) previously ran from only TWO of the run's
// many termination paths (queue drained, out-of-iterations). Every other
// path — circuit breaker, sandbox stall-streak abort, planner/plan-parse
// failure, an uncaught exception, SIGINT/SIGTERM — left certified work
// stranded on a local-only branch with no PR ever opened, while the issues
// it certified sat open forever wearing `shipped-local`.
//
// These tests drive `runMain` for real (no pipeline mocking beyond the
// minimum needed to reach each termination path) against a real temp git
// repo with a real local "origin" remote, so a push is either provably real
// or provably absent — not just "a function was called".
// ---------------------------------------------------------------------------

describe("branchHasCommitsAheadOfBase", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sc-ahead-"));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
    git(repo, "commit", "--allow-empty", "-q", "-m", "init");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("is false when the branch was never created", () => {
    expect(branchHasCommitsAheadOfBase(repo, "never-created", "main")).toBe(
      false,
    );
  });

  it("is false when the branch equals the base (no extra commits)", () => {
    git(repo, "branch", "same-as-main");
    // No `origin` remote exists, so `origin/main` can't resolve either — the
    // function should fall back to "assume ahead" (true) per its own doc
    // when the merge-base lookup fails, NOT silently report false. Set up a
    // fake origin so this test actually exercises the equal-tip case.
    git(repo, "remote", "add", "origin", repo);
    git(repo, "fetch", "-q", "origin", "main:refs/remotes/origin/main");
    expect(branchHasCommitsAheadOfBase(repo, "same-as-main", "main")).toBe(
      false,
    );
  });

  it("is true when the branch has a commit main doesn't", () => {
    git(repo, "remote", "add", "origin", repo);
    git(repo, "fetch", "-q", "origin", "main:refs/remotes/origin/main");
    git(repo, "checkout", "-q", "-b", "ahead");
    git(repo, "commit", "--allow-empty", "-q", "-m", "extra");
    expect(branchHasCommitsAheadOfBase(repo, "ahead", "main")).toBe(true);
  });

  it("assumes ahead (true) when the base ref can't be resolved at all", () => {
    // Branch exists but there is no `origin/main` to diff against (no
    // remote configured). Silently reporting "nothing to push" here would
    // risk dropping real work — the function must fail toward keeping it.
    git(repo, "checkout", "-q", "-b", "orphan-branch");
    git(repo, "commit", "--allow-empty", "-q", "-m", "work");
    expect(branchHasCommitsAheadOfBase(repo, "orphan-branch", "main")).toBe(
      true,
    );
  });
});

describe("branchHasShippableContent", () => {
  let repo: string;

  /** Commit `path` with `body` on the current branch. */
  function commitFile(path_: string, body: string, subject: string): void {
    mkdirSync(path.dirname(path.join(repo, path_)), { recursive: true });
    writeFileSync(path.join(repo, path_), body);
    git(repo, "add", "--", path_);
    git(repo, "commit", "-q", "-m", subject, "--", path_);
  }

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sc-shippable-"));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
    git(repo, "commit", "--allow-empty", "-q", "-m", "init");
    git(repo, "remote", "add", "origin", repo);
    git(repo, "fetch", "-q", "origin", "main:refs/remotes/origin/main");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("is FALSE when the only commit is the rework telemetry line", () => {
    // THE regression this exists for. Before rework telemetry, a run that
    // shipped nothing made no commits at all, so `finishRun` correctly reported
    // "nothing to ship — no push, no PR". A review-verdict quarantine now
    // writes and COMMITS a telemetry line, which makes "commits ahead of base"
    // true on a run whose entire product is one JSONL row — and pushing that
    // leaves a fresh orphaned remote branch behind for every FAILED run.
    git(repo, "checkout", "-q", "-b", "run-branch");
    commitFile(
      REWORK_STORE_RELATIVE_PATH,
      '{"issueNumber":1}\n',
      "chore(sandcastle): record rework telemetry",
    );
    expect(branchHasCommitsAheadOfBase(repo, "run-branch", "main")).toBe(true);
    expect(branchHasShippableContent(repo, "run-branch", "main")).toBe(false);
  });

  it("is TRUE when real work rides alongside the telemetry commit", () => {
    // The other half: the telemetry commit must never SUPPRESS a push. An
    // "any path that isn't the store" test, not an "all paths are the store"
    // one — a run that ships code always also writes telemetry.
    git(repo, "checkout", "-q", "-b", "run-branch");
    commitFile("src/feature.ts", "export const x = 1;\n", "feat: work");
    commitFile(
      REWORK_STORE_RELATIVE_PATH,
      '{"issueNumber":1}\n',
      "chore(sandcastle): record rework telemetry",
    );
    expect(branchHasShippableContent(repo, "run-branch", "main")).toBe(true);
  });

  it("is FALSE when the branch has no commits at all", () => {
    git(repo, "branch", "same-as-main");
    expect(branchHasShippableContent(repo, "same-as-main", "main")).toBe(false);
  });

  it("fails OPEN when git cannot answer", () => {
    // No `origin/main` to diff against. Withholding a push here would risk
    // dropping real work on the floor, so the unknown case must read as
    // "content" — the same direction `branchHasCommitsAheadOfBase` fails.
    const bare = mkdtempSync(path.join(tmpdir(), "sc-shippable-noremote-"));
    try {
      git(bare, "init", "-q", "-b", "main");
      git(bare, "config", "user.email", "test@test");
      git(bare, "config", "user.name", "test");
      git(bare, "commit", "--allow-empty", "-q", "-m", "init");
      git(bare, "checkout", "-q", "-b", "orphan-branch");
      git(bare, "commit", "--allow-empty", "-q", "-m", "work");
      expect(branchHasShippableContent(bare, "orphan-branch", "main")).toBe(
        true,
      );
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// `commitReworkStore` — the loop's own bookkeeping commit, driven against a
// real repo rather than grepped for. Two behaviours matter and neither is
// observable from source text: that repeated calls AMEND instead of piling one
// near-identical commit per iteration onto the run PR, and that the amend is
// vetoed by every condition under which rewriting would destroy or republish
// somebody else's commit.
// ---------------------------------------------------------------------------
describe("commitReworkStore", () => {
  let repo: string;
  let origin: string;
  const BRANCH = "sandcastle/commit-store";
  const ERRORS: string[] = [];

  /** Append one line to the store, as the loop's appender does. */
  function appendLine(issueNumber: number): void {
    const p = path.join(repo, REWORK_STORE_RELATIVE_PATH);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(
      p,
      (existsSync(p) ? readFileSync(p, "utf8") : "") +
        `{"issueNumber":${issueNumber}}\n`,
    );
  }
  const commitCount = (): number =>
    Number(git(repo, "rev-list", "--count", "HEAD").trim());
  const tipSubject = (): string =>
    git(repo, "log", "-1", "--format=%s", "HEAD").trim();

  beforeEach(() => {
    ERRORS.length = 0;
    repo = mkdtempSync(path.join(tmpdir(), "sc-commit-store-"));
    origin = mkdtempSync(path.join(tmpdir(), "sc-commit-store-origin-"));
    git(origin, "init", "-q", "--bare", "-b", "main");
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
    git(repo, "commit", "--allow-empty", "-q", "-m", "init");
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-q", "origin", "main");
    git(repo, "checkout", "-q", "-b", BRANCH);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  });

  const commit = (): boolean =>
    commitReworkStore(repo, BRANCH, (m) => ERRORS.push(m));

  it("AMENDS its own tip instead of one commit per iteration", () => {
    // A 20-iteration run used to add 20 near-identical
    // `chore(sandcastle): record rework telemetry` commits to the run PR.
    appendLine(1);
    expect(commit()).toBe(true);
    const afterFirst = commitCount();
    appendLine(2);
    expect(commit()).toBe(true);
    appendLine(3);
    expect(commit()).toBe(true);
    expect(commitCount()).toBe(afterFirst);
    // And every line survives the collapse — an amend that dropped rows would
    // be far worse than the commit pile it replaces.
    expect(git(repo, "show", `HEAD:${REWORK_STORE_RELATIVE_PATH}`)).toContain(
      '{"issueNumber":3}',
    );
    expect(git(repo, "show", `HEAD:${REWORK_STORE_RELATIVE_PATH}`)).toContain(
      '{"issueNumber":1}',
    );
    expect(ERRORS).toEqual([]);
  });

  it("does not skip CI: the run PR's checks must run even when this commit is its tip (tokenmaxxing#29)", () => {
    // The merge rule self-merges a run PR only when every check is green. A
    // run whose last completion did not ship ends on this commit, and GitHub
    // skips every pull_request workflow when the PR head's message says
    // `[skip ci]` — so that PR would have no checks and could never merge.
    appendLine(1);
    expect(commit()).toBe(true);
    expect(tipSubject()).toBe("chore(sandcastle): record rework telemetry");
    expect(git(repo, "log", "-1", "--format=%B", "HEAD")).not.toMatch(
      /\[(skip ci|ci skip|no ci|skip actions|actions skip)\]/i,
    );
  });

  it("leaves unrelated staged work alone while amending", () => {
    // The amend is pathspec-limited, so it rebuilds the tip's tree from the
    // tip's own tree plus the one store path. A human's staged file must
    // neither be swept into the loop's commit nor unstaged by it.
    appendLine(1);
    expect(commit()).toBe(true);
    writeFileSync(path.join(repo, "human.txt"), "mine\n");
    git(repo, "add", "human.txt");
    appendLine(2);
    expect(commit()).toBe(true);
    expect(git(repo, "show", "--name-only", "--format=", "HEAD").trim()).toBe(
      REWORK_STORE_RELATIVE_PATH,
    );
    expect(git(repo, "status", "--porcelain").trim()).toContain("human.txt");
  });

  it("never amends a commit that is not its own", () => {
    // Subject alone is not the gate — a human commit could carry it. This one
    // does, and is still refused, because its committer is not the loop's
    // synthetic identity.
    writeFileSync(path.join(repo, "src.ts"), "export const x = 1;\n");
    git(repo, "add", "src.ts");
    git(
      repo,
      "commit",
      "-q",
      "-m",
      "chore(sandcastle): record rework telemetry",
    );
    const before = commitCount();
    appendLine(1);
    expect(commit()).toBe(true);
    expect(commitCount()).toBe(before + 1);
    // The human's commit is intact — its file is still in history and was not
    // rewritten out of the tip's parent.
    expect(git(repo, "show", `HEAD~1:src.ts`)).toContain("export const x = 1;");
  });

  it("never amends after the tip has been published to origin", () => {
    // `openRunPr`'s push is deliberately NOT forced, so rewriting a commit a
    // peer host already has turns the next push into a non-fast-forward
    // rejection. Once the tip is reachable from `origin/<branch>` the amend is
    // off, permanently, for that commit.
    appendLine(1);
    expect(commit()).toBe(true);
    git(repo, "push", "-q", "origin", BRANCH);
    const before = commitCount();
    appendLine(2);
    expect(commit()).toBe(true);
    expect(commitCount()).toBe(before + 1);
  });

  it("never amends once another LOCAL ref reaches the tip", () => {
    // `resetStagingToIntegrationTip` points `integration-candidate` at the
    // integration tip, which by then includes the iteration's telemetry commit.
    // Amending underneath it makes the integration tip stop being an ancestor of
    // the staging tip, which drops every remaining promotion out of the clean
    // fast-forward and into the `--no-ff` auto-merge path — a merge commit per
    // iteration, caused by a hygiene fix.
    appendLine(1);
    expect(commit()).toBe(true);
    git(repo, "branch", STAGING_BRANCH);
    const before = commitCount();
    appendLine(2);
    expect(commit()).toBe(true);
    expect(commitCount()).toBe(before + 1);
  });

  it("never amends a merge commit", () => {
    // Amending one would rewrite a merge the promotion machinery made.
    git(repo, "checkout", "-q", "-b", "side");
    writeFileSync(path.join(repo, "side.txt"), "s\n");
    git(repo, "add", "side.txt");
    git(repo, "commit", "-q", "-m", "feat: side");
    git(repo, "checkout", "-q", BRANCH);
    git(
      repo,
      "-c",
      "user.name=sandcastle-telemetry",
      "-c",
      "user.email=telemetry@sandcastle.local",
      "merge",
      "-q",
      "--no-ff",
      "-m",
      "chore(sandcastle): record rework telemetry",
      "side",
    );
    const before = commitCount();
    appendLine(1);
    expect(commit()).toBe(true);
    expect(commitCount()).toBe(before + 1);
    // The merge still has both parents.
    expect(
      git(repo, "log", "-1", "--format=%P", "HEAD~1").trim().split(" "),
    ).toHaveLength(2);
  });

  it("reports success, without a commit, when nothing is left to stage", () => {
    // The already-committed case. It used to be recognised by searching git's
    // localised prose for "nothing to commit"; on a non-English host that read
    // as a failure and the loop retried it every iteration forever. Answered by
    // exit code now, so this holds in every locale.
    appendLine(1);
    expect(commit()).toBe(true);
    const before = commitCount();
    expect(commit()).toBe(true);
    expect(commitCount()).toBe(before);
    expect(ERRORS).toEqual([]);
  });

  it("returns FALSE and keeps the file staged when the commit is refused", () => {
    // A leftover MERGE_HEAD makes git refuse the pathspec commit. The caller's
    // pending flag must stay set, so the run-end backstop retries.
    appendLine(1);
    writeFileSync(
      path.join(repo, ".git", "MERGE_HEAD"),
      `${git(repo, "rev-parse", "HEAD").trim()}\n`,
    );
    expect(commit()).toBe(false);
    expect(ERRORS.join("\n")).toContain("rework telemetry: git commit failed");
    expect(git(repo, "diff", "--cached", "--name-only").trim()).toBe(
      REWORK_STORE_RELATIVE_PATH,
    );
  });

  // -------------------------------------------------------------------------
  // Gate 4 on its own. The gates run in order and a `false` proves nothing
  // about the LAST one if an earlier one already vetoed — so this pair holds
  // subject, committer, parent count and ref-reachability fixed at the values
  // that make the answer `true`, and varies ONLY the file set.
  // -------------------------------------------------------------------------
  describe("reworkTipIsAmendable — gate 4, the file set", () => {
    /** A commit with the loop's exact subject and identity, over `files`. */
    function loopCommit(files: Record<string, string>): void {
      for (const [name, body] of Object.entries(files)) {
        const full = path.join(repo, name);
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, body);
      }
      git(repo, "add", "-A");
      git(
        repo,
        "-c",
        "user.name=sandcastle-telemetry",
        "-c",
        "user.email=telemetry@sandcastle.local",
        "commit",
        "-q",
        "-m",
        "chore(sandcastle): record rework telemetry",
      );
    }

    it("is amendable when the tip touches ONLY the store path", () => {
      // The positive control. Without it, the refusal below could be any of the
      // other four gates firing and gate 4 would be untested.
      loopCommit({ [REWORK_STORE_RELATIVE_PATH]: '{"issueNumber":1}\n' });
      expect(reworkTipIsAmendable(repo, BRANCH)).toBe(true);
    });

    it("REFUSES when the tip also carries product code", () => {
      // Same subject, same synthetic committer, one parent, no other ref —
      // everything the other gates look at is identical to the case above. A
      // commit carrying product code is not ours whatever it claims, and
      // amending it would rewrite somebody's real work.
      loopCommit({
        [REWORK_STORE_RELATIVE_PATH]: '{"issueNumber":1}\n',
        "src/feature.ts": "export const x = 1;\n",
      });
      expect(reworkTipIsAmendable(repo, BRANCH)).toBe(false);
    });

    it("REFUSES when the tip touches a DIFFERENT single path", () => {
      // One file, so a length check alone would pass it. The path has to match.
      loopCommit({ "src/feature.ts": "export const x = 1;\n" });
      expect(reworkTipIsAmendable(repo, BRANCH)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// `recordReworkOutcome` — the call site that decides WHETHER an issue gets a
// line at all. The record's SHAPE is pure and tested in
// `lib/telemetry/rework-record-input.test.ts`; what is only observable here is
// the set of guards, and each of them silently changes what the whole report
// measures. So each gets its own case, against a real store file.
// ---------------------------------------------------------------------------
describe("recordReworkOutcome", () => {
  let dir: string;
  let storePath: string;
  const LOGS: string[] = [];
  const ERRORS: string[] = [];

  beforeEach(() => {
    LOGS.length = 0;
    ERRORS.length = 0;
    dir = mkdtempSync(path.join(tmpdir(), "sc-record-rework-"));
    storePath = path.join(dir, "issues.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function ctx(over: { dryRun?: boolean; recorded?: Set<number> } = {}) {
    return {
      storePath,
      runId: "run-a",
      hostId: "mac",
      dryRun: over.dryRun ?? false,
      recorded: over.recorded ?? new Set<number>(),
      bagRowFor: () => undefined,
      ledgerRowFor: () => undefined,
      log: (m: string) => LOGS.push(m),
      logError: (m: string) => ERRORS.push(m),
    };
  }

  /** Every JSONL line currently in the store. */
  const lines = (): unknown[] =>
    (existsSync(storePath) ? readFileSync(storePath, "utf8") : "")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as unknown);

  it("writes exactly one line and marks the issue recorded", () => {
    const c = ctx();
    expect(recordReworkOutcome(c, 42, "ok", "a".repeat(40))).toBe(true);
    const written = lines();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      issueNumber: 42,
      shippedSha: "a".repeat(40),
      outcome: "shipped",
      runId: "run-a",
      hostId: "mac",
    });
    // The dedup set is the MECHANISM behind "one line per issue per run", not a
    // convention — so the mutation of it is part of the contract.
    expect(c.recorded.has(42)).toBe(true);
  });

  it("records a quarantine as quarantined, not as a ship", () => {
    // A quarantine that reached a ship commit IS recorded — the report needs it
    // to say the work never landed. Recording it as `shipped` would put work
    // that never merged into the headline rate.
    expect(recordReworkOutcome(ctx(), 43, "quarantined", "b".repeat(40))).toBe(
      true,
    );
    expect(lines()[0]).toMatchObject({ outcome: "quarantined" });
  });

  it("writes NOTHING for a deferred issue", () => {
    // Not terminal: the issue goes back to `ready-for-agent` and is re-planned,
    // so a line here would both double-count it and score work that never
    // shipped.
    expect(recordReworkOutcome(ctx(), 44, "deferred", "c".repeat(40))).toBe(
      false,
    );
    expect(existsSync(storePath)).toBe(false);
  });

  it("writes NOTHING under --dry-run", () => {
    // `--dry-run` skips every side effect that touches the world, and writing a
    // tracked file the loop then commits is one.
    expect(
      recordReworkOutcome(ctx({ dryRun: true }), 45, "ok", "d".repeat(40)),
    ).toBe(false);
    expect(existsSync(storePath)).toBe(false);
  });

  it("writes NOTHING the second time the same issue arrives", () => {
    const c = ctx();
    expect(recordReworkOutcome(c, 46, "ok", "e".repeat(40))).toBe(true);
    expect(recordReworkOutcome(c, 46, "ok", "e".repeat(40))).toBe(false);
    expect(lines()).toHaveLength(1);
  });

  it("LOGS rather than invents a record when there is no ship sha", () => {
    // The bare-`HALT` quarantine. There is no point in history to walk forward
    // from, so the row cannot exist — which is exactly why the report calls its
    // quarantine count a FLOOR. Silence here is how that blind spot would stop
    // being visible at all.
    expect(recordReworkOutcome(ctx(), 47, "quarantined", undefined)).toBe(
      false,
    );
    expect(recordReworkOutcome(ctx(), 48, "quarantined", "")).toBe(false);
    expect(existsSync(storePath)).toBe(false);
    expect(LOGS.join("\n")).toContain("no ship sha");
    expect(LOGS.join("\n")).toContain("FLOOR");
  });
});

// ---------------------------------------------------------------------------
// Issue #953: PR #951 moved each ticket's outcome recording out of the
// end-of-batch accounting loop and into the ticket's own pipeline, and the
// whole change rests on one invariant — `recordOutcome` is called exactly
// once per issue per iteration. Nothing pinned it. These tests drive the
// REAL exported seam `runMain` wires together (`shipTimeAccounting` at ship
// time, `finalizeMergedAccounting` once the responsible merge step
// resolves) against a REAL `StatusStore` (only its disk write stubbed —
// `recordOutcome`, `totals`, and `history` are the real implementation, not
// a re-derived stand-in), for both merge modes:
//   - staging: an "ok" outcome defers to promotion.
//   - --no-staging: an "ok" outcome ALSO now defers, to the Phase-3 batch
//     merger — closing the early-"merged" window this ticket also fixes
//     (it used to record immediately, at ship time, up to a full batch
//     before the merger even started).
// ---------------------------------------------------------------------------
describe("recordOutcome — once per issue per iteration (issue #953)", () => {
  function realStore() {
    return createStatusStore(
      {
        branch: "main",
        repo: "my-project",
        repoRoot: "/tmp/sc-953-does-not-matter",
        startedAt: "2026-01-01T00:00:00.000Z",
        iterationsTotal: 1,
        maxConcurrent: 4,
        hostId: "test-host",
        runId: "run-1",
      },
      { writeFn: () => {}, now: () => "2026-01-01T00:00:01.000Z" },
    );
  }

  it("staging: an ok outcome is withheld at ship time and recorded exactly once at promotion", () => {
    const store = realStore();
    store.setPlan([
      { number: 1, title: "a", branch: "agent/issue-1" },
      { number: 2, title: "b", branch: "agent/issue-2" },
    ]);
    const spy = vi.spyOn(store, "recordOutcome");
    const deferred = new Map();

    shipTimeAccounting(
      store,
      1,
      { status: "ok", postSha: "a".repeat(40) },
      deferred,
    );
    shipTimeAccounting(
      store,
      2,
      { status: "ok", postSha: "b".repeat(40) },
      deferred,
    );

    // Ship time: NOT recorded yet — this is the whole invariant PR #951
    // rests on. Recording here would let the dashboard claim the work
    // shipped before the merger has even run.
    expect(spy).not.toHaveBeenCalled();
    expect(store.snapshot().totals.merged).toBe(0);
    expect(store.snapshot().history).toHaveLength(0);
    expect(
      store.snapshot().issues.map((i) => i.phase),
    ).toEqual(["merge", "merge"]);

    // Promotion succeeds for both.
    finalizeMergedAccounting(store, [1, 2], deferred, [], "main");

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls.map((c) => c[0]).sort()).toEqual([1, 2]);
    expect(store.snapshot().totals.merged).toBe(2);
    expect(store.snapshot().history).toHaveLength(2);
    expect(
      store
        .snapshot()
        .history.map((h) => h.number)
        .sort(),
    ).toEqual([1, 2]);
  });

  it("staging: a failed GitHub promotion is flagged needs-human, never recorded merged", () => {
    const store = realStore();
    store.setPlan([{ number: 3, title: "c", branch: "agent/issue-3" }]);
    const spy = vi.spyOn(store, "recordOutcome");
    const deferred = new Map();

    shipTimeAccounting(store, 3, { status: "ok" }, deferred);
    // The FF landed the code but GitHub promotion (label flip/close) failed.
    finalizeMergedAccounting(store, [3], deferred, [3], "main");

    expect(spy).not.toHaveBeenCalled();
    expect(store.snapshot().issues.find((i) => i.number === 3)?.phase).toBe(
      "needs-human",
    );
    expect(store.snapshot().totals.merged).toBe(0);
  });

  it("--no-staging: an ok outcome is withheld until the batch merger resolves, closing the early-'merged' window", () => {
    const store = realStore();
    store.setPlan([
      { number: 10, title: "x", branch: "agent/issue-10" },
      { number: 11, title: "y", branch: "agent/issue-11" },
    ]);
    const spy = vi.spyOn(store, "recordOutcome");
    const deferred = new Map();

    // Issue 10's pipeline finishes fast; issue 11 is still running. This is
    // exactly the window the ticket closes: under the pre-fix code, issue
    // 10 would already be `recordOutcome`'d "merged" right here — before
    // the Phase-3 merger (which waits for the WHOLE batch) has even
    // started.
    shipTimeAccounting(store, 10, { status: "ok" }, deferred);
    expect(spy).not.toHaveBeenCalled();
    expect(store.snapshot().issues.find((i) => i.number === 10)?.phase).toBe(
      "merge",
    );

    shipTimeAccounting(store, 11, { status: "ok" }, deferred);
    expect(spy).not.toHaveBeenCalled();

    // The Phase-3 merger now runs and lands the whole batch.
    finalizeMergedAccounting(store, [10, 11], deferred, [], "main");

    expect(spy).toHaveBeenCalledTimes(2);
    expect(store.snapshot().totals.merged).toBe(2);
    expect(
      store
        .snapshot()
        .history.map((h) => h.number)
        .sort(),
    ).toEqual([10, 11]);
  });

  it("non-ok outcomes record immediately at ship time — exactly once, never repeated at finalize", () => {
    const store = realStore();
    store.setPlan([{ number: 20, title: "z", branch: "agent/issue-20" }]);
    const spy = vi.spyOn(store, "recordOutcome");
    const deferred = new Map();

    shipTimeAccounting(
      store,
      20,
      { status: "quarantined", finalMarker: "HALT" },
      deferred,
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(deferred.has(20)).toBe(false);
    expect(store.snapshot().totals.needsHuman).toBe(1);

    // A quarantined issue is never in `mergedIssueNums`, so a real caller
    // never re-passes it to `finalizeMergedAccounting` — proven here anyway:
    // even called with an empty batch, nothing double-records.
    finalizeMergedAccounting(store, [], deferred, [], "main");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("a mixed batch: every issue records exactly once — non-ok immediately, ok at finalize", () => {
    const store = realStore();
    store.setPlan([
      { number: 30, title: "ok1", branch: "b1" },
      { number: 31, title: "ok2", branch: "b2" },
      { number: 32, title: "quarantined", branch: "b3" },
    ]);
    const spy = vi.spyOn(store, "recordOutcome");
    const deferred = new Map();

    shipTimeAccounting(store, 30, { status: "ok" }, deferred);
    shipTimeAccounting(store, 31, { status: "ok" }, deferred);
    shipTimeAccounting(
      store,
      32,
      { status: "quarantined", finalMarker: "HALT" },
      deferred,
    );

    // Only the quarantine recorded so far — the two "ok" issues are
    // deferred.
    expect(spy).toHaveBeenCalledTimes(1);

    finalizeMergedAccounting(store, [30, 31], deferred, [], "main");

    expect(spy).toHaveBeenCalledTimes(3);
    // Exactly one call per issue number — the invariant PR #951 rests on.
    const counts = new Map<number, number>();
    for (const call of spy.mock.calls) {
      counts.set(call[0], (counts.get(call[0]) ?? 0) + 1);
    }
    expect(counts.get(30)).toBe(1);
    expect(counts.get(31)).toBe(1);
    expect(counts.get(32)).toBe(1);
  });

  it("the #1110 case-2 auto-close records terminally at ship time — never stranded in 'merge'", () => {
    const store = realStore();
    store.setPlan([{ number: 40, title: "already-built", branch: "agent/issue-40" }]);
    const spy = vi.spyOn(store, "recordOutcome");
    const deferred = new Map();

    // A case-2 auto-close reports "ok" but carries the marker. It is terminal
    // NOW: `selectMergeBatch` excludes it, so no `finalizeMergedAccounting`
    // will ever drain it. It must record immediately, not defer.
    shipTimeAccounting(
      store,
      40,
      { status: "ok", finalMarker: ALREADY_BUILT_ON_STAGING_MARKER },
      deferred,
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(deferred.has(40)).toBe(false);
    expect(store.snapshot().totals.merged).toBe(1);
    // Not stranded in the "merge" phase — it has a terminal history row.
    expect(store.snapshot().issues.find((i) => i.number === 40)?.phase).not.toBe(
      "merge",
    );
    expect(store.snapshot().history.map((h) => h.number)).toContain(40);

    // The merge batch correctly never re-passes it; even if it did, no double.
    finalizeMergedAccounting(store, [], deferred, [], "main");
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// `fastForwardIntegration`'s dirty-worktree guard. The loop now writes the
// telemetry JSONL into the LAUNCH worktree, so a persistent failure of that
// commit — an ignore rule reintroduced by `/sandcastle-update` makes `git add`
// fail forever — used to make this guard refuse EVERY promotion for the rest of
// the run, while `finishRun` still opened a run PR saying `Closes #N` for code
// that PR did not contain. A whole night's work, lost to one bookkeeping line.
// ---------------------------------------------------------------------------
describe("fastForwardIntegration — dirty launch worktree", () => {
  let repo: string;
  const BRANCH = "sandcastle/ff-run";
  const LOGS: string[] = [];
  const ERRORS: string[] = [];

  beforeEach(() => {
    LOGS.length = 0;
    ERRORS.length = 0;
    repo = mkdtempSync(path.join(tmpdir(), "sc-ff-dirty-"));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
    git(repo, "commit", "--allow-empty", "-q", "-m", "init");
    git(repo, "checkout", "-q", "-b", BRANCH);
    // Certified work waiting on the staging branch, one commit ahead.
    git(repo, "checkout", "-q", "-b", STAGING_BRANCH);
    writeFileSync(path.join(repo, "shipped.ts"), "export const y = 2;\n");
    git(repo, "add", "shipped.ts");
    git(repo, "commit", "-q", "-m", "feat: certified work");
    git(repo, "checkout", "-q", BRANCH);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  const ff = (): boolean =>
    fastForwardIntegration(
      repo,
      BRANCH,
      (m) => LOGS.push(m),
      (m) => ERRORS.push(m),
    );

  /** Leave the telemetry store uncommitted, as a failed commit does. */
  function dirtyStore(): void {
    const p = path.join(repo, REWORK_STORE_RELATIVE_PATH);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, '{"issueNumber":1}\n');
  }

  it("PROMOTES anyway when the loop's own telemetry file is the only dirt", () => {
    // Also pins the `-uall`: `.sandcastle/telemetry/` is untracked here, exactly
    // as it is in the real repo before the first telemetry commit lands, and
    // plain porcelain collapses it to one `?? .sandcastle/telemetry/` entry that
    // matches no path — which would refuse on the loop's own file after all.
    dirtyStore();
    expect(ff()).toBe(true);
    // Promoted for real: the certified commit is now on the run branch.
    expect(existsSync(path.join(repo, "shipped.ts"))).toBe(true);
    // Still named in the log — the incoming merge does touch that path, so if
    // git ever refuses on it, this line is what makes it diagnosable.
    expect(ERRORS.join("\n")).toContain(REWORK_STORE_RELATIVE_PATH);
  });

  it("still REFUSES on dirt the loop did not write", () => {
    writeFileSync(path.join(repo, "human.txt"), "uncommitted\n");
    expect(ff()).toBe(false);
    expect(ERRORS.join("\n")).toContain("human.txt");
  });

  it("refuses on human dirt even when the telemetry file is dirty too", () => {
    // The filter removes ONE path from the decision; it must not turn the whole
    // guard off.
    dirtyStore();
    writeFileSync(path.join(repo, "human.txt"), "uncommitted\n");
    expect(ff()).toBe(false);
    const said = ERRORS.join("\n");
    expect(said).toContain("human.txt");
    // And the store is not listed as a blocking file — naming it there is what
    // sends the reader hunting outside the loop for a cause inside it.
    expect(said).not.toContain(`(${REWORK_STORE_RELATIVE_PATH},`);
  });
});

describe("selectMergeBatch — the #1110 case-2 auto-close stays OUT of the merge batch", () => {
  // The Phase-3 merge set is keyed on `status === "ok"`. A #1110 case-2
  // auto-close reports `"ok"` (so the ship accounting lists it in `Closes #N`)
  // but built NO branch. If it leaked into this batch it would drag an empty
  // per-issue branch through the merger, re-churn its `shipped-local` label,
  // enter the promotion fence (re-queuing + REBUILDING it under cross-host
  // lease), and be batch-quarantined to needs-human on any sibling's post-merge
  // failure while still listed in `Closes #N`. This seam is what prevents all
  // of that — so it is tested directly.
  const built = (id: number) => ({ id: String(id), branch: `issue-${id}` });

  it("keeps ordinary ok-with-a-real-branch issues, in order", () => {
    const completed = [
      { issue: built(1), outcome: { status: "ok", finalMarker: "ALL_CLEAR" } },
      { issue: built(2), outcome: { status: "ok", finalMarker: "ALL_CLEAR" } },
    ];
    expect(selectMergeBatch(completed)).toEqual([built(1), built(2)]);
  });

  it("EXCLUDES the case-2 auto-close (ALREADY_BUILT_ON_STAGING) while keeping its ok siblings", () => {
    const completed = [
      { issue: built(1), outcome: { status: "ok", finalMarker: "ALL_CLEAR" } },
      {
        issue: built(2),
        outcome: { status: "ok", finalMarker: ALREADY_BUILT_ON_STAGING_MARKER },
      },
      { issue: built(3), outcome: { status: "ok", finalMarker: "ALL_CLEAR" } },
    ];
    // #2 is gone; #1 and #3 remain — so a post-merge failure that quarantines
    // every `mergedIssueNums` can never touch the already-shipped #2.
    expect(selectMergeBatch(completed)).toEqual([built(1), built(3)]);
  });

  it("drops non-ok outcomes (quarantined / deferred / error), as before", () => {
    const completed = [
      { issue: built(1), outcome: { status: "quarantined", finalMarker: "HALT" } },
      { issue: built(2), outcome: { status: "deferred", finalMarker: "LEASE_LOST" } },
      { issue: built(3), outcome: { status: "error", finalMarker: "HALT" } },
      { issue: built(4), outcome: { status: "ok", finalMarker: "ALL_CLEAR" } },
    ];
    expect(selectMergeBatch(completed)).toEqual([built(4)]);
  });

  it("a batch of ONLY a case-2 auto-close merges nothing", () => {
    const completed = [
      {
        issue: built(1),
        outcome: { status: "ok", finalMarker: ALREADY_BUILT_ON_STAGING_MARKER },
      },
    ];
    expect(selectMergeBatch(completed)).toEqual([]);
  });
});

describe("runMain — finishRun runs on every termination path", () => {
  let repo: string;
  let origin: string;
  const BRANCH = "sandcastle/test-run";
  const savedEnv: Record<string, string | undefined> = {};

  function saveEnv(key: string): void {
    savedEnv[key] = process.env[key];
  }

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sc-runmain-repo-"));
    origin = mkdtempSync(path.join(tmpdir(), "sc-runmain-origin-"));
    git(origin, "init", "-q", "--bare", "-b", "main");
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
    git(repo, "commit", "--allow-empty", "-q", "-m", "init");
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-q", "origin", "main");

    saveEnv("SANDCASTLE_CROSS_HOST_SYNC");
    saveEnv("SANDCASTLE_CROSS_HOST_LEASE");
    delete process.env.SANDCASTLE_CROSS_HOST_SYNC;
    delete process.env.SANDCASTLE_CROSS_HOST_LEASE;
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  /** Does `origin` (the bare remote) have `branch` at all? */
  function originHasBranch(branch: string): boolean {
    return git(repo, "ls-remote", "--heads", origin, branch).length > 0;
  }

  it("pushes the branch when the run ends via the circuit breaker (regression: this used to strand it)", async () => {
    // Simulate a resumed run: real uncertified commits already sit on the
    // run branch (as if an earlier session died mid-work). One issue in the
    // plan, and claiming it throws — with consecutiveFailureLimit=1 that
    // trips the breaker on iteration 1, with ZERO issues ever certified
    // this run.
    git(repo, "checkout", "-q", "-b", BRANCH);
    git(repo, "commit", "--allow-empty", "-q", "-m", "uncertified work");
    expect(originHasBranch(BRANCH)).toBe(false);

    const deps = makeDeps({
      listOpenIssuesWithBodies: readyIssues({ number: 1, title: "t" }),
      run: async (spec) => {
        throw new Error(`unexpected deps.run(${spec.name})`);
      },
      claim: async () => {
        throw new Error("claim boom");
      },
      openRunPr: async () => {
        throw new Error(
          "openRunPr should not be called: nothing was certified",
        );
      },
    });

    const args = makeArgs({
      repoRoot: repo,
      branch: BRANCH,
      consecutiveFailureLimit: 1,
    });

    const result = await runMain(args, deps);

    expect(result.exitCode).toBe(1); // circuit breaker's exit code
    expect(result.shippedIssues).toEqual([]);
    // The regression: before this fix, NOTHING reached origin on this path.
    expect(originHasBranch(BRANCH)).toBe(true);
  });

  it("runs finishRun on an uncaught exception and does not swallow the exception", async () => {
    git(repo, "checkout", "-q", "-b", BRANCH);
    git(repo, "commit", "--allow-empty", "-q", "-m", "uncertified work");
    expect(originHasBranch(BRANCH)).toBe(false);

    const deps = makeDeps({
      ticketStartHook: () => {
        throw new Error("boom-from-test-hook");
      },
    });
    const args = makeArgs({ repoRoot: repo, branch: BRANCH });

    await expect(runMain(args, deps)).rejects.toThrow("boom-from-test-hook");
    // finishRun ran in the `finally` before the exception propagated.
    expect(originHasBranch(BRANCH)).toBe(true);
  });

  it("does not open a PR when there is genuinely nothing to ship", async () => {
    // No commits on the branch, nothing certified, nothing rehydrated.
    // Trip the cheapest early-refusal path (cross-host sync misconfigured)
    // so no pipeline work runs at all.
    //
    // NOTE ON THIS TEST'S PROOF VALUE: the "nothing to ship → no PR" guard
    // itself is not new (the pre-fix `finishWithPr` had the same
    // `shippedIssues.length === 0` check). On THIS particular early-refusal
    // path, pre-fix code never called `finishWithPr` at all (that's the bug
    // this whole change fixes), so this assertion is trivially true on both
    // old and new code — it is a forward-looking invariant/guard-rail test,
    // not a fails-before/passes-after regression proof. See the commit
    // message for which tests genuinely diverge.
    process.env.SANDCASTLE_CROSS_HOST_SYNC = "1";
    let openRunPrCalled = false;
    const deps = makeDeps({
      openRunPr: async () => {
        openRunPrCalled = true;
        return { url: "https://example.invalid/should-not-happen" };
      },
    });
    const args = makeArgs({ repoRoot: repo, branch: BRANCH });

    const result = await runMain(args, deps);

    expect(result.exitCode).toBe(2);
    expect(openRunPrCalled).toBe(false);
    expect(originHasBranch(BRANCH)).toBe(false);
  });

  it("hands the opened run PR to the merge rule, with the diff class and commit openRunPr judged (tokenmaxxing#29)", async () => {
    process.env.SANDCASTLE_CROSS_HOST_SYNC = "1";
    const change = {
      door: "two-way" as const,
      doorReasons: [],
      blastRadius: "small" as const,
      blastReasons: [],
      destructiveMigrations: [],
    };
    const settled: unknown[][] = [];
    const logs: string[] = [];
    const deps = makeDeps({
      listIssuesByLabel: async (label) =>
        label === "shipped-local"
          ? [{ number: 900, title: "stranded issue", labels: ["shipped-local"] }]
          : [],
      openRunPr: async () => ({
        url: "https://example.invalid/pr/3",
        mergeRule: { change, headSha: "abc123" },
      }),
      settleRunPr: async (...a) => {
        settled.push(a);
        return { merged: true, why: "two-way door, small blast radius, every check green" };
      },
      log: (m: string) => logs.push(m),
    });
    const args = makeArgs({ repoRoot: repo, branch: BRANCH });

    await runMain(args, deps);

    expect(settled).toEqual([[BRANCH, change, "abc123"]]);
    expect(logs).toContain(
      "merge rule: merged https://example.invalid/pr/3 (two-way door, small blast radius, every check green)",
    );
  });

  it("logs that the run PR waits for Alex when the merge rule leaves it open", async () => {
    process.env.SANDCASTLE_CROSS_HOST_SYNC = "1";
    const logs: string[] = [];
    const deps = makeDeps({
      listIssuesByLabel: async (label) =>
        label === "shipped-local"
          ? [{ number: 900, title: "stranded issue", labels: ["shipped-local"] }]
          : [],
      openRunPr: async () => ({
        url: "https://example.invalid/pr/4",
        mergeRule: {
          change: {
            door: "one-way" as const,
            doorReasons: ["x"],
            blastRadius: "small" as const,
            blastReasons: [],
            destructiveMigrations: ["packages/db/migrations/0142_x.sql"],
          },
          headSha: "abc123",
        },
      }),
      settleRunPr: async () => ({ merged: false, why: "one-way door: x" }),
      log: (m: string) => logs.push(m),
    });

    await runMain(makeArgs({ repoRoot: repo, branch: BRANCH }), deps);

    expect(logs).toContain("merge rule: https://example.invalid/pr/4 waits for Alex (one-way door: x)");
  });

  it("does not throw and does not change the exit code when PR creation fails", async () => {
    // Force finishRun to have something to surface (a rehydrated stranded
    // issue) via the cheap early-refusal path, then make openRunPr reject.
    //
    // NOTE ON THIS TEST'S PROOF VALUE: like the test above, this is a
    // forward-looking invariant test rather than a fails-before/passes-after
    // proof — pre-fix, `openRunPr` is never reached on this path either
    // (rehydration doesn't exist, and this early-refusal path never called
    // `finishWithPr`), so "doesn't throw" holds vacuously on old code too.
    // Proving the *old* `finishWithPr` would have propagated an `openRunPr`
    // rejection unguarded (it had no try/catch) would require a real
    // certified ship reaching `shippedIssues.length > 0` through the full
    // implementer/reviewer pipeline, which this suite does not fake — see
    // the commit message.
    process.env.SANDCASTLE_CROSS_HOST_SYNC = "1";
    const deps = makeDeps({
      listIssuesByLabel: async (label) =>
        label === "shipped-local"
          ? [
              {
                number: 900,
                title: "stranded issue",
                labels: ["shipped-local"],
              },
            ]
          : [],
      openRunPr: async () => {
        throw new Error("gh is down");
      },
    });
    const args = makeArgs({ repoRoot: repo, branch: BRANCH });

    const result = await runMain(args, deps);

    // Same exit code the cross-host-sync misconfiguration always returns —
    // a failed PR must not change it.
    expect(result.exitCode).toBe(2);
  });

  it("rehydrates a previously-stranded shipped-local issue and surfaces it without closing it", async () => {
    process.env.SANDCASTLE_CROSS_HOST_SYNC = "1";
    let capturedArgs: unknown[] | undefined;
    const deps = makeDeps({
      listIssuesByLabel: async (label) =>
        label === "shipped-local"
          ? [
              {
                number: 900,
                title: "stranded issue",
                labels: ["shipped-local"],
              },
            ]
          : [],
      openRunPr: async (...args) => {
        capturedArgs = args;
        return { url: "https://example.invalid/pr/2" };
      },
    });
    const args = makeArgs({ repoRoot: repo, branch: BRANCH });

    await runMain(args, deps);

    expect(capturedArgs).toBeDefined();
    const [branch, shippedIssueNums, opts] = capturedArgs as [
      string,
      readonly number[],
      (
        | { previouslyShipped?: readonly { number: number; title: string }[] }
        | undefined
      ),
    ];
    expect(branch).toBe(BRANCH);
    // Not folded into the Closes list — this run couldn't verify the code
    // is actually present on this branch.
    expect(shippedIssueNums).toEqual([]);
    expect(opts?.previouslyShipped).toEqual([
      { number: 900, title: "stranded issue" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// A plan entry whose `id` is not a usable issue number: ONE predicate, TWO
// reactions, and the two must never disagree about the first part.
//
// `collectSiblingBriefs` DROPS such an entry — it only feeds a prompt, it runs
// before the dispatch pool, and rendering `#NaN` to a model buys nothing. The
// dispatch pool THROWS on it — there it is a real fault in the plan and a
// human has to be told. Both read `isUsableIssueNumber`
// (`lib/checkwriter/check-path.ts`). Before that they read two different
// tests, so an entry could vanish from every check-writer's sibling list
// under one rule while crashing its own dispatch under another.
//
// 2026-09-03: an entry like this can no longer BE PLANNED. The planner is code
// (`planDeterministic`, `lib/state/eligible-set.ts`) and mints every id from
// an open issue's own `number`, so `"not-an-issue"` has no road into a plan —
// the old fixture drove it in through a stubbed planner AGENT that no longer
// exists. What is pinned instead: the plan cannot produce such an id, and the
// pool's guard is still standing behind it. Both halves matter — deleting the
// guard because "the planner can't do that any more" is how a defence dies the
// day before something else starts calling the pool.
// ---------------------------------------------------------------------------

describe("runMain — a plan entry whose id is not a usable issue number", () => {
  let repo: string;
  let origin: string;
  const BRANCH = "sandcastle/test-run";
  const savedSync = process.env.SANDCASTLE_CROSS_HOST_SYNC;
  const savedLease = process.env.SANDCASTLE_CROSS_HOST_LEASE;

  /** A non-empty string `id` that is no issue at all — the shape the two
   *  readers below must agree about. Nothing MINTS one any more (see the
   *  header); the collector is still handed arbitrary caller-supplied entries,
   *  so its half is still driven for real. */
  const BOGUS_PLAN = [
    { id: "not-an-issue", title: "a planner slip", branch: "agent/issue-x" },
  ];

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sc-badid-repo-"));
    origin = mkdtempSync(path.join(tmpdir(), "sc-badid-origin-"));
    git(origin, "init", "-q", "--bare", "-b", "main");
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
    git(repo, "commit", "--allow-empty", "-q", "-m", "init");
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-q", "origin", "main");
    delete process.env.SANDCASTLE_CROSS_HOST_SYNC;
    delete process.env.SANDCASTLE_CROSS_HOST_LEASE;
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
    if (savedSync === undefined) delete process.env.SANDCASTLE_CROSS_HOST_SYNC;
    else process.env.SANDCASTLE_CROSS_HOST_SYNC = savedSync;
    if (savedLease === undefined) delete process.env.SANDCASTLE_CROSS_HOST_LEASE;
    else process.env.SANDCASTLE_CROSS_HOST_LEASE = savedLease;
  });

  it("THE PLAN cannot mint such an id — every id is an open issue's own number", () => {
    const plan = planDeterministic({
      openIssues: [
        {
          number: 71,
          title: "a real ticket",
          body: "",
          labels: ["ready-for-agent"],
        },
      ],
      readyLabel: "ready-for-agent",
      stackSize: 8,
    });
    expect(plan.issues.map((i) => i.id)).toEqual(["71"]);
    for (const card of plan.issues) {
      expect(isUsableIssueNumber(Number(card.id))).toBe(true);
    }
  });

  // A SOURCE-STRING PIN, NOT AN EXECUTED PROOF — and it is a string because
  // nothing can drive the guard any more. The pool takes its cards from
  // `dealer.next()`, the dealer takes them from `dealFromPlanner`, and that
  // mints every id as `String(issue.number)` off a `listOpenIssuesWithBodies`
  // row; the `--issue N` one-shot road parses to a number at the CLI. There is
  // no seam left that accepts a caller-supplied card, so the only thing a test
  // can still assert is that the guard has not been deleted. If a seam ever
  // reappears, replace this with a real dispatch.
  it("the DISPATCH POOL's guard is still present in the source", () => {
    const SRC = readFileSync(
      path.join(import.meta.dirname, "main.mts"),
      "utf8",
    );
    expect(SRC).toContain("if (!isUsableIssueNumber(issueNumber)) {");
    expect(SRC).toContain(
      "`plan issue id is not a usable issue number: ${JSON.stringify(card.id)}`",
    );
  });

  it("the SIBLING-BRIEF COLLECTOR drops the same entry, and keeps the real one beside it", async () => {
    // The other half of the agreement: what the pool crashes on is exactly
    // what never reaches a check-writer's prompt, so the drop hides nothing
    // the pool is not already reporting a moment later.
    expect(await collectSiblingBriefs(BOGUS_PLAN, {})).toEqual([]);
    expect(
      await collectSiblingBriefs(
        [...BOGUS_PLAN, { id: "812", title: "a real ticket" }],
        {},
      ),
    ).toEqual([{ number: 812, title: "a real ticket" }]);
  });
});

// ---------------------------------------------------------------------------
// `decideFirstPassReviewerModel` returns the diff sizes it already computed
// instead of interpolating them into a log string and discarding them — the
// loop's only measure of how much an issue produced, feeding
// `issueTelemetry[].changedLines/Files`. Driven against a REAL temp git repo,
// so numstat parsing and base resolution are exercised for real.
//
// THE TOPOLOGY IS PART OF THAT REALISM: `ctx.args.branch` is the RUN branch,
// while an issue's commits land on the per-issue branch `runIssuePipeline`
// hands to `createSandbox` (`branch: ctx.issue.branch`), so the run branch is
// left BEHIND and the base resolves to a real fork point. Committing onto the
// ctx branch instead makes `postSha` the tip and fires the `<sha>~1` reviewer
// rescue on EVERY case — a state first-pass review cannot reach.
// ---------------------------------------------------------------------------

describe("decideFirstPassReviewerModel", () => {
  type Files = Record<string, string>;
  let repo: string;
  const RUN_BRANCH = "sandcastle/run";
  const ISSUE_BRANCH = "issue-42";
  const logs: string[] = [];
  let onIssueBranch = false;

  /** A ctx carrying only the fields this function actually reads. */
  function makeCtx(
    over: Record<string, unknown> = {},
  ): Parameters<typeof decideFirstPassReviewerModel>[0] {
    return {
      args: { repoRoot: repo, branch: RUN_BRANCH, ...(over.args ?? {}) },
      deps: { log: (l: string) => logs.push(l), logError: () => {} },
      issueNumber: 42,
      ...over,
    } as unknown as Parameters<typeof decideFirstPassReviewerModel>[0];
  }

  /** Cut the issue branch off the run branch, leaving the run branch behind. */
  function startIssue(): void {
    if (!onIssueBranch) git(repo, "checkout", "-q", "-b", ISSUE_BRANCH);
    onIssueBranch = true;
  }

  /** Commit `files` onto the ISSUE branch (cut on first use); returns the sha. */
  const commit = (files: Files, message: string): string => {
    startIssue();
    return commitInto(repo, files, message);
  };

  /** Commit onto the RUN branch — content PREDATING this issue; refused after
   *  the cut, where it would no longer pre-date anything. */
  const commitOnRun = (files: Files, message: string): string => {
    if (onIssueBranch) throw new Error("commitOnRun must precede the cut");
    return commitInto(repo, files, message);
  };

  beforeEach(() => {
    logs.length = 0;
    onIssueBranch = false;
    repo = mkdtempSync(path.join(tmpdir(), "sc-review-decide-"));
    git(repo, "init", "-q", "-b", RUN_BRANCH);
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
    commitOnRun({ "README.md": "seed\n" }, "init");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("reports the numstat-derived counts for a SMALL diff without escalating", () => {
    const sha = commit(
      { "src/a.ts": "one\ntwo\nthree\n", "src/b.ts": "four\n" },
      "small change",
    );
    const decision = decideFirstPassReviewerModel(makeCtx(), sha);

    // The base really IS a fork point here, not the `<sha>~1` rescue.
    expect(git(repo, "merge-base", RUN_BRANCH, sha)).not.toBe(sha);
    // Under the 400-line default threshold and no sensitive path ⇒ cheap model.
    expect(decision.model).toBeUndefined();
    // But the sizes are still reported: 3 + 1 added lines across 2 files.
    expect(decision.diff?.changedLines).toBe(4);
    expect(decision.diff?.changedFiles).toHaveLength(2);
  });

  it("reports the actual changed file PATHS alongside the counts, on the non-escalating path", () => {
    const sha = commit(
      { "src/a.ts": "one\ntwo\nthree\n", "src/b.ts": "four\n" },
      "small change",
    );
    const decision = decideFirstPassReviewerModel(makeCtx(), sha);
    expect(decision.diff?.changedFiles).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("reports the counts AND the escalation model for a LARGE diff", () => {
    const big = `${"x\n".repeat(500)}`;
    const sha = commit({ "src/big.ts": big }, "large change");
    const decision = decideFirstPassReviewerModel(makeCtx(), sha);

    // Asserted against the config, not a literal: this test is about WHETHER
    // the first pass escalates, not which tier is configured this month.
    expect(decision.model).toBe(models.reviewer.escalations[0]);
    expect(decision.diff?.changedLines).toBe(500);
    // The ESCALATING branch returns early, so it carries the measurement on its
    // own separate `return` — asserted here because a regression there would be
    // invisible to the non-escalating test above.
    expect(decision.diff?.changedFiles).toEqual(["src/big.ts"]);
    expect(logs.join("\n")).toContain("changedLines=500");
  });

  it("counts BOTH additions and deletions", () => {
    // Pre-dates the cut, or there would be nothing to DELETE.
    commitOnRun({ "src/c.ts": "a\nb\nc\nd\n" }, "seed c");
    const sha = commit({ "src/c.ts": "a\nZ\n" }, "rewrite c");
    const decision = decideFirstPassReviewerModel(makeCtx(), sha);
    // 1 added (Z) + 3 removed (b, c, d).
    expect(decision.diff?.changedLines).toBe(4);
    expect(decision.diff?.changedFiles).toEqual(["src/c.ts"]);
  });

  // The recorded paths exist to JOIN ticket → files. Plain `git diff --numstat`
  // yields two shapes that join to nothing: `src/{old.ts => new.ts}` for a
  // rename (neither the old path nor the new one) and a C-quoted, octal-escaped
  // form for a non-ASCII path. The sizer therefore runs `-z --no-renames`.
  it("reports a rename as the two REAL paths, never git's `{old => new}` shorthand", () => {
    commitOnRun({ "src/old.ts": "a\nb\n" }, "seed old");
    startIssue();
    git(repo, "mv", "src/old.ts", "src/new.ts");
    git(repo, "commit", "-q", "-m", "rename");
    const decision = decideFirstPassReviewerModel(
      makeCtx(),
      git(repo, "rev-parse", "HEAD"),
    );
    expect(decision.diff?.changedFiles).toEqual(["src/new.ts", "src/old.ts"]);
  });

  it("reports a non-ASCII path raw, not C-quoted and octal-escaped", () => {
    const sha = commit({ "src/café.ts": "x\n" }, "unicode path");
    const decision = decideFirstPassReviewerModel(makeCtx(), sha);
    expect(decision.diff?.changedFiles).toEqual(["src/café.ts"]);
  });

  it("escalates on a rename INTO a sensitive path (the real path now matches the glob)", () => {
    // The old `{old => new}` shorthand matched neither side, so this change to
    // a migrations dir slipped past the sensitive-path rule entirely.
    commitOnRun({ "src/x.sql.txt": "select 1;\n" }, "seed");
    startIssue();
    git(repo, "mv", "src/x.sql.txt", "0001_x.sql");
    git(repo, "commit", "-q", "-m", "promote to a migration");
    const decision = decideFirstPassReviewerModel(
      makeCtx(),
      git(repo, "rev-parse", "HEAD"),
    );
    expect(decision.model).toBe(models.reviewer.escalations[0]);
  });

  it("escalates on a SENSITIVE path even when the diff is tiny", () => {
    const sha = commit({ "db/migrations/0001_x.sql": "select 1;\n" }, "sql");
    const decision = decideFirstPassReviewerModel(makeCtx(), sha);
    expect(decision.model).toBe(models.reviewer.escalations[0]);
    expect(decision.diff?.changedLines).toBe(1);
    expect(decision.diff?.changedFiles).toEqual(["db/migrations/0001_x.sql"]);
  });

  it("omits the sizes entirely when no escalation model is configured", () => {
    const sha = commit({ "src/d.ts": "x\n" }, "d");
    // The codex backend has an empty reviewer escalation ladder, so the
    // function returns BEFORE running any git. Reporting 0 there would claim
    // "measured an empty diff" when nothing was measured at all.
    const decision = decideFirstPassReviewerModel(
      makeCtx({
        args: { repoRoot: repo, branch: RUN_BRANCH, backend: "codex" },
      }),
      sha,
    );
    expect(decision.model).toBeUndefined();
    expect(decision.diff).toBeUndefined();
  });

  // An issue whose sandbox produced NOTHING: `postSha` is still the run branch
  // tip, so the base takes its reviewer-only rescue and lands on the PRECEDING
  // commit — another ticket's work. Recording that credits this issue with files
  // it never touched, in the dataset built to answer "which files did this
  // ticket touch". `shipDiffBase` refuses the rescue for the same reason.
  it("records NOTHING for a zero-commit issue, not the preceding commit's files", () => {
    // Deliberately NOT the root commit: `<postSha>~1` must resolve, or the
    // rescue fails harmlessly and this passes for the wrong reason.
    commitOnRun({ "other.ts": "not this issue's work\n" }, "another issue");
    const postSha = git(repo, "rev-parse", "HEAD");
    startIssue(); // the sandbox cut a branch and committed nothing on it
    // Asserting on `.diff` (not a count) so a regression names the file that
    // was wrongly credited here. The MODEL still reads the rescue base.
    const decision = decideFirstPassReviewerModel(makeCtx(), postSha);
    expect(decision.diff).toBeUndefined();
    expect(decision.model).toBeUndefined();
  });

  it("is fail-quiet on an unresolvable sha (a git hiccup never escalates)", () => {
    const decision = decideFirstPassReviewerModel(
      makeCtx(),
      "0000000000000000000000000000000000000000",
    );
    expect(decision.model).toBeUndefined();
    // WAVE-1 CHANGE: this previously asserted `changedLines === 0`. The sizer is
    // fail-quiet, so a git error and a genuinely empty diff both come back as
    // `{0, []}`; reporting 0 here would record "measured, and genuinely empty"
    // for what was actually a git FAILURE. Under this project's ABSENT ≠ ZERO
    // rule the measurement must be absent instead. TWO guards land on that
    // answer here: the base is the never-recorded rescue (the merge-base is
    // unresolvable), and `{0, []}` is refused on top of that.
    expect(decision.diff).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ROT-GUARD: the telemetry call sites are single optional-chained statements
// scattered through a 8,800-line file, so a later refactor can silently drop
// one and every gate stays green while the data quietly goes missing. These
// tests read main.mts as TEXT and pin the counts. The diff guard goes further
// and walks EVERY source file under `.sandcastle/`, pinning the per-file
// distribution: its helpers are now exported from the module extracted out of
// main.mts (lib/review/diff-measurement.ts), so a call site that merely CHANGED
// FILE must not read as one that vanished — and a call site added in a
// brand-new file must not go unseen.
//
// A failure here is not necessarily a bug — it means a call site moved, was
// added, or was removed. Verify the change was intentional, then update the
// expected count.
// ---------------------------------------------------------------------------

describe("telemetry call-site rot-guard", () => {
  const SRC = readFileSync(path.join(import.meta.dirname, "main.mts"), "utf8");
  /**
   * `lib/review/diff-measurement.ts`, the module the diff-measurement helpers
   * were extracted OUT of main.mts into. Read as its own string, separately
   * from the tree walk below, because the guard pins the helper's DEFINITION to
   * this exact path — an assertion the per-file distribution, which only counts
   * call-shaped needles, cannot make on its own.
   */
  const DIFF_SRC = readFileSync(
    path.join(import.meta.dirname, "lib", "review", "diff-measurement.ts"),
    "utf8",
  );

  /** Non-overlapping occurrences of a literal needle in `src`. */
  function countIn(src: string, needle: string): number {
    return src.split(needle).length - 1;
  }

  /** Non-overlapping occurrences of a literal needle in main.mts. */
  function count(needle: string): number {
    return countIn(SRC, needle);
  }

  /**
   * main.mts with every run of whitespace collapsed to ONE space.
   *
   * Argument-list guards below pin a MULTI-LINE call shape (`"--",\n
   * REWORK_STORE_RELATIVE_PATH,`), and prettier re-wraps and re-indents an
   * argument list the moment an argument is added or removed — so a
   * literal-with-newlines needle goes red on a pure reformat while the
   * property it guards is still perfectly intact. That is a guard that cries
   * wolf, and `prettier --check` cannot even warn about it here because
   * `.prettierignore:8` excludes this whole directory. Match against the
   * squashed source instead: `countSquashed('"--", REWORK_STORE_RELATIVE_PATH,')`
   * is true of every legal formatting of the same argument list and false of
   * every deletion of it.
   */
  const SQUASHED = SRC.replace(/\s+/g, " ");
  /** {@link count}, but insensitive to line breaks and indentation. */
  function countSquashed(needle: string): number {
    return countIn(SQUASHED, needle.replace(/\s+/g, " "));
  }

  /**
   * Directories skipped when walking `.sandcastle/` for source files.
   *
   * `worktrees`, `logs` and `variants` come from `vitest.config.ts`'s
   * `exclude`, and `node_modules`, `dist` and `.git` from the vitest defaults
   * it spreads in. `worktrees/` is the load-bearing one: it holds multi-GB repo
   * checkouts with STALE DUPLICATE copies of the very files scanned here, so
   * descending into it would both stall and report phantom call sites.
   * `__fixtures__` is this suite's own scaffolding and is skipped here only.
   */
  const SKIPPED_DIRS = new Set([
    "worktrees",
    "logs",
    "variants",
    "node_modules",
    "dist",
    ".git",
    "__fixtures__",
  ]);

  /**
   * Every non-test TypeScript source file under `.sandcastle/`, keyed by its
   * repo-relative POSIX path so failures name the offending file on any host.
   * Hand-written `.d.ts`/`.d.mts` declarations are deliberately INCLUDED — one
   * re-declaring a measurement helper is a route worth catching, and nothing
   * here generates them.
   *
   * WHY A WALK AND NOT A FIXED FILE LIST: see the diff-measurement guard below.
   */
  const SOURCES = new Map<string, string>();
  (function collect(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) collect(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!/\.m?ts$/.test(entry.name)) continue;
      if (/\.test\.m?ts$/.test(entry.name)) continue;
      const rel = path.relative(import.meta.dirname, full);
      SOURCES.set(rel.split(path.sep).join("/"), readFileSync(full, "utf8"));
    }
  })(import.meta.dirname);

  /**
   * Per-file occurrence count of `needle` across every scanned source, with
   * zero-count files omitted. Compared with a single `toEqual`, so a rogue call
   * site shows up in vitest's object diff as an extra key naming its file.
   */
  function distributionOf(needle: string): Record<string, number> {
    const dist: Record<string, number> = {};
    for (const [file, src] of SOURCES) {
      const n = countIn(src, needle);
      if (n > 0) dist[file] = n;
    }
    return dist;
  }

  /**
   * How many times each attributable role is DISPATCHED, by name.
   *
   * Counted per role rather than assumed to be one apiece, so a guard that
   * hard-codes "one site per role" never has to be weakened the next time a
   * role gains a second job. (`judge` was dispatched twice until spec #1334
   * deleted both of its passes.)
   *
   * What this still guards is the thing that matters: EVERY dispatch of an
   * attributable role is wrapped, so none of its spend leaks into the run's
   * unattributed overhead where no ticket is ever billed for it.
   *
   * `critique` is gone (spec #1334 folded the design critique into the
   * reviewer), so it has no dispatch site; `main.design-review.test.mts`
   * pins that it stays at zero.
   */
  const ATTRIBUTABLE_ROLES: Readonly<Record<string, number>> = {
    checkWriter: 1,
    implementer: 1,
    reviewer: 1,
    recovery: 1,
    // `judge` is gone: spec #1334 deleted its early pass (SF1) and its
    // disagreement pass (SF2). Pinned at zero below.
  };
  const ATTRIBUTABLE_DISPATCH_SITES = Object.values(ATTRIBUTABLE_ROLES).reduce(
    (a, b) => a + b,
    0,
  );

  it("wraps every attributable role-cost capture site, and leaves the batch ones alone", () => {
    // The batch roles (merger, postMergeReviewer, postMergeFixer) are
    // structurally unattributable to one ticket and MUST stay unwrapped; their
    // spend is reported as runTelemetry.overheadCostUsd instead. checkWriter
    // (issue #911) joined the attributable side: it is dispatched once per
    // issue, before the implementer, so its spend is exactly as chargeable to
    // one ticket as implementer/reviewer/recovery are.
    //
    // (`judge`, issue #1118, was attributable on the same reasoning until
    // spec #1334 deleted it.)
    expect(count("captureIssueRoleCost(ctx, ")).toBe(
      ATTRIBUTABLE_DISPATCH_SITES,
    );
    // Three, not four, since 2026-09-03: the planner is code and spends no
    // tokens, so there is no planner cost to capture.
    expect(count("await captureRoleCost(")).toBe(3);
  });

  it("wraps every attributable role timing site, and leaves the batch ones alone", () => {
    expect(count("timeIssueRole(ctx, ")).toBe(ATTRIBUTABLE_DISPATCH_SITES);
    // Three since 2026-09-03 — see the cost guard above.
    expect(count("timeRole(timingLedger, ")).toBe(3);
  });

  it("wraps every dispatch of all four dispatched ATTRIBUTABLE roles", () => {
    for (const [role, sites] of Object.entries(ATTRIBUTABLE_ROLES)) {
      expect(count(`timeIssueRole(ctx, "${role}"`)).toBe(sites);
      expect(count(`captureIssueRoleCost(ctx, "${role}"`)).toBe(sites);
    }
    // The judge is gone (spec #1334): nothing dispatches, times or costs it.
    expect(count('timeIssueRole(ctx, "judge"')).toBe(0);
    expect(count('captureIssueRoleCost(ctx, "judge"')).toBe(0);
  });

  it("leaves exactly the three BATCH roles unwrapped", () => {
    for (const role of ["merger", "postMergeReviewer", "postMergeFixer"]) {
      expect(count(`timeRole(timingLedger, "${role}"`)).toBe(1);
    }
    // The planner is not a role any more: no agent is dispatched to plan, so
    // nothing times or costs one. A `timeRole(timingLedger, "planner"` coming
    // back would mean the LLM planner had been reinstated.
    expect(count('timeRole(timingLedger, "planner"')).toBe(0);
    expect(count('name: "planner"')).toBe(0);
  });

  it("bumps implementerRetries ONLY at the two retry dispatches", () => {
    // retries = attempts - 1. A FOURTH bump would mean the first pass is
    // being counted, which inverts the run's headline retry rate into
    // nonsense. Needle includes the receiver so the ⚠️ doc comment on
    // PipelineCtx.runCounters (which names the call to warn against
    // misusing it) is not counted as a call site.
    //
    // Two: the review rounds' two fix dispatches (round 2, round 3), bumped
    // for the builder only — the fixer's rounds are counted as a recovery.
    // Issue #915 (Piece I) added a third, the rescue path's screen-check retry
    // round (`runLadderRound`); spec #1334 deleted it with the rescue ladder —
    // a red screen check is recorded, never retried.
    expect(count('ctx.runCounters?.bump("implementerRetries")')).toBe(2);
    // The ORDINAL is taken once, inside runImplementer, so it covers attempts
    // 1, 2 and 3 — including the first pass, which is the denominator.
    expect(count("ctx.telemetry?.noteImplementerAttempt(")).toBe(1);
  });

  it("keeps one call site for each remaining per-issue counter", () => {
    for (const needle of [
      "noteReviewerBlockers()",
      "noteRecovery()",
      "noteQuarantine(",
      "noteDeferral(",
      "noteOutcome(",
      "noteShipPath(",
      "noteReviewerEscalated(",
    ]) {
      expect({ needle, n: count(needle) }).toEqual({ needle, n: 1 });
    }
  });

  it("measures the diff at exactly TWO call sites: first-pass review, then ship", () => {
    // Deliberately two, not one: the first measurement (inside
    // decideFirstPassReviewerModel's caller) only sees the diff up through
    // implementer attempt 1; the second, at the shipAfterMigrations funnel,
    // spans the whole issue. Why the second can safely overwrite the first is
    // argued in one place — `shipDiffBase`'s docstring, now in
    // lib/review/diff-measurement.ts.
    // Three occurrences ACROSS THE WHOLE TREE: the helper's own definition plus
    // its two call sites. Pinned per file, not just in total, so the halves
    // cannot trade places — a definition that migrated back into main.mts, or a
    // call site that grew inside the helper's own module, would still be a
    // different program from the one this test certifies even though the sum
    // stayed 3.
    //
    // WHY THIS SCANS EVERY FILE AND NOT JUST THE PAIR: while the helpers were
    // module-private to main.mts, a third measurement site was FORCED to live
    // in main.mts, where a count of that one file caught it — the language
    // enforced the invariant. Extracting them made `recordDiffMeasurement`,
    // `reviewDiffStats` and `reviewBaseForCommit` `export`ed and therefore
    // importable from anywhere in `.sandcastle/`, so a future `lib/ship/*.ts`
    // could measure from an arbitrary (even `tip-parent`) base and silently
    // overwrite the correct ship measurement via the bag's last-write-wins
    // setter. The "0 in every other file" half below is what restores, as a
    // test, the enforcement that the `export` widening gave away.
    //
    // WHAT IS AND IS NOT ENFORCED — read this before trusting the guard:
    // all four pins below are on CALL SITES BY NAME. They catch the ordinary
    // regression (someone imports a measurement helper into a new module and
    // calls it) and nothing more. Three known holes, all pre-existing and all
    // deliberately left open rather than papered over:
    //   1. `ctx.telemetry?.noteDiff(` is receiver-name-coupled — a rogue that
    //      writes `bag.noteDiff(`, or destructures the method off the bag,
    //      reaches the setter without matching the needle.
    //   2. An ALIASED or rebound import (`import { reviewDiffStats as rds }`)
    //      evades all four needles for the same reason.
    //   3. A file that re-implements the git plumbing inline — its own
    //      `runGit(…, "diff", …)` against a hand-picked base — is measuring
    //      from an arbitrary base without naming any of these helpers.
    // So this pins the NAMES, not the BEHAVIOUR: it is a high-signal tripwire
    // on the paths a refactor actually takes, not a proof that no second
    // measurement can exist.
    expect(countIn(DIFF_SRC, "export function recordDiffMeasurement(")).toBe(1);
    expect(distributionOf("recordDiffMeasurement(")).toEqual({
      "lib/review/diff-measurement.ts": 1,
      "main.mts": 2,
    });
    // Both sites reach the bag through that ONE helper, which is what makes the
    // fail-quiet {0, []} guard hold by construction rather than by two
    // hand-written `if`s that can drift apart. The write itself moved with the
    // helper, so NO other file — main.mts included — may contain one: a
    // reappearance anywhere is a second route to the bag, which is exactly what
    // this pins against.
    expect(distributionOf("ctx.telemetry?.noteDiff(")).toEqual({
      "lib/review/diff-measurement.ts": 1,
    });
    // The two MEASURING helpers, pinned the same way. Writing to the bag was
    // already covered above, but a rogue can do the more insidious thing —
    // measure from a base of its own choosing and then hand the result to the
    // one blessed writer, which records it faithfully. `reviewBaseForCommit`
    // is where the fork-point/tip-parent regime is decided and `reviewDiffStats`
    // is the only thing that runs the diff, so pinning both is what makes the
    // "arbitrary base" threat named above cost a red test rather than a silent
    // overwrite.
    // Counts are the shipped ones, definitions included: `reviewDiffStats` is
    // defined once and called once from main.mts (the first-pass review
    // sizer; the ship funnel measures with the fail-closed `diffStatsBetween`);
    // `reviewBaseForCommit` is defined once, called once INSIDE the module
    // by `shipDiffBase`, and called twice from main.mts. A `{@link …}` doc
    // reference carries no `(` and so is correctly not a call site.
    //
    // Issue #915 fix: a THIRD main.mts call site, inside
    // `shipRecoveredIssue`'s `clearProtectedPaths` — the rescue path now
    // clears the SAME protected-path lock `shipAfterMigrations` does, which
    // needs its own `DiffStats` scoped to `preSha`..the sha being graded.
    // It deliberately does NOT feed `recordDiffMeasurement`/`noteDiff` (this
    // is a violation-detection measurement, not a ship-size one) — it only
    // shares the MEASURING helper, not the write path pinned above, so the
    // `ctx.telemetry?.noteDiff(` guard two assertions up is unaffected. A
    // documented, deliberate widening of this count, not rot.
    //
    // 2026-08-04 review (F3): a FOURTH main.mts call site, also inside
    // `shipRecoveredIssue`. The pre-ladder measurement above it is kept — the
    // no-screen re-check still needs a list frozen before any restore — but
    // `clearProtectedPaths` no longer closes over it. That function is re-run
    // after every ladder round, and a list measured before the ladder started
    // cannot contain a file a LATER round is the first to touch, so the
    // re-run was a no-op for exactly the case it exists for. It now measures
    // its own diff against the sha it is clearing. Like the #915 site, it
    // feeds neither `recordDiffMeasurement` nor `noteDiff` — the write-path
    // guard two assertions up is still unaffected.
    //
    // 2026-08-06 review: the thing that RUNS the diff is now
    // `diffStatsBetween`, and `reviewDiffStats` is a fail-quiet wrapper over
    // it. Both are pinned, because they are the two halves of one measurement
    // with OPPOSITE failure directions — a caller that needs the fail-closed
    // answer and reaches for the wrapper gets `{0, []}` on a git error, which
    // at the proof gate reads as "this diff owes nothing" and waives it. Which
    // helper a call site names is therefore load-bearing, not stylistic, and a
    // silent swap between them is exactly the rot this guard is for.
    //
    // Spec #1334 SG deleted `shipRecoveredIssue` — the fixer ships through
    // `shipAfterMigrations` — and with it the #915 and F3 sites above (its
    // `clearProtectedPaths` re-measure, the wrapper) and its fail-closed proof
    // gate measurement.
    //
    // The shipped `main.mts` sites: the first-pass review sizer takes the
    // fail-quiet wrapper (a git hiccup there must not escalate or stop);
    // `shipAfterMigrations` and `proveFirstTestRewrite` take the fail-closed
    // `diffStatsBetween`. The first feeds the proof gate; the second asks whether the builder
    // touched a migration or a dependency manifest, and a diff nobody could
    // read there must REFUSE the check repair rather than run a pre-builder
    // proof behind a database the replay cannot put back (issue #1118).
    expect(countIn(DIFF_SRC, "export function reviewDiffStats(")).toBe(1);
    expect(distributionOf("reviewDiffStats(")).toEqual({
      "lib/review/diff-measurement.ts": 1,
      "main.mts": 1,
    });
    // Two inside the module: the definition, plus the one call the fail-quiet
    // wrapper makes. That second occurrence is the proof there is only ONE
    // `git diff` behind both entry points.
    // #972 gap 6: a FOURTH main.mts call site, inside
    // `postMergeFixerProofRefusal`. The post-merge fixer commits code on
    // `integration-candidate` AFTER every per-issue proof gate has run; this
    // measures its net diff so the SAME never-waived removed-coverage gate that
    // guards the per-issue ship path also guards the fixer's output. It takes
    // the fail-closed `diffStatsBetween` (a git error there must REFUSE to
    // promote, never read as "nothing changed") and, like the #915 and F3
    // sites, feeds neither `recordDiffMeasurement` nor `noteDiff` — it is a
    // gate measurement, not a ship-size one, so the write-path guards above are
    // unaffected. A documented, deliberate widening of this count, not rot.
    expect(countIn(DIFF_SRC, "export function diffStatsBetween(")).toBe(1);
    expect(distributionOf("diffStatsBetween(")).toEqual({
      "lib/review/diff-measurement.ts": 2,
      // Three fail-closed sites, all feeding a gate (a git error there must
      // REFUSE, never waive): shipAfterMigrations, the first test's one
      // rewrite (`proveFirstTestRewrite`,
      // spec #1334 — it reads the builder's diff to refuse a replay a
      // checkout cannot restore), and the post-merge fixer gate
      // (`postMergeFixerProofRefusal`, #972 gap 6). Spec #1334 deleted the
      // rescue ladder's post-commit re-gate (`regateAfterLadderCommit`) with
      // the ladder, the sibling-check repair's own measurement
      // (`repairSiblingCheckAfterRefusal`, #1271) with that road, and SG the
      // rescue road's proof gate (`shipRecoveredIssue`) with that road.
      "main.mts": 3,
    });
    expect(countIn(DIFF_SRC, "export function reviewBaseForCommit(")).toBe(1);
    expect(distributionOf("reviewBaseForCommit(")).toEqual({
      "lib/review/diff-measurement.ts": 2,
      "main.mts": 2,
    });
  });

  it("keeps one call site for each run-level counter", () => {
    for (const needle of [
      'bump("reviewerBlockers")',
      'bump("recoveries")',
      'bump("quarantines")',
      'bump("deferrals")',
      "noteSkillMiss(",
    ]) {
      expect({ needle, n: count(needle) }).toEqual({ needle, n: 1 });
    }
    // Exactly ONE error-class site. The reviewer's catch runs twice for a
    // single no-verdict (outer call + same-model retry) and the pipeline catch
    // then classifies the rethrown error, so counting anywhere but the
    // pipeline catch reports one event as three.
    expect(count("noteErrorClass({")).toBe(1);
  });

  it("REUSES an issue's bag across iterations instead of replacing it", () => {
    // The per-issue closure runs once per issue PER ITERATION, and a deferred
    // issue is re-planned by the next one. `new IssueTelemetryBag()` alone
    // would keep only the last attempt's counters while the issue ledger
    // accumulated cost across both — a row whose dollars span two attempts and
    // whose attempt count describes one. No runtime test can see this without
    // a two-iteration deferral, so it is pinned here.
    expect(SRC).toContain(
      "issueBags.get(issueNumber) ?? new IssueTelemetryBag()",
    );
    expect(count("new IssueTelemetryBag()")).toBe(1);
  });

  it("records the output-cap verdict in the audit line", () => {
    // It was computed and then omitted, making an output-cap failure
    // indistinguishable from a plain one in the log.
    expect(SRC).toContain("outputCap=${outputCapVerdict}");
  });

  it("never bumps STATUS_SCHEMA_VERSION from main.mts", () => {
    expect(count("STATUS_SCHEMA_VERSION =")).toBe(0);
  });

  // -------------------------------------------------------------------------
  // REWORK STORE WIRING. `lib/telemetry/rework-store.ts` is the durable half of
  // this file's telemetry, and it has exactly one production caller. A store
  // with zero callers is the local failure family this guard exists to prevent:
  // code that is correct in isolation, fully unit-tested, and never reached.
  // Every assertion below goes red if the call site is deleted, renamed, or
  // handed the wrong path.
  // -------------------------------------------------------------------------

  it("appends a rework record from exactly ONE production call site", () => {
    // Tree-wide, definition included. The reader/report side only READS the
    // store, so a second appender appearing anywhere is a second writer to an
    // append-only log — pin it, don't discover it.
    expect(distributionOf("appendReworkRecord(")).toEqual({
      "lib/telemetry/rework-store.ts": 1,
      "main.mts": 1,
    });
    // And the record it appends is built by the extracted, unit-tested shaper.
    // Without this, inlining an object literal back into main.mts leaves
    // `appendReworkRecord(` at 1 and `rework-record-input.test.ts` green while
    // testing code nothing calls — the unwired/inert family.
    expect(distributionOf("buildReworkRecordInput(")).toEqual({
      "lib/telemetry/rework-record-input.ts": 1,
      "main.mts": 1,
    });
  });

  it("passes the MAIN repo root — never a worktree, never cwd", () => {
    // THE load-bearing assertion. `appendReworkRecord` requires an explicit
    // path precisely because the loop's per-issue work happens in
    // `.sandcastle/worktrees/<lane>`, which cleanup DELETES: a record written
    // against a worktree root is appended successfully, returns `true`, logs
    // nothing, and then vanishes with the worktree. That is a silent, total
    // data loss with a green suite — so the argument itself is pinned, not just
    // the presence of a call.
    //
    // Scoped to main.mts rather than the tree-wide distribution ON PURPOSE:
    // `reworkStorePath` is also the reader's entry point, so a report script
    // legitimately calls it and a tree-wide pin here would go red on someone
    // else's correct code.
    //
    // TWO call sites as of issue #1179, not one: the writer's own
    // `reworkContext.storePath` above, and `buildFinalRunReport`'s
    // best-effort `readReworkRecords` read (the end-of-run report's source
    // for each stopped ticket's plain-English cause). Both pass the SAME
    // main-repo root, for the same reason — a worktree-scoped read would
    // silently see nothing the moment cleanup deletes that worktree.
    expect(count("reworkStorePath(args.repoRoot)")).toBe(2);
    // The negative half: no other repo-root-shaped argument reaches it. `cwd()`
    // is the worktree the loop executes from, and any worktree path variable is
    // by definition the deleted-later one.
    expect(count("reworkStorePath(process.cwd())")).toBe(0);
    expect(count("reworkStorePath(stagingWorktreePath")).toBe(0);
    expect(count("reworkStorePath(ctx.args.repoRoot)")).toBe(0);
  });

  it("commits the JSONL once per iteration, before every early return", () => {
    // Writing without committing is strictly WORSE than not writing at all: an
    // untracked file in the launch worktree makes `git status --porcelain`
    // non-empty, and `fastForwardIntegration` refuses the promotion on exactly
    // that — so an uncommitted telemetry line strands every subsequent
    // iteration's certified work on `integration-candidate`.
    expect(count("const commitReworkRecords = ")).toBe(1);
    // The flag wrapper delegates to the exported, unit-tested `commitReworkStore`
    // — one definition, one caller.
    expect(count("export function commitReworkStore(")).toBe(1);
    expect(count("commitReworkStore(args.repoRoot, args.branch")).toBe(1);
    // TWO call SITES: the per-COMPLETION one (#902: was per-ROUND, unguarded,
    // covering every early return the SAME way — now through the merge lane
    // so it can never race a staging reset, queued once per settled ticket)
    // and a run-end backstop in runMain's `finally`. The backstop matters
    // because a settled ticket's unguarded `await deps.releaseIssueLease(...)`
    // sits BETWEEN the append and the per-completion commit — a throw there
    // unwinds past it and would leave the JSONL untracked, stranding the next
    // fast-forward. It is a no-op when nothing is pending.
    expect(count("async () => commitReworkRecords(),")).toBe(1);
    expect(count("commitReworkRecords();")).toBe(1);
    // Pathspec-limited at all THREE git calls in the commit path — the `add`,
    // the `diff --cached` that decides whether anything is left to commit, and
    // the `commit` itself. Dropping it from the `add` or the `commit` sweeps
    // unrelated files in; dropping it from the `diff` makes an unrelated staged
    // file read as "our line is still pending" and retries a commit forever.
    // Squashed, not literal: the `-c user.*` identity flags re-wrap these
    // argument lists, and a newline-and-indent-exact needle would then go red on
    // a pure reformat rather than on a real deletion.
    expect(count('"add", "--", REWORK_STORE_RELATIVE_PATH)')).toBe(1);
    expect(countSquashed('"--", REWORK_STORE_RELATIVE_PATH,')).toBe(2);
    // The commit must not be able to trigger a repo pre-commit hook: a
    // lint/typecheck/test hook firing once per iteration would cost minutes to
    // validate one appended JSON line.
    expect(countSquashed('"commit", "--no-gpg-sign", "--no-verify",')).toBe(1);
    // Identity, mirroring `lib/state/issue-lease.ts`'s commit-tree. Two
    // reasons, both load-bearing: `reworkTipIsAmendable` matches the committer
    // email against `REWORK_COMMIT_EMAIL`, and a host with NO identity at all
    // would fail this commit outright — which, before the pending-flag fix
    // below, stranded every later promotion. (This comment used to cite
    // `buildGitEnv` as the handler of the no-identity case; it no longer is —
    // it returns a fixed identity, see `lib/git/identity.ts`.)
    // `--no-gpg-sign` is the other half: a `commit.gpgsign=true`
    // host with a pinentry-guarded key would BLOCK on a `runGit` `execFileSync`
    // with `stdio` piped. `runGit` now carries a coarse 120s bound
    // (RUN_GIT_DEFAULT_TIMEOUT_MS) so a wedged git is eventually killed rather
    // than freezing the loop forever — but `--no-gpg-sign` is still the right
    // fix: it avoids a 120s stall that then FAILS the commit outright.
    expect(countSquashed('"-c", `user.name=${REWORK_COMMIT_NAME}`,')).toBe(1);
    expect(countSquashed('"-c", `user.email=${REWORK_COMMIT_EMAIL}`,')).toBe(1);
    // Ordering, pinned as text because no unit test can observe it: the commit
    // must run immediately after the iteration's flush — BEFORE the
    // lease-fatal / stall / circuit-breaker early returns, and before
    // `resetStagingToIntegrationTip` rebases staging onto the integration tip.
    // Committing later would either be skipped by an early return or land after
    // staging was already reset, which is what turns `merge-base
    // --is-ancestor` false and pushes promotion into the `--no-ff` path.
    expect(SRC).toContain("flushTelemetry();\n    // The durable rework line");
    // Anchored on the staging prelude's unique guard message rather than on
    // `resetStagingToIntegrationTip(` itself — that name also appears at its
    // DEFINITION far earlier in the file, which would make the comparison
    // trivially false regardless of the call order inside runMain.
    // #902: source ORDER no longer encodes run order — `landTicket` (with the
    // staging prelude) is extracted above `settleOutcome`. The guarantee is now
    // structural: both the rework commit and every staging reset run as jobs
    // on the ONE serial merge lane, queued in completion order, so a commit can
    // never interleave with a reset. `serial-queue.test.ts` pins the lane.
  });

  it("clears the pending flag only on SUCCESS, so the backstop can retry", () => {
    // The shape this forbids — clear-then-attempt — made the run-end backstop a
    // GUARANTEED no-op: any failure returned with the flag already false, so
    // nothing ever retried, the JSONL stayed staged, and
    // `fastForwardIntegration`'s dirty guard then refused EVERY promotion for
    // the rest of the run. The visible symptom is the worst kind: certified work
    // stranded on the staging branch while `finishRun` still opens a run PR
    // saying `Closes #N` for code that PR does not contain.
    expect(
      countSquashed(
        "if (!reworkPendingCommit) return; reworkPendingCommit = false;",
      ),
    ).toBe(0);
    // Cleared on the one path that returns `true` — which `commitReworkStore`
    // defines as "the store path is committed", covering both a fresh commit and
    // "there was nothing left to commit". Never on a failure.
    expect(
      countSquashed(
        "if (commitReworkStore(args.repoRoot, args.branch, deps.logError)) { reworkPendingCommit = false;",
      ),
    ).toBe(1);
    // The classification is by EXIT CODE, never by git's prose. Git localises
    // every one of its messages through gettext and `runGit` passes no `env:`,
    // so a host with a non-English `LANG` (the Linux VPS) misread the
    // already-committed case as a failure and retried it every iteration
    // forever. `git diff --cached --quiet` answers in every locale.
    expect(countSquashed('"diff", "--cached", "--quiet",')).toBe(1);
    expect(SRC).not.toContain("say.includes(");
    expect(count("const say = ")).toBe(0);
  });

  it("runs the run-end backstop BEFORE the branch is pushed", () => {
    // `finishRun()` is what pushes the branch to origin and opens the run PR.
    // A telemetry commit made AFTER it never reaches the remote and dies with
    // the local branch when that branch is reaped — the record is durable in
    // name only. There are exactly two calls (per-iteration + backstop), so the
    // LAST occurrence is the backstop.
    //
    // `lastIndexOf` on BOTH sides: the two earlier `await finishRun()` calls are
    // pre-loop startup refusals (sync-config, single-instance lock) that return
    // before any issue is worked, so no telemetry can exist to commit at either
    // one. The `finally` block's is the last, and it is the one this ordering is
    // about.
    expect(SRC.lastIndexOf("commitReworkRecords();")).toBeLessThan(
      SRC.lastIndexOf("await finishRun();"),
    );
    // And OUTSIDE the hot-reload guard: on exit 75 the JSONL is still sitting
    // uncommitted on disk and would still strand the relaunched run's first
    // promotion, so skipping it there would reintroduce the bug.
    expect(countSquashed("commitReworkRecords(); // Finish-and-PR")).toBe(1);
  });

  it("records at the terminal-outcome funnel, deferrals excluded", () => {
    // One call, in the accounting loop, fed from the outcome that is already
    // final — so nothing is re-measured and no second funnel can drift. The
    // recorder itself is now a top-level exported function (its shaping half
    // lives in `lib/telemetry/rework-record-input.ts` and is unit-tested there);
    // what stays pinned here is the WIRING, which no unit test can see.
    expect(count("export function recordReworkOutcome(")).toBe(1);
    expect(count("recordReworkOutcome(reworkContext,")).toBe(1);
    expect(count("const recordIssueRework = ")).toBe(1);
    expect(count("recordIssueRework(")).toBe(1);
    // #902 B5: the accounting loop's fulfilled branch is now `settleOutcome`,
    // whose param is `v` (the settled promise's value) rather than `s.value`.
    expect(count("v.outcome.postSha")).toBe(1);
    // "deferred" is not terminal — the issue goes back to `ready-for-agent` and
    // is re-planned, so recording it would both double-count the issue and
    // score work that never shipped.
    expect(SRC).toContain('if (status === "deferred") return false;');
    // Exactly-one-line-per-issue-per-run, enforced by a set rather than argued
    // from the status filter.
    expect(count("ctx.recorded.has(issueNumber)")).toBe(1);
    expect(count("ctx.recorded.add(issueNumber)")).toBe(1);
  });

  it("describes the un-recorded quarantines accurately", () => {
    // A bare `HALT` quarantine produces no `shippedSha`, so the store correctly
    // refuses the record — but the OLD justification for that ("no commit was
    // ever made") is factually wrong for the skill-discipline gate, whose own
    // comment says the implementer's commits ARE on the agent's branch and
    // merely have not merged. A comment that misstates why data is missing is
    // how the gap gets argued away later.
    expect(SRC).not.toContain("no commit was ever made");
    expect(SRC).not.toContain("an issue with no commit has nothing later");
    // And the blind spot is surfaced, not just logged: the recorded quarantine
    // count is a FLOOR, and the report says so.
    expect(SRC).toContain("the recorded quarantine count is a FLOOR");
  });

  it("judges 'nothing to ship' by CONTENT, inside finishRun", () => {
    // The unit tests above prove `branchHasShippableContent` answers correctly;
    // this proves `finishRun` is the thing ASKING it. A correct helper with the
    // old caller still wired up is the inert/unwired failure family — the run
    // would keep pushing a branch whose only commit is a telemetry line, one
    // fresh orphan on origin per FAILED run.
    expect(count("branchHasShippableContent(\n        args.repoRoot,")).toBe(1);
    // And the old predicate is GONE from the caller. It survives only at its own
    // definition and inside the new helper (which delegates to it first), so
    // three occurrences total: definition, delegation, and the export.
    expect(count("branchHasCommitsAheadOfBase(\n        args.repoRoot,")).toBe(
      0,
    );
    // Computed ONCE and reused, so the honest "nothing to ship — no push, no
    // PR" log fires for a telemetry-only run instead of falling through to the
    // push-uncertified-commits branch with a confusing message.
    expect(count("const hasShippableContent = ")).toBe(1);
  });

  it("warns, at the push site, that telemetry makes hosts diverge", () => {
    // `merge=union` on the JSONL solves the MERGE side of multi-host telemetry.
    // It does not solve the PUSH side: every host now commits to the same
    // run-branch name every iteration, so two hosts diverge on that branch even
    // when they shipped byte-identical code, and `openRunPr`'s deliberately
    // non-forced push is rejected non-fast-forward more often than it used to
    // be. The caveat belongs where someone debugging a rejected push will read
    // it — at the push, not in `.gitattributes`.
    expect(SRC).toContain("MULTI-HOST CAVEAT");
    expect(
      SRC.indexOf("MULTI-HOST CAVEAT") <
        SRC.indexOf('"push",\n          "origin",'),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// END-TO-END WIRING: does a real `runMain` actually land telemetry in
// status.json?
//
// The unit tests prove the accumulators and the payload builder are correct;
// this proves main.mts is plumbed to them at all. It reads the file OFF DISK
// because runMain returns only {exitCode, shippedIssues}.
//
// GOTCHA that makes this test worth writing carefully: createStatusStore
// defaults to <repoRoot>/.sandcastle/status.json, and a temp repo has no
// .sandcastle directory — the write ENOENTs into `onError`, which is
// SWALLOWED. Without the mkdirSync below the test would assert nothing while
// appearing to pass.
// ---------------------------------------------------------------------------

describe("runMain telemetry wiring", () => {
  let repo: string;
  let origin: string;
  const BRANCH = "sandcastle/telemetry-run";

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sc-telemetry-repo-"));
    origin = mkdtempSync(path.join(tmpdir(), "sc-telemetry-origin-"));
    git(origin, "init", "-q", "--bare", "-b", "main");
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
    git(repo, "commit", "--allow-empty", "-q", "-m", "init");
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-q", "origin", "main");
    // See the gotcha above — without this the status writes vanish silently.
    mkdirSync(path.join(repo, ".sandcastle"), { recursive: true });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  });

  /** The snapshot runMain left on disk, parsed and schema-validated. */
  function readStatus(): Record<string, unknown> {
    const raw = JSON.parse(
      readFileSync(path.join(repo, ".sandcastle", "status.json"), "utf8"),
    ) as Record<string, unknown>;
    const parsed = SandcastleStatusSchema.safeParse(raw);
    expect(parsed.error?.issues).toBeUndefined();
    return raw;
  }

  it("records run identity and survives the schema, on a no-work path", async () => {
    git(repo, "checkout", "-q", "-b", BRANCH);
    const deps = makeDeps({
      // No open issues at all — the "no work" path. `makeDeps`' own default
      // already returns an empty listing; named here so the fixture says out
      // loud what it is testing.
      listOpenIssuesWithBodies: readyIssues(),
      run: async (spec) => {
        throw new Error(`unexpected deps.run(${spec.name})`);
      },
    });

    await runMain(makeArgs({ repoRoot: repo, branch: BRANCH }), deps);

    const status = readStatus();
    const runTelemetry = status.runTelemetry as
      | Record<string, unknown>
      | undefined;
    expect(runTelemetry).toBeDefined();
    // Identity is resolved from the run's OWN inputs, so a run tagged budget
    // whose implementer default is an Opus id is visibly wrong from here.
    const identity = runTelemetry!.identity as Record<string, unknown>;
    expect(identity.profile).toBe("default");
    expect(identity.roleModels).toHaveProperty("implementer");
    // Additive keys only — a bump would make every un-updated peer host
    // silently reject this snapshot mid-run.
    expect(status.schemaVersion).toBe(3);
  });

  it("records the budget profile when the run is a budget run", async () => {
    git(repo, "checkout", "-q", "-b", BRANCH);
    const deps = makeDeps({
      listOpenIssuesWithBodies: readyIssues(),
      run: async () => ({ stdout: "", commits: [] }),
    });

    await runMain(
      makeArgs({ repoRoot: repo, branch: BRANCH, budget: true }),
      deps,
    );

    const identity = (readStatus().runTelemetry as Record<string, unknown>)
      .identity as Record<string, unknown>;
    expect(identity.profile).toBe("budget");
  });

  /**
   * A full agent stub that carries issue #412 all the way to an `ok` outcome.
   *
   * Hoisted out of the cost test so the rework-store wiring test can drive the
   * SAME shipping path rather than maintaining a second copy of it — two stubs
   * that drift apart would let one test certify a pipeline the other never
   * exercises. Every dispatch resolves to a real fixture session, so the cost
   * pipeline runs for real rather than being stubbed out.
   */
  const FIXTURE_ITERATIONS = [{ sessionFilePath: SONNET_FIXTURE }];
  /** The one ticket the shipping stub above carries — issue #412. The host
   *  plans it straight off this listing; there is no planner agent to ask. */
  const shippingQueue = (): Deps["listOpenIssuesWithBodies"] =>
    readyIssues({ number: 412, title: "t" });
  function makeShippingAgentRun(): (spec: {
    name: string;
  }) => Promise<unknown> {
    const iterations = FIXTURE_ITERATIONS;
    return async (spec: { name: string }): Promise<unknown> => {
      if (spec.name.startsWith("check-writer")) {
        // Issue #911: the check-writer now dispatches BEFORE the
        // implementer on every issue. NO_SCREEN_APPLIES is the simplest
        // outcome that PROCEEDS to the implementer without needing an
        // `exec` stub for the must-fail-first proof (that proof only runs
        // for a fresh CHECKS_WRITTEN outcome — see `main.checkwriter.test
        // .mts` for the outcome-routing and must-fail-first coverage).
        const envelope = {
          marker: "NO_SCREEN_APPLIES",
          inherited: false,
          noScreenReason: "fixture issue — no real screen involved",
        };
        return {
          stdout: [
            "reasoning",
            "```json",
            JSON.stringify(envelope),
            "```",
            "NO_SCREEN_APPLIES",
          ].join("\n"),
          commits: [],
          iterations,
        };
      }
      if (spec.name.startsWith("implementer")) {
        // The implementer's fenced-JSON envelope, with the 7-question
        // structural certification. `backend-only` + e2eRequired:false is the
        // vacuous-but-valid combination that needs no test evidence.
        const envelope = {
          marker: "STORY_COMPLETE",
          storyType: "backend-only",
          e2eRequired: false,
          e2eActuallyRan: false,
          testCommandUsed: null,
          e2eAssertionLine: null,
          outputNotFiltered: true,
          testReachedFeature: false,
        };
        return {
          stdout: [
            "work done",
            "```json",
            JSON.stringify(envelope),
            "```",
            "STORY_COMPLETE",
          ].join("\n"),
          commits: [{ sha: "abc123", subject: "work" }],
          iterations,
        };
      }
      if (spec.name.startsWith("reviewer")) {
        return { stdout: "looks good\nALL_CLEAR", commits: [], iterations };
      }
      return { stdout: "", commits: [], iterations };
    };
  }

  it("attributes cost to the ISSUE and counts the run's events", async () => {
    git(repo, "checkout", "-q", "-b", BRANCH);
    const LOGS: string[] = [];
    const agentRun = makeShippingAgentRun();
    const deps = makeDeps({
      listOpenIssuesWithBodies: shippingQueue(),
      run: agentRun as Deps["run"],
      // The per-issue roles dispatch through the SANDBOX's run, not deps.run
      // — deps.run only serves the batch roles (merger/post-merge). The
      // planner is not among them any more: it is code, not an agent.
      createSandbox: (async () => ({
        run: agentRun,
        branch: "agent/issue-412",
        close: async () => undefined,
        cleanup: async () => undefined,
        worktreePath: undefined,
      })) as unknown as Deps["createSandbox"],
      captureSha: async () => "abc123",
      log: (l: string) => LOGS.push(l),
      logError: (l: string) => LOGS.push(`ERR ${l}`),
    });

    await runMain(
      makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 1 }),
      deps,
    );

    const status = readStatus();
    const rows = status.issueTelemetry as Record<string, unknown>[] | undefined;
    expect(rows).toBeDefined();
    const row = rows!.find((r) => r.issue === 412);
    expect(row).toBeDefined();
    // The whole point: dollars charged to ONE ticket, not smeared over a role.
    expect(row!.costUsd).toBeGreaterThan(0);
    // The first pass counts as attempt 1 — the denominator for the retry rate.
    expect(row!.implementerAttempts).toBe(1);
    // On failure, `LOGS` holds the run's full narration — the fastest way to
    // see which gate rejected the stubbed issue.
    expect({ outcome: row!.outcome, logs: LOGS }).toMatchObject({
      outcome: "ok",
    });
    expect(row!.shipPath).toBe("first-pass-only");
    // Only ATTRIBUTABLE roles may appear here; the batch roles' spend is
    // overhead. checkWriter (issue #911) is attributable — it dispatches
    // once per issue, before the implementer.
    const perRole = row!.perRole as Record<string, unknown>;
    expect(Object.keys(perRole).sort()).toEqual([
      "checkWriter",
      "implementer",
      "reviewer",
    ]);

    const runTelemetry = status.runTelemetry as Record<string, unknown>;
    // The batch roles ran (merger, post-merge reviewer), so their cost is
    // reported as overhead rather than as part of any issue's bill. The
    // planner is not among them since 2026-09-03: it is code and spends
    // nothing.
    expect(runTelemetry.overheadCostUsd).toBeGreaterThan(0);
    // Shipped first-try ⇒ no retries. A phantom retry here would invert the
    // run's headline retry rate.
    const counters = runTelemetry.counters as
      | Record<string, unknown>
      | undefined;
    expect(counters?.implementerRetries).toBeUndefined();
    // Cache economics survive unflattened.
    const eff = runTelemetry.tokenEfficiency as Record<string, unknown>;
    expect(eff.implementer).toHaveProperty("cacheRead");
    expect(eff.implementer).toHaveProperty("cacheHitRatio");
  });

  it("lands a DURABLE rework record on disk, at the main repo root", async () => {
    // The runtime half of the rework-store wiring. The rot-guard above pins the
    // call site as TEXT; this proves a real `runMain` actually produces a line
    // — the difference between "the code is there" and "the code is reached",
    // which is precisely the inert/unwired failure family this repo has shipped
    // before.
    //
    // Asserts the FILE, not the commit: `git add`/`commit` are best-effort and
    // route their failures to `logError`, leaving the JSONL on disk either way,
    // so asserting the commit would make this a test of git rather than of
    // wiring.
    git(repo, "checkout", "-q", "-b", BRANCH);
    const agentRun = makeShippingAgentRun();
    const deps = makeDeps({
      listOpenIssuesWithBodies: shippingQueue(),
      run: agentRun as Deps["run"],
      createSandbox: (async () => ({
        run: agentRun,
        branch: "agent/issue-412",
        close: async () => undefined,
        cleanup: async () => undefined,
        worktreePath: undefined,
      })) as unknown as Deps["createSandbox"],
      captureSha: async () => "abc123",
    });

    await runMain(
      makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 1 }),
      deps,
    );

    // THE path assertion, made against the filesystem rather than the source:
    // the store must have been handed the MAIN repo root. A worktree-derived or
    // cwd-derived path would leave this exact location empty while the append
    // returned `true` and logged nothing.
    const storePath = path.join(
      repo,
      ".sandcastle",
      "telemetry",
      "issues.jsonl",
    );
    expect(existsSync(storePath)).toBe(true);
    // DURABILITY, asserted rather than assumed. Two halves, and the second is
    // the one that protects the loop rather than the data:
    //   1. TRACKED — an untracked file is not durable at all; it never reaches
    //      main and is lost with the worktree.
    //   2. NOT DIRTY — `fastForwardIntegration` refuses the promotion whenever
    //      `git status --porcelain` in the launch worktree is non-empty, so a
    //      written-but-uncommitted JSONL would strand every subsequent
    //      iteration's certified work. That makes writing without committing
    //      strictly WORSE than not writing at all, which is why this is pinned.
    // (`beforeEach` configures user.name/user.email, so the commit can run.)
    expect(git(repo, "ls-files", "--", ".sandcastle/telemetry")).toContain(
      "issues.jsonl",
    );
    expect(git(repo, "status", "--porcelain")).not.toContain("issues.jsonl");
    const lines = readFileSync(storePath, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "");
    // Exactly one line: one issue, one run.
    expect(lines.length).toBe(1);
    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(record).toMatchObject({
      issueNumber: 412,
      outcome: "shipped",
      shippedSha: "abc123",
      // Shipped on the first implementer pass ⇒ 0 RETRIES. A `1` here would be
      // the attempts/retries inversion the store's schema warns about.
      retries: 0,
      quarantined: false,
    });
    // The identity fields the store REQUIRES — an empty one silently drops the
    // whole record, so their presence is part of the wiring, not a detail.
    expect(typeof record.runId).toBe("string");
    expect((record.runId as string).length).toBeGreaterThan(0);
    expect(typeof record.hostId).toBe("string");
    expect((record.hostId as string).length).toBeGreaterThan(0);
    expect(record.schemaVersion).toBe(1);
    // The auto-tuning seed: outcomes that cannot be correlated to the settings
    // that produced them make the whole archive un-actionable.
    expect(record.models).toHaveProperty("implementer");
    // TIMING: recorded because this run really did dispatch roles, so `perRole`
    // carries a `wallMs` and the three-state rule is satisfied by PRESENCE.
    // The absent case is guarded as source text (the ledger's `sawTiming` is
    // folded away by `rows()`, so no fixture can produce it from here).
    expect(typeof record.wallMs).toBe("number");
  });

  it("commits the JSONL on a host with NO usable git identity", async () => {
    // The `deploy` user on the VPS is the live candidate for this, and it was
    // the one unguarded `git commit` in main.mts — every sibling host-side
    // commit passes `-c user.*` (`lib/state/issue-lease.ts:413`,
    // `lib/state/status-sync.ts:88`, and the agent-identity sites listed in
    // `lib/git/identity.ts`). `buildGitEnv` is NOT the handler of the
    // no-identity case any more: it returns a fixed identity outright.
    //
    // Empty repo-level values rather than `--unset`: unsetting would fall
    // through to whatever identity the DEVELOPER'S global gitconfig happens to
    // provide, and the test would pass for the wrong reason on every machine
    // that has one. An empty ident is refused by git outright ("empty ident
    // name … not allowed"), and a command-line `-c` outranks repo config — so
    // this fails without the fix and passes with it, on every host.
    git(repo, "config", "user.name", "");
    git(repo, "config", "user.email", "");
    git(repo, "checkout", "-q", "-b", BRANCH);
    const agentRun = makeShippingAgentRun();
    const deps = makeDeps({
      listOpenIssuesWithBodies: shippingQueue(),
      run: agentRun as Deps["run"],
      createSandbox: (async () => ({
        run: agentRun,
        branch: "agent/issue-412",
        close: async () => undefined,
        cleanup: async () => undefined,
        worktreePath: undefined,
      })) as unknown as Deps["createSandbox"],
      captureSha: async () => "abc123",
    });

    await runMain(
      makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 1 }),
      deps,
    );

    // TRACKED and CLEAN — the two halves that matter. A failed commit here
    // leaves the file staged, which makes `git status --porcelain` non-empty,
    // which makes `fastForwardIntegration` refuse every later promotion.
    expect(git(repo, "ls-files", "--", ".sandcastle/telemetry")).toContain(
      "issues.jsonl",
    );
    expect(git(repo, "status", "--porcelain")).not.toContain("issues.jsonl");
  });

  it("does NOT push a branch whose only commit is telemetry", async () => {
    // The wiring half of the content check, driven through a real `runMain`.
    // Before rework telemetry, a run that shipped nothing made no commits at
    // all, so this ended in "nothing to ship — no push, no PR". A quarantine now
    // commits a telemetry line, which made "commits ahead of base" true and sent
    // the run down the push-uncertified-commits path — leaving a fresh orphaned
    // remote branch behind for every FAILED run.
    //
    // The commit is staged by hand rather than produced by a quarantine, so the
    // test states its premise instead of depending on which gate happens to
    // reject a stubbed issue: what is under test is finishRun's DECISION given a
    // telemetry-only branch, not the route that produces one.
    git(repo, "checkout", "-q", "-b", BRANCH);
    mkdirSync(path.dirname(path.join(repo, REWORK_STORE_RELATIVE_PATH)), {
      recursive: true,
    });
    writeFileSync(
      path.join(repo, REWORK_STORE_RELATIVE_PATH),
      '{"issueNumber":1}\n',
    );
    git(repo, "add", "--", REWORK_STORE_RELATIVE_PATH);
    git(
      repo,
      "commit",
      "-q",
      "-m",
      "chore(sandcastle): record rework telemetry",
      "--",
      REWORK_STORE_RELATIVE_PATH,
    );

    const LOGS: string[] = [];
    const deps = makeDeps({
      listOpenIssuesWithBodies: readyIssues(),
      run: async () => ({ stdout: "", commits: [] }),
      log: (l: string) => LOGS.push(l),
      logError: (l: string) => LOGS.push(l),
    });

    await runMain(
      makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 1 }),
      deps,
    );

    expect(LOGS).toContain(
      "run finished with nothing to ship — no push, no PR",
    );
    // The load-bearing half: origin really has no such branch. Asserting only
    // the log would let a future change push AND log.
    expect(git(repo, "ls-remote", "origin", BRANCH).trim()).toBe("");
  });

  it("RETRIES the commit at run end after the iteration's attempt failed", async () => {
    // The dead-backstop regression, driven for real. `commitReworkRecords` used
    // to clear `reworkPendingCommit` BEFORE attempting the commit, so any
    // failure returned with the flag already false and the run-end backstop was
    // a guaranteed no-op — one transient failure became permanent, the JSONL
    // stayed staged, and every remaining promotion in the run was refused.
    //
    // A leftover MERGE_HEAD is the honest way to make the commit fail: git
    // refuses a PATHSPEC commit outright while a merge is in progress, and that
    // state is genuinely reachable in production — `fastForwardIntegration`
    // leaves it behind whenever its own `merge --abort` fails. It also fails
    // EVERY attempt, which is what makes the retry countable: the fixed code
    // logs the refusal once per attempt, so TWO attempts (iteration + backstop)
    // produce two lines, while the broken code could only ever produce one.
    //
    // The refusal is no longer SPECIAL-CASED by message — it lands in the
    // generic failure branch, which is the point: classifying it by prose broke
    // under a non-English `LANG`, and the retry behaviour is identical without
    // the classification.
    git(repo, "checkout", "-q", "-b", BRANCH);
    const head = git(repo, "rev-parse", "HEAD").trim();
    writeFileSync(path.join(repo, ".git", "MERGE_HEAD"), `${head}\n`);

    const LOGS: string[] = [];
    const agentRun = makeShippingAgentRun();
    const deps = makeDeps({
      listOpenIssuesWithBodies: shippingQueue(),
      run: agentRun as Deps["run"],
      createSandbox: (async () => ({
        run: agentRun,
        branch: "agent/issue-412",
        close: async () => undefined,
        cleanup: async () => undefined,
        worktreePath: undefined,
      })) as unknown as Deps["createSandbox"],
      captureSha: async () => "abc123",
      log: (l: string) => LOGS.push(l),
      logError: (l: string) => LOGS.push(l),
    });

    await runMain(
      makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 1 }),
      deps,
    );

    const attempts = LOGS.filter((l) =>
      l.includes("rework telemetry: git commit failed:"),
    );
    expect({ attempts: attempts.length, logs: LOGS }).toMatchObject({
      attempts: 2,
    });
  });
});

// ---------------------------------------------------------------------------
// THE FOUR PLACES A REVIEWER REFUSAL CAN STOP A TICKET, with no judge
// (spec #1334; was issue #1135 LOW 4 / #1133 item 3).
//
// The judge that used to rule at each of these is gone. The host reads the
// reviewer's own GROUNDS line; only a `WRONG-CHECK` on a ticket with a first
// test buys anything beyond the ordinary road (the first test's one rewrite —
// `main.first-test-rewrite.scripted.test.mts`). Here every refusal is an
// ordinary one, so each site must take exactly its ordinary road: the no-retry
// stop, a builder round at the first refusal, and the two later stops.
//
// Driven end-to-end through the REAL `runMain` → `runIssuePipeline`, with a
// role-dispatching sandbox: the check-writer says NO_SCREEN_APPLIES, the
// implementer ships STORY_COMPLETE, the reviewer refuses with a real CATEGORY
// SWEEP + GROUNDS block. `reportStop` and the dispatched agent names are
// captured to prove which site was reached.
// ---------------------------------------------------------------------------
describe("runIssuePipeline — every reviewer-refusal stop takes its ordinary road, with no judge", () => {
  let repo: string;
  let origin: string;
  const BRANCH = "sandcastle/refusal-run";

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sc-refusal-repo-"));
    origin = mkdtempSync(path.join(tmpdir(), "sc-refusal-origin-"));
    git(origin, "init", "-q", "--bare", "-b", "main");
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
    git(repo, "commit", "--allow-empty", "-q", "-m", "init");
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-q", "origin", "main");
    mkdirSync(path.join(repo, ".sandcastle"), { recursive: true });
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  });

  const ISSUE = { id: "701", title: "refusal fixture", branch: "agent/issue-701" };

  /** A reviewer refusal in the real shape: CATEGORY SWEEP, terminator, GROUNDS,
   *  then the bare HAS_BLOCKERS marker on the last line. */
  function reviewerRefused(
    bullets: readonly string[],
    grounds = "GROUNDS: RED-CHECK",
  ): string {
    return [
      "I read the finished diff and I am not passing it.",
      "",
      "CATEGORY SWEEP:",
      ...bullets,
      "SWEEP COMPLETE.",
      grounds,
      "",
      "HAS_BLOCKERS",
    ].join("\n");
  }

  const IMPLEMENTER_ENVELOPE = [
    "work done",
    "```json",
    JSON.stringify({
      marker: "STORY_COMPLETE",
      storyType: "backend-only",
      e2eRequired: false,
      e2eActuallyRan: false,
      testCommandUsed: null,
      e2eAssertionLine: null,
      outputNotFiltered: true,
      testReachedFeature: false,
    }),
    "```",
    "STORY_COMPLETE",
  ].join("\n");

  const CHECK_WRITER_ENVELOPE = [
    "reasoning",
    "```json",
    JSON.stringify({
      marker: "NO_SCREEN_APPLIES",
      inherited: false,
      noScreenReason: "fixture — no real screen involved",
    }),
    "```",
    "NO_SCREEN_APPLIES",
  ].join("\n");

  interface Captured {
    readonly specs: string[];
    readonly stops: { label: string; detail: string }[];
  }

  /** Build the role-dispatching agent run and the deps that record what the
   *  pipeline did. `reviewerRounds[i]` is returned on the (i+1)-th reviewer
   *  dispatch. */
  function harness(opts: {
    reviewerRounds: readonly string[];
  }): { deps: Deps; captured: Captured } {
    const captured: Captured = { specs: [], stops: [] };
    let reviewerCalls = 0;
    const agentRun = async (spec: { name: string }): Promise<unknown> => {
      captured.specs.push(spec.name);
      if (spec.name.startsWith("check-writer")) {
        return { stdout: CHECK_WRITER_ENVELOPE, commits: [] };
      }
      if (spec.name.startsWith("implementer")) {
        return {
          stdout: IMPLEMENTER_ENVELOPE,
          commits: [{ sha: "abc123", subject: "work" }],
        };
      }
      if (spec.name.startsWith("reviewer")) {
        const round =
          opts.reviewerRounds[
            Math.min(reviewerCalls, opts.reviewerRounds.length - 1)
          ];
        reviewerCalls += 1;
        return { stdout: round, commits: [] };
      }
      return { stdout: "", commits: [] };
    };
    const deps = makeDeps({
      listOpenIssuesWithBodies: readyIssues({
        number: Number(ISSUE.id),
        title: ISSUE.title,
      }),
      run: agentRun as Deps["run"],
      createSandbox: (async () => ({
        run: agentRun,
        branch: ISSUE.branch,
        close: async () => undefined,
        cleanup: async () => undefined,
        worktreePath: undefined,
      })) as unknown as Deps["createSandbox"],
      captureSha: async () => "abc123",
      quarantine: async () => undefined,
      reportStop: (async (
        _n: number,
        r: { label: string; detail: string },
      ) => {
        captured.stops.push({ label: r.label, detail: r.detail });
      }) as unknown as Deps["reportStop"],
    });
    return { deps, captured };
  }

  const SPEC_FIT_FINDING = "- Spec fit: FINDING: the total adds every entry, not one agent's";
  const TEST_FIDELITY_OK = "- Test fidelity: ok";

  const checkWriterSpecs = (c: Captured): string[] =>
    c.specs.filter((n) => n.startsWith("check-writer"));
  const implementerSpecs = (c: Captured): string[] =>
    c.specs.filter((n) => n.startsWith("implementer"));
  const reviewerSpecs = (c: Captured): string[] =>
    c.specs.filter((n) => n.startsWith("reviewer"));

  it("SITE 1 (no-retry): an ordinary refusal stops as stopped:reviewer-refused", async () => {
    git(repo, "checkout", "-q", "-b", BRANCH);
    const { deps, captured } = harness({
      reviewerRounds: [reviewerRefused([SPEC_FIT_FINDING, TEST_FIDELITY_OK])],
    });

    await runMain(
      makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 1, retryEnabled: false }),
      deps,
    );

    // No builder retry was possible, so only the first implementer ran, and
    // no rewrite was bought: the check-writer ran once, before the build.
    expect(implementerSpecs(captured)).toHaveLength(1);
    expect(checkWriterSpecs(captured)).toHaveLength(1);
    const stop = captured.stops.at(-1);
    expect(stop?.label).toBe("stopped:reviewer-refused");
    expect(stop?.detail).not.toContain("judge");
  });

  it("SITE 2 (first refusal): a refusal ALWAYS spends the builder round — nothing withholds it any more", async () => {
    git(repo, "checkout", "-q", "-b", BRANCH);
    const { deps, captured } = harness({
      reviewerRounds: [
        reviewerRefused([SPEC_FIT_FINDING, TEST_FIDELITY_OK]),
        "looks good now\nALL_CLEAR",
      ],
    });

    const result = await runMain(
      makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 1, retryEnabled: true }),
      deps,
    );

    expect(implementerSpecs(captured)).toHaveLength(2);
    expect(captured.stops).toEqual([]);
    expect(result.shippedIssues).toEqual([Number(ISSUE.id)]);
  });

  it("SITE 2 (first refusal): a WRONG-CHECK on a ticket with NO first test of its own buys no rewrite — the builder round is spent instead", async () => {
    git(repo, "checkout", "-q", "-b", BRANCH);
    const { deps, captured } = harness({
      reviewerRounds: [
        reviewerRefused(
          [SPEC_FIT_FINDING, TEST_FIDELITY_OK],
          "GROUNDS: WRONG-CHECK (team.spec.ts: asserts the wrong total)",
        ),
        "looks good now\nALL_CLEAR",
      ],
    });

    await runMain(
      makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 1, retryEnabled: true }),
      deps,
    );

    // The check-writer said NO_SCREEN_APPLIES, so there is no test to
    // rewrite: it ran once, before the build, and never again.
    expect(checkWriterSpecs(captured)).toHaveLength(1);
    expect(implementerSpecs(captured)).toHaveLength(2);
  });

  it("SITE 4 (escalated retry): a recurring finding quarantines as stopped:reviewer-refused", async () => {
    git(repo, "checkout", "-q", "-b", BRANCH);
    const { deps, captured } = harness({
      reviewerRounds: [
        // Round 1: spec-fit FINDING.
        reviewerRefused([SPEC_FIT_FINDING, TEST_FIDELITY_OK]),
        // Round 2: SAME spec-fit FINDING unresolved → no third-attempt grant.
        reviewerRefused([SPEC_FIT_FINDING, TEST_FIDELITY_OK]),
      ],
    });

    await runMain(
      makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 1, retryEnabled: true }),
      deps,
    );

    // The loop spent one builder retry (impl1 + impl2) and two reviews, then
    // quarantined on the escalated-retry path.
    expect(implementerSpecs(captured).length).toBe(2);
    expect(reviewerSpecs(captured).length).toBe(2);
    const stop = captured.stops.at(-1);
    expect(stop?.label).toBe("stopped:reviewer-refused");
  });

  it("SITE 3 (third attempt): a granted third round still refused quarantines as stopped:reviewer-refused", async () => {
    git(repo, "checkout", "-q", "-b", BRANCH);
    const { deps, captured } = harness({
      reviewerRounds: [
        // Round 1: spec-fit FINDING.
        reviewerRefused([SPEC_FIT_FINDING, TEST_FIDELITY_OK]),
        // Round 2: spec-fit RESOLVED, a new test-fidelity FINDING → grant round 3.
        reviewerRefused([
          "- Spec fit: ok",
          "- Test fidelity: FINDING: a new problem the round-1 review did not raise",
        ]),
        // Round 3: still HAS_BLOCKERS → third-attempt quarantine.
        reviewerRefused([
          "- Spec fit: ok",
          "- Test fidelity: FINDING: the new problem is still here",
        ]),
      ],
    });

    await runMain(
      makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 1, retryEnabled: true }),
      deps,
    );

    // Three builder rounds and three reviews — the third-attempt grant fired.
    expect(implementerSpecs(captured).length).toBe(3);
    expect(reviewerSpecs(captured).length).toBe(3);
    const stop = captured.stops.at(-1);
    expect(stop?.label).toBe("stopped:reviewer-refused");
  });
});

// ---------------------------------------------------------------------------
// Issue #1143 (ruling 3 of #1106: "No target, no dispatch") — the target-block
// DISPATCH GATE, driven end-to-end through the REAL runMain → runIssuePipeline.
//
// A server-only ticket (it aims at no screen) whose body carries no target
// block gives the check-writer nothing to aim at: it guesses, writes a check
// that passes against broken code, and the ticket dies at
// stopped:no-failing-check having built nothing — a whole build cycle bought
// for nothing. The guard catches that BEFORE a sandbox is spun up, so no money
// is spent, and routes it to a human (stopped:ticket-unclear).
//
// It must ALSO fail open: when the body could not be read (a gh fetch failure
// degrades ctx.issueBody to undefined) the guard cannot prove a target is
// missing from a body it never saw, so it must NOT stop — the pipeline proceeds
// to createSandbox.
//
// The existing coverage (main.stop-reasons.test.mts, the #1150 NEEDS_HUMAN_SITES
// source scan) only proves the CALL SITE threads its opts; nothing DROVE the
// guard. These two DO, on the same runMain harness the judge-reached tests use.
// ---------------------------------------------------------------------------
describe("runIssuePipeline — the #1143 target-block dispatch gate", () => {
  let repo: string;
  let origin: string;
  const BRANCH = "sandcastle/target-gate-run";

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sc-target-gate-repo-"));
    origin = mkdtempSync(path.join(tmpdir(), "sc-target-gate-origin-"));
    git(origin, "init", "-q", "--bare", "-b", "main");
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
    git(repo, "commit", "--allow-empty", "-q", "-m", "init");
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-q", "origin", "main");
    mkdirSync(path.join(repo, ".sandcastle"), { recursive: true });
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  });

  /**
   * A server-only ticket body with NO target block: no `Screen:` line, none of
   * the three `Call this:` / `Called by:` / `Expect this:` lines, and no
   * `Target:` receipt claiming the subject already exists or naming a screen
   * shape — so `auditServerTarget(...).shouldStop` is true.
   */
  const SERVER_ONLY_NO_TARGET =
    "This ticket does some backend work on the commission service.\n" +
    "It changes how a total is computed. No target block was written.\n";

  /**
   * The two tests use DISTINCT issue numbers on purpose: `pinnedClaimBody`
   * pins a ticket's first-claim body in a module-level map keyed by issue
   * number, so reusing one number would leak the STOP test's body into the
   * fail-open test (which fetches nothing) and make the guard fire on a body it
   * never read.
   */
  function pipelineDeps(
    id: string,
    over: Partial<Deps>,
  ): {
    deps: Deps;
    createSandbox: ReturnType<typeof vi.fn>;
    stops: { label: string; detail: string }[];
  } {
    const issue = { id, title: "server-only, no target", branch: `agent/issue-${id}` };
    const stops: { label: string; detail: string }[] = [];
    const createSandbox = vi.fn(async () => {
      // Throw so the pipeline resolves cleanly instead of running an un-stubbed
      // check-writer. The STOP test proves this is NEVER reached; the fail-open
      // test proves it IS.
      throw new Error("createSandbox reached");
    });
    const deps = makeDeps({
      listOpenIssuesWithBodies: readyIssues({
        number: Number(issue.id),
        title: issue.title,
      }),
      run: async () => ({ stdout: "", commits: [] }),
      createSandbox: createSandbox as unknown as Deps["createSandbox"],
      quarantine: async () => undefined,
      reportStop: (async (
        _n: number,
        r: { label: string; detail: string },
      ) => {
        stops.push({ label: r.label, detail: r.detail });
      }) as unknown as Deps["reportStop"],
      ...over,
    });
    return { deps, createSandbox, stops };
  }

  it("QUARANTINES a server-only ticket with no target block BEFORE any sandbox is created", async () => {
    git(repo, "checkout", "-q", "-b", BRANCH);
    const { deps, createSandbox, stops } = pipelineDeps("1143", {
      getIssueBody: async () => SERVER_ONLY_NO_TARGET,
    });

    const result = await runMain(
      makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 1 }),
      deps,
    );

    // The gate fired before any sandbox was spun up — no money spent.
    expect(createSandbox).not.toHaveBeenCalled();
    // Routed to a human as ticket-unclear, written onto the ticket body.
    expect(stops.at(-1)?.label).toBe("stopped:ticket-unclear");
    // The ticket did stop (quarantined), it was not silently shipped.
    expect(result.quarantinedIssues).toContain(1143);
  });

  it("FAILS OPEN when the body could not be read (a gh fetch failure) — the guard does NOT stop; the pipeline reaches createSandbox", async () => {
    git(repo, "checkout", "-q", "-b", BRANCH);
    const { deps, createSandbox, stops } = pipelineDeps("1144", {
      // A gh fetch failure: the body read throws, so ctx.issueBody is undefined
      // and the guard has no body to prove a missing target from.
      getIssueBody: async () => {
        throw new Error("gh boom — could not read the issue body");
      },
    });

    await runMain(
      makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 1 }),
      deps,
    );

    // The guard let the ticket THROUGH: the pipeline advanced past the
    // target-block guard to createSandbox (which throws its sentinel).
    expect(createSandbox).toHaveBeenCalled();
    // And it did NOT stop as ticket-unclear — any stop here is the downstream
    // sandbox failure, never the target-block guard.
    expect(stops.some((s) => s.label === "stopped:ticket-unclear")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Profile-ladder parity: `resolveRunIdentity` vs `roleModelsFor`.
//
// `lib/telemetry/run-identity.ts` deliberately does NOT import `main.mts` (an
// 8,700-line module; importing it from `lib/` invites a cycle), so its
// `selectProfile` MIRRORS `roleModelsFor`'s branch chain by hand. A mirror with
// nothing comparing the two sides is exactly the bug this whole feature exists
// to detect — `.last-run-mode` claiming `opus-4.8` while `budgetModels` ran —
// recreated one layer down. `run-identity.test.ts` cannot close it: it asserts
// against the `models.js` maps directly and never sees `roleModelsFor`, so a
// precedence change there would leave those tests green while the recorded
// profile silently disagreed with the models actually dispatched.
//
// This file CAN close it: `main.mts`'s CLI entry is guarded by `isMain()`, so
// importing it is side-effect-free, and `roleModelsFor` is already exported.
//
// The load-bearing assertion is the DEEP EQUAL of the resolved map, not the
// label: it catches both a precedence flip and a map swap. The label check is
// the secondary half — it proves the recorded name agrees with which map won.
// ---------------------------------------------------------------------------
describe("run-identity profile ladder mirrors roleModelsFor", () => {
  /** Which map each recorded label is REQUIRED to mean. */
  const MAP_FOR_PROFILE = {
    codex: codexModels,
    budget: budgetModels,
    opus5: opus5Models,
    default: models,
  } as const;

  // Every combination that drives the ladder. `OpusProfile` is `"5.5" | "5"`,
  // so the `"5.5"` rows are what would catch a `!==`-vs-`===` flip on that
  // branch; the `budget: false` rows catch a truthiness-vs-strict divergence.
  const CASES: {
    readonly name: string;
    readonly args: RunIdentityArgs;
    readonly expected: keyof typeof MAP_FOR_PROFILE;
  }[] = [
    { name: "no inputs at all", args: {}, expected: "default" },
    {
      name: "claude backend only",
      args: { backend: "claude" },
      expected: "default",
    },
    {
      name: "codex backend only",
      args: { backend: "codex" },
      expected: "codex",
    },
    { name: "budget only", args: { budget: true }, expected: "budget" },
    {
      name: "budget explicitly false",
      args: { budget: false },
      expected: "default",
    },
    { name: "opus 5 only", args: { opusProfile: "5" }, expected: "opus5" },
    {
      name: "opus 5.5 is NOT opus5",
      args: { opusProfile: "5.5" },
      expected: "default",
    },
    // Precedence pairs — each proves one rung outranks the next.
    {
      name: "codex outranks budget",
      args: { backend: "codex", budget: true },
      expected: "codex",
    },
    {
      name: "codex outranks opus5",
      args: { backend: "codex", opusProfile: "5" },
      expected: "codex",
    },
    {
      name: "codex outranks both",
      args: { backend: "codex", budget: true, opusProfile: "5" },
      expected: "codex",
    },
    {
      name: "budget outranks opus5",
      args: { budget: true, opusProfile: "5" },
      expected: "budget",
    },
    {
      name: "budget false leaves opus5 winning",
      args: { budget: false, opusProfile: "5" },
      expected: "opus5",
    },
    {
      name: "claude backend does not disturb budget",
      args: { backend: "claude", budget: true, opusProfile: "5.5" },
      expected: "budget",
    },
    {
      name: "codex outranks budget even when budget is false",
      args: { backend: "codex", budget: false },
      expected: "codex",
    },
  ];

  it.each(CASES)("$name", ({ args, expected }) => {
    // Reader always throws so the prompt-hash half never touches the real FS;
    // `resolveRunIdentity` is never-throw, so this leaves hashes empty.
    const identity = resolveRunIdentity(args, {
      readFile: () => {
        throw new Error("EACCES");
      },
    });

    // THE assertion: the map recorded in telemetry is the map that would
    // actually be dispatched for these same inputs.
    expect(identity.roleModels).toEqual(roleModelsFor(args));

    // And the label names the map that won, so a snapshot reader can trust it.
    expect(identity.profile).toBe(expected);
    expect(identity.roleModels).toEqual(MAP_FOR_PROFILE[expected]);
  });
});

// ---------------------------------------------------------------------------
// The test-VERIFICATION gate inside `shipAfterMigrations` (main.mts, search
// `verifyTestRun`). This is the highest-value block: it proves the gate is
// wired at the right place (after the `SANDCASTLE-TEST: pass` cert check,
// before migrations/markDone) and behaves per its documented contract —
// only an observed FAIL blocks; inconclusive is logged and ships; the cert
// gates (`dormant`/`missing`) still take precedence and skip `verifyTestRun`
// entirely.
//
// `makeShipCtx` mirrors `main.ship.test.mts`'s helper of the same name (see
// its doc comment there for why ONE ctx builder exists) — kept local here per
// instruction to add this coverage inside `main.test.mts` without touching
// that file.
// ---------------------------------------------------------------------------

describe("shipAfterMigrations: test-VERIFICATION gate", () => {
  let repo: string;

  const commit = (files: Record<string, string>, message: string): string =>
    commitInto(repo, files, message);

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sc-ship-verify-"));
    git(repo, "init", "-q", "-b", "issue-42");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
    commit({ "README.md": "seed\n" }, "init");
    git(repo, "branch", "run");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  /** A ctx wired with a spyable `markDone` and `applyMigrations`, per the
   *  `main.ship.test.mts` `makeShipCtx` pattern, extended with `verifyTestRun`
   *  and the cert deps this gate needs. `stagingEnabled: false` so a real
   *  ship (the "pass"/"pass" and "pass"/"inconclusive" cases) actually
   *  reaches `markDone`, giving the negative assertions ("markDone was NOT
   *  called") something real to distinguish against. */
  function makeVerifyShipCtx(over: {
    checkTestCert: Deps["checkTestCert"];
    verifyTestRun: (
      worktreePath: string,
      changedFiles: readonly string[],
      exec: unknown,
    ) => Promise<{
      status: "pass" | "fail" | "inconclusive" | "dormant";
      reason: string;
    }>;
    logErrors?: string[];
  }): {
    ctx: Parameters<typeof shipAfterMigrations>[0];
    markDoneCalls: unknown[][];
    applyMigrationsCalls: unknown[][];
  } {
    const markDoneCalls: unknown[][] = [];
    const applyMigrationsCalls: unknown[][] = [];
    const ctx = {
      args: {
        repoRoot: repo,
        branch: "run",
        stagingEnabled: false,
      },
      deps: {
        log: (): void => {},
        logError: (line: string): void => {
          over.logErrors?.push(line);
        },
        checkLintCert: async () => ({ status: "dormant" as const }),
        checkTestCert: over.checkTestCert,
        verifyTestRun: over.verifyTestRun,
        validateMigrationJournal: async () => [],
        applyMigrations: async (...args: unknown[]) => {
          applyMigrationsCalls.push(args);
          return { realErrors: [], applied: 0 };
        },
        markDone: async (...args: unknown[]) => {
          markDoneCalls.push(args);
        },
        fenceIssue: async () => true,
        release: async () => {},
      },
      issueNumber: 42,
      issue: { branch: "issue-42" },
      telemetry: {
        noteShipPath: () => {},
        noteDiff: () => {},
        noteImplementerAttempt: () => {},
      },
      runCounters: { bump: () => {} },
    } as unknown as Parameters<typeof shipAfterMigrations>[0];
    return { ctx, markDoneCalls, applyMigrationsCalls };
  }

  it("cert pass + verifyTestRun fail -> REJECTS with test-verify-failed, markDone/applyMigrations never called", async () => {
    const preSha = git(repo, "rev-parse", "HEAD");
    const postSha = commit({ "src/a.ts": "one\n" }, "attempt 1");
    const { ctx, markDoneCalls, applyMigrationsCalls } = makeVerifyShipCtx({
      checkTestCert: async () => ({ status: "pass" }),
      verifyTestRun: async () => ({
        status: "fail",
        reason: "@acme/example: exit 1",
      }),
    });

    await expect(
      shipAfterMigrations(
        ctx,
        {} as never,
        {
          ...SHIP_INPUT_DEFAULTS,
          preSha,
          postSha,
          finalMarker: "ALL_CLEAR",
        },
      ),
    ).rejects.toThrow(/test-verify-failed/);

    expect(markDoneCalls).toEqual([]);
    expect(applyMigrationsCalls).toEqual([]);
  });

  it("cert pass + verifyTestRun inconclusive -> ships normally, logs test-verify-inconclusive", async () => {
    const preSha = git(repo, "rev-parse", "HEAD");
    const postSha = commit({ "src/a.ts": "one\n" }, "attempt 1");
    const logErrors: string[] = [];
    const { ctx, markDoneCalls } = makeVerifyShipCtx({
      checkTestCert: async () => ({ status: "pass" }),
      verifyTestRun: async () => ({
        status: "inconclusive",
        reason: "no workspace packages discovered",
      }),
      logErrors,
    });

    const outcome = await shipAfterMigrations(
      ctx,
      {} as never,
      {
        ...SHIP_INPUT_DEFAULTS,
        preSha,
        postSha,
        finalMarker: "ALL_CLEAR",
      },
    );

    expect(outcome.status).toBe("ok");
    expect(markDoneCalls).toHaveLength(1);
    expect(
      logErrors.some((l) => l.includes("test-verify-inconclusive")),
    ).toBe(true);
  });

  // The specific case `verifyTestRun`'s own production impl reports when the
  // ship-diff came back with zero changed paths (git hiccup or a genuinely
  // empty diff — the two are indistinguishable, see that function's doc
  // comment): the gate still treats this "empty changedFiles" flavor of
  // inconclusive exactly like any other — it ships, it does not quarantine —
  // and still logs so a human can see the gate could not verify anything.
  // This only exercises the GATE's reaction to a mocked `verifyTestRun`; it
  // is not a test of the production `verifyTestRun` itself.
  it("cert pass + verifyTestRun inconclusive because changedFiles was empty -> still SHIPS, logs test-verify-inconclusive", async () => {
    const preSha = git(repo, "rev-parse", "HEAD");
    const postSha = commit({ "src/a.ts": "one\n" }, "attempt 1");
    const logErrors: string[] = [];
    const { ctx, markDoneCalls } = makeVerifyShipCtx({
      checkTestCert: async () => ({ status: "pass" }),
      verifyTestRun: async () => ({
        status: "inconclusive",
        reason: "no changed paths to scope the run to (diff unavailable)",
      }),
      logErrors,
    });

    const outcome = await shipAfterMigrations(
      ctx,
      {} as never,
      {
        ...SHIP_INPUT_DEFAULTS,
        preSha,
        postSha,
        finalMarker: "ALL_CLEAR",
      },
    );

    expect(outcome.status).toBe("ok");
    expect(markDoneCalls).toHaveLength(1);
    expect(
      logErrors.some((l) => l.includes("test-verify-inconclusive")),
    ).toBe(true);
  });

  it("cert pass + verifyTestRun pass -> ships, no logError", async () => {
    const preSha = git(repo, "rev-parse", "HEAD");
    const postSha = commit({ "src/a.ts": "one\n" }, "attempt 1");
    const logErrors: string[] = [];
    const { ctx, markDoneCalls } = makeVerifyShipCtx({
      checkTestCert: async () => ({ status: "pass" }),
      verifyTestRun: async () => ({
        status: "pass",
        reason: "all packages passed",
      }),
      logErrors,
    });

    const outcome = await shipAfterMigrations(
      ctx,
      {} as never,
      {
        ...SHIP_INPUT_DEFAULTS,
        preSha,
        postSha,
        finalMarker: "ALL_CLEAR",
      },
    );

    expect(outcome.status).toBe("ok");
    expect(markDoneCalls).toHaveLength(1);
    expect(logErrors).toEqual([]);
  });

  it("cert dormant -> verifyTestRun is NEVER called", async () => {
    const preSha = git(repo, "rev-parse", "HEAD");
    const postSha = commit({ "src/a.ts": "one\n" }, "attempt 1");
    const { ctx, markDoneCalls } = makeVerifyShipCtx({
      checkTestCert: async () => ({ status: "dormant" }),
      verifyTestRun: async () => {
        throw new Error("verifyTestRun must not be called when cert is dormant");
      },
    });

    const outcome = await shipAfterMigrations(
      ctx,
      {} as never,
      {
        ...SHIP_INPUT_DEFAULTS,
        preSha,
        postSha,
        finalMarker: "ALL_CLEAR",
      },
    );

    expect(outcome.status).toBe("ok");
    expect(markDoneCalls).toHaveLength(1);
  });

  it("cert missing -> still throws test-cert-missing, verifyTestRun never called (pre-existing gate wins first)", async () => {
    const preSha = git(repo, "rev-parse", "HEAD");
    const postSha = commit({ "src/a.ts": "one\n" }, "attempt 1");
    const { ctx, markDoneCalls } = makeVerifyShipCtx({
      checkTestCert: async () => ({ status: "missing" }),
      verifyTestRun: async () => {
        throw new Error("verifyTestRun must not be called when cert is missing");
      },
    });

    await expect(
      shipAfterMigrations(
        ctx,
        {} as never,
        {
          ...SHIP_INPUT_DEFAULTS,
          preSha,
          postSha,
          finalMarker: "ALL_CLEAR",
        },
      ),
    ).rejects.toThrow(/test-cert-missing/);

    expect(markDoneCalls).toEqual([]);
  });

  it("verifyTestRun receives the ship-diff's changed file paths and sandbox.worktreePath", async () => {
    const preSha = git(repo, "rev-parse", "HEAD");
    const postSha = commit({ "src/a.ts": "one\n" }, "attempt 1");
    const received: { worktreePath: string; changedFiles: readonly string[] }[] =
      [];
    const { ctx } = makeVerifyShipCtx({
      checkTestCert: async () => ({ status: "pass" }),
      verifyTestRun: async (worktreePath, changedFiles) => {
        received.push({ worktreePath, changedFiles });
        return { status: "pass", reason: "ok" };
      },
    });

    await shipAfterMigrations(
      ctx,
      { worktreePath: "/fake/worktree/for-issue-42" } as never,
      {
        ...SHIP_INPUT_DEFAULTS,
        preSha,
        postSha,
        finalMarker: "ALL_CLEAR",
      },
    );

    expect(received).toHaveLength(1);
    expect(received[0].worktreePath).toBe("/fake/worktree/for-issue-42");
    expect(received[0].changedFiles).toContain("src/a.ts");
  });

  // The whole point of the rework: the gate must hand the verifier the
  // SANDBOX's exec, because that is the only environment where the shipped
  // code's dependencies are installed. If this ever regresses to passing
  // nothing, the gate silently degrades to permanently-inconclusive — which
  // never blocks, so nothing else would notice.
  it("passes the sandbox's own exec through, usable detached from the handle", async () => {
    const preSha = git(repo, "rev-parse", "HEAD");
    const postSha = commit({ "src/a.ts": "one\n" }, "attempt 1");
    const received: unknown[] = [];
    const { ctx } = makeVerifyShipCtx({
      checkTestCert: async () => ({ status: "pass" }),
      verifyTestRun: async (_wt, _files, exec) => {
        received.push(exec);
        return { status: "pass", reason: "ok" };
      },
    });
    // A standalone function, matching the `SandboxCommandRunner` field the
    // handle types declare — nothing here may depend on `this`, which is what
    // makes forwarding it detached safe.
    const theExec = (): Promise<{ marker: string }> =>
      Promise.resolve({ marker: "the-real-sandbox" });
    const sandbox = { worktreePath: "/fake/worktree/for-issue-42", exec: theExec };

    await shipAfterMigrations(
      ctx,
      sandbox as never,
      {
        ...SHIP_INPUT_DEFAULTS,
        preSha,
        postSha,
        finalMarker: "ALL_CLEAR",
      },
    );

    expect(received).toHaveLength(1);
    // Identity, not just "a function": proves the gate forwards THE sandbox's
    // exec rather than some wrapper that could quietly drop the timeout or
    // swallow a rejection.
    expect(received[0]).toBe(theExec);
    await expect(
      (received[0] as () => Promise<{ marker: string }>)(),
    ).resolves.toEqual({ marker: "the-real-sandbox" });
  });

  it("a sandbox with no exec passes undefined — the verifier decides, not the gate", async () => {
    const preSha = git(repo, "rev-parse", "HEAD");
    const postSha = commit({ "src/a.ts": "one\n" }, "attempt 1");
    const received: unknown[] = [];
    const { ctx } = makeVerifyShipCtx({
      checkTestCert: async () => ({ status: "pass" }),
      verifyTestRun: async (_wt, _files, exec) => {
        received.push(exec);
        return { status: "inconclusive", reason: "no exec" };
      },
    });

    const outcome = await shipAfterMigrations(
      ctx,
      { worktreePath: "/fake/worktree/for-issue-42" } as never,
      {
        ...SHIP_INPUT_DEFAULTS,
        preSha,
        postSha,
        finalMarker: "ALL_CLEAR",
      },
    );

    expect(received).toEqual([undefined]);
    // Inconclusive still ships — it is a report, not a gate.
    expect(outcome.status).toBe("ok");
  });

  // -------------------------------------------------------------------------
  // The FREE pre-filter that runs ahead of `verifyTestRun`: read the agent's
  // own session log (`<repoRoot>/.sandcastle/logs/<branch>-<role>.log`, which
  // the sandcastle SDK writes) and reject, with no container work at all, the
  // one blatant case — a `SANDCASTLE-TEST: pass` cert on a run whose log shows
  // no test command was ever invoked.
  //
  // The load-bearing property under test is the ASYMMETRY: the filter may
  // reject, but may never approve. Every non-rejection below is asserted by
  // showing `verifyTestRun` still ran — a good-looking log must NOT let a
  // ticket ship on the log alone.
  // -------------------------------------------------------------------------
  describe("agent-log pre-filter", () => {
    /** Write a log where the SDK writes it, for the ctx's branch `issue-42`. */
    const writeLog = (role: string, text: string): void => {
      const dir = path.join(repo, ".sandcastle", "logs");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, `issue-42-${role}.log`), text);
    };

    const RUN_HEADER = "\n--- Run started: 2026-08-02T00:00:00.000Z ---\n";

    /** Ships a code diff with a passing cert; reports whether the real
     *  verification ran, so each case can assert fall-through vs short-circuit. */
    async function shipWithPrefilter(): Promise<{
      verifyCalls: number;
      outcome: Awaited<ReturnType<typeof shipAfterMigrations>> | "threw";
      error?: unknown;
    }> {
      const preSha = git(repo, "rev-parse", "HEAD");
      const postSha = commit({ "src/a.ts": "one\n" }, "attempt 1");
      let verifyCalls = 0;
      const { ctx } = makeVerifyShipCtx({
        checkTestCert: async () => ({ status: "pass" }),
        verifyTestRun: async () => {
          verifyCalls += 1;
          return { status: "pass", reason: "ok" };
        },
      });
      try {
        const outcome = await shipAfterMigrations(
          ctx,
          { worktreePath: "/fake/worktree/for-issue-42" } as never,
          {
            ...SHIP_INPUT_DEFAULTS,
            preSha,
            postSha,
            finalMarker: "ALL_CLEAR",
          },
        );
        return { verifyCalls, outcome };
      } catch (error) {
        return { verifyCalls, outcome: "threw", error };
      }
    }

    it("log shows a test command -> NOT a rejection, and does NOT skip the real run", async () => {
      writeLog(
        "implementer",
        `${RUN_HEADER}Bash(pnpm --filter @acme/validators run test)\n116 passed\n`,
      );

      const { verifyCalls, outcome } = await shipWithPrefilter();

      // The whole asymmetry in one assertion: a clean-looking log buys the
      // ticket nothing. The container run still happens.
      expect(verifyCalls).toBe(1);
      expect(outcome === "threw" ? "threw" : outcome.status).toBe("ok");
    });

    it("log shows NO test command -> REJECTS before any container work", async () => {
      writeLog(
        "implementer",
        `${RUN_HEADER}Bash(git status --short)\nBash(cat packages/db/src/schema.ts)\n<promise>COMPLETE</promise>\n`,
      );

      const { verifyCalls, outcome, error } = await shipWithPrefilter();

      expect(outcome).toBe("threw");
      expect((error as Error).message).toMatch(/test-verify-uninvoked/);
      // Phrased for the human reading the quarantine: the agent said tests
      // passed, its own log shows no test command.
      expect((error as Error).message).toMatch(/no test command at all/);
      // Short-circuit: the expensive path was never entered.
      expect(verifyCalls).toBe(0);
    });

    it("empty log -> inconclusive, falls through to the real run", async () => {
      writeLog("implementer", "");

      const { verifyCalls } = await shipWithPrefilter();

      expect(verifyCalls).toBe(1);
    });

    it("no log file at all -> inconclusive, falls through to the real run", async () => {
      // Nothing written: `.sandcastle/logs/` does not even exist in this repo.
      const { verifyCalls } = await shipWithPrefilter();

      expect(verifyCalls).toBe(1);
    });

    it("log in an unrecognized format -> inconclusive, falls through to the real run", async () => {
      // No `--- Run started:` header, so we cannot claim to have read a real
      // run. An unparsed log is not an empty one — ABSENT ≠ ZERO.
      writeLog("implementer", '{"jsonl":"some other tool wrote this"}\n');

      const { verifyCalls } = await shipWithPrefilter();

      expect(verifyCalls).toBe(1);
    });

    it("rejection needs unanimity — one sibling log with a test command spares the ticket", async () => {
      writeLog("implementer", `${RUN_HEADER}Bash(git status --short)\n`);
      writeLog("reviewer", `${RUN_HEADER}Bash(pnpm turbo run test)\n`);

      const { verifyCalls } = await shipWithPrefilter();

      // Tests demonstrably WERE invoked on this branch, so "no test command
      // was ever run" would be a false sentence. Never reject on it.
      expect(verifyCalls).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// The sandbox must never be handed the project's PRODUCTION database.
// `readProjectEnv` deliberately forwards the target repo's `.env` (dev server
// + playwright need those creds), but that file carries the live Supabase
// POSTGRES_URL — so every container was starting with prod, and the repo's
// own `assertNotProdDb` guard then refused to run any suite that connects.
// `sandboxTestDbEnv` is the override that is spread OVER the project env at
// the call site, covering both the docker `-e` environment and the literal
// `.env` the boot hook writes inside the container.
// ---------------------------------------------------------------------------
describe("sandboxTestDbEnv", () => {
  it("dials the host, not the container's own localhost, under docker on mac", () => {
    // `localhost` inside a container is the container; the disposable test
    // Postgres is published on the HOST (scripts/test-db.sh -p 55432:5432).
    const url = "postgres://postgres:postgres@host.docker.internal:55432/postgres";
    expect(sandboxTestDbEnv("docker", {}, "darwin")).toEqual({
      POSTGRES_URL: url,
      DATABASE_URL: url,
      SUPABASE_SERVICE_ROLE_KEY: "",
      SANDCASTLE_DEV_HOST: "",
      SANDCASTLE_SHARED_HOST: "",
    });
  });

  it("uses plain localhost on the mac-host provider — there is no container", () => {
    // lib/mac-host-sandbox.ts spawns the agent natively on the host and
    // spreads this env into it, where `host.docker.internal` does not resolve.
    expect(sandboxTestDbEnv("mac-host", {}, "darwin").POSTGRES_URL).toContain(
      "@localhost:55432/",
    );
    expect(sandboxTestDbHost("mac-host", "linux")).toBe("localhost");
  });

  it("uses the default bridge gateway for docker on linux", () => {
    // Docker Engine on Linux has no `host.docker.internal` and the sandbox SDK
    // passes no --add-host, so the container must dial the bridge gateway.
    expect(sandboxTestDbHost("docker", "linux")).toBe("172.17.0.1");
    expect(sandboxTestDbEnv("docker", {}, "linux").POSTGRES_URL).toContain(
      "@172.17.0.1:55432/",
    );
  });

  it("honours SANDCASTLE_TEST_PG_PORT like scripts/test-db.sh does", () => {
    expect(
      sandboxTestDbEnv("docker", { SANDCASTLE_TEST_PG_PORT: "55999" }, "darwin")
        .POSTGRES_URL,
    ).toContain(":55999/");
  });

  it("overrides a project .env prod URL when spread over it", () => {
    const projectEnv = {
      POSTGRES_URL:
        "postgresql://u:p@aws-1-us-east-1.pooler.supabase.com:6543/postgres",
      DATABASE_URL: "postgresql://u:p@db.abc.supabase.co:5432/postgres",
      GEMINI_API_KEY: "keep-me",
    };
    const merged = {
      ...projectEnv,
      ...sandboxTestDbEnv("docker", {}, "darwin"),
    };

    expect(merged.POSTGRES_URL).not.toContain("supabase");
    expect(merged.DATABASE_URL).not.toContain("supabase");
    expect(merged.POSTGRES_URL).toBe(merged.DATABASE_URL);
    // Every OTHER project credential still reaches the sandbox unchanged —
    // see the next test for the ONE deliberate exception
    // (SUPABASE_SERVICE_ROLE_KEY, review finding #8).
    expect(merged.GEMINI_API_KEY).toBe("keep-me");
  });

  // Review finding #8 (SECURITY, 2026-08-04): before this, the sandbox's
  // Postgres was disposable but `SUPABASE_SERVICE_ROLE_KEY` still forwarded
  // the owner's REAL Supabase Storage credential verbatim — a token that
  // bypasses row-level security and authenticates to real customer
  // documents, independent of which database the app's rows live in. This
  // design boots a real server and signs a real browser into it on EVERY
  // ticket, so any check touching a document/client-portal screen reached
  // real storage with that key. Proven red against the pre-fix function
  // before the fix landed (the assertion below fails on the OLD
  // `sandboxTestDbEnv`, which returns only POSTGRES_URL/DATABASE_URL and
  // therefore leaves the real key sitting in `projectEnv` untouched).
  it("blanks SUPABASE_SERVICE_ROLE_KEY — the sandbox has no legitimate need for the owner's real storage credential", () => {
    const projectEnv = {
      POSTGRES_URL: "postgresql://u:p@db.abc.supabase.co:5432/postgres",
      DATABASE_URL: "postgresql://u:p@db.abc.supabase.co:5432/postgres",
      SUPABASE_SERVICE_ROLE_KEY: "eyJ-real-service-role-key-do-not-leak",
      // Not stripped — same reasoning as GEMINI_API_KEY above: the URL
      // alone (no key) can't authenticate to anything privileged, and other
      // code legitimately reads it.
      NEXT_PUBLIC_SUPABASE_URL: "https://realproject.supabase.co",
    };
    const merged = {
      ...projectEnv,
      ...sandboxTestDbEnv("docker", {}, "darwin"),
    };

    expect(merged.SUPABASE_SERVICE_ROLE_KEY).toBe("");
    expect(merged.NEXT_PUBLIC_SUPABASE_URL).toBe(
      "https://realproject.supabase.co",
    );
  });

  // INCIDENTS: sandbox-dev-host-bind (2026-08-28). The VPS repo `.env` set
  // SANDCASTLE_DEV_HOST to the host's own Tailscale IP so a human could reach the
  // dev server from another device. Copied into the check sandbox, that address
  // has no interface in the sandbox's network namespace, so the sandbox
  // `next dev -H <it>` failed with EADDRNOTAVAIL and
  // `apps/nextjs/playwright.config.ts` resolved it into an unreachable
  // `baseURL` — every browser check graded nothing and the ticket died
  // `stopped:no-failing-check`. Proven red against the pre-fix function, which
  // returned only the DB keys + service role and left these two host vars
  // sitting in `projectEnv` untouched.
  it("blanks SANDCASTLE_DEV_HOST / SANDCASTLE_SHARED_HOST — a host bind address has no interface inside the sandbox", () => {
    const projectEnv = {
      SANDCASTLE_DEV_HOST: "100.79.86.27",
      SANDCASTLE_SHARED_HOST: "1",
      GEMINI_API_KEY: "keep-me",
    };
    const merged = {
      ...projectEnv,
      ...sandboxTestDbEnv("docker", {}, "darwin"),
    };

    expect(merged.SANDCASTLE_DEV_HOST).toBe("");
    expect(merged.SANDCASTLE_SHARED_HOST).toBe("");
    // Not a blanket purge — an ordinary project value still reaches the sandbox.
    expect(merged.GEMINI_API_KEY).toBe("keep-me");
  });

  it("NO testDatabase and no SANDCASTLE_TEST_DB_URL (the default): blanks the project's database URLs so a real database never reaches the unattended sandbox", () => {
    expect(sandboxTestDbEnv("docker", {}, "linux", defaultProjectConfig())).toEqual({
      POSTGRES_URL: "",
      DATABASE_URL: "",
      SUPABASE_SERVICE_ROLE_KEY: "",
      SANDCASTLE_DEV_HOST: "",
      SANDCASTLE_SHARED_HOST: "",
    });
  });

  it("honours an operator-set SANDCASTLE_TEST_DB_URL even with no testDatabase configured", () => {
    const url = "postgres://postgres:postgres@10.0.0.5:55432/postgres";
    expect(
      sandboxTestDbEnv("docker", { SANDCASTLE_TEST_DB_URL: url }, "linux", defaultProjectConfig()),
    ).toMatchObject({ POSTGRES_URL: url, DATABASE_URL: url });
  });

  it("honours an operator-set SANDCASTLE_TEST_DB_URL", () => {
    const url = "postgres://postgres:postgres@10.0.0.5:55432/postgres";
    expect(sandboxTestDbEnv("docker", { SANDCASTLE_TEST_DB_URL: url })).toEqual({
      POSTGRES_URL: url,
      DATABASE_URL: url,
      SUPABASE_SERVICE_ROLE_KEY: "",
      SANDCASTLE_DEV_HOST: "",
      SANDCASTLE_SHARED_HOST: "",
    });
  });

  it("refuses to let the escape hatch smuggle prod back in", () => {
    expect(() =>
      sandboxTestDbEnv("docker", {
        SANDCASTLE_TEST_DB_URL:
          "postgresql://u:p@db.abc.supabase.co:5432/postgres",
      }),
    ).toThrow(/Supabase-hosted DB/);
  });
});

// ---------------------------------------------------------------------------
// Boot preflight check #7 — the test database (opt-in: `testDatabase` in
// .sandcastle/project.json).
//
// Off by default: a project that has not named a template database needs no
// `psql` and no Postgres. When it is on, a host missing `psql`, a server that
// is down, or a missing template database is refused ONCE at launch instead of
// quarantining every ticket in the queue after a builder has burned tokens.
// ---------------------------------------------------------------------------
describe("preflight: the test database (check #7)", () => {
  const WITH_TEST_DB = {
    ...defaultProjectConfig(),
    testDatabase: { templateDb: "app_test_template" },
  };

  /** Every other check green, so only #7's verdict shows up in `errors`. */
  function preflightWith(
    opts: Parameters<typeof preflight>[1] = {},
    overrides: Partial<SandcastleArgs> = {},
  ) {
    const args = makeArgs({ sandbox: "mac-host", ...overrides });
    return preflight(args, {
      // symbolic-ref must echo --branch (check #9); everything else only cares
      // about the exit status.
      exec: (bin, a) =>
        a.includes("symbolic-ref")
          ? { ok: true, stdout: `${args.branch}\n` }
          : { ok: true },
      fileExists: () => true,
      getEnv: () => undefined,
      projectConfig: WITH_TEST_DB,
      probeTemplateExists: () => ({ ok: true, stdout: "1" }),
      ...opts,
    });
  }

  const noPsql: NonNullable<Parameters<typeof preflight>[1]>["exec"] = (
    bin,
    a,
  ) => {
    if (a.includes("symbolic-ref")) return { ok: true, stdout: `${makeArgs().branch}\n` };
    if (a.some((x) => x.includes("command -v psql"))) return { ok: false };
    return { ok: true };
  };

  it("passes when psql is present and the template exists", () => {
    const res = preflightWith();
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it("NO testDatabase (the default): does not require psql and probes nothing", () => {
    const res = preflightWith({
      projectConfig: defaultProjectConfig(),
      exec: (bin, a) => {
        if (a.includes("symbolic-ref")) return { ok: true, stdout: `${makeArgs().branch}\n` };
        if (a.some((x) => x.includes("psql"))) {
          throw new Error(
            "must not look for psql when no test database is configured",
          );
        }
        return { ok: true };
      },
      probeTemplateExists: () => {
        throw new Error("must not probe when no test database is configured");
      },
    });
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it("PROVES THE INSTRUMENT: refuses launch when psql is missing from PATH", () => {
    const res = preflightWith({ exec: noPsql });
    expect(res.ok).toBe(false);
    expect(res.errors.join("\n")).toMatch(/psql not found on PATH/);
    expect(res.errors.join("\n")).toMatch(/clones its own database/);
    expect(res.errors.join("\n")).toContain("app_test_template");
  });

  it("refuses launch when the template database does not exist", () => {
    const res = preflightWith({
      probeTemplateExists: () => ({ ok: true, stdout: "" }), // connects fine, zero rows
    });
    expect(res.ok).toBe(false);
    const msg = res.errors.join("\n");
    expect(msg).toMatch(/does not exist/);
    expect(msg).toContain("app_test_template");
    // host:port, never the full URL — the escape hatch may carry a password.
    expect(msg).toContain("localhost:55432");
    expect(msg).not.toContain("postgres:postgres@");
  });

  it("refuses launch when the server is unreachable", () => {
    const res = preflightWith({
      probeTemplateExists: () => ({
        ok: false,
        stderr: "could not connect to server",
      }),
    });
    expect(res.ok).toBe(false);
    expect(res.errors.join("\n")).toMatch(/could not probe/);
    expect(res.errors.join("\n")).toContain("could not connect to server");
  });

  it("probes the URL testDbAdminUrl() resolves, not an ambient one", () => {
    const seen: string[] = [];
    preflightWith({
      getEnv: (k) => (k === "SANDCASTLE_TEST_PG_PORT" ? "55999" : undefined),
      probeTemplateExists: (url, templateDb) => {
        seen.push(`${url} ${templateDb}`);
        return { ok: true, stdout: "1" };
      },
    });
    expect(seen).toEqual([
      "postgres://postgres:postgres@localhost:55999/postgres app_test_template",
    ]);
  });

  it("surfaces a target that points at the shared 5432 port at LAUNCH, not at iteration N", () => {
    const res = preflightWith({
      getEnv: (k) => (k === "SANDCASTLE_TEST_PG_PORT" ? "5432" : undefined),
      probeTemplateExists: () => {
        throw new Error("must not probe an unresolved target");
      },
    });
    expect(res.ok).toBe(false);
    expect(res.errors.join("\n")).toMatch(
      /cannot resolve the admin database target/,
    );
    expect(res.errors.join("\n")).toMatch(/localhost:5432/);
  });

  it("no longer fails merely because DATABASE_URL/POSTGRES_URL are unset", () => {
    const res = preflightWith();
    expect(res.ok).toBe(true);
    expect(res.errors.join("\n")).not.toMatch(/DATABASE_URL|POSTGRES_URL/);
  });

  it("is skipped entirely under the SANDCASTLE_TEST_DB_URL escape hatch — matches createSandboxRaw's own runtime skip condition exactly", () => {
    const res = preflightWith({
      getEnv: (k) =>
        k === "SANDCASTLE_TEST_DB_URL" ? "postgres://escape/hatch" : undefined,
      exec: noPsql,
      probeTemplateExists: () => {
        throw new Error(
          "must not probe — the escape hatch skips cloning entirely",
        );
      },
    });
    expect(res.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Boot preflight check #7d — the SANDBOX's own view of the test database.
//
// 2026-08-05, live: the host firewall dropped the docker bridge. Every
// host-side probe above (#7, #7b, #7c) stayed green — they dial `localhost`,
// and the database really was up. The CONTAINER reaches the same database
// over a different path (`172.17.0.1` / `host.docker.internal`), and that path
// was dead. The loop started anyway, dispatched four issues, and each one
// spent ~19 minutes in Playwright's globalSetup dying with `write
// CONNECT_TIMEOUT 172.17.0.1:55432` before being quarantined
// `stopped:no-failing-check`. ~43 issues were queued behind them.
//
// One container start and one TCP handshake, once, answers that.
// ---------------------------------------------------------------------------
describe("preflight: the sandbox's own view of the test database (check #7d)", () => {
  /** Every other check green, docker provider, so only #7d's verdict shows. */
  function preflightWith(
    opts: Parameters<typeof preflight>[1] = {},
    overrides: Partial<SandcastleArgs> = {},
  ) {
    const args = makeArgs({
      sandbox: "docker",
      imageName: "sandcastle:test",
      ...overrides,
    });
    return preflight(args, {
      exec: (bin, a) =>
        a.includes("symbolic-ref")
          ? { ok: true, stdout: `${args.branch}\n` }
          : { ok: true },
      fileExists: () => true,
      getEnv: () => undefined,
      probeTemplateExists: () => ({ ok: true, stdout: "1" }),
      probeSandboxDb: () => ({ ok: true }),
      ...opts,
    });
  }

  it("passes when a container off the run's image can reach the database", () => {
    const res = preflightWith();
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it("REPRODUCES 2026-08-05: refuses launch when the container cannot reach it, naming the address and the likely cause", () => {
    const res = preflightWith({
      probeSandboxDb: () => ({
        ok: false,
        stderr: "TCP connect to host.docker.internal:55432 timed out after 5000ms",
      }),
    });
    expect(res.ok).toBe(false);
    const msg = res.errors.join("\n");
    expect(msg).toMatch(/sandbox cannot reach the test database at/);
    expect(msg).toContain(":55432");
    // Plain English about WHERE the fault is, so it is not confused with the
    // host-side probes that just passed.
    expect(msg).toMatch(/firewall/);
    // #1198 second review, F4: the cost this names is the CURRENT one. A dead
    // sandbox database no longer quarantines a ticket early — it falls
    // through the check-writer stage and buys a full builder and reviewer
    // pass it cannot prove anything with. Naming the retired
    // `stopped:no-failing-check` label here would send the owner looking for
    // quarantines that will never appear.
    expect(msg).not.toMatch(/stopped:no-failing-check/);
    expect(msg).toMatch(/shipped-without-first-test/);
    // The probe's own words survive.
    expect(msg).toContain("timed out after 5000ms");
  });

  it("probes the address the SANDBOX is given, not the host-side one — the whole point", () => {
    const seen: { image: string; host: string; port: string }[] = [];
    preflightWith(
      {
        probeSandboxDb: (image, host, port) => {
          seen.push({ image, host, port });
          return { ok: true };
        },
      },
      { imageName: "sandcastle:my-project" },
    );
    expect(seen.length).toBe(1);
    // `sandboxTestDbHost` — never `localhost`, which is what every other
    // probe here dials and is precisely why they all stayed green that night.
    expect(seen[0]!.host).not.toBe("localhost");
    expect(seen[0]!.host).toBe(
      process.platform === "linux" ? "172.17.0.1" : "host.docker.internal",
    );
    expect(seen[0]!.port).toBe("55432");
    // The RUN's image, so the probe boots the same container the loop will.
    expect(seen[0]!.image).toBe("sandcastle:my-project");
  });

  it("honours SANDCASTLE_TEST_PG_PORT and the SANDCASTLE_TEST_DB_URL escape hatch", () => {
    const seen: string[] = [];
    preflightWith({
      getEnv: (k) => (k === "SANDCASTLE_TEST_PG_PORT" ? "55999" : undefined),
      probeSandboxDb: (_i, host, port) => {
        seen.push(`${host}:${port}`);
        return { ok: true };
      },
    });
    expect(seen[0]).toMatch(/:55999$/);

    const hatch: string[] = [];
    preflightWith({
      getEnv: (k) =>
        k === "SANDCASTLE_TEST_DB_URL"
          ? "postgres://postgres:postgres@10.0.0.5:6543/postgres"
          : undefined,
      probeSandboxDb: (_i, host, port) => {
        hatch.push(`${host}:${port}`);
        return { ok: true };
      },
    });
    expect(hatch).toEqual(["10.0.0.5:6543"]);
  });

  it("says nothing on --sandbox mac-host — that path has no container, and check #7 already dialled its localhost", () => {
    const res = preflightWith(
      {
        probeSandboxDb: () => {
          throw new Error("must not probe — mac-host runs no container");
        },
      },
      { sandbox: "mac-host" },
    );
    expect(res.errors).toEqual([]);
  });

  it("DEGRADES: a stopped docker daemon reports ITS own error, and #7d stays silent", () => {
    const res = preflightWith({
      exec: (bin, a) => {
        if (a.includes("symbolic-ref")) return { ok: true, stdout: "run\n" };
        if (bin === "docker" && a[0] === "info") {
          return { ok: false, stderr: "Cannot connect to the Docker daemon" };
        }
        return { ok: true };
      },
      probeSandboxDb: () => {
        throw new Error("must not probe — no runnable container exists");
      },
    });
    expect(res.ok).toBe(false);
    const msg = res.errors.join("\n");
    expect(msg).toMatch(/docker info failed/);
    expect(msg).not.toMatch(/cannot reach the test database/);
  });

  it("DEGRADES: a missing sandbox image reports ITS own error, and #7d stays silent", () => {
    const res = preflightWith({
      exec: (bin, a) => {
        if (a.includes("symbolic-ref")) return { ok: true, stdout: "run\n" };
        if (bin === "docker" && a[0] === "image") return { ok: false };
        return { ok: true };
      },
      probeSandboxDb: () => {
        throw new Error("must not probe — the image does not exist locally");
      },
    });
    expect(res.ok).toBe(false);
    const msg = res.errors.join("\n");
    expect(msg).toMatch(/not found locally/);
    expect(msg).not.toMatch(/cannot reach the test database/);
  });

  it("is skippable with --allow-unreachable-sandbox-db, the same escape hatch shape as check #8", () => {
    const res = preflightWith(
      {
        probeSandboxDb: () => {
          throw new Error("must not probe — the operator opted out");
        },
      },
      { allowUnreachableSandboxDb: true },
    );
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // The probe PAYLOAD itself. It is a string of JavaScript, so nothing
  // typechecks it: a syntax error would make every container exit non-zero
  // with a SyntaxError, which check #7d would faithfully report as "the
  // sandbox cannot reach the test database" — a preflight that refuses every
  // launch for a fault that does not exist. Run it for real, against a real
  // socket, in a real `node -e`.
  // -------------------------------------------------------------------------
  describe("the in-container TCP probe script", () => {
    /** Run the real script the way the real probe does. */
    function runProbe(
      host: string,
      port: string,
    ): { exitCode: number; stderr: string } {
      try {
        execFileSync(
          process.execPath,
          ["-e", SANDBOX_DB_TCP_PROBE_SCRIPT, host, port],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 },
        );
        return { exitCode: 0, stderr: "" };
      } catch (err) {
        const e = err as { status?: number; stderr?: string; message?: string };
        return {
          exitCode: e.status ?? 1,
          stderr: String(e.stderr ?? e.message ?? ""),
        };
      }
    }

    it("PROVES THE INSTRUMENT: exits 0 against a socket that is actually listening", async () => {
      const server = createServer();
      const port = await new Promise<number>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          resolve((server.address() as { port: number }).port);
        });
      });
      try {
        const res = runProbe("127.0.0.1", String(port));
        // A SyntaxError would ALSO be a non-zero exit — this is the assertion
        // that proves the script parses and runs, not just that it exits.
        expect(res.stderr).not.toMatch(/SyntaxError/);
        expect(res.exitCode).toBe(0);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("exits non-zero and NAMES the address when nothing is listening", () => {
      // Port 1 on loopback: refused immediately, no waiting.
      const res = runProbe("127.0.0.1", "1");
      expect(res.exitCode).not.toBe(0);
      expect(res.stderr).not.toMatch(/SyntaxError/);
      expect(res.stderr).toContain("127.0.0.1:1");
      expect(res.stderr).toMatch(/TCP connect to .* failed/);
    });
  });

  it("refuses launch when the sandbox's own database URL cannot be resolved at all", () => {
    const res = preflightWith({
      getEnv: (k) =>
        k === "SANDCASTLE_TEST_DB_URL"
          ? "postgres://user@db.abcdefgh.supabase.co:5432/postgres"
          : undefined,
      probeSandboxDb: () => {
        throw new Error("must not probe an unresolved target");
      },
    });
    expect(res.ok).toBe(false);
    expect(res.errors.join("\n")).toMatch(
      /cannot resolve the database address the sandbox will be given/,
    );
  });
});

// ---------------------------------------------------------------------------
// Boot preflight check #7f (Fix G) — the SANDBOX's own DEV SERVER BIND.
//
// F12, 2026-08-28: the VPS repo-root `.env` set `SANDCASTLE_DEV_HOST` to the
// host's own Tailscale IP. That `.env` is copied into every check sandbox,
// where that address has no interface, so `next dev -H <it>` died with
// EADDRNOTAVAIL. The dev server never served, every browser/screen ticket
// graded 0/0/0, and all seven were quarantined `stopped:no-failing-check`.
// Fix F blanked the two host vars; Fix G is the systemic backstop that catches
// ANY future regression re-handing the sandbox an unbindable address — ONCE,
// before a ticket is dispatched.
//
// The abort bar is deliberately high (a misfiring run-aborting guard would
// kill healthy nights): only a HARD bind error REPRODUCED across every attempt
// aborts; healthy / inconclusive / timeout all proceed.
// ---------------------------------------------------------------------------
describe("preflight: the sandbox's own dev server bind (check #7f, Fix G)", () => {
  /** Every other check green, docker provider, so only #7f's verdict shows.
   *  A no-op `sleep` so the retry backoff never actually waits in tests. */
  function preflightWith(
    opts: Parameters<typeof preflight>[1] = {},
    overrides: Partial<SandcastleArgs> = {},
  ) {
    const args = makeArgs({
      sandbox: "docker",
      imageName: "sandcastle:test",
      ...overrides,
    });
    return preflight(args, {
      exec: (bin, a) =>
        a.includes("symbolic-ref")
          ? { ok: true, stdout: `${args.branch}\n` }
          : { ok: true },
      fileExists: () => true,
      // The check only runs when the host environment sets one of the two
      // host-only dev-server vars; the default here sets one.
      getEnv: (k) => (k === "SANDCASTLE_DEV_HOST" ? "100.64.0.1" : undefined),
      probeTemplateExists: () => ({ ok: true, stdout: "1" }),
      probeSandboxDb: () => ({ ok: true }),
      probeDevServerBind: () => ({ status: "healthy" }),
      sleep: () => {},
      ...opts,
    });
  }

  it("passes when a container off the run's image can bind the dev address", () => {
    const res = preflightWith();
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it("ABORTS on a confirmed dead bind, naming the F12 class and the ticket cost", () => {
    const res = preflightWith({
      probeDevServerBind: () => ({
        status: "dead",
        stderr:
          "next dev cannot bind 100.79.86.27:4001 in the sandbox: EADDRNOTAVAIL",
      }),
    });
    expect(res.ok).toBe(false);
    const msg = res.errors.join("\n");
    expect(msg).toMatch(/cannot use its own dev-server address/);
    // #1198 second review, F4: same correction as the sandbox-db refusal —
    // an unbindable dev address no longer quarantines a browser ticket, it
    // makes it fall through and pay for a full build and review it cannot
    // prove anything with.
    expect(msg).not.toMatch(/stopped:no-failing-check/);
    expect(msg).toMatch(/shipped-without-first-test/);
    // References the class explicitly so the fix is obvious from the log alone.
    expect(msg).toMatch(/F12/);
    expect(msg).toMatch(/agent-failures\.md/);
    // The probe's own words survive.
    expect(msg).toContain("EADDRNOTAVAIL");
  });

  it("does NOT abort on a timeout/inconclusive — it might be a slow machine, and a good night must not die for it", () => {
    const res = preflightWith({
      probeDevServerBind: () => ({
        status: "inconclusive",
        stderr: "bind probe did not settle within 30000ms (inconclusive)",
      }),
    });
    expect(res.ok).toBe(true);
    expect(res.errors.join("\n")).not.toMatch(/cannot use its own dev-server address/);
  });

  it("retry-then-healthy proceeds: a one-off dead bind that clears on retry never aborts", () => {
    let calls = 0;
    const res = preflightWith({
      probeDevServerBind: () => {
        calls += 1;
        return calls === 1
          ? { status: "dead", stderr: "EADDRNOTAVAIL" }
          : { status: "healthy" };
      },
    });
    expect(calls).toBe(2); // dead once, then healthy — stops there.
    expect(res.ok).toBe(true);
    expect(res.errors.join("\n")).not.toMatch(/cannot use its own dev-server address/);
  });

  it("retry-then-inconclusive proceeds: a dead bind followed by an ambiguous read does not abort", () => {
    let calls = 0;
    const res = preflightWith({
      probeDevServerBind: () => {
        calls += 1;
        return calls === 1
          ? { status: "dead", stderr: "EADDRINUSE" }
          : { status: "inconclusive" };
      },
    });
    expect(calls).toBe(2);
    expect(res.ok).toBe(true);
  });

  it("aborts only after the hard bind is REPRODUCED across every attempt", () => {
    let calls = 0;
    const res = preflightWith({
      probeDevServerBind: () => {
        calls += 1;
        return { status: "dead", stderr: "EADDRNOTAVAIL" };
      },
    });
    expect(calls).toBe(3); // SANDBOX_DEV_BIND_PROBE_MAX_ATTEMPTS
    expect(res.ok).toBe(false);
    expect(res.errors.join("\n")).toMatch(/Reproduced across 3 attempts/);
  });

  it("forwards ONLY the bind-decision env into the probe container (Fix F's blanked host vars)", () => {
    const seen: { image: string; env: Record<string, string>; port: string }[] =
      [];
    preflightWith(
      {
        // A real .env still setting the host vars: Fix F (sandboxTestDbEnv)
        // must blank them before they reach the probe, so the sandbox is
        // treated as a private machine.
        getEnv: (k) =>
          k === "SANDCASTLE_DEV_HOST"
            ? "100.79.86.27"
            : k === "SANDCASTLE_SHARED_HOST"
              ? "1"
              : undefined,
        probeDevServerBind: (image, env, port) => {
          seen.push({ image, env, port });
          return { status: "healthy" };
        },
      },
      { imageName: "sandcastle:my-project" },
    );
    expect(seen.length).toBe(1);
    expect(seen[0]!.image).toBe("sandcastle:my-project");
    // Fix F won: both host vars arrive BLANK, not as the .env's Tailscale IP.
    expect(seen[0]!.env.SANDCASTLE_DEV_HOST).toBe("");
    expect(seen[0]!.env.SANDCASTLE_SHARED_HOST).toBe("");
  });

  it("says nothing on --sandbox mac-host — that path runs no container", () => {
    const res = preflightWith(
      {
        probeDevServerBind: () => {
          throw new Error("must not probe — mac-host runs no container");
        },
      },
      { sandbox: "mac-host" },
    );
    expect(res.errors).toEqual([]);
  });

  it("is skippable with --allow-unreachable-dev-bind, the same escape-hatch shape as #7d", () => {
    const res = preflightWith(
      {
        probeDevServerBind: () => {
          throw new Error("must not probe — the operator opted out");
        },
      },
      { allowUnreachableDevBind: true },
    );
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it("DEGRADES: a stopped docker daemon reports ITS own error, and #7f stays silent", () => {
    const res = preflightWith({
      exec: (bin, a) => {
        if (a.includes("symbolic-ref")) return { ok: true, stdout: "run\n" };
        if (bin === "docker" && a[0] === "info") {
          return { ok: false, stderr: "Cannot connect to the Docker daemon" };
        }
        return { ok: true };
      },
      probeDevServerBind: () => {
        throw new Error("must not probe — no runnable container exists");
      },
    });
    expect(res.ok).toBe(false);
    const msg = res.errors.join("\n");
    expect(msg).toMatch(/docker info failed/);
    expect(msg).not.toMatch(/cannot use its own dev-server address/);
  });

  it("DEGRADES: a missing sandbox image reports ITS own error, and #7f stays silent", () => {
    const res = preflightWith({
      exec: (bin, a) => {
        if (a.includes("symbolic-ref")) return { ok: true, stdout: "run\n" };
        if (bin === "docker" && a[0] === "image") return { ok: false };
        return { ok: true };
      },
      probeDevServerBind: () => {
        throw new Error("must not probe — the image does not exist locally");
      },
    });
    expect(res.ok).toBe(false);
    const msg = res.errors.join("\n");
    expect(msg).toMatch(/not found locally/);
    expect(msg).not.toMatch(/cannot use its own dev-server address/);
  });

  // -------------------------------------------------------------------------
  // The probe PAYLOAD itself. It is a string of JavaScript, so nothing
  // typechecks it: a syntax error would make every container exit non-zero,
  // which #7f would misread as "the sandbox dev server cannot bind" — a
  // preflight that refuses every launch for a fault that does not exist. Run
  // it for real, against real bindable / unbindable addresses, in a real
  // `node -e`, with the exact env the container is handed.
  // -------------------------------------------------------------------------
  describe("the in-container bind probe script", () => {
    /** Run the real script the way the real probe does. */
    function runProbe(
      env: Record<string, string>,
      port: string,
    ): { exitCode: number; stderr: string } {
      try {
        execFileSync(process.execPath, ["-e", SANDBOX_DEV_BIND_PROBE_SCRIPT, port], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 30_000,
          env: { ...process.env, ...env },
        });
        return { exitCode: 0, stderr: "" };
      } catch (err) {
        const e = err as { status?: number; stderr?: string; message?: string };
        return {
          exitCode: e.status ?? 1,
          stderr: String(e.stderr ?? e.message ?? ""),
        };
      }
    }

    it("PROVES THE INSTRUMENT: exits 0 (healthy) when the sandbox is a private machine and binds all interfaces", () => {
      // No shared-host flag, no dev host → next dev gets no -H → binds 0.0.0.0,
      // always available. Port 0 lets the OS pick a free one.
      const res = runProbe(
        { SANDCASTLE_DEV_HOST: "", SANDCASTLE_SHARED_HOST: "" },
        "0",
      );
      // A SyntaxError would ALSO be a non-zero exit — this asserts the script
      // parses and runs, not just that it exits.
      expect(res.stderr).not.toMatch(/SyntaxError/);
      expect(res.exitCode).toBe(0);
    });

    it("CHANNEL 1 (safe-dev.sh bind): exits 2 (dead) when a shared host forces a bind to an interface that does not exist", () => {
      // Force the F12 shape: shared host + a bogus address with no local
      // interface → EADDRNOTAVAIL at listen().
      const res = runProbe(
        { SANDCASTLE_SHARED_HOST: "1", SANDCASTLE_DEV_HOST: "192.0.2.1" },
        "4001",
      );
      expect(res.stderr).not.toMatch(/SyntaxError/);
      expect(res.exitCode).toBe(2);
      expect(res.stderr).toContain("192.0.2.1:4001");
      expect(res.stderr).toMatch(/EADDRNOTAVAIL/);
    });

    it("CHANNEL 2 (playwright baseURL): exits 2 (dead) when SANDCASTLE_DEV_HOST is a dead IP even though the machine is NOT shared — the bind binds 0.0.0.0 fine but baseURL is unreachable", () => {
      // This is the gap the bind-only probe missed. shared=false (no
      // SANDCASTLE_SHARED_HOST) means safe-dev.sh binds 0.0.0.0 (healthy), but
      // playwright.config.ts reads dev-host.sh UNCONDITIONALLY → baseURL points
      // at 192.0.2.1, which has no interface → every browser check times out.
      // Regression scenario: revert ONLY the SANDCASTLE_DEV_HOST blank in Fix F.
      const res = runProbe(
        { SANDCASTLE_SHARED_HOST: "", SANDCASTLE_DEV_HOST: "192.0.2.1" },
        "4001",
      );
      expect(res.stderr).not.toMatch(/SyntaxError/);
      // Bind channel (0.0.0.0) would pass; the baseURL channel must catch it.
      expect(res.exitCode).toBe(2);
      expect(res.stderr).toContain("192.0.2.1:4001");
      expect(res.stderr).toMatch(/EADDRNOTAVAIL/);
    });

    it("faithful to the shell: an uppercase SANDCASTLE_SHARED_HOST does NOT count as shared (shared-host.sh's case is case-sensitive), so a dead DEV_HOST is caught only via the unconditional baseURL channel", () => {
      // TRUE (uppercase) falls through shared-host.sh's case to the dir check →
      // not shared inside the sandbox → bind is 0.0.0.0 (healthy). The dead IP
      // is still caught, but through channel 2, proving the shell-faithful
      // case-sensitivity AND that channel 2 is doing the catching.
      const res = runProbe(
        { SANDCASTLE_SHARED_HOST: "TRUE", SANDCASTLE_DEV_HOST: "192.0.2.1" },
        "4001",
      );
      expect(res.stderr).not.toMatch(/SyntaxError/);
      expect(res.exitCode).toBe(2);
      expect(res.stderr).toContain("192.0.2.1:4001");
    });

    it("a host counts as shared ONLY when SANDCASTLE_SHARED_HOST says so — the script never guesses from the filesystem", () => {
      expect(SANDBOX_DEV_BIND_PROBE_SCRIPT).not.toMatch(/existsSync/);
      expect(SANDBOX_DEV_BIND_PROBE_SCRIPT).not.toMatch(/\/home\//);
      // Behavioural: with the flag unset and no dev host, nothing forces a
      // bind to a dead interface — healthy, wherever the test runs.
      const res = runProbe({ SANDCASTLE_DEV_HOST: "", SANDCASTLE_SHARED_HOST: "" }, "0");
      expect(res.exitCode).toBe(0);
    });
  });

  it("is OFF (probes nothing) when neither SANDCASTLE_DEV_HOST nor SANDCASTLE_SHARED_HOST is set", () => {
    const res = preflightWith({
      getEnv: () => undefined,
      probeDevServerBind: () => {
        throw new Error("must not probe when no host-only dev-server var is set");
      },
    });
    expect(res.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// `testDbAdminUrl` is the HOST-side sibling of `sandboxTestDbEnv`: the clone
// step shells to the host's psql, so it needs the host address, not the
// container's. It never reads the orchestrator's own DATABASE_URL/POSTGRES_URL,
// which could point unattended schema work at a production database.
// ---------------------------------------------------------------------------
describe("testDbAdminUrl (the host-side sibling of sandboxTestDbEnv)", () => {
  it("targets the LOCAL test Postgres on localhost, not a container address", () => {
    const url = testDbAdminUrl({});
    expect(url).toBe("postgres://postgres:postgres@localhost:55432/postgres");
    // The container-side addresses are unreachable from the host process that
    // actually runs psql — asserting their absence keeps the two helpers from
    // being "unified" by a later refactor.
    expect(url).not.toContain("host.docker.internal");
    expect(url).not.toContain("172.17.0.1");
    expect(url).not.toContain("supabase");
  });

  it("honours SANDCASTLE_TEST_PG_PORT like scripts/test-db.sh does", () => {
    expect(testDbAdminUrl({ SANDCASTLE_TEST_PG_PORT: "55999" })).toContain(
      "@localhost:55999/",
    );
  });

  it("treats an empty port override as unset (`||`, not `??`)", () => {
    expect(testDbAdminUrl({ SANDCASTLE_TEST_PG_PORT: "" })).toContain(":55432/");
  });

  it("honours an operator-set SANDCASTLE_TEST_DB_ADMIN_URL", () => {
    // The hatch can only redirect to ANOTHER disposable local Postgres — the
    // guard is an allowlist of loopback/gateway hosts, so a remote address is
    // refused (see the case below). A second local port is the real use.
    const url = "postgres://postgres:postgres@127.0.0.1:55999/postgres";
    expect(testDbAdminUrl({ SANDCASTLE_TEST_DB_ADMIN_URL: url })).toBe(url);
  });

  it("refuses to let the escape hatch smuggle prod back in", () => {
    expect(() =>
      testDbAdminUrl({
        SANDCASTLE_TEST_DB_ADMIN_URL:
          "postgresql://u:p@db.abc.supabase.co:5432/postgres",
      }),
    ).toThrow(/SANDCASTLE_TEST_DB_ADMIN_URL: refusing/);
    // The pooler host is refused too. NOT because `.supabase.com` is "a
    // different suffix" the old denylist needed a second clause for — that
    // clause was dead code, since `"supabase.com".includes("supabase.co")`.
    // It is refused because it is not on the allowlist, same as everything
    // else that is not this machine's test container.
    expect(() =>
      testDbAdminUrl({
        SANDCASTLE_TEST_DB_ADMIN_URL:
          "postgresql://u:p@aws-1-us-east-1.pooler.supabase.com:6543/postgres",
      }),
    ).toThrow(/aws-1-us-east-1\.pooler\.supabase\.com:6543/);
    // Case: DNS is case-insensitive, `String.includes` is not. This exact URL
    // used to be ALLOWED.
    expect(() =>
      testDbAdminUrl({
        SANDCASTLE_TEST_DB_ADMIN_URL:
          "postgresql://u:p@DB.ABC.SUPABASE.CO:5432/postgres",
      }),
    ).toThrow(/db\.abc\.supabase\.co:5432/);
    // And a non-Supabase remote, which no denylist would have caught.
    expect(() =>
      testDbAdminUrl({
        SANDCASTLE_TEST_DB_ADMIN_URL:
          "postgres://postgres:postgres@10.0.0.5:55432/postgres",
      }),
    ).toThrow(/10\.0\.0\.5:55432/);
  });

  it("refuses SANDCASTLE_TEST_PG_PORT=5432 — the VPS's Mission Control DB", () => {
    // No escape hatch involved: the DEFAULT url is `localhost:${port}`, so on
    // the shared VPS this one env var pointed unattended agent DDL at a live
    // production Postgres and the old Supabase-substring guard saw nothing.
    // See the port rationale in packages/db/src/test-support/test-env.ts.
    expect(() => testDbAdminUrl({ SANDCASTLE_TEST_PG_PORT: "5432" })).toThrow(
      /localhost:5432/,
    );
    // And the message names the knob that actually caused it, not the unset
    // escape hatch.
    expect(() => testDbAdminUrl({ SANDCASTLE_TEST_PG_PORT: "5432" })).toThrow(
      /SANDCASTLE_TEST_PG_PORT/,
    );
  });

  it("ignores an ambient DATABASE_URL/POSTGRES_URL entirely", () => {
    // The bug this whole change closes: ambient process env choosing the
    // database that receives agent-authored DDL.
    const url = testDbAdminUrl({
      DATABASE_URL: "postgresql://u:p@db.abc.supabase.co:5432/postgres",
      POSTGRES_URL: "postgresql://u:p@db.abc.supabase.co:5432/postgres",
    });
    expect(url).toContain("@localhost:");
  });
});

// ---------------------------------------------------------------------------
// The PRODUCTION WIRING of the per-job test database (`testDatabase` in
// .sandcastle/project.json). Same discipline as before: a real temp git repo,
// real `buildDefaultDeps().createSandbox`, and a stub `psql` binary on PATH
// that records what it was actually invoked with, so these die if the clone is
// silently dropped, runs when it is OFF, or skips the project's setup command.
//
// The cases never reach the real sandbox provider: the clone (or the setup
// command) is made to fail on purpose, so the assertions run against a
// deterministic, infra-free failure once the behaviour they prove has happened.
// ---------------------------------------------------------------------------
describe("buildDefaultDeps().createSandbox — per-job test database wiring", () => {
  let repo: string;
  let binDir: string;
  let callLogFile: string;
  const savedEnv = {
    PATH: process.env.PATH,
    SANDCASTLE_TEST_DB_ADMIN_URL: process.env.SANDCASTLE_TEST_DB_ADMIN_URL,
    SANDCASTLE_TEST_DB_URL: process.env.SANDCASTLE_TEST_DB_URL,
    PSQL_EXIT_ON_CREATE_DATABASE: process.env.PSQL_EXIT_ON_CREATE_DATABASE,
  };
  const ADMIN_URL = "postgres://postgres:postgres@127.0.0.1:55991/postgres";
  const WITH_DB = {
    ...defaultProjectConfig(),
    testDatabase: { templateDb: "app_test_template" },
  };

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sc-testdb-wiring-repo-"));
    binDir = mkdtempSync(path.join(tmpdir(), "sc-testdb-wiring-bin-"));
    callLogFile = path.join(binDir, "calls.log");
    writeFileSync(callLogFile, "");

    // Logs the FULL argv. `PSQL_EXIT_ON_CREATE_DATABASE` fails only the
    // clone's own `CREATE DATABASE` statement.
    const psqlStub = path.join(binDir, "psql");
    writeFileSync(
      psqlStub,
      [
        "#!/bin/sh",
        `echo "psql|$*" >> ${JSON.stringify(callLogFile)}`,
        'if [ -n "$PSQL_EXIT_ON_CREATE_DATABASE" ]; then',
        '  case "$*" in *"CREATE DATABASE"*) exit "$PSQL_EXIT_ON_CREATE_DATABASE" ;; esac',
        "fi",
        "exit 0",
      ].join("\n"),
    );
    chmodSync(psqlStub, 0o755);

    process.env.PATH = `${binDir}:${savedEnv.PATH ?? ""}`;
    process.env.SANDCASTLE_TEST_DB_ADMIN_URL = ADMIN_URL;
    delete process.env.SANDCASTLE_TEST_DB_URL;

    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
    commitInto(repo, { "README.md": "seed\n" }, "seed");
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(repo, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  });

  function readCalls(): string[] {
    return readFileSync(callLogFile, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
  }

  it("NO testDatabase (the default): never touches psql — no sweep, no clone", async () => {
    setProjectConfig(defaultProjectConfig());
    process.env.PSQL_EXIT_ON_CREATE_DATABASE = "1";
    // Stop the real provider from being reached: an unusable repo root makes
    // createSandbox throw after the (absent) database step.
    const deps = buildDefaultDeps(
      makeArgs({ repoRoot: repo, sandbox: "mac-host" }),
    );
    await deps
      .createSandbox({
        branch: "sandcastle/issue-9000",
        implementerModel: "stub-implementer",
      })
      .catch(() => undefined);
    expect(readCalls()).toEqual([]);
  });

  it("--dry-run never writes to the database", async () => {
    setProjectConfig(WITH_DB);
    process.env.PSQL_EXIT_ON_CREATE_DATABASE = "1";
    const deps = buildDefaultDeps(
      makeArgs({ repoRoot: repo, sandbox: "mac-host", dryRun: true }),
    );
    await deps
      .createSandbox({
        branch: "sandcastle/issue-9002",
        implementerModel: "stub-implementer",
      })
      .catch(() => undefined);
    expect(readCalls().some((l) => l.includes("CREATE DATABASE"))).toBe(false);
  });

  it("clones the job database FROM the configured template, against the admin database", async () => {
    setProjectConfig(WITH_DB);
    process.env.PSQL_EXIT_ON_CREATE_DATABASE = "1"; // the clone fails — deliberately.
    const deps = buildDefaultDeps(
      makeArgs({ repoRoot: repo, sandbox: "mac-host" }),
    );
    await expect(
      deps.createSandbox({
        branch: "sandcastle/issue-9001",
        implementerModel: "stub-implementer",
      }),
    ).rejects.toThrow();

    const cloneCall = readCalls().find((l) => l.includes("CREATE DATABASE"))!;
    expect(cloneCall).toBeDefined();
    expect(cloneCall).toMatch(/TEMPLATE "?app_test_template"?/);
    expect(cloneCall).toContain("127.0.0.1:55991");
  });

  it("runs setupCommand after the clone with the CLONE's url in DATABASE_URL; a failure drops the clone and throws TestDatabaseSetupError", async () => {
    const out = path.join(binDir, "setup-env.txt");
    setProjectConfig({
      ...WITH_DB,
      testDatabase: {
        templateDb: "app_test_template",
        setupCommand: [
          "sh",
          "-c",
          `printf '%s' "$DATABASE_URL" > ${JSON.stringify(out)}; exit 3`,
        ],
      },
    });
    const deps = buildDefaultDeps(
      makeArgs({ repoRoot: repo, sandbox: "mac-host" }),
    );
    await expect(
      deps.createSandbox({
        branch: "sandcastle/issue-9003",
        implementerModel: "stub-implementer",
      }),
    ).rejects.toThrow(TestDatabaseSetupError);

    const url = readFileSync(out, "utf8");
    expect(url).toMatch(
      /^postgres:\/\/postgres:postgres@127\.0\.0\.1:55991\/sc_job_/,
    );
    const calls = readCalls();
    const clone = calls.findIndex((l) => l.includes("CREATE DATABASE"));
    const drop = calls.findIndex((l) => l.includes("DROP DATABASE"));
    expect(clone).toBeGreaterThanOrEqual(0);
    expect(drop).toBeGreaterThan(clone);
  });
});

describe("runTestDatabaseSetup", () => {
  it("resolves on exit 0 and passes the url in DATABASE_URL and POSTGRES_URL", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sc-setup-cmd-"));
    try {
      const out = path.join(dir, "env.txt");
      await runTestDatabaseSetup(
        [
          "sh",
          "-c",
          `printf '%s|%s' "$DATABASE_URL" "$POSTGRES_URL" > ${JSON.stringify(out)}`,
        ],
        dir,
        "postgres://x@localhost:1/db",
      );
      expect(readFileSync(out, "utf8")).toBe(
        "postgres://x@localhost:1/db|postgres://x@localhost:1/db",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects with the exit code and output tail on a non-zero exit", async () => {
    await expect(
      runTestDatabaseSetup(
        ["sh", "-c", "echo boom >&2; exit 7"],
        tmpdir(),
        "postgres://x@localhost:1/db",
      ),
    ).rejects.toThrow(/exited 7.*boom/);
  });

  it("rejects when the command cannot start", async () => {
    await expect(
      runTestDatabaseSetup(
        ["definitely-not-a-real-binary-xyz"],
        tmpdir(),
        "postgres://x@localhost:1/db",
      ),
    ).rejects.toThrow(/could not start/);
  });
});

// ---------------------------------------------------------------------------
// 2026-09-04 loop-config fix: the sandboxed builder used to run under the
// LAUNCHING host's own personal `~/.claude` (outputStyle, hooks, CLAUDE.md —
// see lib/sandbox-agent-settings.ts's module doc comment for the incident).
// This drives the REAL `buildDefaultDeps().createSandbox` against the
// mac-host provider (no docker/SDK dependency needed) and proves the fix
// where it actually has to land: the worktree the agent's first run will use
// as its cwd, written BEFORE that run, not merely that the writer function
// exists.
// ---------------------------------------------------------------------------
describe("buildDefaultDeps().createSandbox — the sandbox agent settings land in the worktree before any run", () => {
  let repo: string;
  const savedEnv = {
    SANDCASTLE_TEST_DB_URL: process.env.SANDCASTLE_TEST_DB_URL,
  };

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sc-agent-settings-wiring-repo-"));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
    commitInto(repo, { "README.md": "seed\n" }, "seed");
    // The escape hatch: createSandboxRaw's own guard (`if
    // (!process.env.SANDCASTLE_TEST_DB_URL)`) skips the practice-template
    // clone entirely when this is set, which is what lets this test drive a
    // REAL createSandbox call with no Postgres of its own to stand up. The
    // startup orphan sweep still runs and may fail to reach this address —
    // caught and logged (non-fatal) by `ensureJobDbSwept`, never thrown.
    process.env.SANDCASTLE_TEST_DB_URL =
      "postgres://postgres:postgres@127.0.0.1:55991/postgres";
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(repo, { recursive: true, force: true });
  });

  it("writes .claude/settings.local.json into the worktree, with a clean git status, before any run", async () => {
    const deps = buildDefaultDeps(
      makeArgs({ repoRoot: repo, sandbox: "mac-host" }),
    );
    const h = await deps.createSandbox({
      branch: "sandcastle/issue-9003",
      implementerModel: "stub-implementer",
    });
    try {
      expect(h.worktreePath).toBeDefined();
      const settingsPath = path.join(
        h.worktreePath!,
        SANDBOX_AGENT_SETTINGS_RELPATH,
      );
      expect(existsSync(settingsPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
      expect(Object.keys(parsed).sort()).toEqual(
        ["claudeMdExcludes", "disableAllHooks", "outputStyle"].sort(),
      );
      expect(parsed.disableAllHooks).toBe(true);
      expect(parsed.outputStyle).toBe("default");

      // Clean BEFORE any `h.run` — the settings file is git-excluded, not
      // merely present.
      expect(
        execFileSync("git", ["status", "--porcelain"], {
          cwd: h.worktreePath!,
        })
          .toString("utf8")
          .trim(),
      ).toBe("");
    } finally {
      await h.close();
    }
  });
});

/**
 * Rot-guard: the sandbox agent settings must be written from EXACTLY the two
 * sites the design calls for — the per-issue sandbox (`createSandboxRaw`) and
 * the staging worktree (the boot sequence, right after
 * `ensureStagingWorktree`) — and nowhere else (in particular, never into
 * `args.repoRoot`, the operator's own launch checkout). A count that drifts
 * from 2 means a call site moved, was added, or was deleted; verify the
 * change was intentional before updating the expected count.
 */
it("writeSandboxAgentSettings( is called from exactly the two intended sites", () => {
  const SRC = readFileSync(path.join(import.meta.dirname, "main.mts"), "utf8");
  const occurrences = SRC.split("writeSandboxAgentSettings(").length - 1;
  expect(occurrences).toBe(2);
  expect(SRC).toContain("writeSandboxAgentSettings(handle.worktreePath");
  expect(SRC).toContain("writeSandboxAgentSettings(stagingWorktreePath");
});

// ---------------------------------------------------------------------------
// The PRODUCTION WIRING of the harness check's ATTEMPT TRAIL.
//
// Same argument as the migration-wiring block above: `runHarnessScreenCheck`
// has always returned every attempt it made, and until now NO production
// caller read them — both runs' outcomes were dropped on the floor the moment
// the final verdict was resolved. A schema field and two telemetry setters
// that carry the trail prove nothing on their own if the one dep that
// produces the record never fills it in. This drives the REAL
// `buildDefaultDeps().runScreenCheckHarness` against a fake sandbox exec and
// asserts on what it returns and what it logged.
// ---------------------------------------------------------------------------
describe("buildDefaultDeps().runScreenCheckHarness — the attempt trail", () => {
  let repo: string;
  let logFile: string;

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sc-screencheck-trail-"));
    logFile = path.join(repo, "run.log");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  /** A command shaped like one a real builder produced — it has to carry the
   *  nonce-named report path, because the ship-time funnel recovers this run's
   *  nonce FROM the command, and without one `classifyHarnessRun` calls every
   *  run inconclusive regardless of exit code (issue #956). */
  const CHECK_912 = commandWithNonce("pnpm e2e -- checks/issue-912");
  const CHECK_913 = commandWithNonce("pnpm e2e -- checks/issue-913");

  it("carries BOTH runs' verdicts onto the record, and keeps the more-evidenced one as the verdict", async () => {
    const deps = buildDefaultDeps(makeArgs({ repoRoot: repo, logFile }));
    // Attempt 1 reaches grading and proves the figure wrong. Attempt 2 dies
    // like a container hiccup — no host evidence line at all, so nothing
    // proves it ran. The exact pair `moreEvidencedVerdict` exists for.
    const outputs = [
      checkRunStdout(CHECK_912, {
        ...RED_RUN,
        stdout: GRADED_FIGURE_SENTINEL,
      }),
      "docker: connection reset\n",
    ];
    let call = 0;
    const result = await deps.runScreenCheckHarness({
      issueNumber: 912,
      branch: "sandcastle/test-run",
      kind: "browser" as const,
      screen: "/finance/reports",
      checkCommand: CHECK_912,
      exec: async () => ({
        stdout: outputs[call++] ?? "",
        stderr: "",
        exitCode: 1,
        timedOut: false,
      }),
      // No worktree ⇒ the picture path is skipped entirely; this test is
      // about the trail, and the picture has its own tests.
      worktreePath: undefined,
    });

    expect(result.rerun).toBe(true);
    // The kept verdict is attempt 1's, NOT the later attempt's.
    expect(result.verdict).toBe("graded-mismatch");
    expect(result.record.verdict).toBe("graded-mismatch");
    // THE assertion: the losing attempt is still on the record. Without it,
    // "attempt 2 disagreed and lost" is invisible to everyone downstream.
    expect(result.record.attemptVerdicts).toEqual([
      "graded-mismatch",
      "inconclusive",
    ]);
  });

  it("logs both attempts and the choice between them when a re-run happened", async () => {
    const deps = buildDefaultDeps(makeArgs({ repoRoot: repo, logFile }));
    const outputs = [
      checkRunStdout(CHECK_912, {
        ...RED_RUN,
        stdout: GRADED_FIGURE_SENTINEL,
      }),
      "docker: connection reset\n",
    ];
    let call = 0;
    await deps.runScreenCheckHarness({
      issueNumber: 912,
      branch: "sandcastle/test-run",
      kind: "browser" as const,
      screen: "/finance/reports",
      checkCommand: CHECK_912,
      exec: async () => ({
        stdout: outputs[call++] ?? "",
        stderr: "",
        exitCode: 1,
        timedOut: false,
      }),
      worktreePath: undefined,
    });

    const logged = readFileSync(logFile, "utf8");
    expect(logged).toContain("[issue=912] screen-check re-ran once");
    expect(logged).toContain("attempt 1 graded-mismatch");
    expect(logged).toContain("attempt 2 inconclusive");
    expect(logged).toContain("kept graded-mismatch");
  });

  it("records a single-attempt trail and stays silent about a re-run that never happened", async () => {
    const deps = buildDefaultDeps(makeArgs({ repoRoot: repo, logFile }));
    const result = await deps.runScreenCheckHarness({
      issueNumber: 913,
      branch: "sandcastle/test-run",
      kind: "browser" as const,
      screen: "/finance/reports",
      checkCommand: CHECK_913,
      exec: async () => ({
        stdout: checkRunStdout(CHECK_913, GREEN_RUN),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }),
      worktreePath: undefined,
    });

    expect(result.rerun).toBe(false);
    expect(result.record.attemptVerdicts).toEqual(["match"]);
    expect(readFileSync(logFile, "utf8")).not.toContain("re-ran once");
  });
});

// ---------------------------------------------------------------------------
// THE JOIN between a screen-check verdict and the watch-only ALARM (issue
// #930). `isSystemicScreenCheckVerdict` and `createScreenCheckAlarmGate` are
// unit-tested on their own in lib/harness/screen-check-alarm.test.ts, and
// `raiseAlarm`'s ntfy push is unit-tested on its own in
// lib/harness/alarm.test.ts — but the two lines in `buildDefaultDeps`'s
// `reportScreenCheckWatch` that actually WIRE a verdict to that gate and
// that gate's result to `raiseAlarm` are exercised by no test: every other
// test in this file (and main.harness.test.mts / main.rescue-harness.test.mts
// / main.checkwriter.test.mts) replaces `deps.reportScreenCheckWatch`
// wholesale with a stand-in `async (...a) => {...}`, so the real join has
// never run once.
//
// Same "drive the REAL dep, fake only the external edge" shape as
// `buildDefaultDeps().applyMigrations` above (a stub `psql` on PATH) and
// `buildDefaultDeps().runScreenCheckHarness` (a fake `exec`): here the two
// external edges are the `gh` CLI (stubbed on PATH — the fetch-modify-write
// issue-body update, unrelated to the alarm itself) and `fetch` (stubbed at
// the network boundary — the actual thing under test), never the whole
// alarm.
// ---------------------------------------------------------------------------
describe("buildDefaultDeps().reportScreenCheckWatch — the verdict-to-alarm join", () => {
  let repo: string;
  let logFile: string;
  let binDir: string;
  const savedPath = process.env.PATH;
  const savedTopic = process.env.NTFY_TOPIC;
  const originalFetch = globalThis.fetch;
  let fetchCalls: Array<{ url: string; init: RequestInit }>;

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sc-watch-alarm-join-"));
    logFile = path.join(repo, "run.log");
    binDir = mkdtempSync(path.join(tmpdir(), "sc-fake-gh-"));

    // Fake `gh`: `issue view` returns a canned body, `issue edit` succeeds
    // silently. This lets the real fetch-modify-write issue-body update run
    // to completion without ever touching the network — it is not the thing
    // under test, only a prerequisite the real `reportScreenCheckWatch` runs
    // before it ever reaches the alarm gate.
    const stub = path.join(binDir, "gh");
    writeFileSync(
      stub,
      [
        "#!/bin/sh",
        'if [ "$1" = "issue" ] && [ "$2" = "view" ]; then',
        '  printf "existing body\\n"',
        "  exit 0",
        "fi",
        'if [ "$1" = "issue" ] && [ "$2" = "edit" ]; then',
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
    );
    chmodSync(stub, 0o755);
    process.env.PATH = `${binDir}:${savedPath ?? ""}`;
    process.env.NTFY_TOPIC = "test-topic-930";
    // `configureGh`'s cwd is a module-level singleton in lib/state/gh.ts,
    // set once by an earlier `runMain` test elsewhere in this file and never
    // reset — left alone, our `gh` spawn inherits a cwd from a tmp repo a
    // prior test already deleted, and fails with a bare ENOENT that has
    // nothing to do with the fake `gh` on PATH above. Point it at this
    // test's own (real, live) tmp repo instead of trusting file order.
    configureGh({ cwd: repo });

    fetchCalls = [];
    globalThis.fetch = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      fetchCalls.push({ url: String(url), init: init ?? {} });
      return { ok: true, status: 200 } as Response;
    }) as typeof fetch;
  });

  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedTopic === undefined) delete process.env.NTFY_TOPIC;
    else process.env.NTFY_TOPIC = savedTopic;
    globalThis.fetch = originalFetch;
    configureGh({ cwd: undefined });
    rmSync(repo, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  });

  it("a systemic verdict (the app/environment, not the ticket) fires the real ntfy push", async () => {
    const deps = buildDefaultDeps(makeArgs({ repoRoot: repo, logFile }));

    await deps.reportScreenCheckWatch!(930, {
      verdict: "never-settled",
      screen: "/finance/reports",
      detail: "the page never settled after 30s",
      wouldHaveStoppedAs: "stopped:could-not-grade",
    });

    // THE assertion: the alarm's outbound call actually happened, at the
    // real network boundary — not a mock standing in for the whole alarm.
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe("https://ntfy.sh/test-topic-930");
    expect(fetchCalls[0]!.init.method).toBe("POST");
    expect(String(fetchCalls[0]!.init.body)).toContain("never-settled");

    const logged = readFileSync(logFile, "utf8");
    expect(logged).toContain(
      "ALARM: [issue=930] Screen check could not grade: never-settled",
    );
  });

  it("a per-ticket verdict (a wrong figure, not a broken night) never reaches the alarm", async () => {
    const deps = buildDefaultDeps(makeArgs({ repoRoot: repo, logFile }));

    await deps.reportScreenCheckWatch!(930, {
      verdict: "graded-mismatch",
      screen: "/finance/reports",
      detail: "the reported total was wrong",
      wouldHaveStoppedAs: "stopped:check-disagreement",
    });

    expect(fetchCalls).toHaveLength(0);
    expect(readFileSync(logFile, "utf8")).not.toContain("ALARM:");
  });

  it("the suppression branch: a second systemic verdict in the same run logs instead of alarming again", async () => {
    const deps = buildDefaultDeps(makeArgs({ repoRoot: repo, logFile }));

    await deps.reportScreenCheckWatch!(930, {
      verdict: "never-settled",
      detail: "the page never settled after 30s",
      wouldHaveStoppedAs: "stopped:could-not-grade",
    });
    await deps.reportScreenCheckWatch!(931, {
      verdict: "environment-fault",
      detail: "the dev server never came up",
      wouldHaveStoppedAs: "stopped:could-not-grade",
    });

    // Only the FIRST systemic verdict pushed — the second is suppressed and
    // counted, not silently dropped and not re-alarmed.
    expect(fetchCalls).toHaveLength(1);
    const logged = readFileSync(logFile, "utf8");
    expect(logged).toContain(
      "[issue=931] screen-check recorded 'environment-fault': alarm suppressed",
    );
  });
});

// ---------------------------------------------------------------------------
// #1198 A — the two deps the first-test fall-through needs, and the one thing
// nothing else in this suite would catch: either of them being silently
// deleted from `buildDefaultDeps`. Both are OPTIONAL on the `Deps` interface,
// so a missing implementation compiles and degrades to a no-op — which is the
// right failure mode at the call sites (a fall-through must never be able to
// crash a ticket) and exactly why a wiring pin has to exist here.
// ---------------------------------------------------------------------------
describe("buildDefaultDeps().applyFirstTestFallThroughReport — wiring", () => {
  it("is wired in — the dep exists and is callable", () => {
    const deps = buildDefaultDeps(makeArgs({}));
    expect(deps.applyFirstTestFallThroughReport).toBeTypeOf("function");
  });

  it("under --dry-run, returns 'already-present' without shelling out to gh", async () => {
    const deps = buildDefaultDeps(makeArgs({ dryRun: true }));
    const outcome = await deps.applyFirstTestFallThroughReport?.(911, {
      reason: "no-failing-check",
      detail: "the check passed against the unchanged code",
    });
    expect(outcome).toBe("already-present");
  });
});

describe("buildDefaultDeps().markShippedWithoutFirstTest — wiring", () => {
  it("is wired in — the dep exists and is callable", () => {
    const deps = buildDefaultDeps(makeArgs({}));
    expect(deps.markShippedWithoutFirstTest).toBeTypeOf("function");
  });

  it("under --dry-run, resolves without shelling out to gh", async () => {
    const deps = buildDefaultDeps(makeArgs({ dryRun: true }));
    await expect(
      deps.markShippedWithoutFirstTest?.(911),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// #1271 — the two deps the sibling-check repair road needs at the SHIP moment,
// on exactly the terms of the #1198 pair above. Both are OPTIONAL on `Deps`,
// so a missing implementation compiles and degrades to a no-op — which is the
// right failure mode at the call site (a label or a note must never be able to
// quarantine a merged, reviewed build) and precisely why the wiring has to be
// pinned here. One of them writes to a DIFFERENT issue from the one being
// built, so the dry-run short-circuit is doing real work: without it, a
// planning pass could edit the body of a ticket closed weeks ago.
// ---------------------------------------------------------------------------
describe("buildDefaultDeps().applyOlderTestEditRecord — wiring", () => {
  it("is wired in — the dep exists and is callable", () => {
    const deps = buildDefaultDeps(makeArgs({}));
    expect(deps.applyOlderTestEditRecord).toBeTypeOf("function");
  });

  it("under --dry-run, returns 'already-present' without shelling out to gh", async () => {
    const deps = buildDefaultDeps(makeArgs({ dryRun: true }));
    const outcome = await deps.applyOlderTestEditRecord?.(
      1058,
      1235,
      "## An older check here was amended by the loop",
    );
    expect(outcome).toBe("already-present");
  });
});

describe("buildDefaultDeps().markShippedWithOlderTestEdit — wiring", () => {
  it("is wired in — the dep exists and is callable", () => {
    const deps = buildDefaultDeps(makeArgs({}));
    expect(deps.markShippedWithOlderTestEdit).toBeTypeOf("function");
  });

  it("under --dry-run, resolves without shelling out to gh", async () => {
    const deps = buildDefaultDeps(makeArgs({ dryRun: true }));
    await expect(
      deps.markShippedWithOlderTestEdit?.(1235),
    ).resolves.toBeUndefined();
  });
});

describe("buildContainerEnv — the #1190 command-cap vars actually reach the sandbox", () => {
  // buildContainerEnv takes an explicit `env` seam (third param, defaults to
  // process.env in production) so this suite never has to read or mutate the
  // real process.env — a shell that happens to export BASH_DEFAULT_TIMEOUT_MS
  // or GH_TOKEN while running this suite must not change these results.
  it("carries BASH_DEFAULT_TIMEOUT_MS and BASH_MAX_TIMEOUT_MS, matching bashTimeoutEnv's own default", () => {
    const env = buildContainerEnv({}, {}, {});
    expect(env.BASH_DEFAULT_TIMEOUT_MS).toBe(DEFAULT_BASH_TIMEOUT_MS);
    expect(env.BASH_MAX_TIMEOUT_MS).toBe(DEFAULT_BASH_TIMEOUT_MS);
  });

  it("still carries CLAUDE_CODE_MAX_OUTPUT_TOKENS, and never a GH_TOKEN (spec #1334, SB — main.github-key.test.mts)", () => {
    const withoutToken = buildContainerEnv({}, {}, {});
    expect(withoutToken.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBeTruthy();

    const withToken = buildContainerEnv(
      {},
      {},
      { GH_TOKEN: "gh-token-for-test" },
    );
    expect(withToken.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBeTruthy();
    expect(withToken.GH_TOKEN).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// STOPPING RELEASES THE BOARD.
//
// The loop stamps `in-progress` on an issue when it claims it. The ops
// dashboard reads GITHUB LABELS — so when a run ended, its graceful-shutdown
// path released the cross-host LEASES and nothing else, and the board kept
// showing those tickets as "being built now" indefinitely. Observed 2026-08-05:
// a run stopped at 16:11 UTC still had #803/#838/#839/#840 labelled
// `in-progress` at 19:30, and a human had to release them by hand.
//
// These drive `runMain` for real against a faked GitHub (a label set that
// `claim` mutates and `listIssuesByLabel` reads back), and a REAL SIGTERM
// emitted mid-run — so the loop's own signal handler is what sets `shuttingDown`,
// not a test-only flag.
// ---------------------------------------------------------------------------
describe("runMain — a stop releases the in-progress labels this host holds", () => {
  let repo: string;
  let origin: string;
  const BRANCH = "sandcastle/test-run";
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sc-stoplabels-repo-"));
    origin = mkdtempSync(path.join(tmpdir(), "sc-stoplabels-origin-"));
    git(origin, "init", "-q", "--bare", "-b", "main");
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
    git(repo, "commit", "--allow-empty", "-q", "-m", "init");
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-q", "origin", "main");
    git(repo, "checkout", "-q", "-b", BRANCH);
    git(repo, "commit", "--allow-empty", "-q", "-m", "work");
    mkdirSync(path.join(repo, ".sandcastle"), { recursive: true });

    for (const k of ["SANDCASTLE_CROSS_HOST_SYNC", "SANDCASTLE_CROSS_HOST_LEASE"]) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  /** The one issue every case in here plans, claims, and then stops on. */
  const ISSUE = 803;
  /** The queue the host plans off. One ready ticket, no blockers. */
  const QUEUE = (): Deps["listOpenIssuesWithBodies"] =>
    readyIssues({ number: ISSUE, title: "the ticket" });

  /**
   * GitHub, faked at the label level: `claim` adds to the in-progress set,
   * `listIssuesByLabel("in-progress")` reads it back, `release` removes it and
   * records why. That makes the STARTUP reconciliation see an empty board (as it
   * really would) and the SHUTDOWN one see exactly what this run claimed.
   */
  function ghFake() {
    const inProgress = new Set<number>();
    const released: { issue: number; reason: string }[] = [];
    const deps: Partial<Deps> = {
      claim: async (n) => {
        inProgress.add(n);
      },
      listIssuesByLabel: async (label) =>
        label === "in-progress"
          ? [...inProgress].map((n) => ({
              number: n,
              title: `issue ${n}`,
              labels: ["in-progress"],
            }))
          : [],
      release: async (n, reason) => {
        inProgress.delete(n);
        released.push({ issue: n, reason });
      },
    };
    return { inProgress, released, deps };
  }

  /** The host plans the one ticket off `QUEUE()`; the pipeline then fails fast
   *  (no sandbox is stubbed), which is fine — this suite is about the label at
   *  stop time, not about what the agent did with the ticket. No agent is
   *  dispatched at all before that point, so `deps.run` must never be called. */
  const noAgentRuns: Deps["run"] = async (spec) => {
    throw new Error(`unexpected deps.run(${spec.name})`);
  };

  it("releases the label on SIGTERM, naming the shutdown reconciliation as the reason", async () => {
    const gh = ghFake();
    const deps = makeDeps({
      ...gh.deps,
      listOpenIssuesWithBodies: QUEUE(),
      run: noAgentRuns,
      quarantine: async () => undefined,
      // A REAL SIGTERM, delivered mid-run: the loop's own handler flips
      // `shuttingDown`, exactly as `/sandcastle-stop` graceful does. Fired
      // from `claim` (AFTER the ticket is dealt and claimed), not from
      // `ticketStartHook` (which fires BEFORE the dealer is even asked for a
      // card) — #1191 finding A made the dealer's own refill short-circuit
      // once `shuttingDown`/`stopDealing` is set, so a signal fired that
      // early would stop ticket 803 from ever being dealt, and there would
      // be nothing here for the shutdown reconciliation to release.
      claim: async (n) => {
        gh.inProgress.add(n);
        process.emit("SIGTERM", "SIGTERM");
      },
    });

    await runMain(
      makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 1 }),
      deps,
    );

    expect(gh.released.map((r) => r.issue)).toEqual([ISSUE]);
    expect(gh.released[0]!.reason).toContain("shutdown-reconcile");
    // And the board is clean: nothing left claiming to be in flight.
    expect([...gh.inProgress]).toEqual([]);
  });

  it("does NOT release an issue whose lease a live peer holds", async () => {
    // Cross-host: while we were stopping, a peer re-claimed this issue and is
    // working it. Yanking its label mid-work is the theft the startup
    // reconciliation already refuses to commit; the shutdown one must too.
    process.env.SANDCASTLE_CROSS_HOST_LEASE = "1";
    const gh = ghFake();
    const deps = makeDeps({
      ...gh.deps,
      listOpenIssuesWithBodies: QUEUE(),
      run: noAgentRuns,
      quarantine: async () => undefined,
      leaseState: async () => "live",
      // See the SIGTERM-from-`claim` comment on the first test in this
      // describe — #1191 finding A means firing this from `ticketStartHook`
      // (before the ticket is dealt) would leave nothing claimed to test
      // the release-skip against.
      claim: async (n) => {
        gh.inProgress.add(n);
        process.emit("SIGTERM", "SIGTERM");
      },
    });

    await runMain(
      makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 1 }),
      deps,
    );

    expect(gh.released).toEqual([]);
    expect([...gh.inProgress]).toEqual([ISSUE]);
  });

  it("DOES release when that same lease is expired — proving the skip above is the guard, not the plumbing", async () => {
    // The positive control for the test above: identical setup, one word of
    // lease state different.
    process.env.SANDCASTLE_CROSS_HOST_LEASE = "1";
    const gh = ghFake();
    const deps = makeDeps({
      ...gh.deps,
      listOpenIssuesWithBodies: QUEUE(),
      run: noAgentRuns,
      quarantine: async () => undefined,
      leaseState: async () => "expired",
      // See the SIGTERM-from-`claim` comment on the first test in this
      // describe (#1191 finding A).
      claim: async (n) => {
        gh.inProgress.add(n);
        process.emit("SIGTERM", "SIGTERM");
      },
    });

    await runMain(
      makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 1 }),
      deps,
    );

    expect(gh.released.map((r) => r.issue)).toEqual([ISSUE]);
  });

  it("does NOT release on a hot-reload restart — the same host restarts and still owns the work", async () => {
    // Exit 75 is a relaunch on THIS host, not a stop: the wrapper brings the
    // loop straight back and it keeps working the issue it claimed. Handing the
    // label back would let a peer (or the relaunched planner) pick up work that
    // is still in flight.
    const gh = ghFake();
    const deps = makeDeps({
      ...gh.deps,
      listOpenIssuesWithBodies: QUEUE(),
      run: noAgentRuns,
      quarantine: async () => undefined,
      ticketStartHook: (it) => {
        // Iteration 1 claims the issue for real; iteration 2 mutates a tracked
        // file so the restart detector fires.
        if (it === 2) {
          writeFileSync(path.join(repo, ".sandcastle/models.ts"), "// touched\n");
        }
      },
    });

    const result = await runMain(
      makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 2 }),
      deps,
    );

    // Prove the run really ended down the hot-reload path…
    expect(result.exitCode).toBe(75);
    // …and that it claimed the issue on the way (otherwise "no release" is
    // vacuous).
    expect([...gh.inProgress]).toEqual([ISSUE]);
    expect(gh.released).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The shutdown reconciliation in isolation. The runMain tests above pin WHEN it
// runs; these pin what it will and will not touch — the safety half. Releasing
// the wrong issue is worse than leaving a stale label: `releaseViaLabel` puts
// `ready-for-agent` back on, and the next run then re-builds a ticket whose
// code already shipped.
// ---------------------------------------------------------------------------
describe("releaseHeldLabelsOnShutdown", () => {
  function harness(over: Partial<Parameters<typeof releaseHeldLabelsOnShutdown>[0]["deps"]> = {}) {
    const released: number[] = [];
    const logs: string[] = [];
    const errors: string[] = [];
    const deps = {
      release: async (n: number) => {
        released.push(n);
      },
      listIssuesByLabel: async () => [],
      leaseState: async () => "absent" as const,
      log: (l: string) => logs.push(l),
      logError: (l: string) => errors.push(l),
      ...over,
    } as Parameters<typeof releaseHeldLabelsOnShutdown>[0]["deps"];
    return { released, logs, errors, deps };
  }

  const inProgress = (...nums: number[]) =>
    nums.map((n) => ({ number: n, title: `issue ${n}`, labels: ["in-progress"] }));

  it("does not touch an issue that has since left in-progress (shipped, quarantined, closed)", async () => {
    // The reason it re-reads GitHub instead of trusting its own claim record:
    // most claimed issues are `done` by the time the run stops.
    const h = harness({ listIssuesByLabel: async () => [] });
    await releaseHeldLabelsOnShutdown({
      deps: h.deps,
      claimed: new Set([803, 838]),
      leaseEnabled: false,
    });
    expect(h.released).toEqual([]);
  });

  it("does not touch an in-progress issue this host never claimed", async () => {
    // A peer's issue, or one left by an earlier run: startup reconciliation
    // owns that case, under the single-instance lock. This pass does not.
    const h = harness({ listIssuesByLabel: async () => inProgress(999) });
    await releaseHeldLabelsOnShutdown({
      deps: h.deps,
      claimed: new Set([803]),
      leaseEnabled: false,
    });
    expect(h.released).toEqual([]);
  });

  it("releases the intersection: ours, and still in-progress", async () => {
    const h = harness({ listIssuesByLabel: async () => inProgress(803, 999) });
    await releaseHeldLabelsOnShutdown({
      deps: h.deps,
      claimed: new Set([803, 838]),
      leaseEnabled: false,
    });
    expect(h.released).toEqual([803]);
  });

  it("skips the lease check entirely when the lease is off (single-host stays single-host)", async () => {
    let consulted = false;
    const h = harness({
      listIssuesByLabel: async () => inProgress(803),
      leaseState: async () => {
        consulted = true;
        return "absent" as const;
      },
    });
    await releaseHeldLabelsOnShutdown({
      deps: h.deps,
      claimed: new Set([803]),
      leaseEnabled: false,
    });
    expect(consulted).toBe(false);
    expect(h.released).toEqual([803]);
  });

  it("degrades to a logged error, and releases nothing, when the label read fails", async () => {
    const h = harness({
      listIssuesByLabel: async () => {
        throw new Error("gh is down");
      },
    });
    await expect(
      releaseHeldLabelsOnShutdown({
        deps: h.deps,
        claimed: new Set([803]),
        leaseEnabled: false,
      }),
    ).resolves.toBeUndefined();
    expect(h.released).toEqual([]);
    expect(h.errors.join("\n")).toContain("shutdown reconciliation skipped");
  });

  it("keeps going after one issue's release throws — and never throws itself", async () => {
    const released: number[] = [];
    const h = harness({
      listIssuesByLabel: async () => inProgress(803, 838),
      release: async (n: number) => {
        if (n === 803) throw new Error("gh: HTTP 500");
        released.push(n);
      },
    });
    await expect(
      releaseHeldLabelsOnShutdown({
        deps: h.deps,
        claimed: new Set([803, 838]),
        leaseEnabled: false,
      }),
    ).resolves.toBeUndefined();
    expect(released).toEqual([838]);
    expect(h.errors.join("\n")).toContain("failed to release #803");
  });

  it("makes no GitHub call at all when this host claimed nothing", async () => {
    let read = false;
    const h = harness({
      listIssuesByLabel: async () => {
        read = true;
        return [];
      },
    });
    await releaseHeldLabelsOnShutdown({
      deps: h.deps,
      claimed: new Set(),
      leaseEnabled: false,
    });
    expect(read).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The circuit breaker counts CRASHES and PARKED TICKETS separately (issue
// #969). A `quarantined` outcome is the loop working as designed — the ticket
// is parked for a human — and used to increment the same counter an `error`
// (a genuine malfunction) does. On 2026-08-04, with four tickets in flight per
// iteration, that tripped the 3-strike breaker at 5 and ended a 71-ticket run
// at iteration 3 of 71.
//
// Driven through a real `runMain` against a real temp repo: an outcome is
// produced by the actual pipeline (a thrown `createSandbox` quarantines; a
// thrown `quarantine` dep makes it an `error`), never by hand-setting a
// counter.
// ---------------------------------------------------------------------------

describe("runMain — the circuit breaker's two counters", () => {
  let repo: string;
  let origin: string;
  const BRANCH = "sandcastle/breaker-run";

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sc-breaker-repo-"));
    origin = mkdtempSync(path.join(tmpdir(), "sc-breaker-origin-"));
    git(origin, "init", "-q", "--bare", "-b", "main");
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
    git(repo, "commit", "--allow-empty", "-q", "-m", "init");
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-q", "origin", "main");
    git(repo, "checkout", "-q", "-b", BRANCH);
    // Without this the status writes ENOENT into a swallowed onError and the
    // terminal-state assertion below would pass while asserting nothing.
    mkdirSync(path.join(repo, ".sandcastle"), { recursive: true });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  });

  const LOGS: string[] = [];

  /**
   * Deps whose every iteration quarantines: the queue holds one ready ticket,
   * and `createSandbox` throws a non-transient error, which the pipeline's own
   * error handler converts into a `quarantined` outcome (recovery is off in
   * `makeArgs`).
   */
  function quarantineEveryIteration(over: Partial<Deps> = {}): Deps {
    return makeDeps({
      listOpenIssuesWithBodies: readyIssues({ number: 1, title: "t" }),
      run: async () => ({ stdout: "", commits: [] }),
      createSandbox: (async () => {
        throw new Error("sandbox boom — this ticket parks for a human");
      }) as unknown as Deps["createSandbox"],
      log: (l: string) => LOGS.push(l),
      logError: (l: string) => LOGS.push(l),
      ...over,
    });
  }

  beforeEach(() => {
    LOGS.length = 0;
  });

  it("four consecutive quarantines under the quarantine limit do NOT trip it", async () => {
    // The 2026-08-04 night in miniature: every ticket parks, the crash limit is
    // the shipped default of 3, and the run must keep going regardless.
    const result = await runMain(
      makeArgs({
        repoRoot: repo,
        branch: BRANCH,
        iterations: 4,
        consecutiveFailureLimit: 3,
        quarantineLimit: 8,
      }),
      quarantineEveryIteration(),
    );

    expect(result.exitCode).toBe(2); // clean — just out of cycles
    expect(result.iterationsRun).toBe(4);
    expect(result.quarantinedIssues).toHaveLength(4);
  });

  it("trips at the quarantine limit, and says WHICH counter tripped", async () => {
    const result = await runMain(
      makeArgs({
        repoRoot: repo,
        branch: BRANCH,
        iterations: 5,
        consecutiveFailureLimit: 99,
        quarantineLimit: 2,
      }),
      quarantineEveryIteration(),
    );

    expect(result.exitCode).toBe(1);
    expect(result.iterationsRun).toBe(2);
    // A trip message that does not name its counter sends the reader hunting
    // for a crash that never happened.
    const trip = LOGS.find((l) => l.includes("Circuit breaker tripped"));
    expect(trip).toMatch(/quarantine/i);
    expect(trip).toContain("2");
  });

  it("three consecutive ERRORS still trip at the consecutive-failure limit", async () => {
    // Unchanged behaviour, pinned: a `quarantine` dep that throws is the loop
    // failing to even park the ticket — a genuine malfunction, not a decision.
    const result = await runMain(
      makeArgs({
        repoRoot: repo,
        branch: BRANCH,
        iterations: 5,
        consecutiveFailureLimit: 3,
        quarantineLimit: 8,
      }),
      quarantineEveryIteration({
        quarantine: async () => {
          throw new Error("could not even quarantine");
        },
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.iterationsRun).toBe(3);
    const trip = LOGS.find((l) => l.includes("Circuit breaker tripped"));
    expect(trip).toMatch(/consecutive failure/i);
  });

  it("a shipped ticket resets the quarantine counter", async () => {
    // Q Q OK Q Q Q against a limit of 3. With the reset the breaker trips on
    // the SIXTH iteration; without it, on the fourth. Asserting the iteration
    // count is what tells those two apart — the exit code is 1 either way.
    const script = [
      "quarantine",
      "quarantine",
      "ship",
      "quarantine",
      "quarantine",
      "quarantine",
    ] as const;
    let iterationIndex = -1;
    const agentRun = makeShippingAgentRunForBreaker();
    const deps = makeDeps({
      listOpenIssuesWithBodies: readyIssues({ number: 412, title: "t" }),
      run: (async (spec: { name: string }) => agentRun(spec)) as unknown as Deps["run"],
      // The script advances once per ATTEMPT. It used to advance on the
      // planner agent's dispatch, one per refill; there is no such dispatch
      // now, and `createSandbox` is the first thing every attempt reaches.
      createSandbox: (async () => {
        iterationIndex += 1;
        if (script[iterationIndex] !== "ship") {
          throw new Error("sandbox boom — this ticket parks for a human");
        }
        return {
          run: agentRun,
          branch: "agent/issue-412",
          close: async () => undefined,
          cleanup: async () => undefined,
          worktreePath: undefined,
        };
      }) as unknown as Deps["createSandbox"],
      captureSha: async () => "abc123",
      log: (l: string) => LOGS.push(l),
      logError: (l: string) => LOGS.push(l),
    });

    const result = await runMain(
      makeArgs({
        repoRoot: repo,
        branch: BRANCH,
        iterations: 8,
        consecutiveFailureLimit: 99,
        quarantineLimit: 3,
      }),
      deps,
    );

    expect(result.exitCode).toBe(1);
    expect(result.iterationsRun).toBe(6);
    expect(result.shippedIssues).toEqual([412]);
  });

  it("stamps a TERMINAL status when it trips — the feed must not stay 'running'", async () => {
    // The published status ref used to freeze on `state: "running"` forever,
    // so /sandcastle-status reported a deliberate stop as a crash hours later
    // and the run PR body read like a clean night.
    await runMain(
      makeArgs({
        repoRoot: repo,
        branch: BRANCH,
        iterations: 5,
        consecutiveFailureLimit: 99,
        quarantineLimit: 2,
      }),
      quarantineEveryIteration(),
    );

    const status = JSON.parse(
      readFileSync(path.join(repo, ".sandcastle", "status.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(status.state).not.toBe("running");
    expect(status.state).toBe("unhealthy");
  });

  it(
    "#902: trips on the COMPLETION that crosses the limit, not the deal order — a slow middle ticket doesn't delay the trip",
    async () => {
    // Three tickets dealt in ONE refill (maxConcurrent 2, stack size 4 fits
    // all three): #1 and #3 quarantine immediately, #2 sits blocked until
    // released. #3 was dealt SECOND (after #2), but it's #1-then-#3 that
    // trips the breaker — the round loop this replaced could only trip in
    // PLAN order; the pool trips in whichever order completions actually
    // arrive, and #2 (still building) proves it wasn't waited on.
    let releaseSlow!: () => void;
    const slow = new Promise<void>((r) => {
      releaseSlow = r;
    });
    const deps = makeDeps({
      // Dealt in issue-number order, which is what the host ranks by.
      listOpenIssuesWithBodies: readyIssues(
        { number: 1, title: "fast-a" },
        { number: 2, title: "slow-middle" },
        { number: 3, title: "fast-c" },
      ),
      run: async () => ({ stdout: "", commits: [] }),
      createSandbox: (async (spec: { branch: string }) => {
        if (spec.branch === "agent/issue-2") await slow;
        throw new Error("sandbox boom — this ticket parks for a human");
      }) as unknown as Deps["createSandbox"],
      log: (l: string) => LOGS.push(l),
      logError: (l: string) => LOGS.push(l),
    });

    const done = runMain(
      makeArgs({
        repoRoot: repo,
        branch: BRANCH,
        iterations: 3,
        maxConcurrent: 2,
        consecutiveFailureLimit: 99,
        quarantineLimit: 2,
      }),
      deps,
    );

    // Startup runs several best-effort `gh label create` calls against a
    // fake local "origin" (no real GitHub host); each pays its own real
    // subprocess overhead before failing, well before the planner is ever
    // dispatched — a short fixed delay here would race that and release #2
    // before it was even dealt. `vi.waitFor` polls instead, with a timeout
    // generous enough to outlast that startup cost.
    await vi.waitFor(
      () => {
        expect(LOGS.some((l) => l.includes("Circuit breaker tripped"))).toBe(
          true,
        );
      },
      { timeout: 15_000, interval: 50 },
    );
    // #2's pipeline is still blocked on `slow` when the trip fires — proof
    // the trip did not wait for every dealt ticket to settle first.
    releaseSlow();

    const result = await done;
    expect(result.exitCode).toBe(1);
    expect(result.iterationsRun).toBe(3);
    // All three still finish (in-flight siblings run to completion after a
    // trip, they are just not replaced with new work) — #2 included, even
    // though it settled after the trip already latched.
      expect(result.quarantinedIssues.sort()).toEqual([1, 2, 3]);
    },
    20_000,
  );
});

// ---------------------------------------------------------------------------
// #902 (rolling refill): the round loop's replacement — a `maxConcurrent`
// worker pool pulling from a dealer, with merges on their own serial lane —
// proven by the ONE property a round loop structurally cannot have: a fast
// ticket's merge must not wait on a slow sibling still building in the SAME
// batch. Adapted from the plan's sketch to the real seams (confirmed by
// reading the code, not assumed): the implementer's own `promptArgs` key for
// the issue number is `ISSUE_NUMBER` (`main.mts`, the `runImplementer`
// dispatch); the merger's `promptArgs` in THIS commit are still the
// pre-#902-B8 `BRANCHES`/`ISSUES` list shape (B8 moves it to a singular
// `BRANCH`), so the merger call is identified by `BRANCHES` containing the
// branch name instead of a singular `BRANCH` key; `createSandbox`'s spec is
// `{ branch, implementerModel }` per `runIssuePipeline`.
// ---------------------------------------------------------------------------
describe("runMain — a fast ticket merges while a slow sibling is still building", () => {
  let repo: string;
  let origin: string;
  const BRANCH = "sandcastle/rolling-refill-run";

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sc-pool-repo-"));
    origin = mkdtempSync(path.join(tmpdir(), "sc-pool-origin-"));
    git(origin, "init", "-q", "--bare", "-b", "main");
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
    git(repo, "commit", "--allow-empty", "-q", "-m", "init");
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-q", "origin", "main");
    git(repo, "checkout", "-q", "-b", BRANCH);
    mkdirSync(path.join(repo, ".sandcastle"), { recursive: true });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  });

  it(
    "dispatches the merger for #1 before #2's implementer has returned",
    async () => {
    const calls: string[] = [];
    let releaseSlow!: () => void;
    const slow = new Promise<void>((r) => {
      releaseSlow = r;
    });
    const ship = makeShippingAgentRunForBreaker();
    /** Every "dealer refill #N" line the run printed — the pool's own count of
     *  how many times it went back for more work. There is no planner agent to
     *  count calls to any more, so this is what "asked for more" looks like. */
    const refills: string[] = [];
    const agentRun = async (spec: {
      name: string;
      promptArgs?: Record<string, string>;
    }): Promise<unknown> => {
      const key =
        spec.promptArgs?.ISSUE_NUMBER ??
        spec.promptArgs?.BRANCHES ??
        spec.promptArgs?.BRANCH ??
        "";
      calls.push(`${spec.name}:${key}`);
      if (
        spec.name.startsWith("implementer") &&
        spec.promptArgs?.ISSUE_NUMBER === "2"
      ) {
        await slow;
      }
      return ship({ name: spec.name });
    };
    const deps = makeDeps({
      listOpenIssuesWithBodies: readyIssues(
        { number: 1, title: "fast" },
        { number: 2, title: "slow" },
      ),
      log: (l: string) => {
        if (l.startsWith("dealer refill ")) refills.push(l);
      },
      run: (async (spec: {
        name: string;
        promptArgs?: Record<string, string>;
      }) => agentRun(spec)) as unknown as Deps["run"],
      createSandbox: (async (spec: { branch: string }) => ({
        run: agentRun,
        branch: spec.branch,
        close: async () => undefined,
        cleanup: async () => undefined,
        worktreePath: undefined,
      })) as unknown as Deps["createSandbox"],
      captureSha: async () => "abc123",
    });

    const done = runMain(
      makeArgs({
        repoRoot: repo,
        branch: BRANCH,
        iterations: 2,
        maxConcurrent: 2,
      }),
      deps,
    );

    // See the completion-order test above for why this needs a generous
    // timeout: startup's best-effort `gh label create` calls against a fake
    // local "origin" each pay real subprocess overhead before failing.
    await vi.waitFor(
      () =>
        expect(
          calls.some(
            (c) => c.startsWith("merger:") && c.includes("agent/issue-1"),
          ),
        ).toBe(true),
      { timeout: 15_000, interval: 50 },
    );
    expect(
      calls.some(
        (c) => c.startsWith("merger:") && c.includes("agent/issue-2"),
      ),
    ).toBe(false);
    releaseSlow();

    const result = await done;
    expect(result.exitCode).toBe(2);
    // The cap counts ATTEMPTS, incremented the moment each ticket wins its
    // lease — both tickets are dealt from the SAME initial refill (stack
    // size 4 for maxConcurrent 2), so the cap is already hit before either
    // finishes, and the pool never refills a second time.
    expect(result.iterationsRun).toBe(2);
      expect(result.shippedIssues.sort()).toEqual([1, 2]);
      expect(refills).toHaveLength(1);
      // And no planner AGENT was dispatched at all — the plan is computed on
      // the host, so `deps.run` never sees a role by that name.
      expect(calls.some((c) => c.startsWith("planner"))).toBe(false);
    },
    20_000,
  );
});

// ---------------------------------------------------------------------------
// #1191 finding A: a worker parked inside `dealer.next()` — waiting on a
// sibling's `done()` because the stack was empty but something was still
// building — used to ignore both a SIGTERM and the ticket cap once it woke
// up, because `shuttingDown`/the cap were only checked at the TOP of
// `worker()`'s while loop, a point a parked worker has long since passed.
// These pin the fix: the woken worker must re-check both, synchronously,
// with the freshly-dealt card already in hand, before doing anything with
// it.
// ---------------------------------------------------------------------------
describe("runMain — #1191 finding A: a parked worker after SIGTERM or at cap", () => {
  let repo: string;
  let origin: string;
  const BRANCH = "sandcastle/parked-worker-run";

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sc-parked-repo-"));
    origin = mkdtempSync(path.join(tmpdir(), "sc-parked-origin-"));
    git(origin, "init", "-q", "--bare", "-b", "main");
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
    git(repo, "commit", "--allow-empty", "-q", "-m", "init");
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-q", "origin", "main");
    git(repo, "checkout", "-q", "-b", BRANCH);
    mkdirSync(path.join(repo, ".sandcastle"), { recursive: true });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  });

  /**
   * A one-ticket "queue" — every planner call offers the same single issue
   * #1. With `maxConcurrent: 2` this guarantees the SECOND worker parks
   * inside `dealer.next()` (nothing on the stack, one card in flight)
   * instead of getting a distinct second card — the exact shape the bug
   * needs: the parked worker's wake-up is what must re-check, not a race
   * between two workers each holding their own card.
   */
  function singleTicketDeps(over: {
    onImplementerStart?: () => void;
    onImplementerStartCount?: { n: number };
  }): Deps {
    const agentRun = async (spec: {
      name: string;
    }): Promise<{ stdout: string; commits: { sha: string; subject: string }[] }> => {
      if (spec.name.startsWith("implementer")) {
        if (over.onImplementerStartCount) over.onImplementerStartCount.n += 1;
        over.onImplementerStart?.();
        const envelope = {
          marker: "STORY_COMPLETE",
          storyType: "backend-only",
          e2eRequired: false,
          e2eActuallyRan: false,
          testCommandUsed: null,
          e2eAssertionLine: null,
          outputNotFiltered: true,
          testReachedFeature: false,
        };
        return {
          stdout: [
            "work done",
            "```json",
            JSON.stringify(envelope),
            "```",
            "STORY_COMPLETE",
          ].join("\n"),
          commits: [{ sha: "abc123", subject: "work" }],
        };
      }
      if (spec.name.startsWith("check-writer")) {
        const envelope = {
          marker: "NO_SCREEN_APPLIES",
          inherited: false,
          noScreenReason: "fixture issue — no real screen involved",
        };
        return {
          stdout: [
            "reasoning",
            "```json",
            JSON.stringify(envelope),
            "```",
            "NO_SCREEN_APPLIES",
          ].join("\n"),
          commits: [],
        };
      }
      if (spec.name.startsWith("reviewer")) {
        return { stdout: "looks good\nALL_CLEAR", commits: [] };
      }
      return { stdout: "", commits: [] };
    };
    return makeDeps({
      listOpenIssuesWithBodies: readyIssues({
        number: 1,
        title: "the only ticket",
      }),
      run: (async (spec: { name: string }) => agentRun(spec)) as unknown as Deps["run"],
      createSandbox: (async (spec: { branch: string }) => ({
        run: agentRun,
        branch: spec.branch,
        close: async () => undefined,
        cleanup: async () => undefined,
        worktreePath: undefined,
      })) as unknown as Deps["createSandbox"],
      captureSha: async () => "abc123",
    });
  }

  it("a parked worker woken by a sibling's done() after SIGTERM starts no new ticket", async () => {
    const implementerStarts = { n: 0 };
    const deps = singleTicketDeps({
      onImplementerStartCount: implementerStarts,
      // Fires mid-way through the ONLY ticket's implementer step — after the
      // second worker has already parked (nothing else on the stack), before
      // that first ticket ships and its `dealer.done()` wakes the parked
      // worker back up.
      onImplementerStart: () => {
        if (implementerStarts.n === 1) process.emit("SIGTERM", "SIGTERM");
      },
    });

    const result = await runMain(
      makeArgs({
        repoRoot: repo,
        branch: BRANCH,
        iterations: 5,
        maxConcurrent: 2,
      }),
      deps,
    );

    // Exactly one ticket was ever built, even though the woken worker's
    // refill re-offers the same issue #1 (it is no longer in flight once
    // `done()` fires) — `dealFromPlanner`'s own `shuttingDown` short-circuit
    // stops that refill from producing anything to hand out.
    expect(implementerStarts.n).toBe(1);
    expect(result.iterationsRun).toBe(1);
    expect(result.shippedIssues).toEqual([1]);
  });

  it("reports a SIGTERM-drained run as stopped/exit 2, not done/exit 0", async () => {
    // Fire the SIGTERM once the only ticket has already been dealt to
    // worker #1 (parking worker #2).
    let starts = 0;
    const deps = singleTicketDeps({
      onImplementerStart: () => {
        starts += 1;
        if (starts === 1) process.emit("SIGTERM", "SIGTERM");
      },
    });

    const result = await runMain(
      makeArgs({
        repoRoot: repo,
        branch: BRANCH,
        iterations: 5,
        maxConcurrent: 2,
      }),
      deps,
    );

    expect(result.exitCode).toBe(2);
    const status = JSON.parse(
      readFileSync(path.join(repo, ".sandcastle", "status.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(status.state).toBe("stopped");
  });

  it("cap 1 with concurrency 2 attempts exactly 1 ticket, even once the parked worker wakes", async () => {
    const implementerStarts = { n: 0 };
    const deps = singleTicketDeps({ onImplementerStartCount: implementerStarts });

    const result = await runMain(
      makeArgs({
        repoRoot: repo,
        branch: BRANCH,
        iterations: 1,
        maxConcurrent: 2,
      }),
      deps,
    );

    // Worker #2 parked (nothing on the stack while #1 was in flight), then
    // woke on #1's `done()` and refilled — the planner still has issue #1 to
    // offer (this fixture never removes it), so without the post-`next()`
    // cap re-check worker #2 would build it too, a second attempt over a
    // cap of 1.
    expect(implementerStarts.n).toBe(1);
    expect(result.iterationsRun).toBe(1);
    expect(result.exitCode).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// #1191 finding G: `statusStore.setPlan` used to run over a refill's raw
// output BEFORE the dealer's own dedup against its in-flight set — so a plan
// that re-offers a ticket already building has that ticket never actually
// re-dispatched (the dealer's own `seen` set drops the dupe), but the status
// feed's row for it got reset to `planned` anyway, and the viewer showed a
// building ticket as merely queued. `planDeterministic` drops the in-flight
// set itself now, so the filter under test is a second line rather than the
// first — and it is still the only one covering the `--issue N` road.
// ---------------------------------------------------------------------------
describe("runMain — #1191 finding G: a re-offered in-flight ticket must not reset its status row", () => {
  let repo: string;
  let origin: string;
  const BRANCH = "sandcastle/replan-run";

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sc-replan-repo-"));
    origin = mkdtempSync(path.join(tmpdir(), "sc-replan-origin-"));
    git(origin, "init", "-q", "--bare", "-b", "main");
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
    git(repo, "commit", "--allow-empty", "-q", "-m", "init");
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-q", "origin", "main");
    git(repo, "checkout", "-q", "-b", BRANCH);
    mkdirSync(path.join(repo, ".sandcastle"), { recursive: true });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  });

  it("leaves a still-building ticket's status row alone when a refill re-offers its siblings", async () => {
    let releaseSlow!: () => void;
    const slow = new Promise<void>((r) => {
      releaseSlow = r;
    });
    const agentRun = async (spec: {
      name: string;
      promptArgs?: Record<string, string>;
    }): Promise<{ stdout: string; commits: { sha: string; subject: string }[] }> => {
      if (
        spec.name.startsWith("implementer") &&
        spec.promptArgs?.ISSUE_NUMBER === "2"
      ) {
        await slow;
      }
      if (spec.name.startsWith("implementer")) {
        const envelope = {
          marker: "STORY_COMPLETE",
          storyType: "backend-only",
          e2eRequired: false,
          e2eActuallyRan: false,
          testCommandUsed: null,
          e2eAssertionLine: null,
          outputNotFiltered: true,
          testReachedFeature: false,
        };
        return {
          stdout: [
            "work done",
            "```json",
            JSON.stringify(envelope),
            "```",
            "STORY_COMPLETE",
          ].join("\n"),
          commits: [{ sha: "abc123", subject: "work" }],
        };
      }
      if (spec.name.startsWith("check-writer")) {
        const envelope = {
          marker: "NO_SCREEN_APPLIES",
          inherited: false,
          noScreenReason: "fixture issue — no real screen involved",
        };
        return {
          stdout: [
            "reasoning",
            "```json",
            JSON.stringify(envelope),
            "```",
            "NO_SCREEN_APPLIES",
          ].join("\n"),
          commits: [],
        };
      }
      if (spec.name.startsWith("reviewer")) {
        return { stdout: "looks good\nALL_CLEAR", commits: [] };
      }
      return { stdout: "", commits: [] };
    };

    const deps = makeDeps({
      // The listing never changes (the fixture has no `gh` behind it), so the
      // second refill re-offers everything that is not currently in flight —
      // exactly the input `setPlan`'s own in-flight filter has to survive.
      listOpenIssuesWithBodies: readyIssues(
        { number: 1, title: "fast" },
        { number: 2, title: "slow" },
        { number: 3, title: "new" },
      ),
      run: (async (spec: {
        name: string;
        promptArgs?: Record<string, string>;
      }) => agentRun(spec)) as unknown as Deps["run"],
      createSandbox: (async (spec: { branch: string }) => ({
        run: agentRun,
        branch: spec.branch,
        close: async () => undefined,
        cleanup: async () => undefined,
        worktreePath: undefined,
      })) as unknown as Deps["createSandbox"],
      captureSha: async () => "abc123",
    });

    const done = runMain(
      makeArgs({
        repoRoot: repo,
        branch: BRANCH,
        iterations: 3,
        maxConcurrent: 2,
      }),
      deps,
    );

    // Wait for #3 to land in the status feed — proof a refill has been
    // processed by `setPlan` while #2 is still building.
    const readStatus = (): Record<string, unknown> =>
      JSON.parse(
        readFileSync(path.join(repo, ".sandcastle", "status.json"), "utf8"),
      ) as Record<string, unknown>;
    await vi.waitFor(
      () => {
        const status = readStatus();
        const issues = status.issues as { number: number }[];
        expect(issues.some((i) => i.number === 3)).toBe(true);
      },
      { timeout: 15_000, interval: 50 },
    );

    const status = readStatus();
    const issues = status.issues as { number: number; phase: string }[];
    const two = issues.find((i) => i.number === 2);
    // #2 is still building (blocked on `slow`) — no refill may reset it back
    // to "planned". TWO readers enforce that now and both are load-bearing:
    // `planDeterministic` drops every in-flight card before it ranks, and
    // `setPlan`'s own filter (#1191 finding G) is the second one, kept because
    // the status feed must not depend on the planner getting it right.
    expect(two?.phase).not.toBe("planned");

    releaseSlow();
    const result = await done;
    expect(result.shippedIssues.sort()).toEqual([1, 2, 3]);
  });
});


/**
 * The shipping agent stub, hoisted for the breaker's reset test. A copy of
 * `makeShippingAgentRun` in the telemetry describe above, minus the cost
 * fixture — this test cares only that an outcome comes back `ok`.
 */
function makeShippingAgentRunForBreaker(): (spec: {
  name: string;
}) => Promise<unknown> {
  return async (spec: { name: string }): Promise<unknown> => {
    if (spec.name.startsWith("check-writer")) {
      const envelope = {
        marker: "NO_SCREEN_APPLIES",
        inherited: false,
        noScreenReason: "fixture issue — no real screen involved",
      };
      return {
        stdout: [
          "reasoning",
          "```json",
          JSON.stringify(envelope),
          "```",
          "NO_SCREEN_APPLIES",
        ].join("\n"),
        commits: [],
      };
    }
    if (spec.name.startsWith("implementer")) {
      const envelope = {
        marker: "STORY_COMPLETE",
        storyType: "backend-only",
        e2eRequired: false,
        e2eActuallyRan: false,
        testCommandUsed: null,
        e2eAssertionLine: null,
        outputNotFiltered: true,
        testReachedFeature: false,
      };
      return {
        stdout: [
          "work done",
          "```json",
          JSON.stringify(envelope),
          "```",
          "STORY_COMPLETE",
        ].join("\n"),
        commits: [{ sha: "abc123", subject: "work" }],
      };
    }
    if (spec.name.startsWith("reviewer")) {
      return { stdout: "looks good\nALL_CLEAR", commits: [] };
    }
    return { stdout: "", commits: [] };
  };
}

// ---------------------------------------------------------------------------
// Default drift between the CLI parser and the non-CLI fallback bag.
//
// `hardCeilingSec` was written down as a bare literal in TWO places. On
// 2026-08-03 a change lowered 3600 -> 1800 in `defaultArgs()` and in the
// `--help` text but MISSED `parseSandcastleArgs`, which is the only path a
// CLI-launched loop takes. For four days the docs said 30 minutes, the code
// used 60, and nothing failed — until the 2026-08-07 issue-#803 post-mortem
// had to reconcile a log that said `exceeded 3600s` against a comment that
// said 1800.
//
// The resolution kept 3600 (a real implementer legitimately ran 91 minutes
// that day; 1800 would have false-killed it — a stuck agent is the IDLE
// timer's job). What must never come back is the SPLIT, so these pin the two
// paths to each other rather than to a number, and cover the sibling
// timeouts that are spelled out twice the same way.
// ---------------------------------------------------------------------------
describe("CLI defaults match the non-CLI fallback bag", () => {
  /** The only flag `parseSandcastleArgs` insists on; everything else defaults. */
  const MINIMAL_ARGV = ["--iterations", "1"] as const;

  it("agrees on hardCeilingSec", () => {
    expect(parseSandcastleArgs(MINIMAL_ARGV).args.hardCeilingSec).toBe(
      defaultArgs().hardCeilingSec,
    );
  });

  it("holds hardCeilingSec at 3600s — one hour bounds a whole role", () => {
    // Both paths, so lowering either one alone still fails here.
    expect(parseSandcastleArgs(MINIMAL_ARGV).args.hardCeilingSec).toBe(3600);
    expect(defaultArgs().hardCeilingSec).toBe(3600);
  });

  it("agrees on every other duplicated numeric default", () => {
    const cli = parseSandcastleArgs(MINIMAL_ARGV).args;
    const fallback = defaultArgs();
    const pick = (a: SandcastleArgs) => ({
      maxConcurrent: a.maxConcurrent,
      implementerTimeoutSec: a.implementerTimeoutSec,
      reviewerTimeoutSec: a.reviewerTimeoutSec,
      hardCeilingSec: a.hardCeilingSec,
      consecutiveFailureLimit: a.consecutiveFailureLimit,
      quarantineLimit: a.quarantineLimit,
    });
    expect(pick(cli)).toEqual(pick(fallback));
  });

  it("still documents the ceiling default it actually uses", () => {
    // The 2026-08-03 drift survived because the help text was a third,
    // independent copy of the number. Assert the rendered text agrees.
    const { showHelp } = parseSandcastleArgs(["--help"]);
    expect(showHelp).toBe(true);
    expect(HELP_TEXT).toContain(`Default: ${defaultArgs().hardCeilingSec}`);
  });
});

// ---------------------------------------------------------------------------
// THE BLOCKED-BY GATE (2026-09-03). `lib/state/blocked-by.test.ts` proves the
// RULE in isolation. These tests prove the WIRING — that `runMain` actually
// refuses to claim a blocked pick — on the same real-git `runMain` harness the
// #1143 dispatch-gate tests use.
//
// The bug being closed: `Blocked-by:` was honoured by exactly one thing, the
// planner AGENT reading HARD RULE 2 in `.sandcastle/plan-prompt.md`. On
// 2026-09-03 its own log said "#1065 — no blockers in body → eligible" while
// line 1 of #1065's body read `Blocked-by: #1038`, and #1038 was open and
// dealt in the same refill. Both tickets edited the same file.
//
// Both halves are covered on purpose: the plan-time filter, and the DEAL-time
// re-check (a dependent can sit on the dealer's stack for hours while its
// blocker is in flight, so a plan-time check alone is not a gate).
// ---------------------------------------------------------------------------
describe("runMain — Blocked-by is a code gate, not only a planner rule", () => {
  let repo: string;
  let origin: string;
  const BRANCH = "sandcastle/blocked-by-gate-run";

  /** #1065's real shape on 2026-09-03: the directive is line 1, hyphenated. */
  const BODY_1065 = "Blocked-by: #1038\n\nSome ticket text.\n";

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sc-blocked-by-repo-"));
    origin = mkdtempSync(path.join(tmpdir(), "sc-blocked-by-origin-"));
    git(origin, "init", "-q", "--bare", "-b", "main");
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
    git(repo, "commit", "--allow-empty", "-q", "-m", "init");
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-q", "origin", "main");
    mkdirSync(path.join(repo, ".sandcastle"), { recursive: true });
    git(repo, "checkout", "-q", "-b", BRANCH);
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  });

  type OpenRow = {
    number: number;
    title: string;
    body: string;
    labels: string[];
  };

  /** The status snapshot `runMain` left on disk, schema-validated. */
  function gateStatus(): Record<string, unknown> {
    const raw = JSON.parse(
      readFileSync(path.join(repo, ".sandcastle", "status.json"), "utf8"),
    ) as Record<string, unknown>;
    const parsed = SandcastleStatusSchema.safeParse(raw);
    expect(parsed.error?.issues).toBeUndefined();
    return raw;
  }

  /**
   * The deps every case here shares. `openIssues` IS the fixture now: the host
   * plans off that one listing, so what a test wants planned is simply what it
   * puts in the listing with the ready label on it.
   */
  function gateDeps(
    openIssues: () => Promise<readonly OpenRow[]>,
    onClaim?: (issueNum: number) => void,
  ): {
    deps: Deps;
    claimed: number[];
    logs: string[];
    errors: string[];
  } {
    const claimed: number[] = [];
    const logs: string[] = [];
    const errors: string[] = [];
    const deps = makeDeps({
      // No planner agent exists to stub. Any `deps.run` call from this fixture
      // would be a role that has no business running before a sandbox.
      run: (async (spec: { name: string }) => {
        throw new Error(`unexpected deps.run(${spec.name})`);
      }) as unknown as Deps["run"],
      listOpenIssuesWithBodies:
        openIssues as unknown as Deps["listOpenIssuesWithBodies"],
      claim: async (n: number) => {
        claimed.push(n);
        onClaim?.(n);
      },
      // Throw so each dispatched ticket unwinds immediately instead of running
      // an un-stubbed check-writer. Reaching here at all proves the ticket got
      // past the gate; the gate's own proof is `claimed`.
      createSandbox: (async () => {
        throw new Error("createSandbox reached");
      }) as unknown as Deps["createSandbox"],
      quarantine: async () => undefined,
      log: (line: string) => logs.push(line),
      logError: (line: string) => errors.push(line),
    });
    return { deps, claimed, logs, errors };
  }

  it("does NOT deal #1065 while its blocker #1038 is open — and still deals #1038", async () => {
    const { deps, claimed, logs } = gateDeps(async () => [
      { number: 1038, title: "the blocker", body: "", labels: ["ready-for-agent"] },
      { number: 1065, title: "the dependent", body: BODY_1065, labels: ["ready-for-agent"] },
    ]);

    await runMain(makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 3 }), deps);

    expect(claimed).toContain(1038);
    expect(claimed).not.toContain(1065);
    // The HOST withheld it, before anything was ranked — this is the direction
    // the 2026-09-03 LLM planner got wrong first.
    expect(logs).toContain(
      "skipping issue #1065 — blocked by #1038 (open, labels: ready-for-agent)",
    );
    // And the refill carried ONE card, not two: #1065 never reached the stack.
    expect(logs).toContain("dealer refill #1: 1 issue(s) ranked");
  }, 20_000);

  it("DOES deal #1038 when its own blockers are closed — the direction a subtract-only gate could never fix", async () => {
    // The SECOND 2026-09-03 miss, and the reason the eligible set is computed
    // rather than filtered: the planner dropped #1038 itself, whose blockers
    // #1028 and #1056 are both closed, and nothing downstream could add it
    // back. Here both are absent from the open listing — i.e. closed.
    const { deps, claimed } = gateDeps(async () => [
      {
        number: 1038,
        title: "the blocker",
        body: "Blocked-by: #1028, #1056\n",
        labels: ["ready-for-agent"],
      },
    ]);

    await runMain(makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 3 }), deps);

    expect(claimed).toContain(1038);
  }, 20_000);

  it("DOES deal #1065 once #1038 carries `shipped-local` — the loop leaves finished blockers open, so absence alone can never be the rule", async () => {
    const { deps, claimed } = gateDeps(async () => [
      { number: 1038, title: "the blocker", body: "", labels: ["shipped-local"] },
      { number: 1065, title: "the dependent", body: BODY_1065, labels: ["ready-for-agent"] },
    ]);

    await runMain(makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 3 }), deps);

    // #1038 is finished (it keeps `shipped-local` and stays OPEN until the run
    // PR lands), so it is not queued and not re-claimed — but it no longer
    // holds #1065 back either.
    expect(claimed[0]).toBe(1065);
    expect(claimed).not.toContain(1038);
  }, 20_000);

  it("PLAN time, fetch throws twice: nothing is claimed and the run ends LOUDLY, not 'exiting cleanly' (C1)", async () => {
    // The bug this closes. A planner that cannot read the queue produces the
    // same empty answer as an empty queue; an empty plan drains the dealer; a
    // drained dealer with nothing in flight ended the run as `done` / exit 0,
    // printing "no claimable issues — exiting cleanly". A broken instrument
    // read to a person as a quiet, healthy night. Same failure the `type:`
    // gate's own fail-loud re-throw (`BLOCKED_BY_GATE_FAILURE`) exists to
    // stop, so it ends the same way: a distinctive throw to the CLI's fatal
    // handler.
    const { deps, claimed, errors } = gateDeps(async () => {
      throw new Error("gh boom — could not list open issues");
    });

    await expect(
      runMain(makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 3 }), deps),
    ).rejects.toThrow(/ELIGIBLE_SET_FAILURE/);

    expect(claimed).toEqual([]);
    // The retry ran before it gave up — one `gh` blip must not end a night.
    expect(errors.some((l) => l.includes("retrying once"))).toBe(true);
    expect(
      errors.some(
        (l) => l.includes("ELIGIBLE_SET_FAILURE") && l.includes("gh boom"),
      ),
    ).toBe(true);
    // ...and the status file is FINISHED, not left mid-run. A throw reaches
    // none of the nine `statusStore.finish(...)` calls on `runMain`'s return
    // paths, so before the `catch` was added this road left `state: "running"`
    // with the heartbeat stopped — a dead run showing as live in the viewer,
    // forever. The throw itself is what makes the process exit non-zero: the
    // CLI entry point's own `catch` calls `process.exit(1)`.
    expect(gateStatus().state).toBe("unhealthy");
  }, 20_000);

  it("PLAN time, a listing at its cap: refuses to plan rather than trust a queue it cannot see all of", async () => {
    // Was the planner's `<truncation-halt/>` sentinel — a string an LLM was
    // asked to print about its own input. It is a comparison now.
    const capped: OpenRow[] = [];
    for (let i = 1; i <= 500; i += 1) {
      capped.push({
        number: i,
        title: `issue ${i}`,
        body: "",
        labels: ["ready-for-agent"],
      });
    }
    const { deps, claimed, errors } = gateDeps(async () => capped);

    await expect(
      runMain(makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 3 }), deps),
    ).rejects.toThrow(/ELIGIBLE_SET_FAILURE/);

    expect(claimed).toEqual([]);
    expect(errors.some((l) => l.includes("500-row cap"))).toBe(true);
    // Same as the fetch-failure road above. This one is a REGRESSION guard
    // twice over: the truncation road used to latch `exitCode: 2` and reach
    // `finish("unhealthy")` through the ordinary exit funnel, and swapping
    // that latch for a throw quietly took the stamp away with it.
    expect(gateStatus().state).toBe("unhealthy");
  }, 20_000);

  it("DEAL time, fetch throws: the card is skipped and the run finishes UNHEALTHY, never 'done' (C1)", async () => {
    // A throw out of `validate` is caught by the dealer and treated as VALID
    // (fail-open), so the deal-time half cannot fail loud the way the
    // plan-time half does. It refuses the card and RECORDS that it refused it
    // blind; the drained exit then reports unhealthy / exit 1 instead of
    // done / exit 0.
    //
    // The fetch fails only in the window between #7's claim (which drops the
    // shared memo) and the next refill — a transient `gh` blip, the realistic
    // shape. #1065 has already been dealt onto the stack by then.
    let throwing = false;
    let thrown = 0;
    let claimedFirst = false;
    const { deps, claimed, errors } = gateDeps(
      async () => {
        if (throwing) {
          thrown += 1;
          // Two throws is what the deal-time gate spends before giving up.
          if (thrown >= 2) throwing = false;
          throw new Error("gh blip — could not list open issues");
        }
        return claimedFirst
          ? // #7 is being built and #1065 was closed by a person mid-run, so
            // the refill that follows the blind refusal is legitimately empty
            // and the run drains.
            [{ number: 7, title: "the first card", body: "", labels: ["in-progress"] }]
          : [
              { number: 7, title: "the first card", body: "", labels: ["ready-for-agent"] },
              { number: 1065, title: "the dependent", body: "", labels: ["ready-for-agent"] },
            ];
      },
      (n) => {
        if (n === 7) {
          claimedFirst = true;
          throwing = true;
        }
      },
    );

    const result = await runMain(
      makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 3 }),
      deps,
    );

    // #7 was dealt normally; #1065 was refused while the gate was blind.
    expect(claimed).toEqual([7]);
    expect(thrown).toBe(2);
    expect(result.exitCode).toBe(1);
    expect(
      errors.some(
        (l) =>
          l.includes("the queue looks empty") &&
          l.includes("could not read the open-issue listing"),
      ),
    ).toBe(true);
  }, 20_000);

  it("re-checks at DEAL time: #1065 passes the host's plan, then its blocker goes back to `in-progress` while it sits on the stack", async () => {
    // #1038 looks finished when the plan is made, so #1065 is dealt onto the
    // stack. It stops looking finished the moment #7 (dealt first, lower
    // number) is claimed — the "blocker back in flight while its dependent
    // waits" case a plan-time-only check cannot catch.
    let blockerLabels = ["shipped-local"];
    let claimedFirst = false;
    const { deps, claimed, logs } = gateDeps(
      async () => [
        { number: 7, title: "the first card", body: "", labels: claimedFirst ? ["in-progress"] : ["ready-for-agent"] },
        { number: 1038, title: "the blocker", body: "", labels: [...blockerLabels] },
        { number: 1065, title: "the dependent", body: BODY_1065, labels: ["ready-for-agent"] },
      ],
      (n) => {
        if (n === 7) {
          claimedFirst = true;
          blockerLabels = ["in-progress"];
        }
      },
    );

    await runMain(makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 3 }), deps);

    expect(claimed).toContain(7);
    expect(claimed).not.toContain(1065);
    // The reason names `in-progress`, which only became true AFTER the host's
    // plan had already dealt #1065 — so this skip is the deal-time gate, the
    // belt the host's own computation still needs.
    expect(
      logs.some((l) =>
        l.includes(
          "[blocked-by gate] #1065 skipped: blocked by #1038 (open, labels: in-progress)",
        ),
      ),
    ).toBe(true);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// A SHIPPED BLOCKER MUST FREE ITS DEPENDENT ON THE VERY NEXT REFILL.
//
// The blocked-by gate reads one 500-row `gh issue list` through a 15-second
// memo (`lib/state/open-issue-memo.ts`). Claiming invalidates it. Until this
// fix, SHIPPING did not — so a run whose last ticket was the blocker read a
// listing from before the `shipped-local` flip, withheld the dependent, and
// then hit the dealer's "stack empty, nothing in flight" road. The dealer's
// own safeguard there (drain the merge lane, refill once more,
// `lib/pool/dealer.ts`) could not save it: the extra refill re-read the SAME
// cached listing. `next()` returned `null` and the RUN ENDED with a workable
// ticket sitting in the queue — while `lastPlanExclusions` printed a reason
// that had already stopped being true.
//
// Real time, no fake clock, on purpose: the whole test finishes well inside
// the 15-second TTL, which is exactly the window the bug lived in.
// ---------------------------------------------------------------------------
describe("runMain — a shipped blocker frees its dependent on the next refill", () => {
  let repo: string;
  let origin: string;
  const BRANCH = "sandcastle/memo-invalidate-run";

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sc-memo-repo-"));
    origin = mkdtempSync(path.join(tmpdir(), "sc-memo-origin-"));
    git(origin, "init", "-q", "--bare", "-b", "main");
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
    git(repo, "commit", "--allow-empty", "-q", "-m", "init");
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-q", "origin", "main");
    mkdirSync(path.join(repo, ".sandcastle"), { recursive: true });
    git(repo, "checkout", "-q", "-b", BRANCH);
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  });

  /** Poll until `ready()`, or fail loudly rather than hanging the suite. */
  async function waitFor(what: string, ready: () => boolean): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (!ready()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  it("deals #12 after its blocker #11 ships, instead of draining on a listing cached before the flip", async () => {
    // THE SHAPE THAT OPENS THE STALE WINDOW, built deliberately — the memo is
    // already invalidated by every CLAIM, so the bug needs a memo-populating
    // read that lands AFTER the last claim and BEFORE the ship:
    //
    //   #10 independent and quick · #11 the blocker · #12 `Blocked-by: #11`
    //   three workers, so one has nothing to take and parks
    //
    //   1. refill #1 ranks [#10, #11]; #12 is withheld. Two workers take those
    //      two and claim them (each claim drops the memo); the third parks.
    //   2. #10 ships. Its `done()` wakes the parked worker, which refills —
    //      #11 is still building and #12 is still blocked, so it plans nothing
    //      and parks again. THAT read is what re-populates the memo, with #11
    //      recorded as `in-progress`.
    //   3. #11 ships. Its label becomes `shipped-local` — the flip that frees
    //      #12 — and the woken workers refill within the 15-second TTL.
    //
    // Without the ship-time invalidate, step 3's refill re-reads step 2's
    // cached listing, #12 stays withheld, and because nothing is in flight the
    // dealer's last-resort "drain the merge lane and refill once more" re-reads
    // that same cache too — so `next()` returns null and the RUN ENDS with #12
    // still sitting in the queue.
    //
    // Real time, no fake clock: the whole test finishes well inside the TTL,
    // which is precisely the window the bug lived in.
    const labels = new Map<number, string[]>([
      [10, ["ready-for-agent"]],
      [11, ["ready-for-agent"]],
      [12, ["ready-for-agent"]],
    ]);
    const bodies = new Map<number, string>([
      [10, ""],
      [11, ""],
      [12, "Blocked-by: #11\n"],
    ]);
    const claimed: number[] = [];
    const logs: string[] = [];
    /** True once a refill AFTER the first has finished — see step 2. The log
     *  line is written after `readOpenIssuesForPlanning` resolves, and the memo
     *  caches before that await returns, so this is a real happens-after. */
    const memoRewarmed = (): boolean =>
      logs.some((l) => /^dealer refill #[2-9]\d*:/.test(l));

    const agentRunFor = (issueNum: number | undefined) =>
      async (spec: {
        name: string;
      }): Promise<{ stdout: string; commits: { sha: string; subject: string }[] }> => {
        if (spec.name.startsWith("check-writer")) {
          const envelope = {
            marker: "NO_SCREEN_APPLIES",
            inherited: false,
            noScreenReason: "fixture issue — no real screen involved",
          };
          return {
            stdout: ["reasoning", "```json", JSON.stringify(envelope), "```", "NO_SCREEN_APPLIES"].join("\n"),
            commits: [],
          };
        }
        if (spec.name.startsWith("implementer")) {
          // #11 is held here until step 2's refill has re-warmed the memo, so
          // the stale window is OPEN when it ships. Ordering, not a sleep.
          if (issueNum === 11) {
            await waitFor("the post-#10 refill to re-warm the memo", memoRewarmed);
          }
          const envelope = {
            marker: "STORY_COMPLETE",
            storyType: "backend-only",
            e2eRequired: false,
            e2eActuallyRan: false,
            testCommandUsed: null,
            e2eAssertionLine: null,
            outputNotFiltered: true,
            testReachedFeature: false,
          };
          return {
            stdout: ["work done", "```json", JSON.stringify(envelope), "```", "STORY_COMPLETE"].join("\n"),
            commits: [{ sha: "abc123", subject: "work" }],
          };
        }
        if (spec.name.startsWith("reviewer")) {
          return { stdout: "looks good\nALL_CLEAR", commits: [] };
        }
        return { stdout: "", commits: [] };
      };

    const deps = makeDeps({
      // A LIVE tracker, not a fixed listing: the labels move exactly as the
      // loop moves them, so what the gate reads is only ever as fresh as the
      // memo lets it be.
      listOpenIssuesWithBodies: (async () =>
        [...labels.entries()].map(([number, ls]) => ({
          number,
          title: `issue ${number}`,
          body: bodies.get(number) ?? "",
          labels: [...ls],
        }))) as unknown as Deps["listOpenIssuesWithBodies"],
      claim: async (n: number) => {
        claimed.push(n);
        labels.set(n, ["in-progress"]);
      },
      // `--no-staging`: THIS is the flip that resolves the blocker, and it
      // happens inside the pipeline — before `settleOutcome`, and so before
      // the worker's `dealer.done()` wakes anyone into a refill.
      markDone: async (n: number) => {
        labels.set(n, ["shipped-local"]);
      },
      run: (async (spec: { name: string }) =>
        agentRunFor(undefined)(spec)) as unknown as Deps["run"],
      createSandbox: (async (spec: { branch: string }) => {
        const m = /issue-(\d+)$/.exec(spec.branch);
        return {
          run: agentRunFor(m ? Number(m[1]) : undefined),
          branch: spec.branch,
          close: async () => undefined,
          cleanup: async () => undefined,
          worktreePath: undefined,
        };
      }) as unknown as Deps["createSandbox"],
      captureSha: async () => "abc123",
      log: (l: string) => logs.push(l),
    });

    const result = await runMain(
      makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 5, maxConcurrent: 3 }),
      deps,
    );

    // THE WHOLE POINT: #12 was dealt, in the same run, once #11 shipped.
    // Without the ship-time invalidate this is `[10, 11]` and the run exits 0
    // reporting a clean drain over a queue that still had work in it.
    expect(claimed).toContain(12);
    expect([...result.shippedIssues].sort((a, b) => a - b)).toEqual([10, 11, 12]);
    expect(labels.get(12)).toEqual(["shipped-local"]);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// The gate's own unit tests. The `runMain` describe above proves the WIRING —
// that both halves are reached and that a blocked ticket is not claimed. This
// one proves the FUNCTION, including the two roads no fixture above can reach:
// a listing that came back at its 500-row cap, and a pick that is missing from
// a listing that did NOT.
// ---------------------------------------------------------------------------
describe("blockedByGate — the function itself", () => {
  const GH_CAP = 500;
  const noSleep = async (): Promise<void> => undefined;

  type Row = {
    number: number;
    title: string;
    body: string;
    labels: readonly string[];
  };
  const row = (number: number, body = "", ...labels: string[]): Row => ({
    number,
    title: `issue ${number}`,
    body,
    labels,
  });

  /** A listing padded out to exactly the `gh --limit` cap, i.e. TRUNCATED. */
  const atCap = (...rows: Row[]): Row[] => {
    const filler: Row[] = [];
    for (let n = 900_000; filler.length < GH_CAP - rows.length; n += 1) {
      if (!rows.some((r) => r.number === n)) filler.push(row(n));
    }
    return [...rows, ...filler];
  };

  const gateDepsFor = (
    fetch: () => Promise<readonly Row[]>,
  ): {
    deps: Pick<Deps, "listOpenIssuesWithBodies" | "logError">;
    errors: string[];
  } => {
    const errors: string[] = [];
    return {
      deps: {
        listOpenIssuesWithBodies:
          fetch as unknown as Deps["listOpenIssuesWithBodies"],
        logError: (line: string) => errors.push(line),
      },
      errors,
    };
  };

  it("clears a pick whose declared blocker is `shipped-local`", async () => {
    const { deps } = gateDepsFor(async () => [
      row(1038, "", "shipped-local"),
      row(1065, "Blocked-by: #1038", "ready-for-agent"),
    ]);
    const gate = await blockedByGate([1065], deps, { sleep: noSleep });
    expect([...gate.skips.keys()]).toEqual([]);
    expect(gate.unreadable).toBe(false);
  });

  it("TRUNCATED + blocker missing → skipped, naming the cap (I1)", async () => {
    // The pick itself IS in the listing; its BLOCKER is the row that fell off
    // the end. Before this, `unresolvedBlockers` read that absence as "closed"
    // and the dependent was dealt while its blocker was still building.
    const { deps } = gateDepsFor(async () =>
      atCap(row(1065, "Blocked-by: #1038", "ready-for-agent")),
    );
    const gate = await blockedByGate([1065], deps, { sleep: noSleep });
    expect(gate.unreadable).toBe(false);
    expect(gate.skips.get(1065)).toBe(
      "blocked by #1038 (not in the capped open-issue listing — cannot be proven resolved)",
    );
  });

  it("TRUNCATED + PICK missing → skipped, naming the cap", async () => {
    const { deps } = gateDepsFor(async () => atCap());
    const gate = await blockedByGate([1065], deps, { sleep: noSleep });
    expect(gate.unreadable).toBe(false);
    expect(gate.skips.get(1065)).toContain("500-row cap");
    expect(gate.skips.get(1065)).toContain("#1065 was not in it");
  });

  it("NOT truncated + PICK missing → still skipped, and says the two views disagree (I4)", async () => {
    // The pick came out of an open `ready-for-agent` listing moments earlier,
    // so its absence from the open set is an instrument contradicting itself,
    // not evidence the ticket closed — and lease acquisition reads no body.
    const { deps } = gateDepsFor(async () => [row(7, "", "ready-for-agent")]);
    const gate = await blockedByGate([1065], deps, { sleep: noSleep });
    expect(gate.unreadable).toBe(false);
    expect(gate.skips.get(1065)).toContain("was not in the open-issue listing");
    expect(gate.skips.get(1065)).toContain("the two views disagree");
  });

  it("RETRIES the fetch once and clears the pick when the retry succeeds (C1b)", async () => {
    let calls = 0;
    const { deps, errors } = gateDepsFor(async () => {
      calls += 1;
      if (calls === 1) throw new Error("gh blip");
      return [row(1065, "", "ready-for-agent")];
    });
    const gate = await blockedByGate([1065], deps, { sleep: noSleep });
    expect(calls).toBe(2);
    expect(gate.unreadable).toBe(false);
    expect([...gate.skips.keys()]).toEqual([]);
    expect(errors.some((l) => l.includes("retrying once"))).toBe(true);
  });

  it("reports `unreadable` — NOT a clean answer — when both fetches fail (C1a)", async () => {
    let calls = 0;
    const { deps, errors } = gateDepsFor(async () => {
      calls += 1;
      throw new Error("gh boom");
    });
    const gate = await blockedByGate([1038, 1065], deps, { sleep: noSleep });
    expect(calls).toBe(2);
    expect(gate.unreadable).toBe(true);
    expect(gate.failure).toContain("gh boom");
    // Still fails closed on the dispatch decision — both picks are skipped.
    expect([...gate.skips.keys()]).toEqual([1038, 1065]);
    expect(
      errors.some(
        (l) => l.includes("fetch failed twice") && l.includes("is BLIND"),
      ),
    ).toBe(true);
  });

  it("shares ONE fetch across the plan-time sweep and the deal-time checks (I5)", async () => {
    // The waste this closes: the plan-time gate fetched all open issues,
    // discarded them, and then each of up to 8 cards re-fetched the identical
    // listing seconds later.
    let calls = 0;
    const fetchOpen = async (): Promise<readonly Row[]> => {
      calls += 1;
      return [
        row(1038, "", "shipped-local"),
        row(1065, "Blocked-by: #1038", "ready-for-agent"),
      ];
    };
    const memo = createMemo(fetchOpen);
    const { deps } = gateDepsFor(async () => {
      throw new Error("the memo must be what is read, not deps directly");
    });

    await blockedByGate([1038, 1065], deps, {
      fetchOpen: () => memo.read(),
      sleep: noSleep,
    });
    await blockedByGate([1038], deps, {
      fetchOpen: () => memo.read(),
      sleep: noSleep,
    });
    await blockedByGate([1065], deps, {
      fetchOpen: () => memo.read(),
      sleep: noSleep,
    });

    expect(calls).toBe(1);
  });

  it("leaves a plan entry that is not an issue number alone — the pool's own guard names it", async () => {
    // `Number("not-an-issue")` is NaN. Skipping it here as "missing from the
    // listing" would silently drop it, and the dispatch pool's loud
    // "not a usable issue number" refusal would never be reached.
    const { deps } = gateDepsFor(async () => [row(7, "", "ready-for-agent")]);
    const gate = await blockedByGate([Number("not-an-issue")], deps, {
      sleep: noSleep,
    });
    expect(gate.skips.size).toBe(0);
    expect(gate.unreadable).toBe(false);
  });

  it("makes no call at all for an empty pick list", async () => {
    let calls = 0;
    const { deps } = gateDepsFor(async () => {
      calls += 1;
      return [];
    });
    const gate = await blockedByGate([], deps, { sleep: noSleep });
    expect(calls).toBe(0);
    expect(gate.unreadable).toBe(false);
  });
});

describe("buildBlockedByNote — the same reading of the rule as the gate (M1)", () => {
  it("honours a non-default queue label, exactly as the plan does", () => {
    // It used to hardcode `ready-for-agent` on BOTH axes — the filter and the
    // wording — while `eligibleForPlanning` read `--label`. A run on another
    // queue label got a note about a queue it was not reading.
    const rows = [
      { number: 1038, body: "", labels: ["in-progress"] },
      { number: 1065, body: "Blocked-by: #1038", labels: ["queue:night"] },
    ];
    expect(buildBlockedByNote(rows)).toBe("");
    expect(buildBlockedByNote(rows, "queue:night")).toBe(
      " (note: #1065 is ready but blocked by #1038 (open, labels: in-progress))",
    );
  });

  it("does NOT call a `shipped-local` blocker a blocker", () => {
    // The bug: openness alone. The loop leaves a finished ticket OPEN wearing
    // `shipped-local`, so the note told the operator #1065 was blocked at the
    // very moment the gate was dealing it.
    expect(
      buildBlockedByNote([
        { number: 1038, body: "", labels: ["shipped-local"] },
        {
          number: 1065,
          body: "Blocked-by: #1038",
          labels: ["ready-for-agent"],
        },
      ]),
    ).toBe("");
  });

  it("names the blocker AND the labels it is actually wearing", () => {
    expect(
      buildBlockedByNote([
        { number: 1038, body: "", labels: ["in-progress", "type:backend"] },
        {
          number: 1065,
          body: "Blocked-by: #1038",
          labels: ["ready-for-agent"],
        },
      ]),
    ).toBe(
      " (note: #1065 is ready but blocked by #1038 (open, labels: in-progress, type:backend))",
    );
  });
});

// ---------------------------------------------------------------------------
// tokenmaxxing build plan 4.5: when every pooled account is out, the loop
// waits until the soonest allowance reset, then carries on. Before this, the
// pool's 429 was an ordinary rate limit: a fallback-model retry, then up to
// MAX_DEFERRALS (3) releases, then the ticket was PARKED (quarantined).
//
// Driven through the real `runMain` against a real temp repo. The agent's
// failure is the exact text CLIProxyAPI v8.0.15 sends when every login is
// cooling down (see `lib/allowance.ts`), and the pool's per-login state is a
// recorded `GET /v0/management/auth-files` shape.
// ---------------------------------------------------------------------------

describe("runMain — every pooled account is out", () => {
  let repo: string;
  let origin: string;
  const BRANCH = "sandcastle/allowance-run";
  const START = Date.parse("2026-10-06T12:00:00Z");
  const HOUR = 3_600_000;
  const COOLDOWN =
    "claude exited with code 1:\nAPI Error: 429 " +
    '{"type":"error","error":{"type":"rate_limit_error","message":"All credentials for model stub-implementer are cooling down via provider claude"}}';

  beforeEach(() => {
    __resetTransientStateForTests();
    repo = mkdtempSync(path.join(tmpdir(), "sc-allowance-repo-"));
    origin = mkdtempSync(path.join(tmpdir(), "sc-allowance-origin-"));
    git(origin, "init", "-q", "--bare", "-b", "main");
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
    git(repo, "commit", "--allow-empty", "-q", "-m", "init");
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-q", "origin", "main");
    git(repo, "checkout", "-q", "-b", BRANCH);
    mkdirSync(path.join(repo, ".sandcastle"), { recursive: true });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  });

  it("parks no ticket, waits until the soonest reset, and resumes after it", async () => {
    let now = START;
    const attemptsAt: number[] = [];
    const released: string[] = [];
    const quarantineReasons: string[] = [];
    const deps = makeDeps({
      listOpenIssuesWithBodies: readyIssues({ number: 1, title: "t" }),
      run: async () => ({ stdout: "", commits: [] }),
      // Four empty-pool answers (one more than MAX_DEFERRALS, so the old code
      // parked the ticket on the fourth), then an ordinary failure that ends
      // this one-ticket run.
      createSandbox: (async () => {
        attemptsAt.push(now);
        throw new Error(attemptsAt.length <= 4 ? COOLDOWN : "sandbox boom");
      }) as unknown as Deps["createSandbox"],
      release: async (_n, reason) => {
        released.push(reason);
      },
      quarantine: async (_n, reason) => {
        quarantineReasons.push(reason);
      },
      poolAllowance: {
        // Both logins out: the sooner one is back two hours from each read.
        readAuthFiles: async () => ({
          files: [
            {
              name: "a.json",
              provider: "claude",
              disabled: false,
              unavailable: true,
              next_retry_after: new Date(now + 2 * HOUR).toISOString(),
            },
            {
              name: "b.json",
              provider: "claude",
              disabled: false,
              unavailable: true,
              next_retry_after: new Date(now + 3 * HOUR).toISOString(),
            },
          ],
        }),
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    });

    await runMain(
      makeArgs({
        repoRoot: repo,
        branch: BRANCH,
        iterations: 1,
        consecutiveFailureLimit: 99,
        quarantineLimit: 99,
      }),
      deps,
    );

    expect(attemptsAt).toHaveLength(5);
    // No empty-pool attempt parked the ticket; only the ordinary failure did.
    expect(quarantineReasons).toHaveLength(1);
    expect(quarantineReasons[0]).toContain("sandbox boom");
    expect(released).toHaveLength(4);
    expect(released[0]).toMatch(/every pooled Claude login is out/);
    expect(released[0]).toMatch(/not counted against MAX_DEFERRALS/);
    // Each retry came only after the soonest login's reset.
    for (let i = 1; i < attemptsAt.length; i++) {
      expect(attemptsAt[i]! - attemptsAt[i - 1]!).toBeGreaterThanOrEqual(2 * HOUR);
    }
  });

  it("an attempt that found the pool empty does not use up the run's ticket budget", async () => {
    let now = START;
    let attempts = 0;
    const result = await runMain(
      makeArgs({
        repoRoot: repo,
        branch: BRANCH,
        iterations: 2,
        consecutiveFailureLimit: 99,
        quarantineLimit: 99,
      }),
      makeDeps({
        listOpenIssuesWithBodies: readyIssues({ number: 1, title: "t" }),
        run: async () => ({ stdout: "", commits: [] }),
        // Three attempts find the pool empty; after that the ticket fails for
        // an ordinary reason and is parked, which DOES count.
        createSandbox: (async () => {
          attempts++;
          throw new Error(attempts <= 3 ? COOLDOWN : "sandbox boom");
        }) as unknown as Deps["createSandbox"],
        poolAllowance: {
          readAuthFiles: async () => {
            throw new Error("management API unreachable");
          },
          now: () => now,
          sleep: async (ms) => {
            now += ms;
          },
        },
      }),
    );

    expect(attempts).toBe(5);
    expect(result.quarantinedIssues).toHaveLength(2);
  });

  it("production deps read the pool at the agents' pool address, and nothing without one", () => {
    const saved = process.env.ANTHROPIC_BASE_URL;
    try {
      process.env.ANTHROPIC_BASE_URL = "http://pool:8317";
      const onPool = buildDefaultDeps(makeArgs({ repoRoot: repo })).poolAllowance;
      expect(onPool?.readAuthFiles).toBeTypeOf("function");
      delete process.env.ANTHROPIC_BASE_URL;
      const offPool = buildDefaultDeps(makeArgs({ repoRoot: repo })).poolAllowance;
      expect(offPool).toBeDefined();
      expect(offPool?.readAuthFiles).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = saved;
    }
  });
});

describe("runWithRateLimitFallback — an empty pool is not a reason to switch models", () => {
  beforeEach(() => __resetTransientStateForTests());

  it("does not retry on the fallback model when the pool says every login is out", async () => {
    const models: string[] = [];
    const run = runWithRateLimitFallback(
      async (model) => {
        models.push(model);
        throw new Error(
          "API Error: 429 All credentials for model opus are cooling down via provider claude",
        );
      },
      "opus",
      "sonnet",
      () => undefined,
      "implementer",
      "implementer",
    );
    await expect(run).rejects.toThrow(/cooling down/);
    expect(models).toEqual(["opus"]);
  });

  it("still retries an ordinary rate limit on the fallback model", async () => {
    const models: string[] = [];
    const out = await runWithRateLimitFallback(
      async (model) => {
        models.push(model);
        if (model === "opus") throw new Error("API Error: 429 rate_limit_error");
        return "ok";
      },
      "opus",
      "sonnet",
      () => undefined,
      "implementer",
      "implementer-ordinary",
    );
    expect(out).toBe("ok");
    expect(models).toEqual(["opus", "sonnet"]);
  });
});
