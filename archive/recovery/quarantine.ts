/**
 * Higher-level quarantine coordinator.
 *
 * Track D's `quarantineStoryInPrd` already mutates prd.json AND transitions
 * the GH label (when ghIssue is present). This file owns the coordination
 * step on top: post a GH issue comment that captures the quarantine reason
 * for human triage, and threads errors so the caller knows the prd.json
 * write succeeded vs. the (best-effort) GH-side annotation.
 *
 * Mirrors the bash driver's split (afk-ralph.sh ~L245-270 + the call sites
 * that follow `quarantine_story` with a `gh issue comment` for traceability).
 *
 * Error policy:
 *   - prd.json mutation failure → re-throw. The on-disk state is the source
 *     of truth; if we couldn't move the story to quarantined, the loop
 *     driver MUST stop and surface the error.
 *   - GH-side comment failure → log and swallow. The prd.json write is
 *     already durable; the GH comment is decoration. (The label transition
 *     itself runs inside `quarantineStoryInPrd` and follows the same
 *     "label drift is recoverable" stance Track D documents.)
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { quarantineStoryInPrd } from "../../src/state/index.js";
import type { Story } from "../../src/types.js";

const execFileP = promisify(execFile);

/**
 * Comment + label + prd-mutation flow. The label transition runs inside
 * `quarantineStoryInPrd`; this function posts the human-readable comment.
 */
export interface QuarantineStoryOptions {
  /**
   * Override the gh CLI binary. Test seam — defaults to "gh" on PATH.
   */
  readonly ghBin?: string;
  /**
   * Override the comment-poster. Test seam: receives `(issueNum, body)` and
   * resolves on success or rejects on failure. Production code uses
   * `gh issue comment` via execFile.
   */
  readonly _commentPoster?: (issueNum: number, body: string) => Promise<void>;
}

/**
 * Quarantine a story end-to-end:
 *   1. Mutate prd.json (status -> quarantined, record reason + attempts +
 *      timestamp). Throws if this step fails.
 *   2. Transition the GH label to "quarantine" (handled inside
 *      `quarantineStoryInPrd` already).
 *   3. Post a `gh issue comment` summarizing the quarantine reason. Logged
 *      and swallowed on failure — does not throw.
 */
export async function quarantineStory(
  repoRoot: string,
  story: Story,
  reason: string,
  options: QuarantineStoryOptions = {},
): Promise<void> {
  const attempts = story.attempts ?? 1;

  // Step 1 + 2: prd.json mutation + GH label transition.
  // `quarantineStoryInPrd` throws on prd.json failure — we let that propagate.
  await quarantineStoryInPrd(repoRoot, story.id, reason, attempts);

  // Step 3: post a comment for the human triage queue. Best-effort.
  if (typeof story.ghIssue !== "number") {
    return;
  }

  const body = formatQuarantineComment(story, reason, attempts);
  const poster =
    options._commentPoster ?? makeDefaultCommentPoster(options.ghBin ?? "gh");

  try {
    await poster(story.ghIssue, body);
  } catch (err) {
    // Swallow — the prd.json write is already durable. Surface a warning to
    // stderr so the loop log preserves the failure for forensics; the
    // story is correctly quarantined regardless.
    const msg = (err as Error).message ?? String(err);
    process.stderr.write(
      `quarantineStory: gh issue comment for #${story.ghIssue} failed; ` +
        `prd.json mutation already succeeded. Error: ${msg}\n`,
    );
  }
}

/**
 * Format the quarantine comment body. Markdown, since gh issue comments
 * render as markdown. Truncate `reason` aggressively — the bash version
 * caps at 300 chars; we go to 1000 since GH supports up to 65k and longer
 * stack traces are useful for triage.
 */
function formatQuarantineComment(
  story: Story,
  reason: string,
  attempts: number,
): string {
  const reasonTrunc = reason.length > 1000 ? `${reason.slice(0, 1000)}…` : reason;
  return [
    `**Story \`${story.id}\` quarantined by the Ralph loop.**`,
    "",
    `- attempts: ${attempts}`,
    `- when: ${new Date().toISOString()}`,
    "",
    "**Reason:**",
    "",
    "```",
    reasonTrunc,
    "```",
    "",
    "Status flipped to `quarantined` in prd.json; this issue's label was " +
      "transitioned to `quarantine`. A human should investigate before the " +
      "story is requeued.",
  ].join("\n");
}

/**
 * Default `gh issue comment <num> --body <body>` runner via execFile so the
 * comment body can never shell-inject. The bash version used a heredoc,
 * which still required careful quoting of `\$`, backticks, etc.
 */
function makeDefaultCommentPoster(
  ghBin: string,
): (issueNum: number, body: string) => Promise<void> {
  return async (issueNum, body) => {
    if (!Number.isInteger(issueNum) || issueNum <= 0) {
      throw new Error(
        `quarantineStory: refusing to comment on invalid issueNum '${issueNum}'`,
      );
    }
    await execFileP(
      ghBin,
      ["issue", "comment", String(issueNum), "--body", body],
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    );
  };
}
