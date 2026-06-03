/**
 * gh CLI wrappers. Always invoked via execFile (NEVER exec) so that label
 * names, issue bodies, and comment text can't shell-inject. Every argument
 * is a separate argv entry — `gh` receives them verbatim.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const execFileP = promisify(execFile);

const GH_BIN = "gh";
const DEFAULT_TIMEOUT_MS = 30_000;

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
export function warnIfHitLimit(count: number, fn: string): void {
  if (count === 100) {
    process.stderr.write(
      `WARN: ${fn} returned exactly 100 results — may have hit the limit. Backlog could be larger.\n`,
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
 * Fetch the body markdown of a GH issue. Used by the loop driver to pre-warm
 * the implementer/reviewer prompt so they never call `gh issue view` themselves.
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
//   in-progress      --quarantine-->  needs-human  (+ comment, leave OPEN)
//
// `quarantine` is treated as a synonym for `needs-human` for back-compat:
// quarantineViaLabel always writes `needs-human`, but readers should accept
// both label spellings.
// ---------------------------------------------------------------------------

/** Canonical label names used by the v1 state machine. */
export const LABEL_READY = "ready-for-agent";
export const LABEL_IN_PROGRESS = "in-progress";
export const LABEL_DONE = "done";
export const LABEL_NEEDS_HUMAN = "needs-human";
/**
 * Intermediate label for the staging fix-loop. An issue's branch flips from
 * `in-progress` → `merged-to-staging` once it lands in `integration-candidate`,
 * and only flips to `done` after the post-merge reviewer certifies staging
 * (POST_MERGE_ALL_CLEAR) and the orchestrator fast-forwards integration.
 *
 * If staging fails certification (POST_MERGE_ISSUES_FOUND, even after the
 * fixer pass), every issue still in `merged-to-staging` for that iteration is
 * quarantined via `LABEL_NEEDS_HUMAN`.
 */
export const LABEL_MERGED_TO_STAGING = "merged-to-staging";
/**
 * Legacy synonym for `needs-human` — older bash drivers and a not-yet-
 * fixed call site (`quarantineStoryInPrd` in src/state/prd.ts) still write
 * this spelling. Readers MUST accept both `"needs-human"` and `"quarantine"`
 * as meaning "this issue is quarantined". New writes go to LABEL_NEEDS_HUMAN.
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
  "done",
  "needs-human",
  "quarantine",
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
 */
export async function claimViaLabel(issueNum: number): Promise<void> {
  if (!Number.isInteger(issueNum) || issueNum <= 0) {
    throw new Error(`claimViaLabel: invalid issueNum '${issueNum}'`);
  }
  await transitionLabel(issueNum, LABEL_READY, LABEL_IN_PROGRESS);
}

/**
 * Mark an issue done: remove `in-progress`, add `done`, post a summary
 * comment, and close the issue. Order matters — labels first so an observer
 * tailing the issue stream sees the state flip before the close event.
 */
export async function markDoneViaLabel(
  issueNum: number,
  summary: string,
): Promise<void> {
  if (!Number.isInteger(issueNum) || issueNum <= 0) {
    throw new Error(`markDoneViaLabel: invalid issueNum '${issueNum}'`);
  }
  await transitionLabel(issueNum, LABEL_IN_PROGRESS, LABEL_DONE);
  // closeIssue posts the comment + closes in a single gh invocation.
  await closeIssue(issueNum, summary);
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
 * Promote every `merged-to-staging` issue to `done` after staging fast-
 * forwards into the integration branch. Posts a single shared `summary`
 * comment on each issue and closes it. Per-issue failures are isolated —
 * one bad gh call doesn't block the rest. Returns the list of issues that
 * could not be promoted (caller logs / decides quarantine).
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
      await transitionLabel(n, LABEL_MERGED_TO_STAGING, LABEL_DONE);
      await closeIssue(n, summary);
    } catch {
      failed.push(n);
    }
  }
  return { failed };
}

/**
 * Quarantine an issue: remove `in-progress` (the common path from the loop),
 * add `needs-human`, and post a comment with the reason. The issue stays OPEN
 * — a human triages it before requeue.
 *
 * If the issue is still in `ready-for-agent` (rare — quarantine usually
 * follows a claim), the caller can call `transitionLabel(num,
 * LABEL_READY, LABEL_NEEDS_HUMAN)` first or rely on the underlying `gh`
 * tolerance for removing a not-applied label being a no-op.
 */
export async function quarantineViaLabel(
  issueNum: number,
  reason: string,
): Promise<void> {
  if (!Number.isInteger(issueNum) || issueNum <= 0) {
    throw new Error(`quarantineViaLabel: invalid issueNum '${issueNum}'`);
  }
  await transitionLabel(issueNum, LABEL_IN_PROGRESS, LABEL_NEEDS_HUMAN);
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
async function fetchIssueLabels(issueNum: number): Promise<string[]> {
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
  body: string;
  labels: string[];
}

const OpenIssueRow = z.object({
  number: z.number().int(),
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
 * Caps at 100 results (same pagination caveat as the other list helpers).
 */
export async function listOpenIssuesWithBodies(): Promise<OpenIssueWithBody[]> {
  const { stdout } = await runGh([
    "issue",
    "list",
    "--state",
    "open",
    "--json",
    "number,body,labels",
    "--limit",
    "100",
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
    body: row.body ?? "",
    labels: row.labels.map((l) => l.name),
  }));
  summaries.sort((a, b) => a.number - b.number);
  warnIfHitLimit(summaries.length, "listOpenIssuesWithBodies");
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
