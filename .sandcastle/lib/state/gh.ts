/**
 * gh CLI wrappers. Always invoked via execFile (NEVER exec) so that label
 * names, issue bodies, and comment text can't shell-inject. Every argument
 * is a separate argv entry — `gh` receives them verbatim.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { getProjectConfig } from "../project-config.js";

import { collectIssueRefs } from "./issue-refs.js";
import type { IssueSpecRead } from "./issue-spec.js";
import {
  CHECK_READING_LABEL_DEFINITIONS,
  CHECK_READING_STOP_LABELS,
  CHECK_READING_VALUES,
  buildCheckReadingSection,
  checkReadingLabelFor,
  parseCheckReadingSection,
  tallyCheckReadings,
  upsertCheckReadingSection,
  type CheckReadingRecord,
  type CheckReadingTally,
} from "./check-reading.js";
import {
  VERDICT_LABEL_DEFINITIONS,
  VERDICT_NEEDED_LABEL,
  VERDICT_NEEDED_LABEL_DEFINITION,
  VERDICT_VALUES,
  buildVerdictSection,
  carryVerdictHistory,
  decideVerdictWrite,
  parseVerdictSection,
  tallyVerdicts,
  upsertVerdictSection,
  verdictLabelFor,
  type VerdictRecord,
  type VerdictTally,
} from "./verdict.js";
import {
  NEEDS_OWNER_DECISION_LABEL,
  OWNER_DECISION_STOP_REASONS,
  STOP_LABEL_DEFINITIONS,
  upsertScreenCheckWatchSection,
  upsertStopSection,
  type QuarantineOpts,
  type StopReasonLabel,
} from "./stop-reasons.js";
import {
  parseRefusalRecord,
  type RefusalOutcome,
} from "./refusal.js";
import {
  WAITING_FOR_SESSION_LABEL,
  appendRetryAttempt,
  decideRetry,
  type RetryAttempt,
  type RetryDecision,
} from "./retry-budget.js";
import { readMarkedSection, upsertMarkedSection } from "./body-sections.js";
import {
  FIRST_TEST_FALLTHROUGH_SECTION_END,
  FIRST_TEST_FALLTHROUGH_SECTION_START,
  buildFirstTestFallThroughSection,
  type FirstTestFallThrough,
} from "./first-test-fallthrough.js";
import {
  runReportSectionEnd,
  runReportSectionStart,
  titleRunReport,
} from "./run-report.js";
import { olderTestEditMarkers } from "./older-test-edit-record.js";
import {
  decideMerge,
  mergeRuleSectionEnd,
  mergeRuleSectionStart,
  readChecks,
  renderMergeDanger,
} from "./merge-rule.js";
import type { ChangeClass, ChecksState, RollupEntry } from "./merge-rule.js";

const execFileP = promisify(execFile);

const GH_BIN = "gh";
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Directory every host-side `gh` invocation resolves its repo against. `gh`
 * picks its target repo from the git remote of its working directory, so when
 * the loop is pointed at a `--repo-root` different from the launch cwd (e.g. a
 * sub-worktree, or `node main.mts --repo-root ../other`), an unset cwd makes
 * every issue list/edit/close silently hit the LAUNCH repo instead of the
 * managed one. There is exactly one host repo per loop process, so a single
 * module-level value is correct (and concurrency-safe: the per-sandbox agents
 * run their own `gh` inside their containers/worktrees, never through here).
 *
 * MUST be set once via {@link configureGh} at the top of `runMain`, before any
 * gh call. Left unset, calls fall back to the process cwd (legacy behavior).
 */
let ghRepoRoot: string | undefined;

/**
 * Bind the working directory all subsequent host-side `gh` calls resolve
 * against. Call once at loop startup with `args.repoRoot`. Passing `undefined`
 * clears it (used by tests to restore the process-cwd default between cases).
 */
export function configureGh(opts: { readonly cwd?: string }): void {
  ghRepoRoot = opts.cwd;
}

interface RunResult {
  stdout: string;
  stderr: string;
}

/**
 * Default backoff schedule for `withRetry` (Wave 2 / N3 fix). Three attempts
 * total: first retry after 500ms, second retry after a further 1500ms, third
 * (final) retry after a further 4000ms — total worst-case wait ≈ 6000ms.
 *
 * Production code uses real `setTimeout`. Tests inject a no-op `sleep` so
 * vitest doesn't actually wait.
 */
const DEFAULT_BACKOFFS_MS: readonly number[] = [500, 1500, 4000];

/**
 * Wave 3 / M2 — the gh wrappers cap `gh issue list` calls at `--limit 100`.
 * If the backlog actually exceeds 100, items 101+ silently fall off. Per the
 * Wave 3 brief we don't paginate yet (would change semantics elsewhere); we
 * just emit a loud stderr WARN whenever a list call returns exactly 100
 * results so the silent loss becomes loud and operators can manually requeue.
 *
 * Exported so `archive/loop/run.ts:defaultListInProgressIssues` (frozen v1) can use the same
 * helper rather than duplicating the message string.
 */
export function warnIfHitLimit(count: number, fn: string, limit = 100): void {
  if (count === limit) {
    process.stderr.write(
      `WARN: ${fn} returned exactly ${limit} results — may have hit the ` +
        `limit. Backlog could be larger.\n`,
    );
  }
}

/** Real-time sleep helper. Replaceable in tests. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry an async operation with exponential-style backoff (delays from
 * `opts.backoffsMs`).
 *
 * Semantics:
 * - `opts.attempts` total tries (so `attempts=3` ⇒ at most 2 retries).
 * - Wait `opts.backoffsMs[i]` BEFORE attempt `i` (i.e. the first attempt has
 *   no preceding wait — `backoffsMs[0]` is the wait before the second attempt,
 *   etc). Caller-supplied schedules of length 3 cover up to 3 attempts.
 * - On success at any attempt: return immediately.
 * - On final failure: throw the original error so callers see the underlying
 *   gh error message verbatim.
 * - `opts.shouldRetry` (optional) gates retries — return false to bail
 *   immediately (used for validation errors which won't get fixed by waiting).
 *
 * Tests inject `opts.sleep` to skip real timers; production omits it and gets
 * the real `setTimeout`-based sleep.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    attempts: number;
    backoffsMs: readonly number[];
    shouldRetry?: (err: unknown) => boolean;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<T> {
  const { attempts, backoffsMs } = opts;
  const sleep = opts.sleep ?? defaultSleep;
  const shouldRetry = opts.shouldRetry ?? (() => true);
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isLast = i === attempts - 1;
      if (isLast || !shouldRetry(err)) break;
      const delay = backoffsMs[i] ?? 0;
      if (delay > 0) await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * True iff the error is a runtime gh / network failure (worth retrying), not
 * a programmer-error validation throw raised by our own argument-checking
 * code. Validation errors are deterministic — retrying just wastes time.
 *
 * Convention: every internal validation throw in this module starts with the
 * function name followed by either `:` (no issue number context) or `(N):`
 * (with the issue number for diagnostic context). Examples:
 *   - `transitionLabel: invalid issueNum '0'`
 *   - `quarantineViaLabel: invalid issueNum '-1'`
 *   - `fetchIssueLabels(42): unexpected gh output shape: ...`
 *
 * The regex below matches that shape: a leading identifier (letter, then
 * letters/digits) followed by either `:` or `(<digits>):`. Anything that
 * matches is treated as a deterministic validation throw (NOT retried). This
 * is convention-based instead of prefix-listed so newly-added validation
 * throws inherit the non-retry behavior automatically — Wave 5 / LOW-1
 * extended this from a hand-maintained allow-list (which omitted
 * `fetchIssueLabels(N):` and would have wasted ~6s retrying a deterministic
 * shape-mismatch on every `transitionLabel("*", X)` failure).
 */
const VALIDATION_THROW_PREFIX = /^[a-zA-Z][a-zA-Z0-9]*(:|\(\d+\):)/;

export function isRetryableGhError(err: unknown): boolean {
  if (!(err instanceof Error)) return true;
  // Validation throws from THIS module — non-retryable. Match against the
  // function-name-prefix convention (see VALIDATION_THROW_PREFIX above).
  if (VALIDATION_THROW_PREFIX.test(err.message)) {
    return false;
  }
  return true;
}

async function runGh(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileP(GH_BIN, args, {
      cwd: ghRepoRoot,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { stdout, stderr };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: string | number;
    };
    const stderr = typeof e.stderr === "string" ? e.stderr : "";
    const stdout = typeof e.stdout === "string" ? e.stdout : "";
    const code = e.code ?? "unknown";
    throw new Error(
      `gh ${args.join(" ")} failed (code=${String(code)}): ${stderr || stdout || e.message}`,
    );
  }
}

/**
 * Move a label on an issue.
 *
 * - When `from` is a concrete label, the call is a single `gh issue edit`
 *   that adds `to` and removes `from` atomically.
 * - When `from === "*"`, the function first fetches the issue's current
 *   labels via `gh issue view --json labels`, removes every label that
 *   appears in `STATUS_LABELS` (one `gh issue edit --remove-label` per
 *   match), then adds `to`. This guarantees the issue ends up in exactly
 *   one status label without clobbering non-status labels (priority:*, etc).
 *
 * Errors propagate — Track C decides whether label drift is fatal.
 */
export async function transitionLabel(
  issueNum: number,
  from: string,
  to: string,
  /**
   * Test seam (Wave 2): inject a no-op sleep so the retry-with-backoff
   * doesn't actually wait in unit tests. Production callers omit it and get
   * the real `setTimeout`-based sleep from `defaultSleep`.
   */
  _sleep?: (ms: number) => Promise<void>,
): Promise<void> {
  if (!Number.isInteger(issueNum) || issueNum <= 0) {
    throw new Error(`transitionLabel: invalid issueNum '${issueNum}'`);
  }
  if (typeof from !== "string" || from === "") {
    throw new Error("transitionLabel: 'fromLabel' must be a non-empty string");
  }
  if (typeof to !== "string" || to === "") {
    throw new Error("transitionLabel: 'to' label must be non-empty");
  }
  // Wrap the gh-issuing body in a retry-with-backoff so transient API hiccups
  // (network blips, GH rate-limit jitter, intermittent auth lookups) don't
  // propagate up the loop. Validation throws above are non-retryable by
  // design — they fail fast, before the retry loop starts.
  await withRetry(
    async () => {
      if (from === "*") {
        // Strip every known status label currently on the issue, preserving
        // non-status labels (priority:*, kind:*, etc), then add `to`.
        const current = await fetchIssueLabels(issueNum);
        for (const label of current) {
          if (isStatusLabel(label) && label !== to) {
            await runGh([
              "issue",
              "edit",
              String(issueNum),
              "--remove-label",
              label,
            ]);
          }
        }
        await runGh(["issue", "edit", String(issueNum), "--add-label", to]);
        return;
      }
      const args: string[] = [
        "issue",
        "edit",
        String(issueNum),
        "--add-label",
        to,
        "--remove-label",
        from,
      ];
      await runGh(args);
    },
    {
      attempts: 3,
      backoffsMs: DEFAULT_BACKOFFS_MS,
      shouldRetry: isRetryableGhError,
      sleep: _sleep,
    },
  );
}

/**
 * Close a GH issue with an optional comment.
 * `gh issue close <num> [--comment <body>]`.
 */
export async function closeIssue(
  issueNum: number,
  comment?: string,
): Promise<void> {
  if (!Number.isInteger(issueNum) || issueNum <= 0) {
    throw new Error(`closeIssue: invalid issueNum '${issueNum}'`);
  }
  const args: string[] = ["issue", "close", String(issueNum)];
  if (comment !== undefined && comment !== "") {
    args.push("--comment", comment);
  }
  await runGh(args);
}

/**
 * Injectable command runner for {@link getIssueClosure}. Mirrors the shape of
 * the module-level `runGh`; tests pass a stub so the JSON parsing can be driven
 * deterministically without a child_process mock. Production callers omit it.
 */
export interface GetIssueClosureDeps {
  runGh?: (args: string[]) => Promise<RunResult>;
}

/** `gh issue view --json state,stateReason,body,comments` output shape. */
const IssueClosureShape = z.object({
  state: z.string().optional(),
  stateReason: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  comments: z
    .array(z.object({ body: z.string().nullable().optional() }))
    .optional(),
});

/**
 * Fetch a GH issue's open/closed state, its state reason, and the free text a
 * "superseded by #N" reference would live in (issue body + every comment).
 *
 * `gh` reports `state` as `"OPEN" | "CLOSED"` and `stateReason` as one of
 * GitHub's `IssueStateReason` values (`COMPLETED`, `NOT_PLANNED`, `DUPLICATE`,
 * `REOPENED`, …) or `null`/`""`. We normalize `state` to lowercase and pass the
 * reason through RAW (empty → `null`) — deliberately NOT enumerating it — so the
 * caller can treat **any closed issue whose `stateReason !== "COMPLETED"`** as
 * UNPROVEN. Enumerating would silently drop future/other not-done reasons (a
 * `DUPLICATE` close is exactly a superseded-style close that must not read as
 * shipped).
 *
 * A GitHub "superseded" close is a not-completed reason PLUS a human comment
 * naming the successor — the reason alone cannot see it. So we also return
 * `closeText` (body + all comment bodies) as the sourced input for
 * {@link parseSupersededBy}, rather than leaving the completion agent to
 * hand-run `gh issue view` for it.
 */
export async function getIssueClosure(
  issueNum: number,
  deps?: GetIssueClosureDeps,
): Promise<{
  state: "open" | "closed";
  stateReason: string | null;
  closeText: string;
}> {
  if (!Number.isInteger(issueNum) || issueNum <= 0) {
    throw new Error(`getIssueClosure: invalid issueNum '${issueNum}'`);
  }
  const run = deps?.runGh ?? runGh;
  const { stdout } = await run([
    "issue",
    "view",
    String(issueNum),
    "--json",
    "state,stateReason,body,comments",
  ]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout || "{}");
  } catch (err) {
    throw new Error(
      `getIssueClosure(${issueNum}): failed to parse gh output as JSON: ${
        (err as Error).message
      }`,
    );
  }
  const result = IssueClosureShape.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `getIssueClosure(${issueNum}): unexpected gh output shape: ${result.error.message}`,
    );
  }
  const data = result.data;
  const state =
    String(data.state ?? "").toLowerCase() === "closed" ? "closed" : "open";
  // Pass the reason through raw (empty → null). Callers key "unproven" on
  // `stateReason !== "COMPLETED"`, so we must NOT collapse DUPLICATE/other
  // not-done reasons here.
  const reason = data.stateReason;
  const stateReason =
    typeof reason === "string" && reason !== "" ? reason : null;
  const closeText = [
    data.body ?? "",
    ...(data.comments ?? []).map((c) => c.body ?? ""),
  ]
    .filter((s) => s !== "")
    .join("\n");
  return { state, stateReason, closeText };
}

/**
 * Pure extractor for "superseded by #N" references in issue-close text.
 *
 * Collects the `#N` references that appear AFTER a supersession phrase
 * (`superseded`, case-insensitive) up to the end of that line — i.e. the
 * successor refs, not any predecessor mentioned earlier on the line. Returns
 * de-duplicated issue numbers in first-seen order; `[]` when there is no
 * supersession language (a bare `#N` with no such phrase is ignored).
 */
export function parseSupersededBy(text: string): number[] {
  if (text.length === 0) return [];
  // Gather the tail of every supersession line, then run the canonical `#N`
  // sweep once (it dedupes first-seen across the joined text).
  const supersededText = (text.match(/superseded[^\n]*/gi) ?? []).join("\n");
  return collectIssueRefs(supersededText);
}

/**
 * Fetch the title, body and label names of one GH issue in ONE read — the
 * claim-time read that fills every agent prompt's `{{ISSUE_SPEC}}` (spec
 * #1334, SB: the sandbox holds no GitHub key, so no agent can read its own
 * ticket) and the body the ship-time removal gate trusts.
 */
export async function getIssueSpec(issueNum: number): Promise<IssueSpecRead> {
  if (!Number.isInteger(issueNum) || issueNum <= 0) {
    throw new Error(`getIssueSpec: invalid issueNum '${issueNum}'`);
  }
  const { stdout } = await runGh([
    "issue",
    "view",
    String(issueNum),
    "--json",
    "title,body,labels",
  ]);
  const parsed = JSON.parse(stdout) as {
    title?: unknown;
    body?: unknown;
    labels?: { name?: unknown }[];
  };
  if (typeof parsed.title !== "string" || typeof parsed.body !== "string") {
    throw new Error(`getIssueSpec: issue #${issueNum} came back without a title or body`);
  }
  return {
    title: parsed.title,
    body: parsed.body,
    labels: (parsed.labels ?? [])
      .map((l) => l.name)
      .filter((n): n is string => typeof n === "string"),
  };
}

/**
 * Fetch the body markdown of a GH issue. Used for the other in-flight
 * tickets' briefs (`collectSiblingBriefs`); the ticket being built is read
 * through {@link getIssueSpec}.
 */
export async function getIssueBody(issueNum: number): Promise<string> {
  if (!Number.isInteger(issueNum) || issueNum <= 0) {
    throw new Error(`getIssueBody: invalid issueNum '${issueNum}'`);
  }
  const { stdout } = await runGh([
    "issue",
    "view",
    String(issueNum),
    "--json",
    "body",
    "--jq",
    ".body",
  ]);
  return stdout;
}

// ---------------------------------------------------------------------------
// V1 label-state-machine helpers.
//
// In v1 the canonical state lives in GH labels (not prd.json). The
// transitions are:
//   ready-for-agent  --claim-->  in-progress
//   in-progress      --done-->   done   (+ comment, + close)
//   in-progress      --quarantine-->  quarantine | needs-human  (+ comment, leave OPEN)
//
// Issue #1150 split the terminal label by CAUSE: a genuine loop FAILURE lands
// on `quarantine` (the default), and `needs-human` is reserved for stops a
// person or config must act on — an owner/config handoff. `quarantineViaLabel`
// writes `quarantine` by default and `needs-human` only when its options ask
// for it (`quarantineTerminalLabel`). Both spellings mean "quarantined / still
// blocking", so every reader must accept EITHER (`isQuarantineLabel`,
// `STATUS_LABELS`).
// ---------------------------------------------------------------------------

/** Canonical label names used by the v1 state machine. */
export const LABEL_READY = "ready-for-agent";
export const LABEL_IN_PROGRESS = "in-progress";
export const LABEL_DONE = "done";
/**
 * Certified by the loop and merged into THIS HOST'S run branch — but not yet
 * on `main`, and therefore not shipped in any sense the user cares about.
 *
 * The loop never pushed to `main` and never opened a PR, so the old behaviour
 * (flip to `done` + `closeIssue` the moment the local integration branch
 * fast-forwarded) manufactured a false "shipped" signal: on 2026-07-30 all 26
 * issues of a run were closed and labelled `done` while ZERO of them were on
 * `main`. Recovering the truth cost a full human session of archaeology.
 *
 * So the loop now stops at `shipped-local` and leaves the issue OPEN. Closing
 * is the run PR's job — its `Closes #N` lines fire when a human merges it, so
 * "closed" can only ever mean "the code is on the default branch".
 */
export const LABEL_SHIPPED_LOCAL = "shipped-local";
export const LABEL_NEEDS_HUMAN = "needs-human";
/**
 * Intermediate label for the staging fix-loop. An issue's branch flips from
 * `in-progress` → `merged-to-staging` once it lands in `integration-candidate`,
 * and only flips to `done` after the post-merge reviewer certifies staging
 * (POST_MERGE_ALL_CLEAR) and the orchestrator fast-forwards integration.
 *
 * If staging fails certification (POST_MERGE_ISSUES_FOUND, even after the
 * fixer pass), every issue still in `merged-to-staging` for that iteration is
 * quarantined. A staging-cert failure is a loop FAILURE, so after issue #1150
 * that terminal label is `LABEL_QUARANTINE_LEGACY` (the default — the site
 * passes no handoff opts), not `LABEL_NEEDS_HUMAN`.
 */
export const LABEL_MERGED_TO_STAGING = "merged-to-staging";
/**
 * The `quarantine` label. Named `_LEGACY` because it began as the older bash
 * drivers' synonym for `needs-human` — but after issue #1150 that name is a
 * MISNOMER: `quarantine` is now the DEFAULT terminal write (a loop failure),
 * and `needs-human` is the special case (an owner/config handoff). The constant
 * name is retained rather than renamed to avoid a churny rename across its many
 * readers. Readers MUST accept both `"needs-human"` and `"quarantine"` as
 * meaning "this issue is quarantined / still blocking".
 */
export const LABEL_QUARANTINE_LEGACY = "quarantine";
/**
 * Back-compat alias retained for callers that still import the original
 * name. Kept identical to LABEL_QUARANTINE_LEGACY.
 */
export const LABEL_QUARANTINE_ALIAS = LABEL_QUARANTINE_LEGACY;

/**
 * The full set of v1 status labels — exactly one of these should be
 * present on any open work item. `transitionLabel(num, "*", X)` strips
 * every label in this list before adding `X`, so non-status labels
 * (priority:*, kind:*, etc) are preserved verbatim.
 *
 * Includes both `"needs-human"` (canonical) and `"quarantine"` (legacy
 * synonym) so a transition correctly clears whichever spelling the issue
 * happens to carry.
 */
export const STATUS_LABELS = [
  "ready-for-agent",
  "in-progress",
  "merged-to-staging",
  // MUST stay in this list. `transitionLabel(n, "*", X)` strips only labels
  // that appear here, so if `shipped-local` were omitted a later wildcard
  // transition would leave it stuck alongside the new label — and if that new
  // label were `ready-for-agent`, the issue would re-enter the queue while
  // still marked shipped, and be built a second time.
  "shipped-local",
  "done",
  "needs-human",
  "quarantine",
  // Spec #1334 SC: the retry budget's terminal label. Here so a wildcard
  // transition (a person re-queuing by hand, a later claim) clears it.
  WAITING_FOR_SESSION_LABEL,
] as const;

const STATUS_LABEL_SET: ReadonlySet<string> = new Set(STATUS_LABELS);

/**
 * True iff `label` is one of the v1 status labels — used by
 * `transitionLabel("*", X)` to decide which existing labels to strip.
 */
export function isStatusLabel(label: string): boolean {
  return STATUS_LABEL_SET.has(label);
}

/**
 * True iff `label` denotes "this issue is quarantined / needs a human".
 * Accepts both the canonical `"needs-human"` and the legacy `"quarantine"`
 * spellings; case-sensitive (GH labels are case-sensitive in practice).
 */
export function isQuarantineLabel(label: string): boolean {
  return label === LABEL_NEEDS_HUMAN || label === LABEL_QUARANTINE_LEGACY;
}

export interface ReadyIssueSummary {
  number: number;
  title: string;
  body: string;
  labels: string[];
  createdAt: string;
}

/** GH `--json labels` returns `Array<{ name: string, ... }>`. */
interface GhLabelObject {
  name: string;
}

/**
 * Raw shape of a single record from
 * `gh issue list --json number,title,body,labels,createdAt`.
 */
interface GhIssueListRow {
  number: number;
  title: string;
  body: string;
  labels: GhLabelObject[];
  createdAt: string;
}

type Priority = "high" | "medium" | "low";

const PRIORITY_RANK: Record<Priority, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * Pick the highest-precedence priority from a label set. Defaults to
 * `medium` if no `priority:*` label is present. Handles the (illegal-but-
 * possible) case of multiple priority labels by returning the highest.
 */
export function getPriorityFromLabels(labels: string[]): Priority {
  let best: Priority = "medium";
  let bestRank = -1;
  let saw = false;
  for (const raw of labels) {
    const lower = raw.toLowerCase();
    let candidate: Priority | null = null;
    if (lower === "priority:high") candidate = "high";
    else if (lower === "priority:medium") candidate = "medium";
    else if (lower === "priority:low") candidate = "low";
    if (candidate === null) continue;
    saw = true;
    const rank = PRIORITY_RANK[candidate];
    if (rank > bestRank) {
      best = candidate;
      bestRank = rank;
    }
  }
  return saw ? best : "medium";
}

/**
 * List open issues labelled `ready-for-agent`, sorted by priority desc
 * (high > medium > low; missing label defaults to medium) then by createdAt
 * ascending within priority (older first — FIFO within a priority bucket).
 *
 * Capped at 100 to bound runtime; v1 loop only ever needs the head of the
 * queue.
 *
 * ⚠️ NOT THE BLOCKER GATE. This returns the raw `ready-for-agent` pool with
 * NO blocked-issue filtering — an issue whose body says `Blocked by: #N` is
 * still in this list. Blocked issues are excluded downstream, in code:
 * `eligibleForPlanning` (`./eligible-set.ts`) never puts one in the plan, and
 * `blockedByGate` (`.sandcastle/main.mts`) re-checks every card again at deal
 * time. Both read `unresolvedBlockers` in `./blocked-by.ts`.
 */
export async function listReadyIssues(): Promise<ReadyIssueSummary[]> {
  const { stdout } = await runGh([
    "issue",
    "list",
    "--state",
    "open",
    "--label",
    LABEL_READY,
    "--json",
    "number,title,body,labels,createdAt",
    "--limit",
    "100",
  ]);

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout || "[]");
  } catch (err) {
    throw new Error(
      `listReadyIssues: failed to parse gh output as JSON: ${
        (err as Error).message
      }`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `listReadyIssues: expected JSON array from gh, got ${typeof parsed}`,
    );
  }

  const rows = parsed as GhIssueListRow[];
  const summaries: ReadyIssueSummary[] = rows.map((row) => ({
    number: row.number,
    title: row.title ?? "",
    body: row.body ?? "",
    labels: Array.isArray(row.labels)
      ? row.labels.map((l) => l?.name ?? "").filter((n) => n.length > 0)
      : [],
    createdAt: row.createdAt ?? "",
  }));

  summaries.sort((a, b) => {
    const pa = PRIORITY_RANK[getPriorityFromLabels(a.labels)];
    const pb = PRIORITY_RANK[getPriorityFromLabels(b.labels)];
    if (pa !== pb) return pb - pa; // higher priority first
    // Older first within the same priority bucket. ISO-8601 strings sort
    // lexicographically the same as chronologically, so a plain string
    // compare is sufficient and avoids parse cost.
    if (a.createdAt < b.createdAt) return -1;
    if (a.createdAt > b.createdAt) return 1;
    return 0;
  });

  // Wave 3 / M2 — loud WARN when the result count exactly equals the gh
  // `--limit` cap. We almost certainly hit the limit; items 101+ are silently
  // dropped until pagination lands.
  warnIfHitLimit(summaries.length, "listReadyIssues");

  return summaries;
}

/**
 * Atomically transition an issue from `ready-for-agent` to `in-progress`.
 * Single `gh issue edit` call (--add-label + --remove-label) so the labels
 * flip together; if the call fails the caller can retry without leaking a
 * half-claimed state.
 *
 * ⚠️ NOT THE BLOCKER GATE. Claiming performs NO `Blocked by:` check — it
 * trusts that the issue reached it through the pipeline that does:
 * `eligibleForPlanning` (`./eligible-set.ts`), which is what builds the plan,
 * and `blockedByGate` (`.sandcastle/main.mts`), which re-checks every card
 * again at deal time. Never claim an issue that skipped both.
 */
export async function claimViaLabel(issueNum: number): Promise<void> {
  if (!Number.isInteger(issueNum) || issueNum <= 0) {
    throw new Error(`claimViaLabel: invalid issueNum '${issueNum}'`);
  }
  await transitionLabel(issueNum, LABEL_READY, LABEL_IN_PROGRESS);
}

/**
 * Mark an issue shipped-locally: remove `in-progress`, add `shipped-local`,
 * post the summary comment. The issue stays OPEN — see LABEL_SHIPPED_LOCAL.
 * Order matters: labels first, so an observer tailing the issue stream sees
 * the state flip before the comment.
 *
 * Keeps its historical name because it is the `--no-staging` twin of
 * `promoteAllStagingToDone`; both now stop short of closing.
 */
export async function markDoneViaLabel(
  issueNum: number,
  summary: string,
): Promise<void> {
  if (!Number.isInteger(issueNum) || issueNum <= 0) {
    throw new Error(`markDoneViaLabel: invalid issueNum '${issueNum}'`);
  }
  await transitionLabel(issueNum, LABEL_IN_PROGRESS, LABEL_SHIPPED_LOCAL);
  // Deliberately NOT closeIssue: this work is on a local run branch, not on
  // `main`. Merging the run PR is what closes it.
  await postIssueComment(issueNum, summary);
}

/**
 * Flip `in-progress` → `merged-to-staging` once an issue's branch lands on
 * the `integration-candidate` staging branch. The issue stays OPEN — only
 * `promoteAllStagingToDone` (after POST_MERGE_ALL_CLEAR) closes it.
 *
 * Uses the wildcard transition (`*` → target) so it tolerates issues that
 * already lost the `in-progress` label for any reason; the wildcard strips
 * every status label and re-adds the target.
 */
export async function markMergedToStagingViaLabel(
  issueNum: number,
): Promise<void> {
  if (!Number.isInteger(issueNum) || issueNum <= 0) {
    throw new Error(`markMergedToStagingViaLabel: invalid issueNum '${issueNum}'`);
  }
  await transitionLabel(issueNum, "*", LABEL_MERGED_TO_STAGING);
}

/**
 * Promote every `merged-to-staging` issue to `shipped-local` after staging
 * fast-forwards into the integration branch. Posts a single shared `summary`
 * comment on each. Per-issue failures are isolated — one bad gh call doesn't
 * block the rest. Returns the list of issues that could not be promoted
 * (caller logs / decides quarantine).
 *
 * Does NOT close: the integration branch is local to this host and nothing
 * here has touched `main`. See LABEL_SHIPPED_LOCAL.
 */
export async function promoteAllStagingToDone(
  issueNums: readonly number[],
  summary: string,
): Promise<{ failed: readonly number[] }> {
  const failed: number[] = [];
  for (const n of issueNums) {
    if (!Number.isInteger(n) || n <= 0) {
      failed.push(n);
      continue;
    }
    try {
      await transitionLabel(n, LABEL_MERGED_TO_STAGING, LABEL_SHIPPED_LOCAL);
      // Deliberately NOT closeIssue — see LABEL_SHIPPED_LOCAL.
      await postIssueComment(n, summary);
    } catch {
      failed.push(n);
    }
  }
  return { failed };
}

/**
 * The TERMINAL status label one quarantine writes, split by CAUSE (issue
 * #1150). The default — a genuine loop FAILURE — is `quarantine`. `needs-human`
 * is written only for an owner/config handoff, asked for in one of two ways
 * (see {@link QuarantineOpts}):
 *
 *   - `handoff: true` — the call site itself knows this is a handoff (already
 *     built, missing practice-world data, an uninstalled rubric).
 *   - `stopLabel` in `OWNER_DECISION_STOP_REASONS` — a stop only the owner can
 *     settle (e.g. `stopped:ticket-unclear`). Every other stop stays a loop
 *     failure → `quarantine`.
 *
 * Pure and exported so the decision is pinned by unit test without shelling out
 * to `gh` (`quarantineViaLabel` runs it, then hands the label to
 * `transitionLabel`, which uses the module-level `runGh`). One spelling of the
 * rule — it reads the same `OWNER_DECISION_STOP_REASONS` the body-section
 * labeller does, so the two can never disagree about which stops the owner owns.
 */
export function quarantineTerminalLabel(
  opts?: QuarantineOpts,
): typeof LABEL_NEEDS_HUMAN | typeof LABEL_QUARANTINE_LEGACY {
  const toNeedsHuman =
    opts?.handoff === true ||
    (opts?.stopLabel !== undefined &&
      OWNER_DECISION_STOP_REASONS.has(opts.stopLabel));
  return toNeedsHuman ? LABEL_NEEDS_HUMAN : LABEL_QUARANTINE_LEGACY;
}

/**
 * Quarantine an issue: remove `in-progress` (the common path from the loop),
 * add the terminal status label, and post a comment with the reason. The issue
 * stays OPEN — it is triaged before requeue.
 *
 * The terminal label is `quarantine` by DEFAULT (a loop failure) and
 * `needs-human` only when `opts` marks this stop an owner/config handoff — see
 * {@link quarantineTerminalLabel}. Both leave the issue still-blocking; the
 * split is issue #1150.
 *
 * If the issue is still in `ready-for-agent` (rare — quarantine usually
 * follows a claim), the caller can call `transitionLabel(num, LABEL_READY, …)`
 * first or rely on the underlying `gh` tolerance for removing a not-applied
 * label being a no-op.
 */
export async function quarantineViaLabel(
  issueNum: number,
  reason: string,
  opts?: QuarantineOpts,
): Promise<void> {
  if (!Number.isInteger(issueNum) || issueNum <= 0) {
    throw new Error(`quarantineViaLabel: invalid issueNum '${issueNum}'`);
  }
  await transitionLabel(
    issueNum,
    LABEL_IN_PROGRESS,
    quarantineTerminalLabel(opts),
  );
  await postIssueComment(issueNum, reason);
  // NB: deliberately no closeIssue here — quarantine leaves the issue open.
}

/**
 * Release an in-progress issue back to ready-for-agent. Used when the loop
 * defers an issue due to a transient rate-limit — the next iteration will
 * re-claim and retry. Posts a comment so there's an audit trail of why the
 * issue bounced back.
 */
export async function releaseViaLabel(
  issueNum: number,
  reason: string,
): Promise<void> {
  if (!Number.isInteger(issueNum) || issueNum <= 0) {
    throw new Error(`releaseViaLabel: invalid issueNum '${issueNum}'`);
  }
  await transitionLabel(issueNum, LABEL_IN_PROGRESS, LABEL_READY);
  await postIssueComment(issueNum, reason);
}

/**
 * Post a comment on an issue via `gh issue comment <num> --body <body>`.
 * Exported for the v1 loop's progress-reporting paths; `markDoneViaLabel`
 * uses `closeIssue`'s --comment passthrough instead, and `quarantineViaLabel`
 * uses this directly because it must NOT close the issue.
 */
export async function postIssueComment(
  issueNum: number,
  body: string,
): Promise<void> {
  if (!Number.isInteger(issueNum) || issueNum <= 0) {
    throw new Error(`postIssueComment: invalid issueNum '${issueNum}'`);
  }
  await runGh(["issue", "comment", String(issueNum), "--body", body]);
}

// ---------------------------------------------------------------------------
// Recovery / introspection helpers.
// ---------------------------------------------------------------------------

/**
 * Fetch the label names currently on an issue. Returns `[]` if the issue
 * has no labels or if `gh` returns empty stdout (e.g. mocked in tests).
 *
 * Used internally by `transitionLabel("*", X)` to decide which status
 * labels to strip; not exported because callers should reach for
 * `listIssuesByLabel` or fold the labels into a list query instead of
 * doing N point-fetches.
 */
export async function fetchIssueLabels(issueNum: number): Promise<string[]> {
  const { stdout } = await runGh([
    "issue",
    "view",
    String(issueNum),
    "--json",
    "labels",
  ]);
  const trimmed = stdout.trim();
  if (trimmed === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(
      `fetchIssueLabels(${issueNum}): failed to parse gh output as JSON: ${
        (err as Error).message
      }`,
    );
  }
  // `gh issue view --json labels` returns `{ "labels": [{ "name": "...", ... }] }`.
  const shape = z.object({
    labels: z.array(z.object({ name: z.string() })),
  });
  const result = shape.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `fetchIssueLabels(${issueNum}): unexpected gh output shape: ${result.error.message}`,
    );
  }
  return result.data.labels.map((l) => l.name);
}

/** Public shape returned by `listIssuesByLabel`. */
export interface LabelledIssueSummary {
  number: number;
  title: string;
  labels: string[];
}

export interface OpenIssueWithBody {
  number: number;
  /** Issue #1179 review, deferable 8: without this, any report entry built
   *  from this listing (the retry sweep's requeued/waiting
   *  tickets) can only ever render a bare `#N` — the exact archaeology the
   *  report exists to remove. Best-effort: `""` when `gh` returns no title. */
  title: string;
  body: string;
  labels: string[];
}

const OpenIssueRow = z.object({
  number: z.number().int(),
  title: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  labels: z.array(z.object({ name: z.string() })),
});
const OpenIssueRows = z.array(OpenIssueRow);

/**
 * List ALL open issues with their body markdown + labels (no label filter).
 *
 * Used by the loop driver's "no claimable issues" exit (Issue E) to surface
 * `Blocked by: #N` chains: it needs the set of every open issue number to
 * decide whether a blocker referenced by a `ready-for-agent` issue is still
 * open, and the bodies to find the directives. A blocker is typically
 * `in-progress` (not `ready-for-agent`), so a label-filtered query wouldn't
 * see it — hence "all open".
 *
 * Caps at 500 results (same pagination caveat as the other list helpers).
 * Was 100, raised when the loop stopped closing issues at ship time
 * (LABEL_SHIPPED_LOCAL): the open set now grows until a human lands the work,
 * and a repo sitting above the cap silently disables the startup WIP-ref
 * prune. Keep in sync with GH_OPEN_ISSUE_LIST_LIMIT in main.mts, which the
 * planning road compares against to decide the listing may be missing rows.
 */
export async function listOpenIssuesWithBodies(): Promise<OpenIssueWithBody[]> {
  const { stdout } = await runGh([
    "issue",
    "list",
    "--state",
    "open",
    "--json",
    "number,title,body,labels",
    "--limit",
    "500",
  ]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout || "[]");
  } catch (err) {
    throw new Error(
      `listOpenIssuesWithBodies: failed to parse gh output as JSON: ${
        (err as Error).message
      }`,
    );
  }
  const result = OpenIssueRows.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `listOpenIssuesWithBodies: unexpected gh output shape: ${result.error.message}`,
    );
  }
  const summaries: OpenIssueWithBody[] = result.data.map((row) => ({
    number: row.number,
    title: row.title ?? "",
    body: row.body ?? "",
    labels: row.labels.map((l) => l.name),
  }));
  summaries.sort((a, b) => a.number - b.number);
  // Issue #1178 review, deferable finding 6: this list caps at 500, not
  // 100, so the shared `warnIfHitLimit(count, fn)` two-arg call silently
  // never fired here — the retry sweep (and every other caller of
  // this function) could sit above the cap with zero warning that some
  // open tickets, including quarantine candidates, are invisible to it.
  warnIfHitLimit(summaries.length, "listOpenIssuesWithBodies", 500);
  return summaries;
}

const LabelledIssueRow = z.object({
  number: z.number().int(),
  title: z.string(),
  labels: z.array(z.object({ name: z.string() })),
});
const LabelledIssueRows = z.array(LabelledIssueRow);

/**
 * List open issues that carry `label`, sorted by issue number ascending
 * (deterministic for tests). Caps at 100 results — startup-recovery never
 * needs more than the head of the queue.
 *
 * Used by the loop driver's startup-recovery path to find issues that were
 * left labelled `in-progress` by a previous (crashed) run and need to be
 * reset to `ready-for-agent`.
 */
export async function listIssuesByLabel(
  label: string,
): Promise<LabelledIssueSummary[]> {
  if (typeof label !== "string" || label === "") {
    throw new Error("listIssuesByLabel: 'label' must be a non-empty string");
  }
  const { stdout } = await runGh([
    "issue",
    "list",
    "--label",
    label,
    "--state",
    "open",
    "--json",
    "number,title,labels",
    "--limit",
    "100",
  ]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout || "[]");
  } catch (err) {
    throw new Error(
      `listIssuesByLabel(${label}): failed to parse gh output as JSON: ${
        (err as Error).message
      }`,
    );
  }
  const result = LabelledIssueRows.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `listIssuesByLabel(${label}): unexpected gh output shape: ${result.error.message}`,
    );
  }
  const summaries: LabelledIssueSummary[] = result.data.map((row) => ({
    number: row.number,
    title: row.title,
    labels: row.labels.map((l) => l.name),
  }));
  summaries.sort((a, b) => a.number - b.number);

  // Wave 3 / M2 — same pagination-cap WARN as listReadyIssues.
  warnIfHitLimit(summaries.length, "listIssuesByLabel");

  return summaries;
}

/**
 * Open a DRAFT pull request from `head` into `base`, or return the URL of the
 * one that already exists.
 *
 * This is how a run ends. The loop previously stopped at "certified on a local
 * branch" and told GitHub the issues were done — false in the only sense that
 * matters, since nothing had reached `main`. Ending on a draft PR makes the
 * run's output one reviewable object, and its `Closes #N` lines mean merging
 * is what closes the issues.
 *
 * Draft deliberately: the branch is not pre-approved to merge, and a draft
 * cannot be picked up by anything auto-merging the repo. The one way it
 * leaves draft is {@link settleRunPr} (tokenmaxxing#29), which marks it
 * ready and merges it only when the merge rule allows.
 *
 * Idempotent — a branch that already has an open PR returns that PR instead of
 * erroring, so a resumed or re-run loop does not fail here.
 */
export async function openDraftPr(opts: {
  readonly head: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
}): Promise<{ url: string; alreadyExisted: boolean }> {
  if (!opts.head.trim()) throw new Error("openDraftPr: empty head branch");
  if (!opts.base.trim()) throw new Error("openDraftPr: empty base branch");

  // Existing-PR check first: `gh pr create` errors on a branch that already
  // has one, and that error is indistinguishable from a real failure at the
  // call site.
  try {
    const { stdout } = await runGh([
      "pr",
      "list",
      "--head",
      opts.head,
      "--state",
      "open",
      "--json",
      "url",
      "--limit",
      "1",
    ]);
    const rows = JSON.parse(stdout || "[]") as { url?: string }[];
    const existing = rows[0]?.url;
    if (existing) return { url: existing, alreadyExisted: true };
  } catch {
    // A failed lookup is not a reason to skip opening the PR — fall through.
  }

  const { stdout } = await runGh([
    "pr",
    "create",
    "--draft",
    "--head",
    opts.head,
    "--base",
    opts.base,
    "--title",
    opts.title,
    "--body",
    opts.body,
  ]);
  const url = stdout.trim().split("\n").pop() ?? "";
  return { url, alreadyExisted: false };
}

/**
 * The repo's default branch (`main`, `master`, …), read from GitHub rather
 * than assumed. Falls back to `main` if the lookup fails — a wrong base on a
 * draft PR a human reviews beats no PR at all.
 */
export async function defaultBranch(): Promise<string> {
  try {
    const { stdout } = await runGh([
      "repo",
      "view",
      "--json",
      "defaultBranchRef",
      "--jq",
      ".defaultBranchRef.name",
    ]);
    return stdout.trim() || "main";
  } catch {
    return "main";
  }
}

// ---------------------------------------------------------------------------
// The stop reasons — Piece H's five (issue #914) plus issue #923's four.
// Three functions:
//   - ensureStopLabelsExist: create-on-demand — "the GitHub labels must
//     actually exist in the repository or the loop will fail at runtime when
//     it tries to apply one." `gh` does NOT invent a label on `--add-label`;
//     it 404s. Calling this once at loop startup (see main.mts's `runMain`)
//     makes label existence a property of running the loop, not a manual
//     setup step someone can forget.
//   - applyStopReport: apply the label(s) and upsert the issue BODY section
//     — never a comment. This repo's own rule: state lives in the body
//     because comments go stale and are not reliably re-read.
//   - applyStopLabelOnly: the label and nothing else (issue #923), for the
//     three stop sites whose full explanation is ALREADY a comment and
//     must stay one by owner decision.
// ---------------------------------------------------------------------------

/** Test seam mirroring {@link GetIssueClosureDeps} — production omits it and
 *  gets the real module-level `runGh`. */
export interface StopReportDeps {
  runGh?: (args: string[]) => Promise<RunResult>;
}

/**
 * Create (or, via `--force`, update) every label in {@link STOP_LABEL_DEFINITIONS}.
 * Idempotent and safe to call on every loop startup — `gh label create
 * --force` creates an absent label and updates color/description on one that
 * already exists; it never errors on "already exists" the way a plain
 * `gh label create` would.
 *
 * Best-effort per label: one label's create/update failure (a transient API
 * hiccup, a token missing the right scope) is reported through `onError` and
 * does NOT stop the rest — a single bad label must not silently
 * disable every stop reason.
 *
 * Does NOT create `needs-owner-decision` — that label already exists in this
 * repo (verified via `gh label list` before this module was written; see
 * `stop-reasons.ts`'s own doc comment) and this function only owns the
 * `stopped:*` labels themselves.
 */
export async function ensureStopLabelsExist(
  opts?: { onError?: (name: string, err: unknown) => void } & StopReportDeps,
): Promise<void> {
  const run = opts?.runGh ?? runGh;
  const onError = opts?.onError ?? ((): void => {});
  for (const def of STOP_LABEL_DEFINITIONS) {
    try {
      await run([
        "label",
        "create",
        def.name,
        "--color",
        def.color,
        "--description",
        def.description,
        "--force",
      ]);
    } catch (err) {
      onError(def.name, err);
    }
  }
}

/**
 * Apply a stop label to `issueNum` and upsert the human-readable
 * explanation into the issue's BODY — never a comment.
 *
 * Three steps, each best-effort against the others in the sense that a
 * label failure does not prevent the body write from being attempted (and
 * vice versa) — the caller (`main.mts`) already wraps this whole call in a
 * best-effort try/catch (mirroring `commentBestEffort`), but partial
 * progress here is still better than none:
 *
 *   1. Add the stop label (`opts.label`), and `needs-owner-decision` too when
 *      `opts.label` is one of `OWNER_DECISION_STOP_REASONS`
 *      (`stopped:ticket-unclear`).
 *   2. Fetch the CURRENT body (never assume it is empty — a real issue
 *      carries the ticket's own description, which must survive).
 *   3. Upsert the stop section (`upsertStopSection`, pure) and write the
 *      WHOLE new body back with a single `gh issue edit --body` — `gh` has
 *      no partial-body-edit verb, so a full-body write is the only way to
 *      "not clobber the existing body" while still updating in place.
 *
 * Labels and body are applied in ONE `gh issue edit` call when possible —
 * fewer network round trips, and no window where the label is applied but
 * the body update has not landed yet.
 */
export async function applyStopReport(
  issueNum: number,
  opts: {
    readonly label: StopReasonLabel;
    readonly section: string;
  },
  deps?: StopReportDeps,
): Promise<void> {
  if (!Number.isInteger(issueNum) || issueNum <= 0) {
    throw new Error(`applyStopReport: invalid issueNum '${issueNum}'`);
  }
  const run = deps?.runGh ?? runGh;

  const { stdout } = await run([
    "issue",
    "view",
    String(issueNum),
    "--json",
    "body",
    "--jq",
    ".body",
  ]);
  const currentBody = stdout.replace(/\n$/, "");
  const newBody = upsertStopSection(currentBody, opts.section);

  const args: string[] = [
    "issue",
    "edit",
    String(issueNum),
    "--body",
    newBody,
    "--add-label",
    opts.label,
  ];
  // Which stops also carry `needs-owner-decision` is decided in ONE place
  // (`OWNER_DECISION_STOP_REASONS`, `stop-reasons.ts`), never by an `if`
  // here: `stopped:ticket-unclear`, a question only the owner can answer.
  if (OWNER_DECISION_STOP_REASONS.has(opts.label)) {
    args.push("--add-label", NEEDS_OWNER_DECISION_LABEL);
  }
  // #1130 finding 2: a STOPPED disagreement owes a ruling exactly as a WATCHED
  // one does — but only the watch path (`applyScreenCheckWatchReport`) applied
  // `verdict:needed`, so a person typing `gh issue list --label verdict:needed`
  // silently saw the watched cases and none of the stopped ones. `countVerdicts`
  // was never wrong (it queries `stopped:check-disagreement` too), but the hand
  // query was. Apply the label here so both surfaces agree.
  //
  // Only when no verdict is on the body yet, read from the SAME `currentBody`
  // fetched above. A verdict written later by hand (`pnpm sandcastle:verdict`,
  // which calls `applyVerdictReport`) removes the label again.
  if (
    opts.label === "stopped:check-disagreement" &&
    parseVerdictSection(currentBody) === undefined
  ) {
    args.push("--add-label", VERDICT_NEEDED_LABEL);
  }
  await run(args);
}

/**
 * Apply a stop label and NOTHING else — no body write, no comment (issue
 * #923).
 *
 * Two of `main.mts`'s `quarantine` call sites already post a good GitHub
 * COMMENT explaining themselves: the skills-discipline gate and the
 * stuck-detector (the design-critique gate was a third until spec #1334).
 * **Owner decision, 2026-08-16: that comment text stays exactly where it is
 * and must not be moved into the body.** What those lacked was a LABEL, and a comment
 * cannot be counted — without one, those stop kinds are invisible to any
 * tally of what the run did last night.
 *
 * So this is deliberately NOT {@link applyStopReport} with an empty section:
 * it must never touch the body at all. A body write here would fetch the
 * ticket's description and write the whole thing back for no reason, which
 * is a real risk of clobbering on a ticket someone is editing by hand.
 */
export async function applyStopLabelOnly(
  issueNum: number,
  opts: { readonly label: StopReasonLabel },
  deps?: StopReportDeps,
): Promise<void> {
  if (!Number.isInteger(issueNum) || issueNum <= 0) {
    throw new Error(`applyStopLabelOnly: invalid issueNum '${issueNum}'`);
  }
  const run = deps?.runGh ?? runGh;
  await run(["issue", "edit", String(issueNum), "--add-label", opts.label]);
}

/**
 * The label every merge that took the first-test fall-through carries
 * (#1198 A). NOT a status label — it is deliberately absent from
 * {@link STATUS_LABELS}, so `transitionLabel(n, "*", X)` leaves it alone and
 * it survives `in-progress` → `merged-to-staging` → `shipped-local` → `done`
 * intact. That is what lets it be applied ONCE, at the moment the ticket
 * ships, and still be on the ticket when the run's pull request closes it.
 */
export const LABEL_SHIPPED_WITHOUT_FIRST_TEST = "shipped-without-first-test";

/** Colour and description for {@link LABEL_SHIPPED_WITHOUT_FIRST_TEST}. The
 *  amber every "worth a look, nothing is broken" label in this repo wears;
 *  description held under GitHub's 100-character cap, which `gh label create`
 *  rejects with HTTP 422 above. */
export const SHIPPED_WITHOUT_FIRST_TEST_LABEL_DEFINITION = {
  name: LABEL_SHIPPED_WITHOUT_FIRST_TEST,
  color: "FBCA04",
  description:
    "Merged on the reviewer's pass alone; the loop could not make a first test good (#1198)",
} as const;

/**
 * Create {@link LABEL_SHIPPED_WITHOUT_FIRST_TEST}, idempotently, exactly the
 * way {@link ensureCheckReadingLabelsExist} creates the `check-read:*` labels.
 *
 * **Why this exists at all (#1198 review, S4).**
 * {@link markShippedWithoutFirstTest} shells out to
 * `gh issue edit --add-label`, which ERRORS when the label does not exist in
 * the repository, and its one caller swallows that error best-effort. So on
 * any host or fork where the label was never created by hand, the single
 * owner-visible signal that a merge carried the weaker proof vanished
 * silently — the merge looked exactly like a fully proven one. Creating it at
 * run start, before any ticket can ship, is the same remedy the verdict and
 * check-reading labels already use.
 *
 * Best-effort: a failure is reported through `onError` and never stops the
 * run. A missing label costs a signal; a thrown startup costs the night.
 */
export async function ensureShippedWithoutFirstTestLabelExists(
  opts?: { onError?: (name: string, err: unknown) => void } & StopReportDeps,
): Promise<void> {
  const run = opts?.runGh ?? runGh;
  const def = SHIPPED_WITHOUT_FIRST_TEST_LABEL_DEFINITION;
  try {
    await run([
      "label",
      "create",
      def.name,
      "--color",
      def.color,
      "--description",
      def.description,
      "--force",
    ]);
  } catch (err) {
    opts?.onError?.(def.name, err);
  }
}

/**
 * Record on `issueNum` that this build shipped without a first test (#1198 A)
 * — one additive label, nothing else.
 *
 * Same shape as {@link applyStopLabelOnly} and for the same reason: the body
 * has already been written by {@link applyFirstTestFallThroughReport} at the
 * moment the fall-through happened, hours before the ship. Re-fetching and
 * re-writing the whole body here would risk clobbering a ticket someone is
 * editing by hand, for a fact that is already on it.
 *
 * `--add-label` is idempotent in `gh`, so a retry or a double-ship costs one
 * wasted call and changes nothing.
 */
export async function markShippedWithoutFirstTest(
  issueNum: number,
  deps?: StopReportDeps,
): Promise<void> {
  if (!Number.isInteger(issueNum) || issueNum <= 0) {
    throw new Error(`markShippedWithoutFirstTest: invalid issueNum '${issueNum}'`);
  }
  const run = deps?.runGh ?? runGh;
  await run([
    "issue",
    "edit",
    String(issueNum),
    "--add-label",
    LABEL_SHIPPED_WITHOUT_FIRST_TEST,
  ]);
}

/**
 * The two labels the APPROVING reviewer's report-only rows put on a shipped
 * ticket (spec #1334 follow-on; parsed by `readReviewNotes` in
 * `lib/review/review-notes.ts`). A `FINDING` on the Structure row and a
 * `WEAK` on the First-test strength row. They never stop a ticket: they tell
 * the owner's end-of-run review which merges to read first.
 *
 * NOT status labels, deliberately absent from {@link STATUS_LABELS}, exactly
 * like {@link LABEL_SHIPPED_WITHOUT_FIRST_TEST} and for the identical reason:
 * applied ONCE at the ship moment, they must survive `in-progress` →
 * `shipped-local` → `done`.
 */
export const LABEL_SHIPPED_WITH_STRUCTURE_FINDING =
  "shipped-with-structure-finding";
export const LABEL_SHIPPED_WITH_WEAK_FIRST_TEST = "shipped-with-weak-first-test";
export type ReviewNoteLabel =
  | typeof LABEL_SHIPPED_WITH_STRUCTURE_FINDING
  | typeof LABEL_SHIPPED_WITH_WEAK_FIRST_TEST;

/** Colour and description for the two review-note labels — the amber every
 *  "worth a look, nothing is broken" label wears; descriptions under GitHub's
 *  100-character cap. */
export const REVIEW_NOTE_LABEL_DEFINITIONS = [
  {
    name: LABEL_SHIPPED_WITH_STRUCTURE_FINDING,
    color: "FBCA04",
    description:
      "Merged; the approving reviewer noted a structure problem worth a look (never blocks)",
  },
  {
    name: LABEL_SHIPPED_WITH_WEAK_FIRST_TEST,
    color: "FBCA04",
    description:
      "Merged; the approving reviewer judged the ticket's first test weak (never blocks)",
  },
] as const;

/**
 * Create both review-note labels, idempotently, at run start — the way
 * {@link ensureShippedWithoutFirstTestLabelExists} creates its own, and for
 * the same reason: `--add-label` errors on a label the repository lacks, and
 * its caller swallows that error, so the signal would vanish silently.
 * Best-effort: a failure is reported through `onError`, never thrown.
 */
export async function ensureReviewNoteLabelsExist(
  opts?: { onError?: (name: string, err: unknown) => void } & StopReportDeps,
): Promise<void> {
  const run = opts?.runGh ?? runGh;
  for (const def of REVIEW_NOTE_LABEL_DEFINITIONS) {
    try {
      await run([
        "label",
        "create",
        def.name,
        "--color",
        def.color,
        "--description",
        def.description,
        "--force",
      ]);
    } catch (err) {
      opts?.onError?.(def.name, err);
    }
  }
}

/**
 * Add one review-note label to `issueNum` — no body write, same shape as
 * {@link markShippedWithoutFirstTest}. `--add-label` is idempotent.
 */
export async function markShippedWithReviewNote(
  issueNum: number,
  label: ReviewNoteLabel,
  deps?: StopReportDeps,
): Promise<void> {
  if (!Number.isInteger(issueNum) || issueNum <= 0) {
    throw new Error(`markShippedWithReviewNote: invalid issueNum '${issueNum}'`);
  }
  const run = deps?.runGh ?? runGh;
  await run(["issue", "edit", String(issueNum), "--add-label", label]);
}

/**
 * Write the first-test fall-through diagnosis (#1198 A) onto `issueNum`'s
 * BODY, and apply NO label at all.
 *
 * The label omission is the entire point, exactly as it is for
 * `applyScreenCheckWatchReport`. This
 * replaces a `stopped:*` write, and the ticket is emphatically NOT stopped —
 * a builder is about to run on it. A `stopped:*` label here would make an
 * in-progress ticket read as held to every query and every triage pass, which
 * is the precise misreading #1198 exists to end. The label that DOES get
 * applied is `shipped-without-first-test`, and it lands at the ship moment
 * ({@link markShippedWithoutFirstTest}), because only then is it true.
 *
 * ## Why this one REWRITES rather than writing once
 *
 * This section is not a one-shot latch — it is a diagnosis, and the LATEST
 * diagnosis is the true one. A ticket that fell through on `run-fault` last
 * night and on `no-failing-check` tonight must say `no-failing-check`, not
 * keep a stale sentence about a sandbox
 * that has since been fixed.
 *
 * So the comparison is on CONTENT, not presence: a section byte-identical to
 * what is already there returns `"already-present"` and makes no write (a
 * re-run of the same fall-through costs one `gh` call, not two, and leaves
 * the body's mtime alone), and anything else is upserted in place.
 */
export async function applyFirstTestFallThroughReport(
  issueNum: number,
  fallThrough: FirstTestFallThrough,
  deps?: StopReportDeps & { readonly now?: Date },
): Promise<"applied" | "already-present"> {
  if (!Number.isInteger(issueNum) || issueNum <= 0) {
    throw new Error(
      `applyFirstTestFallThroughReport: invalid issueNum '${issueNum}'`,
    );
  }
  const run = deps?.runGh ?? runGh;
  const section = buildFirstTestFallThroughSection({
    reason: fallThrough.reason,
    detail: fallThrough.detail,
    issueNumber: issueNum,
    date: (deps?.now ?? new Date()).toISOString().slice(0, 10),
  });

  const currentBody = await fetchIssueBody(issueNum, run);
  const existing = readMarkedSection(
    currentBody,
    FIRST_TEST_FALLTHROUGH_SECTION_START,
    FIRST_TEST_FALLTHROUGH_SECTION_END,
  );
  if (existing === section) return "already-present";

  const newBody = upsertMarkedSection(
    currentBody,
    FIRST_TEST_FALLTHROUGH_SECTION_START,
    FIRST_TEST_FALLTHROUGH_SECTION_END,
    section,
  );
  await run(["issue", "edit", String(issueNum), "--body", newBody]);
  return "applied";
}

/**
 * The label every merge that amended an OLDER ticket's frozen test carries
 * (#1271). NOT a status label — deliberately absent from
 * {@link STATUS_LABELS}, exactly like
 * {@link LABEL_SHIPPED_WITHOUT_FIRST_TEST} and for the identical reason: it
 * is applied ONCE, at the ship moment, and must survive `in-progress` →
 * `merged-to-staging` → `shipped-local` → `done` so it is still on the ticket
 * when the run's pull request closes it.
 *
 * What it tells a person: this merge's proof is weaker than an ordinary one.
 * A test written on an earlier night to pin an earlier rule was edited by
 * this ticket's builder or fixer, under the older-test rules the ship gate
 * checks (`verifyOlderTestEdits`), so that this ticket's new rule could ship.
 *
 * The string keeps its pre-#1334 name ("sibling-check-amended") because
 * tickets already carry it; renaming it would split one signal across two
 * labels.
 */
export const LABEL_SHIPPED_WITH_OLDER_TEST_EDIT =
  "shipped-with-sibling-check-amended";

/** Colour and description for
 *  {@link LABEL_SHIPPED_WITH_OLDER_TEST_EDIT}. The same amber every
 *  "worth a look, nothing is broken" label in this repo wears — the two names
 *  are what tell them apart, and splitting the colour family would make the
 *  class harder to scan, not easier. Description held under GitHub's
 *  100-character cap, which `gh label create` rejects with HTTP 422 above. */
export const SHIPPED_WITH_OLDER_TEST_EDIT_LABEL_DEFINITION = {
  name: LABEL_SHIPPED_WITH_OLDER_TEST_EDIT,
  color: "FBCA04",
  description:
    "Merged after this ticket's build edited an older ticket's test (spec #1334)",
} as const;

/**
 * Create {@link LABEL_SHIPPED_WITH_OLDER_TEST_EDIT}, idempotently, the
 * way {@link ensureShippedWithoutFirstTestLabelExists} creates its own.
 *
 * Same reason it exists, verbatim (#1198 review, S4):
 * {@link markShippedWithOlderTestEdit} shells out to
 * `gh issue edit --add-label`, which ERRORS when the label is not in the
 * repository, and its one caller swallows that error best-effort. Without
 * this, on any host or fork where nobody created the label by hand, the one
 * owner-visible signal that a merge rewrote another ticket's test would
 * vanish silently and the merge would look fully proven.
 *
 * Best-effort: a failure is reported through `onError` and never stops the
 * run. A missing label costs a signal; a thrown startup costs the night.
 */
export async function ensureShippedWithOlderTestEditLabelExists(
  opts?: { onError?: (name: string, err: unknown) => void } & StopReportDeps,
): Promise<void> {
  const run = opts?.runGh ?? runGh;
  const def = SHIPPED_WITH_OLDER_TEST_EDIT_LABEL_DEFINITION;
  try {
    await run([
      "label",
      "create",
      def.name,
      "--color",
      def.color,
      "--description",
      def.description,
      "--force",
    ]);
  } catch (err) {
    opts?.onError?.(def.name, err);
  }
}

/**
 * Record on `issueNum` — the ticket that was BUILT — that shipping it
 * required amending an older ticket's check (#1271). One additive label,
 * nothing else.
 *
 * Same shape as {@link markShippedWithoutFirstTest} and for the same reason:
 * the prose record went onto the SIBLING's body (see
 * {@link applyOlderTestEditRecord}), so re-fetching and re-writing this
 * ticket's own body here would risk clobbering a description someone is
 * editing by hand, to say something no reader would look for there.
 *
 * `--add-label` is idempotent in `gh`, so a retry or a double-ship costs one
 * wasted call and changes nothing.
 */
export async function markShippedWithOlderTestEdit(
  issueNum: number,
  deps?: StopReportDeps,
): Promise<void> {
  if (!Number.isInteger(issueNum) || issueNum <= 0) {
    throw new Error(
      `markShippedWithOlderTestEdit: invalid issueNum '${issueNum}'`,
    );
  }
  const run = deps?.runGh ?? runGh;
  await run([
    "issue",
    "edit",
    String(issueNum),
    "--add-label",
    LABEL_SHIPPED_WITH_OLDER_TEST_EDIT,
  ]);
}

/**
 * Write the older-test edit record (#1271, spec #1334) onto `olderIssueNum`'s
 * BODY — the OLDER ticket whose loop-written test this ticket's build edited —
 * or report that this amender's record is already there.
 *
 * Same fetch-modify-write shape as {@link applyFirstTestFallThroughReport},
 * and the same deliberate omission: NO label. The older ticket is not being reopened,
 * held or re-judged; it is being told, on itself, that its test now says
 * something different and why. A `stopped:*` label here would make a ticket
 * closed weeks ago read as held. The label that IS applied goes on the
 * AMENDING ticket, at the ship moment
 * ({@link markShippedWithOlderTestEdit}).
 *
 * ## Why the markers are keyed on the amender
 *
 * `amendedByIssue` selects the marker pair
 * ({@link olderTestEditMarkers}), so each amending ticket owns
 * exactly one section on the older ticket's body: idempotent per amender,
 * additive across amenders. One older check can be made wrong by two
 * different later rules over its life, and each of those is a separate fact
 * with its own date, reason and files. Under a single fixed marker pair the
 * second would either overwrite the first or, behind the `already-present`
 * latch below, never be written at all.
 *
 * That is also why a garbage `amendedByIssue` throws rather than being
 * coerced: it goes into the marker string, so a bad value would mint a marker
 * nothing can ever match again and the latch would re-append on every run.
 *
 * Returns `"already-present"` without writing when {@link readMarkedSection}
 * finds THIS amender's section already on the body — the durable, cross-run
 * half of the one-shot latch. A ticket rebuilt after a restart must not stack
 * a second copy of the same record onto a closed ticket.
 *
 * PRESENCE, not content, is the comparison — deliberately unlike
 * {@link applyFirstTestFallThroughReport}, which re-writes because the LATEST
 * diagnosis is the true one. This is not a diagnosis that can go stale: it
 * records what one particular run did to one particular file on one
 * particular day. A later re-run of the same amender describes the same event,
 * so the first record stands and the older ticket's body is left alone.
 */
export async function applyOlderTestEditRecord(
  olderIssueNum: number,
  amendedByIssue: number,
  sectionMarkdown: string,
  deps?: StopReportDeps,
): Promise<"applied" | "already-present"> {
  if (!Number.isInteger(olderIssueNum) || olderIssueNum <= 0) {
    throw new Error(
      `applyOlderTestEditRecord: invalid issueNum '${olderIssueNum}'`,
    );
  }
  if (!Number.isInteger(amendedByIssue) || amendedByIssue <= 0) {
    throw new Error(
      `applyOlderTestEditRecord: invalid amendedByIssue '${amendedByIssue}'`,
    );
  }
  const run = deps?.runGh ?? runGh;
  const { start, end } = olderTestEditMarkers(amendedByIssue);

  const currentBody = await fetchIssueBody(olderIssueNum, run);
  if (readMarkedSection(currentBody, start, end) !== undefined) {
    return "already-present";
  }

  const newBody = upsertMarkedSection(currentBody, start, end, sectionMarkdown);
  await run(["issue", "edit", String(olderIssueNum), "--body", newBody]);
  return "applied";
}

/**
 * Upsert a red screen-check observation into the issue's BODY, and apply NO
 * label at all (issue #916; spec #1334).
 *
 * The label omission is the whole point, not an oversight. A red screen check
 * does not stop the ticket, so it must not wear a `stopped:*` label either: those labels are what the triage agent
 * and the human queue read as "this ticket is held". A watched verdict has to
 * be findable and countable without pretending anything was held back.
 *
 * Same fetch-modify-write shape as {@link applyStopReport} (there is no
 * partial-body-edit verb in `gh`), on its own section markers so a watched
 * night and a stopped night can both be recorded on the same issue.
 */
export async function applyScreenCheckWatchReport(
  issueNum: number,
  opts: {
    readonly section: string;
    /**
     * Mark the ticket as owing a ruling (issue #1117). Set ONLY when the
     * watched verdict was a genuine disagreement — the page settled, the
     * claim matched, and the figure did not. `verdict:needed` is not a
     * `stopped:*` label and holds nothing back, so issue #916's rule that a
     * watched ticket must not look held stands. Without it a watched
     * disagreement is invisible to every query and can never be ruled.
     */
    readonly verdictNeeded?: boolean;
  },
  deps?: StopReportDeps,
): Promise<void> {
  if (!Number.isInteger(issueNum) || issueNum <= 0) {
    throw new Error(`applyScreenCheckWatchReport: invalid issueNum '${issueNum}'`);
  }
  const run = deps?.runGh ?? runGh;
  const { stdout } = await run([
    "issue",
    "view",
    String(issueNum),
    "--json",
    "body",
    "--jq",
    ".body",
  ]);
  const currentBody = stdout.replace(/\n$/, "");
  const newBody = upsertScreenCheckWatchSection(currentBody, opts.section);
  const args = ["issue", "edit", String(issueNum), "--body", newBody];
  if (opts.verdictNeeded === true) args.push("--add-label", VERDICT_NEEDED_LABEL);
  await run(args);
}

// Re-exported so a caller that only imported gh.ts (the barrel's usual
// entry point) can check whether a body already carries a stop section
// without a second import of stop-reasons.ts. The marker itself is owned by
// `stop-reasons.ts`, beside the code that writes it — this file used to
// re-declare the literal, which is one hand-copied string away from a
// reader that never finds what the writer wrote.
export { STOP_SECTION_START } from "./stop-reasons.js";

// ---------------------------------------------------------------------------
// The verdict — which side was wrong (issue #1117)
// ---------------------------------------------------------------------------

/**
 * Create the four `verdict:*` labels, idempotently, the same way
 * {@link ensureStopLabelsExist} creates the stop labels — `gh label create
 * --force` creates when absent and updates colour and description when
 * present, so calling this at every run startup is safe and cheap.
 *
 * Best-effort per label: one label failing (a transient API hiccup, a token
 * missing a scope) is reported through `onError` and does not stop the
 * rest. A single bad label must not disable the whole verdict count.
 */
export async function ensureVerdictLabelsExist(
  opts?: { onError?: (name: string, err: unknown) => void } & StopReportDeps,
): Promise<void> {
  const run = opts?.runGh ?? runGh;
  const onError = opts?.onError ?? ((): void => {});
  for (const def of [
    ...VERDICT_LABEL_DEFINITIONS,
    VERDICT_NEEDED_LABEL_DEFINITION,
  ]) {
    try {
      await run([
        "label",
        "create",
        def.name,
        "--color",
        def.color,
        "--description",
        def.description,
        "--force",
      ]);
    } catch (err) {
      onError(def.name, err);
    }
  }
}

async function fetchIssueBody(
  issueNum: number,
  run: (args: string[]) => Promise<RunResult>,
): Promise<string> {
  const { stdout } = await run([
    "issue",
    "view",
    String(issueNum),
    "--json",
    "body",
    "--jq",
    ".body",
  ]);
  return stdout.replace(/\n$/, "");
}

/**
 * Fetch BOTH the body and the labels of one issue in a single `gh` call, as
 * they stand RIGHT NOW — used where a caller must re-decide against a fresh
 * copy of both (see {@link applyRetryDecision}). Reusing
 * a caller's earlier label listing alongside a freshly re-fetched body is
 * exactly the bug this exists to avoid: the two would be read at different
 * moments, so a peer's label-only write between them is invisible to the
 * decision.
 */
async function fetchIssueBodyAndLabels(
  issueNum: number,
  run: (args: string[]) => Promise<RunResult>,
): Promise<{ readonly body: string; readonly labels: readonly string[] }> {
  const { stdout } = await run([
    "issue",
    "view",
    String(issueNum),
    "--json",
    "body,labels",
  ]);
  const trimmed = stdout.trim();
  if (trimmed === "") return { body: "", labels: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(
      `fetchIssueBodyAndLabels(${issueNum}): failed to parse gh output as JSON: ${
        (err as Error).message
      }`,
    );
  }
  const shape = z.object({
    body: z.string().default(""),
    labels: z.array(z.object({ name: z.string() })),
  });
  const result = shape.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `fetchIssueBodyAndLabels(${issueNum}): unexpected gh output shape: ${result.error.message}`,
    );
  }
  return {
    body: result.data.body.replace(/\n$/, ""),
    labels: result.data.labels.map((l) => l.name),
  };
}

/**
 * Read the verdict off a ticket, or `undefined` when it carries none.
 *
 * Reads the BODY, never the label. The label is an index that makes a count
 * one query instead of hundreds; the body is the record, and it is the only
 * one of the two a person can edit by hand. Trusting the label would mean a
 * hand-written correction was ignored until the next run re-synced it.
 */
export async function readVerdict(
  issueNum: number,
  deps?: StopReportDeps,
): Promise<VerdictRecord | undefined> {
  if (!Number.isInteger(issueNum) || issueNum <= 0) {
    throw new Error(`readVerdict: invalid issueNum '${issueNum}'`);
  }
  const run = deps?.runGh ?? runGh;
  return parseVerdictSection(await fetchIssueBody(issueNum, run));
}

/**
 * Write a verdict onto a ticket: upsert the verdict block in the BODY, and
 * move the `verdict:*` label to match.
 *
 * Returns `"kept-human"` and writes NOTHING when the ticket already carries
 * a verdict a person set by hand. Owner ruling 1 of the 2026-08-16 grilling
 * is that he can overturn any verdict by editing the ticket, and the judge
 * was accepted only because he can. A run that re-ruled over his correction
 * the next night would make the correction worthless, and would quietly
 * poison the one count this ticket exists to produce.
 *
 * **The body is written FIRST, in its own call, and the labels after.**
 * That is deliberately the opposite of {@link applyStopReport}, which sends
 * both in one edit so a label can never appear without its explanation.
 * Here the priority is inverted: the body IS the record and the label is
 * only an index. One edit carrying both means a label problem — the label
 * missing from the repo, a token without the scope, the label deleted by
 * hand — takes the verdict down with it. This was not hypothetical: the
 * four `verdict:*` labels did not exist in the repo at all when this was
 * first written, so every single write would have failed and lost the
 * verdict with it.
 *
 * A label failure is reported through `onLabelError` and does not change
 * the return value, because the verdict really was recorded. The next run's
 * startup re-creates any missing label.
 *
 * The other three labels are removed alongside, so a ticket ruled one way
 * on Monday and the other way on Tuesday is never counted twice.
 *
 * **A ruling this one replaces is kept, not deleted.** See
 * {@link carryVerdictHistory}: a ticket can be judged twice in a single night
 * and both rounds were paid for. The incoming ruling stands and is the one the
 * label and every count follow; the earlier ones are folded into the same
 * block, so the ticket still carries exactly one countable verdict.
 *
 * **Known read-modify-write race, INHERITED and out of scope (#1130 finding 3).**
 * This reads the whole body, changes one block, and writes the whole body back;
 * `gh` has no partial-body edit. If another host writes to the same ticket
 * between the read and the write — a stop report from {@link applyStopReport},
 * a watch-only observation from {@link applyScreenCheckWatchReport} — that other
 * write is lost. This is NOT new to the verdict slot: all three body-writers
 * have had this shape since they were built, and it is recorded here only so a
 * future reader does not mistake it for something the verdict introduced. The
 * fix (a compare-and-set or a real lock) is deliberately not attempted here.
 */
export async function applyVerdictReport(
  issueNum: number,
  opts: { readonly record: VerdictRecord },
  deps?: StopReportDeps & {
    readonly onLabelError?: (err: unknown) => void;
  },
): Promise<"written" | "kept-human"> {
  if (!Number.isInteger(issueNum) || issueNum <= 0) {
    throw new Error(`applyVerdictReport: invalid issueNum '${issueNum}'`);
  }
  const run = deps?.runGh ?? runGh;
  const currentBody = await fetchIssueBody(issueNum, run);
  const existing = parseVerdictSection(currentBody);
  if (decideVerdictWrite(existing, opts.record) === "keep-human") {
    return "kept-human";
  }

  // The ruling being replaced is folded into the new block rather than
  // deleted. A ticket can be judged twice in one night — the reviewer refuses,
  // the retry comes back clear, the screen check then mismatches — and both
  // rounds cost money. The LAST ruling stands and is the one the label and
  // every count follow; the earlier ones are kept beside it so a round the run
  // paid for cannot vanish from the only place it was recorded.
  const newBody = upsertVerdictSection(
    currentBody,
    buildVerdictSection(carryVerdictHistory(existing, opts.record)),
  );
  await run(["issue", "edit", String(issueNum), "--body", newBody]);

  const labelArgs: string[] = [
    "issue",
    "edit",
    String(issueNum),
    "--add-label",
    verdictLabelFor(opts.record.verdict),
  ];
  for (const other of VERDICT_VALUES) {
    if (other === opts.record.verdict) continue;
    labelArgs.push("--remove-label", verdictLabelFor(other));
  }
  // `verdict:needed` marked this ticket as waiting for a ruling. It has one
  // now, so it comes off — otherwise the "still unruled" list never shrinks.
  labelArgs.push("--remove-label", VERDICT_NEEDED_LABEL);
  try {
    await run(labelArgs);
  } catch (err) {
    deps?.onLabelError?.(err);
  }
  return "written";
}

/** The label edit that moves a ticket off `quarantine` onto
 *  `waiting-for-session`. The `stopped:*` label is deliberately KEPT: it is
 *  the index of WHY the loop gave up. */
const TO_WAITING_ARGS: readonly string[] = [
  "--remove-label",
  LABEL_QUARANTINE_LEGACY,
  "--add-label",
  WAITING_FOR_SESSION_LABEL,
];

/**
 * Record one failed attempt on the ticket's retry ledger (spec #1334, SC),
 * then decide on the NEW body and the ticket's CURRENT labels — fetched
 * together, fresh, in one `gh` call — and write once: the body, plus, when
 * the attempt ends retries, the move to `waiting-for-session` in the SAME
 * edit. A `retry` decision leaves `quarantine` on; the next run's start sweep
 * ({@link applyRetryDecision}) is what re-queues it.
 *
 * `gh` failures propagate; the caller in `main.mts` wraps it best-effort.
 */
export async function recordRetryAttempt(
  issueNum: number,
  attempt: RetryAttempt,
  deps?: StopReportDeps,
): Promise<{ readonly decision: RetryDecision }> {
  if (!Number.isInteger(issueNum) || issueNum <= 0) {
    throw new Error(`recordRetryAttempt: invalid issueNum '${issueNum}'`);
  }
  const run = deps?.runGh ?? runGh;
  const { body, labels } = await fetchIssueBodyAndLabels(issueNum, run);
  const newBody = appendRetryAttempt(body, attempt);
  const decision = decideRetry({ labels, body: newBody });
  await run([
    "issue",
    "edit",
    String(issueNum),
    "--body",
    newBody,
    ...(decision.action === "waiting" ? TO_WAITING_ARGS : []),
  ]);
  return { decision };
}

/**
 * Apply the run-start retry decision for ONE ticket (spec #1334, SC).
 *
 * Re-decides against a FRESH fetch of body and labels, never the caller's
 * batch listing: a peer host (or a person) may have moved the ticket since
 * that listing was read, and a stale label list would let two hosts both
 * re-queue it. `retry` removes `quarantine` and every `stopped:*` label and
 * adds `ready-for-agent`; `waiting` swaps `quarantine` for
 * `waiting-for-session`; `skip` writes nothing.
 *
 * The returned `decision` is the one this call ACTED on — the caller keys its
 * run report off it, so the report can never say something the write
 * disagreed with (the #1178 final review's BLOCKER I, kept).
 */
export async function applyRetryDecision(
  issueNum: number,
  deps?: StopReportDeps,
): Promise<{ readonly decision: RetryDecision }> {
  if (!Number.isInteger(issueNum) || issueNum <= 0) {
    throw new Error(`applyRetryDecision: invalid issueNum '${issueNum}'`);
  }
  const run = deps?.runGh ?? runGh;
  const { body, labels } = await fetchIssueBodyAndLabels(issueNum, run);
  const decision = decideRetry({ labels, body });
  if (decision.action === "retry") {
    const stopLabels = labels.filter((l) => l.startsWith("stopped:"));
    await run([
      "issue",
      "edit",
      String(issueNum),
      "--remove-label",
      LABEL_QUARANTINE_LEGACY,
      ...stopLabels.flatMap((l) => ["--remove-label", l]),
      "--add-label",
      LABEL_READY,
    ]);
  } else if (decision.action === "waiting") {
    await run(["issue", "edit", String(issueNum), ...TO_WAITING_ARGS]);
  }
  return { decision };
}

/** Colour and description for {@link WAITING_FOR_SESSION_LABEL} — held under
 *  GitHub's 100-character description cap. */
export const WAITING_FOR_SESSION_LABEL_DEFINITION = {
  name: WAITING_FOR_SESSION_LABEL,
  color: "D93F0B",
  description: "Loop stopped retrying: $100 spent or tried 3 times. Hand to a session.",
} as const;

/**
 * Create {@link WAITING_FOR_SESSION_LABEL}, idempotently, at run start —
 * `gh issue edit --add-label` errors on a label the repository lacks, and
 * the retry writes are best-effort, so without this the move to waiting
 * would fail silently on a fresh host. Best-effort itself.
 */
export async function ensureWaitingForSessionLabelExists(
  opts?: { onError?: (name: string, err: unknown) => void } & StopReportDeps,
): Promise<void> {
  const run = opts?.runGh ?? runGh;
  const def = WAITING_FOR_SESSION_LABEL_DEFINITION;
  try {
    await run([
      "label",
      "create",
      def.name,
      "--color",
      def.color,
      "--description",
      def.description,
      "--force",
    ]);
  } catch (err) {
    opts?.onError?.(def.name, err);
  }
}

/**
 * Best-effort: upsert the end-of-run report (issue #1179) into the run PR's
 * body, keyed off `branch`.
 *
 * `openDraftPr` (above) never edits an existing PR's body — a RELAUNCH on
 * the same branch would otherwise leave the first attempt's report frozen
 * and stale, describing a run that never finished. This is the fix: called
 * separately, AFTER `openRunPr` returns, on every finish (a fresh PR or one
 * that already existed), it re-fetches the PR's current body, replaces just
 * the marked report block, and writes the whole body back — the same
 * fetch-modify-write shape every other body writer in this file uses
 * (`applyStopReport`, `recordRetryAttempt`).
 *
 * **Keyed by `hostId` since the multi-host review fix (issue #1179 blocker
 * 4).** A shared run has more than one host finishing independently; a
 * single shared marker meant the last host to call this OVERWROTE every
 * other host's section whole, so host A's "Needs you" could vanish the
 * moment host B finished clean. Each host now upserts only its OWN
 * `runReportSectionStart(hostId)`/`runReportSectionEnd(hostId)` block, and
 * the report is titled ("# Report from <hostId>") so the PR body reads as
 * one section per host rather than one anonymous, overwritten block.
 *
 * Never throws. A missing PR (the branch has nothing open, or `gh` is down)
 * is reported back as `updated: false` with an `error`, and the caller logs
 * it — the report text itself is never lost, because `main.mts` always logs
 * the full report too.
 */
export async function upsertRunPrReport(
  branch: string,
  report: string,
  hostId: string,
  deps?: StopReportDeps,
): Promise<{ readonly updated: boolean; readonly error?: string }> {
  const run = deps?.runGh ?? runGh;
  try {
    const { stdout } = await run([
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "open",
      "--json",
      "number,body",
      "--limit",
      "1",
    ]);
    const rows = JSON.parse(stdout || "[]") as {
      number?: number;
      body?: string;
    }[];
    const pr = rows[0];
    if (pr?.number === undefined) {
      return { updated: false, error: `no open PR found for branch '${branch}'` };
    }
    const newBody = upsertMarkedSection(
      pr.body ?? "",
      runReportSectionStart(hostId),
      runReportSectionEnd(hostId),
      titleRunReport(report, hostId),
    );
    await run(["pr", "edit", String(pr.number), "--body", newBody]);
    return { updated: true };
  } catch (err) {
    return { updated: false, error: (err as Error).message };
  }
}

/** What {@link countVerdicts} answers. `unruledIssues` is listed by number
 *  rather than merely counted: eight unruled disagreements is the finding
 *  that started issue #1117, so the answer has to name them, not just say
 *  how many there were. */
export interface VerdictCount {
  readonly counts: VerdictTally;
  readonly unruledIssues: readonly number[];
  readonly issuesRead: readonly number[];
}

/**
 * Count how often each side turned out to be wrong — the number the whole
 * judge design rests on, and the reason issue #1117 exists.
 *
 * **Read from GitHub, never from `.sandcastle/telemetry/issues.jsonl`.**
 * Owner ruling 12 put the verdict on the ticket only, so the committed
 * record file cannot answer this and must not be asked.
 *
 * Two passes. First, ask GitHub for every ticket that could carry a verdict:
 * the four `verdict:*` labels, plus `stopped:check-disagreement`, which is
 * how a disagreement with NO verdict yet is found. Then read each ticket's
 * body once and parse it. The label narrows the search; the body decides
 * the answer.
 *
 * Closed tickets are included (`--state all`). A disagreement that was
 * ruled and then closed still happened, and dropping it would flatter the
 * count in exactly the direction that makes the check look better than it is.
 *
 * **The answer is SPLIT by whether a check stood behind the argument, and the
 * `verdict:*` label cannot make that split.** The judge rules on the
 * reviewer's first refusal as well as on a screen check, and most reviewer
 * refusals have no check behind them at all — poor code, a house rule,
 * missing proof the code was run. A `checks-wrong` ruling there wears the same
 * label as a real wrong check while meaning something else entirely. Only the
 * `source` field in the BODY separates them, which is another reason the label
 * narrows the search and the body decides the answer. `counts.byGrounds` in
 * `lib/state/verdict.ts` carries the split; the flat counts are kept beside it
 * so no existing reader silently starts counting a subset.
 *
 * **What a label search cannot see, stated out loud.** The `stopped:*`
 * labels only started being applied in August 2026 (issues #914 and #923).
 * Six of the eight disagreements issue #1117 measured — #805, #820, #845,
 * #848, #850 and #860 — stopped BEFORE that and carry no label, so no
 * query finds them; verified against the tracker on 2026-08-19. They are
 * reachable only by number, which is what `extraIssues` is for. A count run
 * with no `extraIssues` is a count of the labelled era, not of all time.
 */
export async function countVerdicts(
  deps?: StopReportDeps & {
    readonly limit?: number;
    /** Extra ticket numbers to read regardless of their labels — the only
     *  way to reach a disagreement that pre-dates the labels. */
    readonly extraIssues?: readonly number[];
  },
): Promise<VerdictCount> {
  const run = deps?.runGh ?? runGh;
  const limit = deps?.limit ?? 500;
  const labels = [
    ...VERDICT_VALUES.map((v) => verdictLabelFor(v)),
    // A ticket the screen check disagreed with while only WATCHING is never
    // stopped and never wears a `stopped:*` label (issue #916), so it would
    // be invisible to a count without this one.
    VERDICT_NEEDED_LABEL,
    "stopped:check-disagreement",
  ];

  // #1130 finding 1: `gh issue list --json number,body` returns the bodies in
  // the LIST call itself, so a labelled ticket needs no second `gh issue view`.
  // The old shape made six list calls and then one view per ticket found — at a
  // few hundred tickets a several-minute command; now it is one list call per
  // label and no per-ticket pass. Only an `extraIssue` (named by number, not
  // found by any label query) still needs its own fetch.
  const numbers = new Set<number>();
  const numberToBody = new Map<number, string>();
  for (const label of labels) {
    const { stdout } = await run([
      "issue",
      "list",
      "--label",
      label,
      "--state",
      "all",
      "--limit",
      String(limit),
      "--json",
      "number,body",
    ]);
    const parsed: unknown = JSON.parse(stdout.trim() === "" ? "[]" : stdout);
    if (!Array.isArray(parsed)) continue;
    for (const row of parsed) {
      const n = (row as { number?: unknown }).number;
      const body = (row as { body?: unknown }).body;
      if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) continue;
      numbers.add(n);
      // Every label query that returns this ticket returns the SAME body, so
      // the first one wins and the rest are no-ops.
      if (typeof body === "string" && !numberToBody.has(n)) {
        numberToBody.set(n, body);
      }
    }
  }
  for (const n of deps?.extraIssues ?? []) {
    if (Number.isInteger(n) && n > 0) numbers.add(n);
  }

  const issuesRead = [...numbers].sort((a, b) => a - b);
  const bodies: string[] = [];
  const unruledIssues: number[] = [];
  for (const n of issuesRead) {
    // A label-found ticket already carries its body from the list call; only an
    // extraIssue (or the rare row that came back with no body field) falls
    // through to a single fetch.
    const body = numberToBody.get(n) ?? (await fetchIssueBody(n, run));
    bodies.push(body);
    if (parseVerdictSection(body) === undefined) unruledIssues.push(n);
  }
  return { counts: tallyVerdicts(bodies), unruledIssues, issuesRead };
}

// ---------------------------------------------------------------------------
// The refusal outcome — was a refused ticket refused correctly (issue #1096)
// ---------------------------------------------------------------------------

/** One refused ticket, and how its refusal turned out. */
export interface RefusalRow {
  readonly issue: number;
  readonly outcome: RefusalOutcome;
  readonly runId?: string;
  readonly whenIso?: string;
}

/** What {@link countRefusals} answers: every refused ticket carrying the
 *  `stopped:reviewer-refused` label, with the outcome ticked on its body. */
export interface RefusalCount {
  readonly rows: readonly RefusalRow[];
}

/**
 * Read every reviewer refusal and the outcome ticked on its body.
 *
 * The reviewer has refused thirteen tickets across nine runs. Seven of one
 * night's eight were later built by hand and shipped — the refusal was wrong,
 * at roughly $30–40 of build cost each — but a fair refusal and a wrong one
 * looked identical for ever, so the refusal rule could not be tuned because
 * nobody knew its error rate. This is what turns that into a number.
 *
 * **Read from the ticket BODY, never from run telemetry.** Grilling decision
 * 2026-08-25: the refusal and the later close happen on different runs, so a
 * per-run record cannot span the gap. The `stopped:reviewer-refused` label
 * narrows the search; the body's outcome checkbox decides the answer.
 *
 * Closed tickets are included (`--state all`): a refusal that was later shown
 * wrong and then closed is the single most important row here, and dropping it
 * would flatter the count in exactly the direction that hides the problem.
 *
 * One `gh issue list --json number,body` call returns the bodies inline, so
 * there is no second per-ticket pass (the shape #1130 finding 1 moved
 * `countVerdicts` to).
 */
export async function countRefusals(
  deps?: StopReportDeps & { readonly limit?: number },
): Promise<RefusalCount> {
  const run = deps?.runGh ?? runGh;
  const limit = deps?.limit ?? 500;
  const { stdout } = await run([
    "issue",
    "list",
    "--label",
    "stopped:reviewer-refused",
    "--state",
    "all",
    "--limit",
    String(limit),
    "--json",
    "number,body",
  ]);
  const parsed: unknown = JSON.parse(stdout.trim() === "" ? "[]" : stdout);
  if (!Array.isArray(parsed)) return { rows: [] };

  const rows: RefusalRow[] = [];
  for (const row of parsed) {
    const n = (row as { number?: unknown }).number;
    const body = (row as { body?: unknown }).body;
    if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) continue;
    const record = parseRefusalRecord(typeof body === "string" ? body : "");
    // A ticket wearing the label but carrying no outcome stamp is an OLDER
    // refusal from before #1096 (the stamp did not exist). Count it as owed a
    // ruling rather than dropping it — the whole point is that these were
    // never attributable, and hiding them repeats that.
    rows.push({
      issue: n,
      outcome: record?.outcome ?? "unjudged",
      runId: record?.runId,
      whenIso: record?.whenIso,
    });
  }
  rows.sort((a, b) => a.issue - b.issue);
  return { rows };
}

// ---------------------------------------------------------------------------
// The check reading — what the judge made of the check (issue #1118)
// ---------------------------------------------------------------------------

/**
 * Create the three `check-read:*` labels, idempotently, exactly the way
 * {@link ensureVerdictLabelsExist} creates the verdict labels — `gh label
 * create --force` creates when absent and updates colour and description when
 * present, so calling this at every run startup is safe and cheap.
 *
 * Best-effort per label: one label failing (a transient API hiccup, a token
 * missing a scope) is reported through `onError` and does not stop the rest.
 * A single bad label must not disable the whole count.
 */
export async function ensureCheckReadingLabelsExist(
  opts?: { onError?: (name: string, err: unknown) => void } & StopReportDeps,
): Promise<void> {
  const run = opts?.runGh ?? runGh;
  const onError = opts?.onError ?? ((): void => {});
  for (const def of CHECK_READING_LABEL_DEFINITIONS) {
    try {
      await run([
        "label",
        "create",
        def.name,
        "--color",
        def.color,
        "--description",
        def.description,
        "--force",
      ]);
    } catch (err) {
      onError(def.name, err);
    }
  }
}

/**
 * Record what the judge made of this ticket's check: upsert the check-reading
 * block in the BODY, and move the `check-read:*` label to match.
 *
 * **Every reading is written, the routine `sound` one included.** That is the
 * whole point of issue #1118: only the two failing answers used to reach the
 * ticket, so the run could report a count of bad checks with no total under
 * it, and eight bad checks means nothing until you know whether it is eight
 * out of twelve or eight out of three hundred.
 *
 * **There is no human-outranks-the-run rule here, unlike
 * {@link applyVerdictReport}.** A verdict is a judgement the owner may
 * overturn; this is a record of what the run did on a given night, and nobody
 * overturns a record. A person who disagrees with the judge's reading says so
 * in the verdict block, which this never touches. So this block is simply
 * REPLACED each run, and the rendered block says so out loud.
 *
 * **The body is written FIRST, in its own call, and the labels after** —
 * same as {@link applyVerdictReport} and for the same stated reason. The body
 * IS the record and the label is only an index, so one edit carrying both
 * would let a label problem (label missing from the repo, token without the
 * scope, label deleted by hand) take the record down with it. That is not
 * hypothetical: the four `verdict:*` labels did not exist in the repo at all
 * when they were first written, and these three do not exist yet either.
 *
 * A label failure is reported through `onLabelError` and is otherwise
 * swallowed, because the reading really was recorded. The next run's startup
 * re-creates any missing label.
 *
 * The other two labels are removed alongside, so a ticket read one way on
 * Monday and another way on Tuesday is never counted twice.
 */
export async function applyCheckReadingReport(
  issueNum: number,
  opts: { readonly record: CheckReadingRecord },
  deps?: StopReportDeps & {
    readonly onLabelError?: (err: unknown) => void;
  },
): Promise<void> {
  if (!Number.isInteger(issueNum) || issueNum <= 0) {
    throw new Error(`applyCheckReadingReport: invalid issueNum '${issueNum}'`);
  }
  const run = deps?.runGh ?? runGh;
  const currentBody = await fetchIssueBody(issueNum, run);
  const newBody = upsertCheckReadingSection(
    currentBody,
    buildCheckReadingSection(opts.record),
  );
  await run(["issue", "edit", String(issueNum), "--body", newBody]);

  const labelArgs: string[] = [
    "issue",
    "edit",
    String(issueNum),
    "--add-label",
    checkReadingLabelFor(opts.record.reading),
  ];
  for (const other of CHECK_READING_VALUES) {
    if (other === opts.record.reading) continue;
    labelArgs.push("--remove-label", checkReadingLabelFor(other));
  }
  try {
    await run(labelArgs);
  } catch (err) {
    deps?.onLabelError?.(err);
  }
}

/**
 * Read back the check reading already recorded on a ticket, or `undefined`
 * when the ticket carries none.
 *
 * ONE caller, and it is the only reason this exists: a ticket that paused
 * mid-build re-runs the judge's early pass on the night it is picked up
 * again, over a check the judge already approved. On a resumed worktree that
 * pass may not repair anything, so a second opinion it never asked for can
 * strand the saved work — every night, for ever. The resume proves the
 * check's bytes have not moved since the reading below and skips the re-read.
 *
 * Best-effort by contract: it reads GitHub, and a ticket whose body cannot be
 * fetched must fall back to reading the check again, never to skipping it.
 * The caller treats a throw as "no reading".
 */
export async function readCheckReading(
  issueNum: number,
  deps?: StopReportDeps,
): Promise<CheckReadingRecord | undefined> {
  if (!Number.isInteger(issueNum) || issueNum <= 0) {
    throw new Error(`readCheckReading: invalid issueNum '${issueNum}'`);
  }
  const run = deps?.runGh ?? runGh;
  return parseCheckReadingSection(await fetchIssueBody(issueNum, run));
}

/** What {@link countCheckReadings} answers.
 *
 *  `unreadIssues` is listed by number rather than merely counted, the same
 *  way {@link VerdictCount} names its unruled tickets: a ticket wearing a
 *  `check-read:*` label whose body carries no block is a disagreement between
 *  the index and the record, and the answer has to name those tickets so
 *  somebody can go and look at one. It holds ONLY tickets wearing that label —
 *  a ticket swept in by a stop label or by number never claimed to have been
 *  read, so naming it there would be an accusation with nothing behind it. */
export interface CheckReadingCount {
  readonly counts: CheckReadingTally;
  readonly unreadIssues: readonly number[];
  readonly issuesRead: readonly number[];
}

/**
 * Count how the judge read the checks it opened — and, crucially, HOW MANY IT
 * OPENED. `counts.total` is the denominator the owner asked for on
 * 2026-08-20; `counts.sound` beside it is "of the checks the judge read, how
 * many were sound".
 *
 * **Read from GitHub, never from `.sandcastle/telemetry/issues.jsonl`.** The
 * owner's ruling that put the verdict on the ticket only applies here for the
 * same reason — the telemetry file is committed to git, so a nightly write
 * there would need a branch and a pull request every time. The committed
 * record file cannot answer this and must not be asked.
 *
 * Two passes, exactly as {@link countVerdicts} does. First, ask GitHub for
 * every ticket wearing one of the three `check-read:*` labels — AND the two
 * judge stop labels in {@link CHECK_READING_STOP_LABELS}, for the same reason
 * `countVerdicts` also asks `stopped:check-disagreement`: the reading is
 * written to the body before the label, so a ticket whose label write failed
 * still holds a real reading, and the tickets where that is most likely are
 * exactly the ones the judge stopped. Then read each ticket's body once and
 * parse it. The label narrows the search; the BODY decides the answer, because
 * the body is the record and the label is only an index that a hand edit or a
 * failed label write can leave stale.
 *
 * **Widening the search never widens the accusation.** `unreadIssues` names
 * tickets whose index and record disagree, and only a `check-read:*` label
 * claims a check was read. A ticket reached through a stop label, or named in
 * `extraIssues`, is counted if it carries a reading and is otherwise left
 * alone — the documented `--issues 805,820,…` invocation used to print six
 * pre-label disagreement tickets as though each had lost a reading it never
 * had.
 *
 * Closed tickets are included (`--state all`). A check read on a ticket that
 * then shipped was still read, and dropping it would shrink the denominator
 * in exactly the direction that makes the bad readings look worse than they
 * were.
 *
 * **What a label search cannot see, stated out loud.** These labels start
 * being applied the first night this ships. Every early pass the judge ran
 * before that wrote nothing and wears no label, so no query reaches it and
 * none ever will — those readings are gone, not merely unqueried. A count run
 * today is a count of the recorded era, and `extraIssues` reaches a ticket by
 * number for the only other case: a ticket whose label write failed while its
 * body write succeeded.
 */
export async function countCheckReadings(
  deps?: StopReportDeps & {
    readonly limit?: number;
    /** Extra ticket numbers to read regardless of their labels — how a
     *  ticket whose label write failed is still counted. */
    readonly extraIssues?: readonly number[];
  },
): Promise<CheckReadingCount> {
  const run = deps?.runGh ?? runGh;
  const limit = deps?.limit ?? 500;

  const numbers = new Set<number>();
  // Tracked apart from `numbers`, because only THESE tickets can be accused of
  // having lost a reading: a `check-read:*` label is the index claiming the
  // check was read, so a body with no block contradicts it. A ticket reached
  // through a stop label or named by number never made that claim.
  const labelledAsRead = new Set<number>();

  const collect = async (label: string, into?: Set<number>): Promise<void> => {
    const { stdout } = await run([
      "issue",
      "list",
      "--label",
      label,
      "--state",
      "all",
      "--limit",
      String(limit),
      "--json",
      "number",
    ]);
    const parsed: unknown = JSON.parse(stdout.trim() === "" ? "[]" : stdout);
    if (!Array.isArray(parsed)) return;
    for (const row of parsed) {
      const n = (row as { number?: unknown }).number;
      if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) continue;
      numbers.add(n);
      into?.add(n);
    }
  };

  for (const reading of CHECK_READING_VALUES) {
    await collect(checkReadingLabelFor(reading), labelledAsRead);
  }
  for (const label of CHECK_READING_STOP_LABELS) await collect(label);
  for (const n of deps?.extraIssues ?? []) {
    if (Number.isInteger(n) && n > 0) numbers.add(n);
  }

  const issuesRead = [...numbers].sort((a, b) => a - b);
  const bodies: string[] = [];
  const unreadIssues: number[] = [];
  for (const n of issuesRead) {
    const body = await fetchIssueBody(n, run);
    bodies.push(body);
    if (parseCheckReadingSection(body) === undefined && labelledAsRead.has(n)) {
      unreadIssues.push(n);
    }
  }
  return { counts: tallyCheckReadings(bodies), unreadIssues, issuesRead };
}

// ---------------------------------------------------------------------------
// The merge rule (tokenmaxxing#29). `openDraftPr` still opens the run PR as a
// draft; `settleRunPr` then decides whether the loop may merge it itself.
// The decision is `lib/state/merge-rule.ts`'s; this is only the GitHub half.
// ---------------------------------------------------------------------------

export interface SettleRunPrDeps {
  runGh?: (args: string[]) => Promise<RunResult>;
  /**
   * Land the run: fast-forward the remote `base` branch onto `headSha` from
   * the local checkout, minting no commit (in production a non-forced
   * `git push origin <headSha>:refs/heads/<base>`). Throws when it cannot,
   * including when `base` has moved and the push is no longer a fast-forward.
   *
   * Required, and never `gh pr merge`: a merge made on GitHub's servers is a
   * new commit authored as the owner, and agent work must never land under
   * his name (project CLAUDE.md). A fast-forward keeps the loop's own commits,
   * already authored as the agent, and GitHub marks the PR merged by itself.
   */
  land: (headSha: string, base: string) => Promise<void>;
  /**
   * The pre-merge check, run on the exact commit about to land, only once the
   * merge rule has said "merge" (in production the project's `landCheck`
   * command from `.sandcastle/project.json`). Throws to refuse: the PR
   * is then left waiting for the owner with the reason. Absent = no check.
   */
  beforeLand?: (headSha: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Wait for the run PR's checks, then land it or leave it for the owner, and
 * write the outcome into the PR body's Merge Danger section.
 *
 * Lands only when `decideMerge` says so AND the PR head is still `headSha`,
 * the commit whose diff produced `change`. The land itself is pinned to that
 * commit (the base is fast-forwarded onto `headSha`, never onto the branch
 * name), so a peer host's later push can never ride along on a decision made
 * about a different diff.
 *
 * Gives up at `timeoutMs` and leaves the PR open: a check still running is not
 * a green check. A one-way door or a large blast radius is decided at once,
 * with no wait. Never throws.
 */
export async function settleRunPr(
  opts: {
    readonly branch: string;
    readonly headSha: string;
    readonly change: ChangeClass;
    readonly timeoutMs: number;
    readonly pollMs: number;
  },
  deps: SettleRunPrDeps,
): Promise<{ readonly merged: boolean; readonly why: string }> {
  const run = deps.runGh ?? runGh;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;

  let pr: { number: number; base: string; body: string } | undefined;
  const writeOutcome = async (mergeLine: string): Promise<void> => {
    if (pr === undefined) return;
    const section = renderMergeDanger(opts.change, mergeLine);
    pr.body = upsertMarkedSection(pr.body, mergeRuleSectionStart(), mergeRuleSectionEnd(), section);
    try {
      await run(["pr", "edit", String(pr.number), "--body", pr.body]);
    } catch {
      // The outcome is also returned to the caller, which logs it.
    }
  };
  const wait = async (why: string) => {
    await writeOutcome(`waits for ${getProjectConfig().ownerName} (${why}).`);
    return { merged: false, why };
  };

  try {
    // A one-way door or a large blast radius is decided before any check runs.
    const blocked = decideMerge(opts.change, "green");
    const start = now();
    let checks: ChecksState = "none";
    for (;;) {
      const { stdout } = await run([
        "pr",
        "view",
        opts.branch,
        "--json",
        "number,headRefOid,baseRefName,body,statusCheckRollup",
      ]);
      const view = JSON.parse(stdout) as {
        number: number;
        headRefOid: string;
        baseRefName: string;
        body?: string;
        statusCheckRollup?: RollupEntry[];
      };
      pr = { number: view.number, base: view.baseRefName, body: view.body ?? "" };
      if (!blocked.merge) return await wait(blocked.why);
      if (view.headRefOid !== opts.headSha) {
        return await wait("the PR head moved past the commit the loop classified");
      }
      checks = readChecks(view.statusCheckRollup ?? []);
      if (checks === "green" || checks === "failing") break;
      if (now() - start >= opts.timeoutMs) break;
      await sleep(opts.pollMs);
    }

    const decision = decideMerge(opts.change, checks);
    if (!decision.merge) return await wait(decision.why);

    // The pre-merge check runs only on a run the rule would merge: a run that
    // waits for the owner anyway gets no heavy check it does not need.
    if (deps.beforeLand !== undefined) {
      try {
        await deps.beforeLand(opts.headSha);
      } catch (err) {
        return await wait(`the pre-merge check failed: ${(err as Error).message}`);
      }
    }

    await writeOutcome(`merged by the loop: ${decision.why}.`);
    const n = String(pr.number);
    try {
      await run(["pr", "ready", n]);
      await deps.land(opts.headSha, pr.base);
    } catch (err) {
      try {
        await run(["pr", "ready", n, "--undo"]);
      } catch {
        // Best effort: a non-draft PR that did not merge is still a PR the owner sees.
      }
      return await wait(`the merge failed: ${(err as Error).message}`);
    }
    return { merged: true, why: decision.why };
  } catch (err) {
    return await wait(`could not read the PR: ${(err as Error).message}`);
  }
}
