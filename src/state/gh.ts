/**
 * gh CLI wrappers. Always invoked via execFile (NEVER exec) so that label
 * names, issue bodies, and comment text can't shell-inject. Every argument
 * is a separate argv entry — `gh` receives them verbatim.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const GH_BIN = "gh";
const DEFAULT_TIMEOUT_MS = 30_000;

interface RunResult {
  stdout: string;
  stderr: string;
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
 * Move a label on an issue. If `from === "*"`, only adds the new label (no
 * removal). Otherwise removes `from` and adds `to` in the same `gh issue edit`
 * call. Errors propagate — Track C decides whether label drift is fatal.
 */
export async function transitionLabel(
  issueNum: number,
  from: string,
  to: string,
): Promise<void> {
  if (!Number.isInteger(issueNum) || issueNum <= 0) {
    throw new Error(`transitionLabel: invalid issueNum '${issueNum}'`);
  }
  if (!to) {
    throw new Error("transitionLabel: 'to' label must be non-empty");
  }
  const args: string[] = ["issue", "edit", String(issueNum), "--add-label", to];
  if (from !== "*") {
    args.push("--remove-label", from);
  }
  await runGh(args);
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
/** Legacy synonym for `needs-human`; readers should accept either. */
export const LABEL_QUARANTINE_ALIAS = "quarantine";

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
