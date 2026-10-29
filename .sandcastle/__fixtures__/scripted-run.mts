/**
 * The scripted-run harness: drive the REAL `runMain` → `runIssuePipeline`
 * end to end, with stand-in AI agents giving scripted answers, and record
 * what the run did (spec #1334, "Testing Decisions").
 *
 * ## Why this file exists
 *
 * Every rule in spec #1334 gets one test that drives the whole loop and
 * asserts only the run's OUTPUT — shipped or waiting, labels, run report.
 * The only harness that did that against a real git checkout (which the
 * fixer road needs) lived privately inside `main.recovery-judge.test.mts`,
 * a file the judge deletion removed whole. It is lifted here so every later
 * scripted test builds on one copy instead of a fresh paste.
 *
 * Not a `*.test.*` file, so vitest imports it but never collects it as a
 * suite (the same convention as the rest of `__fixtures__/`).
 *
 * `main.test.mts` keeps its own private copies of `readyIssues` / `makeArgs`
 * / `makeDeps` on purpose: many slices edit that file, and swapping its
 * helpers would add conflict surface for nothing.
 *
 * ## Two modes
 *
 * - **Mocked** (`worktreePath` omitted): the fake sandbox has no worktree and
 *   `captureSha` answers `"abc123"`. Enough for check-writer → builder →
 *   reviewer → ship.
 * - **Real git** (`worktreePath` = a real checkout, usually the `repo` from
 *   {@link initRepoWithOrigin}): `captureSha` reads `git rev-parse HEAD`.
 *   Use it for the fixer road and for any rule that reads the diff
 *   (protected paths, diff stats).
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { SandboxCommandRunner } from "../lib/sandbox-exec.js";
import type { Deps, SandcastleArgs } from "../main.mts";
import { git } from "./git-repo.js";

// ---------------------------------------------------------------------------
// Deps / args builders
// ---------------------------------------------------------------------------

/** A `listOpenIssuesWithBodies` answering these rows. A bare number is a
 *  ticket with a default title, an empty body and `ready-for-agent`. */
export function readyIssues(
  ...rows: (
    | number
    | { number: number; title?: string; body?: string; labels?: string[] }
  )[]
): Deps["listOpenIssuesWithBodies"] {
  const built = rows.map((r) => {
    const row = typeof r === "number" ? { number: r } : r;
    return {
      number: row.number,
      title: row.title ?? `issue ${row.number}`,
      body: row.body ?? "",
      labels: (row.labels ?? ["ready-for-agent"]) as readonly string[],
    };
  });
  return (async () => built) as unknown as Deps["listOpenIssuesWithBodies"];
}

/** Run arguments for a test run. `iterations` is the `--max-tickets` cap. */
export function makeArgs(overrides: Partial<SandcastleArgs> = {}): SandcastleArgs {
  return {
    iterations: 3,
    repoRoot: "/repo",
    branch: "sandcastle/test-run",
    runId: "sandcastle/test-run",
    label: "ready-for-agent",
    maxConcurrent: 1,
    implementerModel: "stub-implementer",
    reviewerModel: "stub-reviewer",
    critiqueModel: "stub-critique",
    mergerModel: "stub-merger",
    postMergeReviewerModel: "stub-pmr",
    recoveryModel: "stub-recovery",
    implementerTimeoutSec: 60,
    implementerTimeoutSecExplicit: true,
    reviewerTimeoutSec: 60,
    hardCeilingSec: 60,
    consecutiveFailureLimit: 5,
    dryRun: false,
    recoveryEnabled: false,
    retryEnabled: true,
    stagingEnabled: false,
    opusProfile: "5.5",
    budget: false,
    imageName: "sandcastle:test",
    allowDirtySandcastle: true,
    sandbox: "docker",
    stuckDetector: false,
    ...overrides,
  } as SandcastleArgs;
}

/** Fully-stubbed Deps. `run` and `createSandbox` throw unless overridden — a
 *  test that reaches an un-stubbed agent path fails loudly instead of
 *  silently doing nothing. Every other member is an inert async stub. */
export function makeDeps(overrides: Partial<Deps> = {}): Deps {
  const unused = (name: string) => (): never => {
    throw new Error(`unexpected deps.${name} call`);
  };
  const base: Deps = {
    run: unused("run") as Deps["run"],
    createSandbox: unused("createSandbox") as Deps["createSandbox"],
    claim: async () => undefined,
    markDone: async () => undefined,
    markMergedToStaging: async () => undefined,
    promoteStagingToDone: async () => ({ failed: [] }),
    openRunPr: async () => ({ url: "https://example.invalid/pr/1" }),
    quarantine: async () => undefined,
    release: async () => undefined,
    comment: async () => undefined,
    listIssuesByLabel: async () => [],
    listOpenIssuesWithBodies: async () => [],
    captureSha: async () => "",
    checkLintCert: async () => ({ status: "dormant" }),
    checkTestCert: async () => ({ status: "dormant" }),
    verifyLintRun: async () => ({ status: "inconclusive", reason: "stub" }),
    verifyTestRun: async () => ({ status: "dormant", reason: "stub" }),
    runScreenCheckHarness: async () => ({
      verdict: "match",
      reason: "stub",
      rerun: false,
      record: {
        verdict: "match",
        whenIso: new Date(0).toISOString(),
        rerun: false,
        pictureStored: false,
      },
    }),
    acquireIssueLease: async () => true,
    releaseIssueLease: async () => undefined,
    leaseState: async () => "absent",
    renewLeases: async () => undefined,
    releaseAllLeases: async () => undefined,
    fenceIssue: async () => true,
    syncLanes: async () => ({ peers: [] }),
    publishLane: async () => undefined,
    publishStatus: async () => ({ ok: true }),
    fetchStatusPeers: async () => [],
    checkpointInflight: async () => [],
    // Spec #1368: startup hooks that do nothing — no container is found or
    // removed, and no ticket is stamped.
    sweepLeftoverContainers: async () => ({ removed: [] }),
    stampStopCauses: async () => [],
    log: () => undefined,
    logError: () => undefined,
  };
  return { ...base, ...overrides };
}

/** A temp repo on `main` with one empty commit, pushed to a bare local
 *  `origin`, with a git identity (`runMain` commits telemetry here) and a
 *  `.sandcastle/` folder (the status file lands there). No branch is checked
 *  out beyond `main` — each test checks out its own. */
export function initRepoWithOrigin(prefix: string): {
  readonly repo: string;
  readonly origin: string;
  readonly cleanup: () => void;
} {
  const repo = mkdtempSync(path.join(tmpdir(), `${prefix}repo-`));
  const origin = mkdtempSync(path.join(tmpdir(), `${prefix}origin-`));
  git(origin, "init", "-q", "--bare", "-b", "main");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@test");
  git(repo, "config", "user.name", "test");
  git(repo, "commit", "--allow-empty", "-q", "-m", "init");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "origin", "main");
  mkdirSync(path.join(repo, ".sandcastle"), { recursive: true });
  return {
    repo,
    origin,
    cleanup: () => {
      rmSync(repo, { recursive: true, force: true });
      rmSync(origin, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Agent answers the parsers accept
// ---------------------------------------------------------------------------

/** Check-writer: no screen applies, so no check is written and no harness,
 *  coverage or must-fail-first run happens. */
export const CHECK_WRITER_NO_SCREEN = [
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

/** Builder: finished, backend-only, no browser test run. */
export const IMPLEMENTER_STORY_COMPLETE = [
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

/** Reviewer (the builder's or the fixer's): passes the ticket. */
export const REVIEWER_ALL_CLEAR = "looks good\nALL_CLEAR";

/** A reviewer refusal in the real shape: CATEGORY SWEEP, terminator, GROUNDS,
 *  then the bare HAS_BLOCKERS marker on the last line. */
export function reviewerRefused(bullets: readonly string[]): string {
  return [
    "I read the finished diff and I am not passing it.",
    "",
    "CATEGORY SWEEP:",
    ...bullets,
    "SWEEP COMPLETE.",
    "GROUNDS: RED-CHECK",
    "",
    "HAS_BLOCKERS",
  ].join("\n");
}

/** The exact message a real 3600s wall-clock kill produces (`withHardCeiling`
 *  in `main.mts`). `STALL_RE` matches "hard ceiling", so it counts as a stall,
 *  but none of `isTransientError` / `isOutputCapError` / `MarkerNotFoundError`
 *  match it — which is what hands the ticket to the fixer under
 *  `recoveryEnabled: true`, exactly as a real ceiling kill does. Throw it as
 *  the builder's answer: `answers: { implementer: new Error(...) }`. */
export const IMPLEMENTER_HARD_CEILING_MESSAGE =
  'hard ceiling: sandbox run "implementer" exceeded 3600s wall-clock — aborting and killing the sandboxed agent.';

// ---------------------------------------------------------------------------
// scriptedRun
// ---------------------------------------------------------------------------

/** Which stand-in agent a dispatch is, read off its run name. */
export type ScriptedRole =
  | "check-writer"
  | "implementer"
  | "reviewer"
  /** The fixer's passes: `fixer`, `fixer-retry`, `fixer-retry-2`. */
  | "fixer"
  /** The fixer's reviews: `fixer-reviewer`, `fixer-reviewer-retry`, … */
  | "fixer-reviewer"
  | "judge"
  | "critique"
  /** merger, post-merge-reviewer, post-merge-fixer, anything else. */
  | "other";

/** Map a dispatch's `spec.name` to its role. The fixer's reviews first:
 *  `"fixer-reviewer"` also starts with `"fixer"`, and `"post-merge-reviewer"`
 *  must not read as the ticket's reviewer. */
export function roleOf(name: string): ScriptedRole {
  if (name.startsWith("fixer-reviewer")) return "fixer-reviewer";
  if (name.startsWith("fixer")) return "fixer";
  if (name.startsWith("check-writer")) return "check-writer";
  if (name.startsWith("implementer")) return "implementer";
  if (name.startsWith("reviewer")) return "reviewer";
  if (name.startsWith("judge")) return "judge";
  if (name.startsWith("critique")) return "critique";
  return "other";
}

export interface ScriptedRunResult {
  readonly stdout: string;
  readonly commits?: readonly { sha: string; subject: string }[];
  /** e.g. `[{ sessionFilePath: SONNET_FIXTURE }]` to record a cost; omitted
   *  records nothing to attribute. */
  readonly iterations?: readonly { sessionFilePath?: string }[];
}

/** One answer: a stdout string, a full run result, an Error to throw, or a
 *  function computing one of those at dispatch time — for an agent whose
 *  answer has a side effect, e.g. a check-writer that writes its check file
 *  into the worktree before it answers. */
export type ScriptedAnswer =
  | string
  | Error
  | ScriptedRunResult
  | (() => string | Error | ScriptedRunResult | Promise<string | Error | ScriptedRunResult>);

/** Per role: one answer for every dispatch, or one per round — the Nth
 *  dispatch of that role gets `rounds[min(N, rounds.length - 1)]`. */
export type ScriptedAnswers = Partial<
  Record<ScriptedRole, ScriptedAnswer | readonly ScriptedAnswer[]>
>;

/** What each role answers when the test does not say. */
export const DEFAULT_ANSWERS: Readonly<Record<ScriptedRole, ScriptedAnswer>> = {
  "check-writer": CHECK_WRITER_NO_SCREEN,
  implementer: IMPLEMENTER_STORY_COMPLETE,
  reviewer: REVIEWER_ALL_CLEAR,
  fixer: IMPLEMENTER_STORY_COMPLETE,
  "fixer-reviewer": REVIEWER_ALL_CLEAR,
  judge: "",
  critique: "",
  other: "",
};

/** A builder or fixer answered with a bare string reports this one commit,
 *  so the pipeline sees work landed. Pass a {@link ScriptedRunResult} to say
 *  otherwise. */
const FAKE_BUILDER_COMMIT = { sha: "abc123", subject: "work" } as const;

export interface ScriptedCapture {
  /** Every dispatch's `spec.name`, in order. */
  readonly specs: string[];
  readonly stops: { label: string; detail: string }[];
  readonly quarantines: { issue: number; reason: string; opts: unknown }[];
  readonly logs: string[];
  /** Issues labelled `shipped-without-first-test`. */
  readonly shippedWithoutFirstTest: number[];
  /** Every dispatch's name and the prompt arguments the host filled in, in
   *  order — what the agent's prompt was rendered from. */
  readonly prompts: { name: string; promptArgs: Readonly<Record<string, string>> }[];
}

/**
 * Build the Deps for a one-ticket scripted run, plus the record of what the
 * run did. Hand `deps` to `runMain(makeArgs({ repoRoot, branch, ... }), deps)`.
 *
 * The same role router is installed as `deps.run` (top-level runs: merger,
 * post-merge) and as the fake sandbox's `run` (everything per ticket).
 * `deps` overrides are applied last and win over everything here.
 */
export function scriptedRun(opts: {
  readonly issueNumber: number;
  readonly title?: string;
  readonly body?: string;
  readonly labels?: string[];
  /** The agent branch the fake sandbox reports. */
  readonly branch: string;
  /** A real git checkout → real-git mode (see the file header). */
  readonly worktreePath?: string;
  readonly answers?: ScriptedAnswers;
  /** The fake sandbox's command runner — what runs a unit check's
   *  must-fail-first proof and its ship-time re-run. Omitted: the sandbox
   *  has no `exec`, which is fine for any ticket that writes no check. */
  readonly exec?: SandboxCommandRunner;
  /** The fake sandbox says it was resumed from the ticket's own saved work
   *  (a `refs/sandcastle/wip/issue-N` checkpoint) rather than cut fresh. */
  readonly resumedFromCheckpoint?: boolean;
  readonly deps?: Partial<Deps>;
}): { deps: Deps; captured: ScriptedCapture } {
  const captured: ScriptedCapture = {
    specs: [],
    stops: [],
    quarantines: [],
    logs: [],
    shippedWithoutFirstTest: [],
    prompts: [],
  };
  const calls = new Map<ScriptedRole, number>();

  const answerFor = (role: ScriptedRole): ScriptedAnswer => {
    const scripted = opts.answers?.[role] ?? DEFAULT_ANSWERS[role];
    const n = calls.get(role) ?? 0;
    calls.set(role, n + 1);
    if (!Array.isArray(scripted)) return scripted as ScriptedAnswer;
    const rounds = scripted as readonly ScriptedAnswer[];
    const pick = rounds[Math.min(n, rounds.length - 1)];
    if (pick === undefined) throw new Error(`scriptedRun: empty answer list for ${role}`);
    return pick;
  };

  const agentRun = async (spec: {
    name: string;
    promptArgs?: Record<string, string>;
  }): Promise<unknown> => {
    captured.specs.push(spec.name);
    captured.prompts.push({ name: spec.name, promptArgs: spec.promptArgs ?? {} });
    const role = roleOf(spec.name);
    const scripted = answerFor(role);
    const answer = typeof scripted === "function" ? await scripted() : scripted;
    if (answer instanceof Error) throw answer;
    if (typeof answer === "string") {
      return {
        stdout: answer,
        commits:
          role === "implementer" || role === "fixer" ? [FAKE_BUILDER_COMMIT] : [],
      };
    }
    return { commits: [], ...answer };
  };

  const deps = makeDeps({
    listOpenIssuesWithBodies: readyIssues({
      number: opts.issueNumber,
      title: opts.title ?? `scripted fixture ${opts.issueNumber}`,
      ...(opts.body === undefined ? {} : { body: opts.body }),
      ...(opts.labels === undefined ? {} : { labels: opts.labels }),
    }),
    run: agentRun as Deps["run"],
    createSandbox: (async () => ({
      run: agentRun,
      branch: opts.branch,
      close: async () => undefined,
      cleanup: async () => undefined,
      worktreePath: opts.worktreePath,
      ...(opts.exec === undefined ? {} : { exec: opts.exec }),
      ...(opts.resumedFromCheckpoint === true
        ? { resumedFromCheckpoint: true }
        : {}),
    })) as unknown as Deps["createSandbox"],
    captureSha:
      opts.worktreePath === undefined
        ? async () => "abc123"
        : ((async (wt: string) => git(wt, "rev-parse", "HEAD")) as unknown as Deps["captureSha"]),
    quarantine: (async (issue: number, reason: string, qopts?: unknown) => {
      captured.quarantines.push({ issue, reason, opts: qopts });
    }) as unknown as Deps["quarantine"],
    reportStop: (async (_n: number, r: { label: string; detail: string }) => {
      captured.stops.push({ label: r.label, detail: r.detail });
    }) as unknown as Deps["reportStop"],
    markShippedWithoutFirstTest: async (issue: number) => {
      captured.shippedWithoutFirstTest.push(issue);
    },
    log: (line: string) => {
      captured.logs.push(line);
    },
    ...opts.deps,
  });
  return { deps, captured };
}
