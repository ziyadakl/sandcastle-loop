/**
 * Issue #909 (Piece C of `docs/specs/2026-08-04-screen-check-design-lock.md`)
 * — the ship-funnel wiring of the protected-path lock, and the proof that a
 * REAL tampering commit is caught, restored, and recorded.
 *
 * The detection/restore MECHANISM itself (glob matching, byte-for-byte
 * restore, commit message building) is unit-tested in
 * `lib/paths/protected-paths.test.ts` and
 * `lib/paths/protected-path-restore.test.ts`. This file proves the other
 * half CLAUDE.md's evidence rule demands: that the mechanism is actually
 * WIRED IN at ship time, against a real git commit that really tampers with
 * a real protected path — not a fake one — and that the tamper count really
 * reaches `.sandcastle/telemetry/issues.jsonl` through the SAME functions
 * production uses (`buildReworkRecordInput` → `appendReworkRecord`), read
 * back afterward rather than trusted from a mocked write.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { commitInto, git } from "./__fixtures__/git-repo.js";
import {
  checkDirForIssue,
  checkDirGlobForIssue,
} from "./lib/checkwriter/check-path.js";
import {
  resolveProtectedPathGlobs,
} from "./lib/paths/protected-paths.js";
import { snapshotDir } from "./lib/paths/worktree-replay.js";
import { IssueTelemetryBag } from "./lib/telemetry/issue-bag.js";
import { buildReworkRecordInput } from "./lib/telemetry/rework-record-input.js";
import {
  appendReworkRecord,
  readReworkRecords,
} from "./lib/telemetry/rework-store.js";
import {
  enforceCheckWriterProtectedPaths,
  enforceProtectedPaths,
  shipAfterMigrations,
} from "./main.mts";
import { SHIP_INPUT_DEFAULTS } from "./__fixtures__/ship-input.mts";

const PROTECTED_FILE =
  "apps/nextjs/e2e/lib/teams/bright-city.ts";

/** A ctx exposing only what `enforceProtectedPaths`/`shipAfterMigrations`
 *  read, mirroring `main.ship.test.mts`'s `makeShipCtx`. */
function makeCtx(over: {
  repoRoot: string;
  branch: string;
  telemetry?: IssueTelemetryBag;
  log?: (l: string) => void;
  logError?: (l: string) => void;
  /** Sets `ctx.frozenCheck.current.location` — the frozen check whose tsconfig
   *  seeds the ship-time value guard (issue #1135) watches. Left off, the
   *  tsconfig guard is dormant, exactly as it is for a `NO_SCREEN_APPLIES`
   *  ticket that froze no check. */
  frozenLocation?: unknown;
}): Parameters<typeof shipAfterMigrations>[0] {
  return {
    args: { repoRoot: over.repoRoot, branch: over.branch, stagingEnabled: true },
    deps: {
      log: over.log ?? ((): void => {}),
      logError: over.logError ?? ((): void => {}),
      checkLintCert: async () => ({ status: "dormant" }),
      checkTestCert: async () => ({ status: "dormant" }),
      validateMigrationJournal: async () => [],
      applyMigrations: async () => ({ realErrors: [], applied: 0 }),
    },
    issueNumber: 909,
    issue: { branch: over.branch },
    telemetry: over.telemetry,
    runCounters: { bump: () => {} },
    frozenCheck:
      over.frozenLocation === undefined
        ? undefined
        : { current: { location: over.frozenLocation } },
  } as unknown as Parameters<typeof shipAfterMigrations>[0];
}

/** A browser check location, the frozen check whose e2e tsconfigs the value
 *  guard watches. */
const BROWSER_LOCATION_909 = {
  kind: "browser",
  issueNumber: 909,
  checkDir: "apps/nextjs/e2e/checks/issue-909",
  checkDirGlob: "apps/nextjs/e2e/checks/issue-909/**",
  checkPath: "team-total.spec.ts",
};

// The always-on globs are the project's `protectedPaths` setting; these tests
// run with project.example.json installed.
import { EXAMPLE_PROJECT_CONFIG } from "./__fixtures__/example-project-config.js";
const DEFAULT_PROTECTED_PATH_GLOBS = EXAMPLE_PROJECT_CONFIG.protectedPaths;

describe("enforceProtectedPaths — real git repo, real tampering commit", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sc-protected-paths-"));
    git(repo, "init", "-q", "-b", "issue-909");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("is a no-op on a clean diff — no restore commit, sha unchanged", async () => {
    const preSha = commitInto(
      repo,
      { [PROTECTED_FILE]: "export const brightCity = {};\n" },
      "chore: seed",
    );
    const postSha = commitInto(
      repo,
      { "apps/nextjs/src/app/page.tsx": "export default function Page() {}\n" },
      "feat: unrelated change",
    );
    const ctx = makeCtx({ repoRoot: repo, branch: "issue-909" });
    const result = (await enforceProtectedPaths(
      ctx,
      { branch: "issue-909", worktreePath: repo } as never,
      preSha,
      postSha,
      { changedLines: 1, changedFiles: ["apps/nextjs/src/app/page.tsx"] },
    )).sha;
    expect(result).toBe(postSha);
  });

  it("catches an UNCOMMITTED edit to a protected path that the commit-to-commit diff never lists", async () => {
    // The hole: the browser gate runs Playwright in the LIVE WORKTREE
    // (`runOnce` in `lib/harness/run-harness-check.ts` execs the check command
    // in `worktreePath` — it never checks out `postSha` and never demands a
    // clean tree), so the bytes that actually get graded are the bytes ON
    // DISK. A builder that edits a protected path and simply never runs
    // `git add` is invisible to `shipDiff.changedFiles`, which is a
    // commit-to-commit measurement.
    const originalContent =
      "export const brightCity = { key: 'bright-city', keeps: 10967.5 };\n";
    const preSha = commitInto(
      repo,
      { [PROTECTED_FILE]: originalContent },
      "chore: seed the practice world",
    );
    const postSha = commitInto(
      repo,
      { "apps/nextjs/src/app/page.tsx": "export default function Page() {}\n" },
      "feat: honest-looking work\n\nSANDCASTLE-LINT: pass\nSANDCASTLE-TEST: pass",
    );
    // The tamper: on disk only. Never staged, never committed.
    writeFileSync(
      path.join(repo, PROTECTED_FILE),
      "export const brightCity = { key: 'bright-city', keeps: 999999 };\n",
    );

    const bag = new IssueTelemetryBag();
    const errors: string[] = [];
    const ctx = makeCtx({
      repoRoot: repo,
      branch: "issue-909",
      telemetry: bag,
      logError: (l) => errors.push(l),
    });

    const restoredSha = (await enforceProtectedPaths(
      ctx,
      { branch: "issue-909", worktreePath: repo } as never,
      preSha,
      postSha,
      // The commit diff is honest and clean — the protected path is NOT in it.
      { changedLines: 1, changedFiles: ["apps/nextjs/src/app/page.tsx"] },
    )).sha;

    // The lock fired: a restore commit exists, and the bytes Playwright would
    // load off disk are the ORIGINAL ones again.
    expect(restoredSha).not.toBe(postSha);
    expect(readFileSync(path.join(repo, PROTECTED_FILE), "utf8")).toBe(
      originalContent,
    );
    expect(git(repo, "show", `${restoredSha}:${PROTECTED_FILE}`)).toBe(
      originalContent.trimEnd(),
    );
    expect(errors.some((e) => e.includes("protected-paths-tampered"))).toBe(
      true,
    );
    expect(bag.toRow().checksTamperCount).toBe(1);
  });

  it("catches a NEW, never-committed spec file smuggled into the locked check directory", async () => {
    // Playwright GLOBS the check directory — it does not load one named file.
    // So dropping a second, always-passing spec beside the real one changes
    // the verdict just as completely as rewriting the real one, and doing it
    // without `git add` keeps it out of every commit-based measurement.
    const checkGlob = checkDirGlobForIssue(909);
    const checkDir = checkDirForIssue(909);
    const preSha = commitInto(
      repo,
      { [`${checkDir}/team-cash-flow.spec.ts`]: "expect(total).toBe(47300);\n" },
      "chore(check-writer): add acceptance check for issue #909",
    );
    const postSha = commitInto(
      repo,
      { "apps/nextjs/src/app/page.tsx": "export default function Page() {}\n" },
      "feat: implement issue #909\n\nSANDCASTLE-LINT: pass\nSANDCASTLE-TEST: pass",
    );
    const smuggled = path.join(repo, checkDir, "zz-always-passes.spec.ts");
    writeFileSync(smuggled, "test('ok', () => { expect(1).toBe(1); });\n");

    const bag = new IssueTelemetryBag();
    const ctx = {
      ...makeCtx({ repoRoot: repo, branch: "issue-909", telemetry: bag }),
      protectedPathGlobs: [checkGlob],
    };

    const restoredSha = (await enforceProtectedPaths(
      ctx,
      { branch: "issue-909", worktreePath: repo } as never,
      preSha,
      postSha,
      { changedLines: 1, changedFiles: ["apps/nextjs/src/app/page.tsx"] },
    )).sha;

    // "Restore" for a path that never existed at the hand-off commit means
    // the tree goes back to having no such file — so Playwright can no longer
    // find it to grade.
    expect(existsSync(smuggled)).toBe(false);
    expect(bag.toRow().checksTamperCount).toBe(1);
    // The smuggle never entered git, so `postSha`'s tree was always correct
    // and there is nothing to mint a restore commit FROM — the ship sha is
    // unchanged, and the ticket is not falsely quarantined as unrestorable.
    expect(restoredSha).toBe(postSha);
    // The real check the check-writer wrote is untouched — the restore
    // deleted only what was smuggled in.
    expect(
      readFileSync(path.join(repo, checkDir, "team-cash-flow.spec.ts"), "utf8"),
    ).toBe("expect(total).toBe(47300);\n");
  });

  it("PROVES THE INSTRUMENT: catches a REAL commit that edits the practice world, restores it byte-for-byte, and ships a distinct commit", async () => {
    const originalContent =
      "export const brightCity = { key: 'bright-city', keeps: 10967.5 };\n";
    const preSha = commitInto(
      repo,
      { [PROTECTED_FILE]: originalContent },
      "chore: seed the practice world",
    );
    // A REAL agent-style tamper: raise the team's own number so a money
    // check on it comes out green regardless of the real math.
    const postSha = commitInto(
      repo,
      { [PROTECTED_FILE]: "export const brightCity = { key: 'bright-city', keeps: 999999 };\n" },
      "fix: make the team cash-flow check pass\n\nSANDCASTLE-LINT: pass\nSANDCASTLE-TEST: pass",
    );

    const bag = new IssueTelemetryBag();
    const logs: string[] = [];
    const errors: string[] = [];
    const ctx = makeCtx({
      repoRoot: repo,
      branch: "issue-909",
      telemetry: bag,
      log: (l) => logs.push(l),
      logError: (l) => errors.push(l),
    });

    const restoredSha = (await enforceProtectedPaths(
      ctx,
      { branch: "issue-909", worktreePath: repo } as never,
      preSha,
      postSha,
      { changedLines: 1, changedFiles: [PROTECTED_FILE] },
    )).sha;

    // A genuinely new commit — not the tampered one, not the base.
    expect(restoredSha).not.toBe(postSha);
    expect(restoredSha).not.toBe(preSha);
    // The tree at the new commit carries the ORIGINAL content, not the
    // tampered "999999".
    const shippedContent = git(repo, "show", `${restoredSha}:${PROTECTED_FILE}`);
    expect(shippedContent).toBe(originalContent.trimEnd());
    expect(shippedContent).not.toContain("999999");
    // The file on disk (what downstream gates like verifyTestRun would read)
    // matches too.
    expect(readFileSync(path.join(repo, PROTECTED_FILE), "utf8")).toBe(
      originalContent,
    );
    // The restore commit's message preserved the original's cert tokens, so
    // the lint/test-cert gates that run right after this in
    // `shipAfterMigrations` don't spuriously quarantine an honest builder.
    const shippedMessage = git(repo, "show", "-s", "--format=%B", restoredSha);
    expect(shippedMessage).toContain("SANDCASTLE-LINT: pass");
    expect(shippedMessage).toContain("SANDCASTLE-TEST: pass");
    // ALWAYS RECORDED, NEVER SILENT: both the log and the telemetry bag.
    expect(errors.some((e) => e.includes("protected-paths-tampered"))).toBe(
      true,
    );
    expect(bag.toRow().checksTamperCount).toBe(1);
  });

  it("restores the SECOND tamper for the SAME issue too — an edit never stops the ticket by itself (spec #1334)", async () => {
    const original = "export const bright = 1;\n";
    const preSha1 = commitInto(
      repo,
      { [PROTECTED_FILE]: original },
      "chore: seed",
    );
    const postSha1 = commitInto(
      repo,
      { [PROTECTED_FILE]: "export const bright = 999;\n" },
      "fix: attempt 1 (tampers)",
    );
    // The SAME bag persists across both calls — this is the real mechanism
    // (`main.mts` reuses `issueBags.get(issueNumber)` across a redispatch of
    // the same issue within a run) that makes "twice, ever" meaningful.
    const bag = new IssueTelemetryBag();
    const ctx = makeCtx({ repoRoot: repo, branch: "issue-909", telemetry: bag });

    const firstRestoreSha = (await enforceProtectedPaths(
      ctx,
      { branch: "issue-909", worktreePath: repo } as never,
      preSha1,
      postSha1,
      { changedLines: 1, changedFiles: [PROTECTED_FILE] },
    )).sha;
    expect(bag.toRow().checksTamperCount).toBe(1);

    // A SECOND dispatch of the same ticket tampers again, from the restored
    // tip.
    const postSha2 = commitInto(
      repo,
      { [PROTECTED_FILE]: "export const bright = 1;\n// but I ALSO snuck this in\n" },
      "fix: attempt 2 (tampers again)",
    );

    const secondRestoreSha = (await enforceProtectedPaths(
      ctx,
      { branch: "issue-909", worktreePath: repo } as never,
      firstRestoreSha,
      postSha2,
      { changedLines: 1, changedFiles: [PROTECTED_FILE] },
    )).sha;
    expect(bag.toRow().checksTamperCount).toBe(2);
    expect(secondRestoreSha).not.toBe(postSha2);
    expect(git(repo, "show", `${secondRestoreSha}:${PROTECTED_FILE}`)).toBe(original.trimEnd());
  });

  it("refuses to ship un-restored when there is no worktree to restore from", async () => {
    const preSha = commitInto(repo, { [PROTECTED_FILE]: "a\n" }, "seed");
    const postSha = commitInto(repo, { [PROTECTED_FILE]: "b\n" }, "tamper");
    const ctx = makeCtx({ repoRoot: repo, branch: "issue-909" });
    await expect(
      enforceProtectedPaths(
        ctx,
        { branch: "issue-909", worktreePath: undefined } as never,
        preSha,
        postSha,
        { changedLines: 1, changedFiles: [PROTECTED_FILE] },
      ),
    ).rejects.toThrow(/protected-paths-unrestorable/);
  });

  it("FAILS CLOSED: a real sha change git cannot diff is refused, not passed as clean (#972 sibling parity)", () => {
    // Two distinct, non-existent shas: the pre-flight sees `entrySha !==
    // postCheckWriterSha` (a real change), then `git diff` fails because
    // neither ref resolves. Silence is not an all-clear — the gate must SIGNAL
    // "unmeasurable" so the caller refuses, exactly as the post-merge fixer
    // gate does. Before this it returned empty violations, reading as a pass.
    const result = enforceCheckWriterProtectedPaths(
      repo,
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      "cafebabecafebabecafebabecafebabecafebabe",
      undefined,
    );
    expect(result.unmeasurable).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("does NOT flag unmeasurable on a normal, resolvable diff (no false stop)", () => {
    const preSha = commitInto(repo, { [PROTECTED_FILE]: "a\n" }, "seed");
    const postSha = commitInto(
      repo,
      { "apps/nextjs/src/app/page.tsx": "export default function P() {}\n" },
      "feat: unrelated",
    );
    const result = enforceCheckWriterProtectedPaths(
      repo,
      preSha,
      postSha,
      undefined,
    );
    expect(result.unmeasurable ?? false).toBe(false);
    expect(result.violations).toEqual([]);
  });

  it("a per-job glob (the #911 seam) protects an additional path without ever dropping the practice-world default", () => {
    const resolved = resolveProtectedPathGlobs([
      ".sandcastle/checks/909-acceptance.md",
    ]);
    for (const g of DEFAULT_PROTECTED_PATH_GLOBS) expect(resolved).toContain(g);
    expect(resolved).toContain(".sandcastle/checks/909-acceptance.md");
  });
});

describe("shipAfterMigrations end-to-end: a tampered ship never carries the tampered content", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sc-protected-paths-ship-"));
    git(repo, "init", "-q", "-b", "issue-909");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
    commitInto(repo, { "README.md": "seed\n" }, "init");
    git(repo, "branch", "run");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("ships the RESTORED practice-world file, not the tampered one, and records the tamper on the telemetry bag", async () => {
    const originalContent = "export const bright = { keeps: 10967.5 };\n";
    commitInto(repo, { [PROTECTED_FILE]: originalContent }, "chore: seed practice world");
    const preSha = git(repo, "rev-parse", "HEAD");
    const postSha = commitInto(
      repo,
      { [PROTECTED_FILE]: "export const bright = { keeps: 999999 };\n" },
      "fix: cash flow bug\n\nSANDCASTLE-LINT: pass\nSANDCASTLE-TEST: pass",
    );

    const bag = new IssueTelemetryBag();
    const outcome = await shipAfterMigrations(
      makeCtx({ repoRoot: repo, branch: "run", telemetry: bag }),
      { branch: "issue-909", worktreePath: repo } as never,
      {
        ...SHIP_INPUT_DEFAULTS,
        preSha,
        postSha,
        finalMarker: "ALL_CLEAR",
      },
    );

    expect(outcome.postSha).not.toBe(postSha);
    const shippedContent = git(
      repo,
      "show",
      `${outcome.postSha}:${PROTECTED_FILE}`,
    );
    expect(shippedContent).toBe(originalContent.trimEnd());
    expect(bag.toRow().checksTamperCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The check-writer's OWN hand-off commit must never read as tampering
// (issue #914 finding: shipDiffBase's fork-point base always widened past
// preSha, so noteChecksTampered() fired on every ticket). Derives the diff
// the way PRODUCTION does — a real `shipAfterMigrations` call computing its
// own `shipDiff` via the real `shipDiffBase`, never a hand-fed
// `changedFiles` array — because every OTHER test in this file hand-feeds
// `changedFiles` directly to `enforceProtectedPaths`, which is exactly why
// this bug was invisible to the existing suite: none of them ever exercised
// `shipDiffBase` itself.
// ---------------------------------------------------------------------------

describe("shipAfterMigrations — the check-writer's hand-off commit is not tampering (issue #914)", () => {
  let repo: string;
  const issueNumber = 1000;

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sc-protected-paths-checkwriter-"));
    git(repo, "init", "-q", "-b", `issue-${issueNumber}`);
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
    // The fork point: the "run" branch's tip, BEFORE the check-writer or
    // the builder ever touch the issue branch.
    commitInto(repo, { "README.md": "seed\n" }, "init");
    git(repo, "branch", "run");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("ships clean — no false tamper, no restore commit — when only the check-writer's commit sits between the fork point and preSha", async () => {
    const checkGlob = checkDirGlobForIssue(issueNumber);
    const checkFilePath = `${checkDirForIssue(issueNumber)}/team-cash-flow.spec.ts`;

    // The check-writer's OWN commit, landed BEFORE the builder ever runs —
    // exactly what `runCheckWriterStage` does (main.mts: `nextPreSha =
    // await ctx.deps.captureSha(...)` AFTER this kind of commit). This is
    // the "state handed to the builder".
    commitInto(
      repo,
      { [checkFilePath]: "// a real acceptance check, proven red\n" },
      "chore(check-writer): add acceptance check for issue #1000",
    );
    const preSha = git(repo, "rev-parse", "HEAD");

    // The builder's own, legitimate, UNRELATED work. Never touches the
    // check file at all.
    const postSha = commitInto(
      repo,
      { "apps/nextjs/src/app/page.tsx": "export default function Page() {}\n" },
      "feat: implement issue #1000\n\nSANDCASTLE-LINT: pass\nSANDCASTLE-TEST: pass",
    );

    const bag = new IssueTelemetryBag();
    const ctx = {
      ...makeCtx({ repoRoot: repo, branch: "run", telemetry: bag }),
      // Mirrors `runCheckWriterStage`'s own wiring: the per-issue check
      // directory glob is added to `protectedPathGlobs` from the moment
      // the check-writer hands off, exactly as production does.
      protectedPathGlobs: [checkGlob],
    };

    const outcome = await shipAfterMigrations(
      ctx,
      { branch: `issue-${issueNumber}`, worktreePath: repo } as never,
      {
        ...SHIP_INPUT_DEFAULTS,
        preSha,
        postSha,
        finalMarker: "ALL_CLEAR",
      },
    );

    expect(outcome.status).toBe("ok");
    // No restore commit was minted — the shipped sha IS the builder's own.
    expect(outcome.postSha).toBe(postSha);
    // The lock never fired at all — ABSENT, not zero (this project's own
    // "absent means never happened" discipline).
    expect(bag.toRow().checksTamperCount).toBeUndefined();
    // And the check file itself still carries what the check-writer wrote,
    // never restored (there was nothing to restore).
    const shipped = git(repo, "show", `${outcome.postSha}:${checkFilePath}`);
    expect(shipped).toBe("// a real acceptance check, proven red");
  });

  it("STILL catches a real tamper of the check file even with the check-writer's own commit ahead of it in history", async () => {
    const checkGlob = checkDirGlobForIssue(issueNumber);
    const checkFilePath = `${checkDirForIssue(issueNumber)}/team-cash-flow.spec.ts`;

    commitInto(
      repo,
      { [checkFilePath]: "expect(total).toBe(47300); // the REAL answer\n" },
      "chore(check-writer): add acceptance check for issue #1000",
    );
    const preSha = git(repo, "rev-parse", "HEAD");

    // The builder edits the check file itself this time — a real tamper.
    const postSha = commitInto(
      repo,
      { [checkFilePath]: "expect(total).toBe(999999); // rewrote the answer to match my bug\n" },
      "fix: implement issue #1000\n\nSANDCASTLE-LINT: pass\nSANDCASTLE-TEST: pass",
    );

    const bag = new IssueTelemetryBag();
    const ctx = {
      ...makeCtx({ repoRoot: repo, branch: "run", telemetry: bag }),
      protectedPathGlobs: [checkGlob],
    };

    const outcome = await shipAfterMigrations(
      ctx,
      { branch: `issue-${issueNumber}`, worktreePath: repo } as never,
      {
        ...SHIP_INPUT_DEFAULTS,
        preSha,
        postSha,
        finalMarker: "ALL_CLEAR",
      },
    );

    // Restored — a DIFFERENT sha than the tampered postSha.
    expect(outcome.postSha).not.toBe(postSha);
    const shipped = git(repo, "show", `${outcome.postSha}:${checkFilePath}`);
    expect(shipped).toBe("expect(total).toBe(47300); // the REAL answer");
    expect(bag.toRow().checksTamperCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// BLOCKER 1 (issue #1177 review hardening): a proved first-test check repair
// on the reviewer-refusal road rewrites the SAME protected check directory
// this lock watches, between the ORIGINAL preSha (before the builder ever
// ran) and a postSha that already carries the repair. Before this fix, that
// rewrite read as tampering exactly like a builder editing its own grader —
// `noteChecksTampered()` fired, the WRONG (pre-repair) check was restored
// from preSha, and the ticket shipped or quarantined graded by the very
// check the judge had just ruled wrong. Proven here against a REAL git
// repo, through the REAL `shipAfterMigrations` → `enforceProtectedPaths`,
// with `ctx.frozenCheck.current` built the same way
// `proveFirstTestRewrite` builds it — from a real `snapshotDir` read of
// the check directory as it actually stands on disk.
// ---------------------------------------------------------------------------

describe("enforceProtectedPaths — a proved first-test rewrite is not tampering, and a tamper restores the REWRITE (issue #1177, spec #1334)", () => {
  let repo: string;
  const issueNumber = 1177;

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sc-protected-paths-repair-"));
    git(repo, "init", "-q", "-b", `issue-${issueNumber}`);
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("does NOT flag the check as tampered when the shipped bytes are exactly the current frozen (accepted) ones", async () => {
    const checkGlob = checkDirGlobForIssue(issueNumber);
    const checkDir = checkDirForIssue(issueNumber);
    const checkFilePath = `${checkDir}/team-cash-flow.spec.ts`;

    // The ORIGINAL check the builder was handed — this is the reviewer
    // road's `preSha`, captured before the builder ever ran.
    commitInto(
      repo,
      { [checkFilePath]: "expect(total).toBe(1000); // the wrong assertion\n" },
      "chore(check-writer): add acceptance check for issue #1177",
    );
    const preSha = git(repo, "rev-parse", "HEAD");

    // The REPAIR: a proved first-test rewrite, committed on top — exactly
    // what `proveFirstTestRewrite`'s own commit does. This is the
    // reviewer road's `postSha`.
    const postSha = commitInto(
      repo,
      { [checkFilePath]: "expect(total).toBe(182400); // the repaired, correct assertion\n" },
      "chore(sandcastle): proved first-test check repair\n\nSANDCASTLE-LINT: pass\nSANDCASTLE-TEST: pass",
    );

    // `ctx.frozenCheck.current`, built the same way `proveFirstTestRewrite`
    // builds it after a repair proves itself: a real snapshot of the check
    // directory as it stands on disk RIGHT NOW — which is exactly the
    // repaired bytes, since `commitInto` wrote them to disk as well as into
    // the commit.
    const repairedSnapshot = snapshotDir(repo, checkDir);
    if (repairedSnapshot === undefined) throw new Error("snapshot failed");
    const frozenCheck = {
      location: {
        kind: "browser",
        issueNumber,
        checkDir,
        checkDirGlob: checkGlob,
        checkPath: "team-cash-flow.spec.ts",
      },
      frozenAtIso: new Date().toISOString(),
      checkDir: repairedSnapshot,
      environment: [],
      fingerprint: "test-fingerprint",
    };

    const bag = new IssueTelemetryBag();
    const ctx = {
      ...makeCtx({ repoRoot: repo, branch: "run", telemetry: bag }),
      protectedPathGlobs: [checkGlob],
      frozenCheck: { current: frozenCheck },
    };

    const outcome = await shipAfterMigrations(
      ctx as never,
      { branch: `issue-${issueNumber}`, worktreePath: repo } as never,
      {
        ...SHIP_INPUT_DEFAULTS,
        preSha,
        postSha,
        finalMarker: "ALL_CLEAR",
      },
    );

    // No restore commit — the shipped sha IS the repair's own commit.
    expect(outcome.postSha).toBe(postSha);
    const shipped = git(repo, "show", `${outcome.postSha}:${checkFilePath}`);
    expect(shipped).toBe(
      "expect(total).toBe(182400); // the repaired, correct assertion",
    );
    // The lock never fired — ABSENT, not zero.
    expect(bag.toRow().checksTamperCount).toBeUndefined();
  });

  it("STILL catches a real tamper — a rewrite that matches NEITHER preSha NOR the current frozen bytes", async () => {
    const checkGlob = checkDirGlobForIssue(issueNumber);
    const checkDir = checkDirForIssue(issueNumber);
    const checkFilePath = `${checkDir}/team-cash-flow.spec.ts`;

    commitInto(
      repo,
      { [checkFilePath]: "expect(total).toBe(1000); // the wrong assertion\n" },
      "chore(check-writer): add acceptance check for issue #1177",
    );
    const preSha = git(repo, "rev-parse", "HEAD");

    // A repair really happened and was accepted — the freeze holds ITS
    // bytes (182400).
    const acceptedBytes = Buffer.from(
      "expect(total).toBe(182400); // the repaired, correct assertion\n",
    );

    // But what actually SHIPPED is a THIRD value — neither the pre-repair
    // original nor the accepted repair. A builder (or anything else) edited
    // the check again after the freeze was taken.
    const postSha = commitInto(
      repo,
      { [checkFilePath]: "expect(total).toBe(999999); // tampered after the repair\n" },
      "fix: implement issue #1177\n\nSANDCASTLE-LINT: pass\nSANDCASTLE-TEST: pass",
    );

    const frozenCheck = {
      location: {
        kind: "browser",
        issueNumber,
        checkDir,
        checkDirGlob: checkGlob,
        checkPath: "team-cash-flow.spec.ts",
      },
      frozenAtIso: new Date().toISOString(),
      checkDir: {
        relPaths: ["team-cash-flow.spec.ts"],
        bytesByRelPath: new Map([["team-cash-flow.spec.ts", acceptedBytes]]),
      },
      environment: [],
      fingerprint: "test-fingerprint",
    };

    const bag = new IssueTelemetryBag();
    const ctx = {
      ...makeCtx({ repoRoot: repo, branch: "run", telemetry: bag }),
      protectedPathGlobs: [checkGlob],
      frozenCheck: { current: frozenCheck },
    };

    const outcome = await shipAfterMigrations(
      ctx as never,
      { branch: `issue-${issueNumber}`, worktreePath: repo } as never,
      {
        ...SHIP_INPUT_DEFAULTS,
        preSha,
        postSha,
        finalMarker: "ALL_CLEAR",
      },
    );

    // Restored from the FREEZE — the accepted rewrite — never from preSha,
    // which still holds the OLD, wrong test (spec #1334, risk 2). A restore
    // from preSha would silently put the wrong test back.
    expect(outcome.postSha).not.toBe(postSha);
    const shipped = git(repo, "show", `${outcome.postSha}:${checkFilePath}`);
    expect(shipped).toBe(
      "expect(total).toBe(182400); // the repaired, correct assertion",
    );
    expect(bag.toRow().checksTamperCount).toBe(1);
  });

  it("STILL catches a commit-tamper-then-disk-revert: postSha carries tampered bytes even though the working tree was reverted to the accepted bytes (final-review BLOCKER A)", async () => {
    const checkGlob = checkDirGlobForIssue(issueNumber);
    const checkDir = checkDirForIssue(issueNumber);
    const checkFilePath = `${checkDir}/team-cash-flow.spec.ts`;
    const acceptedText =
      "expect(total).toBe(182400); // the repaired, correct assertion\n";

    commitInto(
      repo,
      { [checkFilePath]: "expect(total).toBe(1000); // the wrong assertion\n" },
      "chore(check-writer): add acceptance check for issue #1177",
    );
    const preSha = git(repo, "rev-parse", "HEAD");

    // The accepted repair — this is what the freeze holds.
    commitInto(
      repo,
      { [checkFilePath]: acceptedText },
      "chore(sandcastle): proved first-test check repair\n\nSANDCASTLE-LINT: pass\nSANDCASTLE-TEST: pass",
    );
    const repairedSnapshot = snapshotDir(repo, checkDir);
    if (repairedSnapshot === undefined) throw new Error("snapshot failed");

    // A builder now COMMITS tampered bytes on top of the repair — this is
    // the ship-time postSha, what actually merges.
    const postSha = commitInto(
      repo,
      { [checkFilePath]: "expect(total).toBe(1); // tampered by the builder\n" },
      "fix: implement issue #1177\n\nSANDCASTLE-LINT: pass\nSANDCASTLE-TEST: pass",
    );

    // The builder then reverts the WORKING TREE back to the accepted bytes,
    // without committing — an attempt to make the disk-only check above
    // (pre-fix `violationMatchesAcceptedCheck`) read this as a match while
    // the tampered commit still ships.
    writeFileSync(path.join(repo, checkFilePath), acceptedText);

    const frozenCheck = {
      location: {
        kind: "browser",
        issueNumber,
        checkDir,
        checkDirGlob: checkGlob,
        checkPath: "team-cash-flow.spec.ts",
      },
      frozenAtIso: new Date().toISOString(),
      checkDir: repairedSnapshot,
      environment: [],
      fingerprint: "test-fingerprint",
    };

    const bag = new IssueTelemetryBag();
    const ctx = {
      ...makeCtx({ repoRoot: repo, branch: "run", telemetry: bag }),
      protectedPathGlobs: [checkGlob],
      frozenCheck: { current: frozenCheck },
    };

    const outcome = await shipAfterMigrations(
      ctx as never,
      { branch: `issue-${issueNumber}`, worktreePath: repo } as never,
      {
        ...SHIP_INPUT_DEFAULTS,
        preSha,
        postSha,
        finalMarker: "ALL_CLEAR",
      },
    );

    // Still flagged and restored — the disk revert must not launder the
    // tampered COMMIT through — and restored to the ACCEPTED rewrite.
    expect(outcome.postSha).not.toBe(postSha);
    const shipped = git(repo, "show", `${outcome.postSha}:${checkFilePath}`);
    expect(shipped).toBe(acceptedText.trimEnd());
    expect(bag.toRow().checksTamperCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The verdict machinery is not just the check file (issue #914 finding):
// playwright.config.ts / apps/nextjs/e2e/lib/** are blanket-protected paths
// (DEFAULT_PROTECTED_PATH_GLOBS); apps/nextjs/package.json's `scripts.e2e`
// field is a narrower, content-level guard (e2e-script-guard.ts). Both are
// proven end-to-end here, through the REAL `enforceProtectedPaths`.
// ---------------------------------------------------------------------------

describe("enforceProtectedPaths — the verdict machinery beyond the check file (issue #914)", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sc-protected-paths-verdict-"));
    git(repo, "init", "-q", "-b", "issue-914");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("catches a rewrite of playwright.config.ts (a blanket-protected path)", async () => {
    const preSha = commitInto(
      repo,
      { "apps/nextjs/playwright.config.ts": "export default { testDir: './e2e' };\n" },
      "seed",
    );
    const postSha = commitInto(
      repo,
      {
        "apps/nextjs/playwright.config.ts":
          "export default { testDir: './e2e', reporter: [['line', { alwaysPass: true }]] };\n",
      },
      "fix: tweak the config\n\nSANDCASTLE-LINT: pass\nSANDCASTLE-TEST: pass",
    );
    const bag = new IssueTelemetryBag();
    const ctx = makeCtx({ repoRoot: repo, branch: "issue-914", telemetry: bag });
    const restoredSha = (await enforceProtectedPaths(
      ctx,
      { branch: "issue-914", worktreePath: repo } as never,
      preSha,
      postSha,
      {
        changedLines: 1,
        changedFiles: ["apps/nextjs/playwright.config.ts"],
      },
    )).sha;
    expect(restoredSha).not.toBe(postSha);
    expect(bag.toRow().checksTamperCount).toBe(1);
  });

  it("catches the e2e script being retargeted inside apps/nextjs/package.json, without blocking the rest of the file", async () => {
    const originalPkg =
      JSON.stringify(
        { name: "@acme/nextjs", scripts: { e2e: "playwright test" } },
        null,
        2,
      ) + "\n";
    const preSha = commitInto(
      repo,
      { "apps/nextjs/package.json": originalPkg },
      "seed",
    );
    const tamperedPkg =
      JSON.stringify(
        {
          name: "@acme/nextjs",
          scripts: { e2e: 'echo "1 passed"' },
          dependencies: { "some-new-lib": "^1.0.0" },
        },
        null,
        2,
      ) + "\n";
    const postSha = commitInto(
      repo,
      { "apps/nextjs/package.json": tamperedPkg },
      "fix: add a dependency (and quietly fake every check)\n\nSANDCASTLE-LINT: pass\nSANDCASTLE-TEST: pass",
    );
    const bag = new IssueTelemetryBag();
    const ctx = makeCtx({ repoRoot: repo, branch: "issue-914", telemetry: bag });
    const restoredSha = (await enforceProtectedPaths(
      ctx,
      { branch: "issue-914", worktreePath: repo } as never,
      preSha,
      postSha,
      { changedLines: 3, changedFiles: ["apps/nextjs/package.json"] },
    )).sha;
    expect(restoredSha).not.toBe(postSha);
    const shippedContent = git(
      repo,
      "show",
      `${restoredSha}:apps/nextjs/package.json`,
    );
    expect(shippedContent).toBe(originalPkg.trimEnd());
    expect(bag.toRow().checksTamperCount).toBe(1);
  });

  it("does NOT flag an ordinary dependency-only change to apps/nextjs/package.json — the e2e script never moved", async () => {
    const originalPkg =
      JSON.stringify(
        { name: "@acme/nextjs", scripts: { e2e: "playwright test" } },
        null,
        2,
      ) + "\n";
    const preSha = commitInto(
      repo,
      { "apps/nextjs/package.json": originalPkg },
      "seed",
    );
    const updatedPkg =
      JSON.stringify(
        {
          name: "@acme/nextjs",
          scripts: { e2e: "playwright test" },
          dependencies: { "@sentry/nextjs": "^8.0.0" },
        },
        null,
        2,
      ) + "\n";
    const postSha = commitInto(
      repo,
      { "apps/nextjs/package.json": updatedPkg },
      "feat: add Sentry crash monitoring\n\nSANDCASTLE-LINT: pass\nSANDCASTLE-TEST: pass",
    );
    const bag = new IssueTelemetryBag();
    const ctx = makeCtx({ repoRoot: repo, branch: "issue-914", telemetry: bag });
    const result = (await enforceProtectedPaths(
      ctx,
      { branch: "issue-914", worktreePath: repo } as never,
      preSha,
      postSha,
      { changedLines: 3, changedFiles: ["apps/nextjs/package.json"] },
    )).sha;
    expect(result).toBe(postSha); // shipped unchanged — no restore commit
    expect(bag.toRow().checksTamperCount).toBeUndefined();
  });
});

describe("arrival proof: the tamper count reaches the REAL issues.jsonl store", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sc-protected-paths-store-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips checksTamperCount through buildReworkRecordInput -> appendReworkRecord -> readReworkRecords, on the REAL file", () => {
    const bag = new IssueTelemetryBag();
    bag.noteChecksTampered();
    const bagRow = bag.toRow();
    expect(bagRow.checksTamperCount).toBe(1); // sanity: the bag really has it

    const input = buildReworkRecordInput({
      issueNumber: 909,
      status: "ok",
      shippedSha: "a".repeat(40),
      runId: "run-1",
      hostId: "host-1",
      shippedAtIso: new Date().toISOString(),
      bagRow,
    });
    // Prove the FIELD actually crosses the record-input boundary before
    // trusting the file write — a prompt/field naming a value is not
    // evidence it arrives (Piece L of the design doc).
    expect(input.checksTamperCount).toBe(1);

    const storePath = path.join(dir, "issues.jsonl");
    const wrote = appendReworkRecord(input, { path: storePath });
    expect(wrote).toBe(true);

    // Read the REAL file back — not the in-memory `input` — so this proves
    // the bytes on disk, not just the object we built.
    const { records, exists } = readReworkRecords({ path: storePath });
    expect(exists).toBe(true);
    expect(records).toHaveLength(1);
    expect(records[0]?.checksTamperCount).toBe(1);
    expect(records[0]?.issueNumber).toBe(909);
  });

  it("does not write the field at all when the lock never fired (absent, not zero)", () => {
    const bag = new IssueTelemetryBag(); // never tampered
    const input = buildReworkRecordInput({
      issueNumber: 910,
      status: "ok",
      shippedSha: "b".repeat(40),
      runId: "run-1",
      hostId: "host-1",
      shippedAtIso: new Date().toISOString(),
      bagRow: bag.toRow(),
    });
    expect(input.checksTamperCount).toBeUndefined();

    const storePath = path.join(dir, "issues.jsonl");
    appendReworkRecord(input, { path: storePath });
    const { records } = readReworkRecords({ path: storePath });
    expect(records[0]).not.toHaveProperty("checksTamperCount");
  });
});

describe("enforceCheckWriterProtectedPaths — the check-writer moving the answer key (#909)", () => {
  const CHECK_DIR = "apps/nextjs/e2e/checks/issue-909";
  const CHECK_FILE = `${CHECK_DIR}/team-cash-flow.spec.ts`;
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sandcastle-cw-protected-"));
    git(repo, "init", "-q", "-b", "issue-909");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("catches a committed edit to the practice-world answer key and restores it byte-for-byte", () => {
    const entrySha = commitInto(
      repo,
      { [PROTECTED_FILE]: "export const rent = 1000;\n" },
      "seed the answer key",
    );
    // The check-writer commits its own check AND, in the same window, edits the
    // frozen figure so a wrong answer will grade green.
    const postSha = commitInto(
      repo,
      {
        [CHECK_FILE]: "test('cash flow', () => {});\n",
        [PROTECTED_FILE]: "export const rent = 9999;\n",
      },
      "check-writer: check plus a sneaky answer-key edit",
    );

    const result = enforceCheckWriterProtectedPaths(
      repo,
      entrySha,
      postSha,
      CHECK_DIR,
    );

    expect(result.violations).toEqual([PROTECTED_FILE]);
    expect(result.restored.every((r) => r.restored)).toBe(true);
    // Restored on disk to the entry bytes, not the tampered ones.
    expect(readFileSync(path.join(repo, PROTECTED_FILE), "utf8")).toBe(
      "export const rent = 1000;\n",
    );
  });

  it("does NOT flag the check directory the check-writer legitimately created", () => {
    const entrySha = commitInto(
      repo,
      { "packages/api/src/router/deal.ts": "export const x = 1;\n" },
      "seed",
    );
    const postSha = commitInto(
      repo,
      { [CHECK_FILE]: "test('ok', () => {});\n" },
      "check-writer: only its own check",
    );

    const result = enforceCheckWriterProtectedPaths(
      repo,
      entrySha,
      postSha,
      CHECK_DIR,
    );

    expect(result.violations).toEqual([]);
  });

  it("is fail-quiet on empty or equal shas — a git hiccup never stops a night", () => {
    expect(enforceCheckWriterProtectedPaths(repo, "", "x", CHECK_DIR).violations).toEqual([]);
    expect(enforceCheckWriterProtectedPaths(repo, "abc", "abc", CHECK_DIR).violations).toEqual([]);
  });
});

// ISSUE #1135, MEDIUM 1: the frozen tsconfigs decide what a graded check SEES,
// but none is on DEFAULT_PROTECTED_PATH_GLOBS — a `paths` remap or an
// include/exclude edit was reported as drift and then SHIPPED once the graded
// run (which used the restored copy) passed. The value guard closes that at
// ship time. Proven end-to-end through the REAL `enforceProtectedPaths`.
describe("enforceProtectedPaths — the frozen tsconfig value guard (issue #1135)", () => {
  let repo: string;
  const TS = "apps/nextjs/e2e/checks/tsconfig.json";
  const cleanTs =
    JSON.stringify(
      {
        extends: "@acme/tsconfig/base.json",
        compilerOptions: { lib: ["ES2022"], paths: {} },
        include: ["./**/*.ts"],
        exclude: ["node_modules"],
      },
      null,
      2,
    ) + "\n";

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sc-protected-paths-tsconfig-"));
    git(repo, "init", "-q", "-b", "issue-1135");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("restores a tsconfig whose compilerOptions.paths was remapped to a stub", async () => {
    const preSha = commitInto(repo, { [TS]: cleanTs }, "seed");
    const tampered =
      JSON.stringify(
        {
          extends: "@acme/tsconfig/base.json",
          compilerOptions: {
            lib: ["ES2022"],
            paths: { "@acme/db": ["./__stubs__/passes.ts"] },
          },
          include: ["./**/*.ts"],
          exclude: ["node_modules"],
        },
        null,
        2,
      ) + "\n";
    const postSha = commitInto(
      repo,
      { [TS]: tampered },
      "fix: quietly redirect the check's imports\n\nSANDCASTLE-LINT: pass\nSANDCASTLE-TEST: pass",
    );
    const bag = new IssueTelemetryBag();
    const ctx = makeCtx({
      repoRoot: repo,
      branch: "issue-1135",
      telemetry: bag,
      frozenLocation: BROWSER_LOCATION_909,
    });
    const restoredSha = (await enforceProtectedPaths(
      ctx,
      { branch: "issue-1135", worktreePath: repo } as never,
      preSha,
      postSha,
      { changedLines: 1, changedFiles: [TS] },
    )).sha;
    expect(restoredSha).not.toBe(postSha);
    // The shipped tree carries the accepted tsconfig again.
    expect(git(repo, "show", `${restoredSha}:${TS}`)).toBe(cleanTs.trimEnd());
    expect(bag.toRow().checksTamperCount).toBe(1);
  });

  it("does NOT flag a tsconfig edit that leaves paths/include/exclude untouched", async () => {
    const preSha = commitInto(repo, { [TS]: cleanTs }, "seed");
    const libBumped = cleanTs.replace('"ES2022"', '"ES2023"');
    const postSha = commitInto(
      repo,
      { [TS]: libBumped },
      "chore: bump lib\n\nSANDCASTLE-LINT: pass\nSANDCASTLE-TEST: pass",
    );
    const bag = new IssueTelemetryBag();
    const ctx = makeCtx({
      repoRoot: repo,
      branch: "issue-1135",
      telemetry: bag,
      frozenLocation: BROWSER_LOCATION_909,
    });
    const result = (await enforceProtectedPaths(
      ctx,
      { branch: "issue-1135", worktreePath: repo } as never,
      preSha,
      postSha,
      { changedLines: 1, changedFiles: [TS] },
    )).sha;
    expect(result).toBe(postSha);
    expect(bag.toRow().checksTamperCount).toBeUndefined();
  });

  it("is dormant when no check was frozen (frozenLocation absent)", async () => {
    const preSha = commitInto(repo, { [TS]: cleanTs }, "seed");
    const tampered = cleanTs.replace('"paths": {}', '"paths": { "@x": ["./y"] }');
    const postSha = commitInto(
      repo,
      { [TS]: tampered },
      "edit\n\nSANDCASTLE-LINT: pass\nSANDCASTLE-TEST: pass",
    );
    const bag = new IssueTelemetryBag();
    const ctx = makeCtx({ repoRoot: repo, branch: "issue-1135", telemetry: bag });
    const result = (await enforceProtectedPaths(
      ctx,
      { branch: "issue-1135", worktreePath: repo } as never,
      preSha,
      postSha,
      { changedLines: 1, changedFiles: [TS] },
    )).sha;
    // No freeze => no check to protect => the guard never runs.
    expect(result).toBe(postSha);
    expect(bag.toRow().checksTamperCount).toBeUndefined();
  });
});
