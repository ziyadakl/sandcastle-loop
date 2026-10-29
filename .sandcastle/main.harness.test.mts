/**
 * Issue #912 (Piece F) — the harness-run browser check, wired into
 * `shipAfterMigrations` as the ship-time gate that runs AFTER the
 * check-writer's check exists (#911) and BEFORE migrations apply.
 *
 * Proven here, matching the ticket's own "Prove it" section:
 *
 *   1. A `match` verdict ships normally, exactly like today.
 *   2. The five failure verdicts — `never-settled`, `claim-mismatch`,
 *      `graded-mismatch`, `environment-fault`, `inconclusive` — are each
 *      RECORDED with a DISTINCTLY WORDED explanation, never one shared
 *      "screen check failed" message, and the ticket ships (spec #1334: a red
 *      screen check is a record, never a stop).
 *   3. (folded into 2 since spec #1334.)
 *   4. The gate is a complete no-op — `deps.runScreenCheckHarness` is never
 *      called at all — when `checkWriterCheckCommand` is `undefined`
 *      (`NO_SCREEN_APPLIES`, or any pre-#912 call site).
 *   5. The OBSERVED record (`ctx.telemetry.noteScreenCheck`) is written on
 *      every path, including the failing ones, and carries the verdict the
 *      harness returned — not a re-derived guess.
 *
 * Real end-to-end proof that a browser reads a real figure off a real
 * populated page, and that a wrong figure goes red, lives in
 * `apps/nextjs/e2e/checks/issue-912/*.spec.ts` — this file proves the
 * ORCHESTRATION around that check (main.mts's own gate), with
 * `deps.runScreenCheckHarness` stubbed the same way `checkLintCert`/
 * `checkTestCert` already are in every other `shipAfterMigrations` test in
 * this repo.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { commitInto, git } from "./__fixtures__/git-repo.js";
import { shipAfterMigrations } from "./main.mts";
import type { ScreenCheckHarnessResult } from "./main.mts";
import { SHIP_INPUT_DEFAULTS } from "./__fixtures__/ship-input.mts";
import { ProofDemandUnsatisfiedStopError } from "./lib/state/stop-reasons.js";
import { IssueTelemetryBag } from "./lib/telemetry/issue-bag.js";
import { buildReworkRecordInput } from "./lib/telemetry/rework-record-input.js";
import { appendReworkRecord, readReworkRecords } from "./lib/telemetry/rework-store.js";

let repo: string;
let commit: (files: Record<string, string>, message: string) => string;

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), "sandcastle-harness-"));
  git(repo, "init", "-q", "-b", "issue-912");
  git(repo, "config", "user.email", "test@test");
  git(repo, "config", "user.name", "test");
  commit = (files, message) => commitInto(repo, files, message);
  commit({ "README.md": "seed\n" }, "init");
  git(repo, "branch", "run");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function harnessResult(
  verdict: ScreenCheckHarnessResult["verdict"],
  over: Partial<ScreenCheckHarnessResult> = {},
): ScreenCheckHarnessResult {
  return {
    verdict,
    reason: `stub reason for ${verdict}`,
    rerun: false,
    record: {
      screen: "/finance/reports?view=team",
      verdict,
      whenIso: "2026-08-04T13:00:00.000Z",
      rerun: false,
      pictureStored: false,
    },
    ...over,
  };
}

function makeShipCtx(over: {
  runScreenCheckHarness?: (...a: unknown[]) => Promise<ScreenCheckHarnessResult>;
  noteScreenCheck?: (record: unknown) => void;
  log?: (line: string) => void;
  logError?: (line: string) => void;
  reportScreenCheckWatch?: (...a: unknown[]) => Promise<void>;
  reportStop?: (...a: unknown[]) => Promise<void>;
  /** #1198 A: run this ship as a ticket the loop built without a first test. */
  firstTestFellThrough?: { reason: string; detail: string };
  markShippedWithoutFirstTest?: (issueNum: number) => Promise<void>;
}): unknown {
  return {
    args: {
      repoRoot: repo,
      branch: "run",
      stagingEnabled: true,
    },
    issueNumber: 912,
    issue: { branch: "issue-912" },
    firstTestFellThrough: over.firstTestFellThrough,
    deps: {
      markShippedWithoutFirstTest: over.markShippedWithoutFirstTest,
      log: over.log ?? (() => {}),
      logError: over.logError ?? (() => {}),
      checkLintCert: async () => ({ status: "dormant" }),
      checkTestCert: async () => ({ status: "dormant" }),
      validateMigrationJournal: async () => [],
      applyMigrations: async () => ({ realErrors: [], applied: 0 }),
      reportScreenCheckWatch: over.reportScreenCheckWatch,
      reportStop: over.reportStop,
      runScreenCheckHarness:
        over.runScreenCheckHarness ??
        (async () => {
          throw new Error("unexpected deps.runScreenCheckHarness call");
        }),
    },
    telemetry: {
      noteShipPath: () => {},
      noteDiff: () => {},
      noteImplementerAttempt: () => {},
      noteImplementerCertification: () => {},
      noteScreenCheck: over.noteScreenCheck ?? (() => {}),
      noteStopReason: () => {},
    },
    runCounters: { bump: () => {} },
  };
}

describe("shipAfterMigrations — the harness-run browser check gate (issue #912)", () => {
  it("is a complete no-op when checkWriterCheckCommand is undefined (NO_SCREEN_APPLIES, or any pre-#912 call site)", async () => {
    const preSha = git(repo, "rev-parse", "HEAD");
    const postSha = commit({ "docs/x.md": "note\n" }, "docs-only change");
    let called = false;
    const outcome = await shipAfterMigrations(
      makeShipCtx({
        runScreenCheckHarness: async () => {
          called = true;
          return harnessResult("match");
        },
      }) as never,
      { worktreePath: repo, exec: undefined } as never,
      {
        ...SHIP_INPUT_DEFAULTS,
        preSha,
        postSha,
        finalMarker: "ALL_CLEAR",
        checkWriterMarker: undefined, // checkWriterMarker: this call site has no check-writer stage
        checkWriterCheckCommand: undefined,
        checkWriterScreen: undefined,
      },
    );
    expect(called).toBe(false);
    expect(outcome.status).toBe("ok");
  });

  it("#1198 A: SKIPS the harness entirely on a ticket built without a first test — the instrument the loop refused to stand behind may not become its gate", async () => {
    // The one place this whole ticket could have failed quietly. A
    // fall-through ticket often DOES carry a check command — on the
    // green-twice road the check is real, it just never failed — so
    // without the flag this gate would stop the ticket HERE, after a full
    // build and a full review, using the very instrument the loop had already
    // decided it could not trust. That is the original stop three agents
    // later, paid for in full.
    const preSha = git(repo, "rev-parse", "HEAD");
    const postSha = commit(
      { "apps/nextjs/src/x.tsx": "export default function X() {}\n" },
      "feature",
    );
    let called = false;
    const labelled: number[] = [];
    const outcome = await shipAfterMigrations(
      makeShipCtx({
        firstTestFellThrough: {
          reason: "no-failing-check",
          detail: "the check passed against the unchanged code",
        },
        markShippedWithoutFirstTest: async (n) => {
          labelled.push(n);
        },
        runScreenCheckHarness: async () => {
          called = true;
          // A verdict that WOULD stop the ticket, so a regression that
          // re-enables the harness here fails loudly rather than passing on a
          // lucky green.
          return harnessResult("graded-mismatch");
        },
      }) as never,
      { worktreePath: repo, exec: undefined } as never,
      {
        ...SHIP_INPUT_DEFAULTS,
        preSha,
        postSha,
        finalMarker: "ALL_CLEAR",
        checkWriterMarker: "CHECKS_WRITTEN",
        checkWriterCheckCommand: "env CI=1 pnpm --filter @acme/nextjs e2e -- checks/issue-912/x.spec.ts --reporter=line",
        checkWriterScreen: "/finance/reports?view=team",
      },
    );
    expect(called).toBe(false);
    expect(outcome.status).toBe("ok");
    expect(labelled).toEqual([912]);
  });

  it("#1198 A: PROVING THE INSTRUMENT — the identical ship WITHOUT the flag still runs the harness and records its verdict", async () => {
    // The paired negative. Same fixture, same verdict, no flag — so the skip
    // above is really about the flag and not about a broken harness double.
    const preSha = git(repo, "rev-parse", "HEAD");
    const postSha = commit(
      { "apps/nextjs/src/x.tsx": "export default function X() {}\n" },
      "feature",
    );
    let called = false;
    const watched: unknown[] = [];
    await shipAfterMigrations(
      makeShipCtx({
        runScreenCheckHarness: async () => {
          called = true;
          return harnessResult("graded-mismatch");
        },
        reportScreenCheckWatch: async (...a) => {
          watched.push(a[1]);
        },
      }) as never,
      { worktreePath: repo, exec: undefined } as never,
      {
        ...SHIP_INPUT_DEFAULTS,
        preSha,
        postSha,
        finalMarker: "ALL_CLEAR",
        checkWriterMarker: "CHECKS_WRITTEN",
        checkWriterCheckCommand: "env CI=1 pnpm --filter @acme/nextjs e2e -- checks/issue-912/x.spec.ts --reporter=line",
        checkWriterScreen: "/finance/reports?view=team",
      },
    );
    expect(called).toBe(true);
    expect(watched).toHaveLength(1);
  });

  it("ships normally on a match verdict, and records the observed half of the record", async () => {
    const preSha = git(repo, "rev-parse", "HEAD");
    const postSha = commit(
      { "apps/nextjs/src/x.tsx": "export default function X() {}\n" },
      "feature",
    );
    const recorded: unknown[] = [];
    const outcome = await shipAfterMigrations(
      makeShipCtx({
        runScreenCheckHarness: async () => harnessResult("match"),
        noteScreenCheck: (r) => recorded.push(r),
      }) as never,
      { worktreePath: repo, exec: undefined } as never,
      {
        ...SHIP_INPUT_DEFAULTS,
        preSha,
        postSha,
        finalMarker: "ALL_CLEAR",
        checkWriterMarker: "CHECKS_WRITTEN",
        checkWriterCheckCommand: "env CI=1 pnpm --filter @acme/nextjs e2e -- checks/issue-912/x.spec.ts --reporter=line",
        checkWriterScreen: "/finance/reports?view=team",
      },
    );
    expect(outcome.status).toBe("ok");
    expect(recorded).toHaveLength(1);
    expect((recorded[0] as { verdict: string }).verdict).toBe("match");
  });

  it.each([
    ["never-settled", /^screen-check-could-not-grade:/],
    ["claim-mismatch", /^screen-check-app-fault:/],
    ["graded-mismatch", /^screen-check-graded-mismatch:/],
    ["environment-fault", /^screen-check-environment-fault:/],
    ["inconclusive", /^screen-check-inconclusive:/],
  ] as const)("%s is RECORDED with its own distinctly-worded explanation and the ticket ships", async (verdict, wording) => {
    const preSha = git(repo, "rev-parse", "HEAD");
    const postSha = commit({ "apps/nextjs/src/x.tsx": `x ${verdict}\n` }, "feature");
    const watched: { detail: string }[] = [];
    const outcome = await shipAfterMigrations(
      makeShipCtx({
        runScreenCheckHarness: async () => harnessResult(verdict),
        reportScreenCheckWatch: async (...a) => {
          watched.push(a[1] as { detail: string });
        },
      }) as never,
      { worktreePath: repo, exec: undefined } as never,
      {
        ...SHIP_INPUT_DEFAULTS,
        preSha,
        postSha,
        finalMarker: "ALL_CLEAR",
        checkWriterMarker: "CHECKS_WRITTEN",
        checkWriterCheckCommand: "check-command",
        checkWriterScreen: "/finance/reports?view=team",
      },
    );
    expect(outcome.status).toBe("ok");
    expect(watched).toHaveLength(1);
    expect(watched[0]!.detail).toMatch(wording);
  });
});

// ---------------------------------------------------------------------------
// Issue #1025 — the graded harness run must be PROVEN to have used this job's
// own database clone, on the MAIN ship path. Review blocker: a wrong-database
// (or unprovable) green must not certify. The observed database is read off the
// HARNESS run's own output (`observedDatabases`), never the implementer agent's
// assistant text.
// ---------------------------------------------------------------------------

describe("shipAfterMigrations — wrong-database guard (issue #1025)", () => {
  const JOB_DB = "sc_job_agent_issue_1025_9_zzz";

  async function shipWith(
    over: Partial<ScreenCheckHarnessResult>,
    jobDb: string | null | undefined,
  ) {
    const preSha = git(repo, "rev-parse", "HEAD");
    const postSha = commit({ "apps/nextjs/src/x.tsx": "x\n" }, "feature");
    return shipAfterMigrations(
      makeShipCtx({
        runScreenCheckHarness: async () => harnessResult("match", over),
      }) as never,
      { worktreePath: repo, exec: undefined, jobDb } as never,
      {
        ...SHIP_INPUT_DEFAULTS,
        preSha,
        postSha,
        finalMarker: "ALL_CLEAR",
        checkWriterMarker: "CHECKS_WRITTEN",
        checkWriterCheckCommand: "env CI=1 pnpm --filter @acme/nextjs e2e -- checks/issue-1025/x.spec.ts",
        checkWriterScreen: "/finance/reports?view=team",
      },
    );
  }

  it("stops a green run that resolved to a SHARED database (the #1015 shape)", async () => {
    await expect(
      shipWith({ observedDatabases: ["postgres"] }, JOB_DB),
    ).rejects.toThrow(/WRONG_TEST_DATABASE/);
  });

  it("FAILS CLOSED on a green browser check that named NO database at all", async () => {
    // This is the exact hole the review flagged: no-observation used to certify
    // green with zero evidence of which DB ran. It must now stop.
    await expect(
      shipWith({ observedDatabases: [] }, JOB_DB),
    ).rejects.toThrow(/WRONG_TEST_DATABASE/);
  });

  it("ships a green run that resolved to this job's own clone", async () => {
    const outcome = await shipWith({ observedDatabases: [JOB_DB] }, JOB_DB);
    expect((outcome as { status: string }).status).toBe("ok");
  });

  it("is dormant when no clone was minted (jobDb absent) — no false stop", async () => {
    // Every pre-#1025 sandbox (mac host, test double) has no jobDb, so a green
    // run with no observation must still ship — the guard only bites where the
    // per-job isolation actually exists.
    const outcome = await shipWith({ observedDatabases: [] }, undefined);
    expect((outcome as { status: string }).status).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Spec #1334 SA — there is no watch-only / enforcing switch any more. A red
// screen check is RECORDED (the issue-body watch section, the telemetry row,
// one alarm per run for a systemic verdict) and the ticket ships. The record
// still carries everything the old stop carried — the verdict, both sides of a
// graded mismatch, a distinct per-verdict explanation — so nothing the owner
// could read before is lost; only the stop is gone.
//
// The old switch was the `SANDCASTLE_SCREEN_CHECK_ENFORCE` environment
// variable (and the `screenCheckEnforce` run argument it filled). Both are set
// to "on" in every test below, so a pass proves the switch is GONE, not merely
// defaulted off.
// ---------------------------------------------------------------------------

describe("shipAfterMigrations — a failing screen check is recorded and the ticket still ships (#1334 SA)", () => {
  const OLD_SWITCH = "SANDCASTLE_SCREEN_CHECK_ENFORCE";
  let savedSwitch: string | undefined;
  beforeEach(() => {
    savedSwitch = process.env[OLD_SWITCH];
    process.env[OLD_SWITCH] = "1";
  });
  afterEach(() => {
    if (savedSwitch === undefined) delete process.env[OLD_SWITCH];
    else process.env[OLD_SWITCH] = savedSwitch;
  });

  /** The ship ctx, with the retired switch's old run argument forced ON. */
  function ctxWithOldSwitchOn(over: Parameters<typeof makeShipCtx>[0]): unknown {
    const ctx = makeShipCtx(over) as { args: Record<string, unknown> };
    ctx.args.screenCheckEnforce = true;
    return ctx;
  }

  async function shipWith(over: Parameters<typeof makeShipCtx>[0]) {
    const preSha = git(repo, "rev-parse", "HEAD");
    const postSha = commit(
      { "apps/nextjs/src/x.tsx": `export const x = "${preSha}";\n` },
      "feature",
    );
    return await shipAfterMigrations(
      ctxWithOldSwitchOn(over) as never,
      { worktreePath: repo, exec: undefined } as never,
      {
        ...SHIP_INPUT_DEFAULTS,
        preSha,
        postSha,
        finalMarker: "ALL_CLEAR",
        checkWriterMarker: "CHECKS_WRITTEN",
        checkWriterCheckCommand: "env CI=1 pnpm --filter @acme/nextjs e2e -- checks/issue-912/x.spec.ts --reporter=line",
        checkWriterScreen: "/finance/reports?view=team",
      },
    );
  }

  it.each([
    "graded-mismatch",
    "claim-mismatch",
    "never-settled",
    "environment-fault",
    "inconclusive",
  ] as const)("%s: ships, records the verdict once, and never stops", async (verdict) => {
    const stops: unknown[] = [];
    const watched: {
      verdict?: string;
      detail?: string;
      disagreement?: { checkDemanded?: string; builderProduced?: string };
    }[] = [];
    const noted: Record<string, unknown>[] = [];
    let harnessRuns = 0;
    const outcome = await shipWith({
      runScreenCheckHarness: async () => {
        harnessRuns++;
        return harnessResult(verdict);
      },
      noteScreenCheck: (r) => noted.push(r as Record<string, unknown>),
      reportScreenCheckWatch: async (...a) => {
        watched.push(a[1] as (typeof watched)[number]);
      },
      reportStop: async (...a) => {
        stops.push(a[1]);
      },
    });
    expect(outcome.status).toBe("ok");
    expect(harnessRuns).toBe(1);
    expect(stops).toEqual([]);
    expect(watched).toHaveLength(1);
    expect(watched[0]!.verdict).toBe(verdict);
    expect(watched[0]!.detail).toBeTruthy();
    expect(noted).toHaveLength(1);
    expect(noted[0]!.verdict).toBe(verdict);
    expect(noted[0]).not.toHaveProperty("enforcement");
    if (verdict === "graded-mismatch") {
      expect(watched[0]!.disagreement?.checkDemanded).toBeTruthy();
      expect(watched[0]!.disagreement?.builderProduced).toBeTruthy();
    }
  });

  it("each failing verdict is recorded with its OWN distinct explanation, never one shared message", async () => {
    const details = new Set<string>();
    for (const verdict of [
      "never-settled",
      "claim-mismatch",
      "graded-mismatch",
      "environment-fault",
      "inconclusive",
    ] as const) {
      await shipWith({
        runScreenCheckHarness: async () => harnessResult(verdict),
        reportScreenCheckWatch: async (...a) => {
          details.add((a[1] as { detail: string }).detail);
        },
      });
    }
    expect(details.size).toBe(5);
  });

  it("says in the loop's own output that a red check was recorded and the ticket shipped — never a silent swallow", async () => {
    const lines: string[] = [];
    await shipWith({
      runScreenCheckHarness: async () => harnessResult("graded-mismatch"),
      log: (l) => lines.push(l),
      logError: (l) => lines.push(l),
    });
    const joined = lines.join("\n");
    expect(joined).toContain("graded-mismatch");
    expect(joined).toMatch(/recorded/i);
    expect(joined).not.toMatch(/WATCH-ONLY|ENFORCING/);
  });

  it("PROVES THE INSTRUMENT: a never-waived proof refusal (a deleted regression spec) STILL stops the ticket", async () => {
    const seeded = commit(
      { "apps/nextjs/e2e/x.spec.ts": "test('x', () => {});\n" },
      "seed the regression spec",
    );
    git(repo, "branch", "-f", "run", seeded);
    rmSync(path.join(repo, "apps/nextjs/e2e/x.spec.ts"));
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "delete the regression spec");
    const postSha = git(repo, "rev-parse", "HEAD");
    const watched: unknown[] = [];
    await expect(
      shipAfterMigrations(
        ctxWithOldSwitchOn({
          runScreenCheckHarness: async () => harnessResult("match"),
          reportScreenCheckWatch: async (...a) => {
            watched.push(a[1]);
          },
        }) as never,
        { worktreePath: repo, exec: undefined } as never,
        {
          ...SHIP_INPUT_DEFAULTS,
          preSha: seeded,
          postSha,
          finalMarker: "ALL_CLEAR",
          checkWriterMarker: "CHECKS_WRITTEN",
          checkWriterCheckCommand: "check-command",
          checkWriterScreen: "/finance/reports?view=team",
        },
      ),
    ).rejects.toBeInstanceOf(ProofDemandUnsatisfiedStopError);
    expect(watched).toEqual([]);
  });
});

describe("the observed record's FULL, REAL journey to disk (issue #912, Piece K / Piece L)", () => {
  // Piece L: "a prompt or check naming a field is not evidence the field
  // arrives" — every producer/consumer link in this chain is the REAL
  // production module (no fakes, no stubs standing in for any of them):
  //   1. shipAfterMigrations calls ctx.telemetry.noteScreenCheck(record) —
  //      here that's a REAL IssueTelemetryBag, not a spy that just records
  //      the call happened.
  //   2. bag.toRow() (real) is fed into buildReworkRecordInput (real).
  //   3. appendReworkRecord (real) writes to a REAL file on disk.
  //   4. The assertion re-opens that file and re-parses the RAW bytes —
  //      never the in-memory record any step along the way held onto.
  it("a never-settled verdict from shipAfterMigrations's gate reaches raw bytes on disk, through the REAL bag and the REAL store — no step faked", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "sandcastle-harness-e2e-"));
    const storeDir = mkdtempSync(path.join(tmpdir(), "sandcastle-harness-store-"));
    const storePath = path.join(storeDir, "issues.jsonl");
    try {
      git(repo, "init", "-q", "-b", "issue-912");
      git(repo, "config", "user.email", "test@test");
      git(repo, "config", "user.name", "test");
      commitInto(repo, { "README.md": "seed\n" }, "init");
      const preSha = git(repo, "rev-parse", "HEAD");
      const postSha = commitInto(
        repo,
        { "apps/nextjs/src/x.tsx": "export default function X() {}\n" },
        "feature",
      );

      const bag = new IssueTelemetryBag();
      const ctx = {
        args: {
          repoRoot: repo,
          branch: "run",
          stagingEnabled: true,
        },
        issueNumber: 912,
        issue: { branch: "issue-912" },
        deps: {
          log: () => {},
          logError: () => {},
          checkLintCert: async () => ({ status: "dormant" }),
          checkTestCert: async () => ({ status: "dormant" }),
          validateMigrationJournal: async () => [],
          applyMigrations: async () => ({ realErrors: [], applied: 0 }),
          runScreenCheckHarness: async () => ({
            verdict: "never-settled",
            reason: "data-app-ready never became true within 15000ms",
            rerun: true,
            record: {
              screen: "/finance/reports?view=team",
              verdict: "never-settled",
              whenIso: "2026-08-04T13:00:00.000Z",
              rerun: true,
              pictureStored: false,
            },
          }),
        },
        telemetry: bag, // the REAL bag — noteScreenCheck really mutates it
        runCounters: { bump: () => {} },
      };

      // A red check is recorded, not a stop (spec #1334): the ship succeeds
      // and the verdict still reaches disk.
      const outcome = await shipAfterMigrations(
        ctx as never,
        { worktreePath: repo, exec: undefined } as never,
        {
          ...SHIP_INPUT_DEFAULTS,
          preSha,
          postSha,
          finalMarker: "ALL_CLEAR",
          checkWriterMarker: "CHECKS_WRITTEN",
          checkWriterCheckCommand: "check-command",
          checkWriterScreen: "/finance/reports?view=team",
        },
      );
      expect(outcome.status).toBe("ok");

      // Step 1 checkpoint: the REAL bag really has it — not asserted from the
      // stub's own return value, from the bag `shipAfterMigrations` actually
      // called `.noteScreenCheck` on.
      expect(bag.toRow().screenCheck?.verdict).toBe("never-settled");

      // Steps 2-3: feed the real bag row through the real builder into the
      // real store — exactly what `recordReworkOutcome` in main.mts does.
      const wrote = appendReworkRecord(
        buildReworkRecordInput({
          issueNumber: 912,
          status: "ok",
          shippedSha: postSha,
          runId: "run-1",
          hostId: "host-1",
          shippedAtIso: "2026-08-04T13:00:05.000Z",
          bagRow: bag.toRow(),
        }),
        { path: storePath },
      );
      expect(wrote).toBe(true);

      // Step 4: read back OFF DISK — a fresh file read, a fresh JSON.parse,
      // never the `bag`/`ctx` objects still sitting in this test's memory.
      const raw = JSON.parse(
        readFileSync(storePath, "utf8").split("\n")[0]!,
      ) as { screenCheck?: { verdict?: string; rerun?: boolean } };
      expect(raw.screenCheck?.verdict).toBe("never-settled");
      expect(raw.screenCheck?.rerun).toBe(true);

      // And through the real reader too, not just a raw JSON.parse.
      const { records } = readReworkRecords({ path: storePath });
      expect(records[0]!.screenCheck?.verdict).toBe("never-settled");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(storeDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #871 (repair 3) — THE STORY-TYPE-VS-DIFF GATE, both modes.
//
// `decideUiClaimVsDiff` catches the #868 shape: a finished diff that touched a
// rendered surface (a `.tsx` under apps/** makes `requiredProofForDiff(...)`
// answer `demand === "browser"`) while the implementer certified
// `storyType="backend-only", e2eRequired=false` — a self-report the diff
// contradicts. The PR #1149 review found NO test at any level for this gate.
// Since spec #1334 it has ONE arm:
//
//   - RECORD: the branch used to only LOG. Its comment claimed "the
//     disagreement is on the record" while telemetry and the issue body saw
//     nothing, so the settling-in count #871 exists to produce read zero even
//     as the mismatch happened. The fix RECORDS it via BOTH
//     `ctx.telemetry.noteScreenCheck({verdict:"graded-mismatch"})` and
//     `ctx.deps.reportScreenCheckWatch(..., {verdict:"graded-mismatch",
//     wouldHaveStoppedAs:"stopped:check-disagreement"})`, then ships.
//
// Driven through the REAL `shipAfterMigrations` on the same makeShipCtx harness
// every other gate test here uses, with `checkWriterMarker`/
// `checkWriterCheckCommand` left `undefined` so the proof gate is dormant and
// the browser-harness gate is a no-op — the ONLY gate this exercises is the
// story-type-vs-diff one.
// ---------------------------------------------------------------------------
describe("shipAfterMigrations — story-type-vs-diff gate (issue #871, PR #1149 coverage)", () => {
  /**
   * A well-formed implementer certification that calls its story `backend-only`
   * and denies e2e was required — the real STORY_COMPLETE envelope shape (see
   * `main.test.mts`'s IMPLEMENTER_ENVELOPE). Paired with a `.tsx`-touching diff
   * below, it is exactly the contradiction `decideUiClaimVsDiff` flags.
   */
  const BACKEND_ONLY_CERT = {
    marker: "STORY_COMPLETE",
    storyType: "backend-only",
    e2eRequired: false,
    e2eActuallyRan: false,
    testCommandUsed: null,
    e2eAssertionLine: null,
    outputNotFiltered: true,
    testReachedFeature: false,
  } as const;

  async function shipWithCert(over: Parameters<typeof makeShipCtx>[0]) {
    const preSha = git(repo, "rev-parse", "HEAD");
    // A rendered surface under apps/** — `requiredProofForDiff` answers
    // `demand:"browser"` for it, so the backend-only cert contradicts the diff.
    const postSha = commit(
      {
        "apps/nextjs/src/config-driven-chart.tsx":
          "export default function Chart() {}\n",
      },
      "a backend-only-certified diff that touched a rendered surface",
    );
    return await shipAfterMigrations(
      makeShipCtx(over) as never,
      { worktreePath: repo, exec: undefined } as never,
      {
        ...SHIP_INPUT_DEFAULTS,
        preSha,
        postSha,
        finalMarker: "ALL_CLEAR",
        checkWriterMarker: undefined, // checkWriterMarker — proof gate dormant
        checkWriterCheckCommand: undefined, // checkWriterCheckCommand — browser-harness gate a no-op
        checkWriterScreen: undefined,
        checkWriterCheckKind: "browser", // checkWriterCheckKind (unused with no check command)
        builderAccount: undefined,
        checkLocation: undefined,
        checkWriterCheckPackage: undefined,
        implementerCertification: BACKEND_ONLY_CERT as never,
      },
    );
  }

  it("records the disagreement via BOTH telemetry and the watch report, and still ships", async () => {
    const noted: { verdict?: string; enforcement?: string }[] = [];
    const watched: {
      verdict?: string;
      detail?: string;
      wouldHaveStoppedAs?: string;
      disagreement?: { checkDemanded?: string; builderProduced?: string };
    }[] = [];
    const outcome = await shipWithCert({
      noteScreenCheck: (r) => noted.push(r as (typeof noted)[number]),
      reportScreenCheckWatch: async (...a) => {
        watched.push(a[1] as (typeof watched)[number]);
      },
    });
    // (0) The ticket SHIPS — a recorded disagreement never stops.
    expect(outcome.status).toBe("ok");
    // (a) Telemetry received a graded-mismatch record for the mismatch.
    const gm = noted.find((r) => r.verdict === "graded-mismatch");
    expect(gm).toBeTruthy();
    expect(gm).not.toHaveProperty("enforcement");
    // (b) The watch report carried the both-sides evidence and the
    //     would-have-stopped label — the record the log-only version dropped.
    expect(watched).toHaveLength(1);
    expect(watched[0].verdict).toBe("graded-mismatch");
    expect(watched[0].wouldHaveStoppedAs).toBe("stopped:check-disagreement");
    expect(watched[0].disagreement?.checkDemanded).toBeTruthy();
    expect(watched[0].disagreement?.builderProduced).toBeTruthy();
  });
});
