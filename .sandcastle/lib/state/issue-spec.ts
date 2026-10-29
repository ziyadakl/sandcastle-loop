/**
 * The ticket text every agent prompt carries as `{{ISSUE_SPEC}}` (spec #1334,
 * slice SB).
 *
 * The prompts used to load it with an in-sandbox `gh issue view … | jq`.
 * The sandbox now holds no GitHub key, and that pipeline would then have
 * produced a blank ticket with no error (jq exits 0 on empty input), so the
 * host reads the ticket once at claim time and renders it here.
 */

/** The three fields read from GitHub for one ticket. */
export interface IssueSpecRead {
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
}

/** The ticket as the prompts show it — the same shape the old `jq` printed. */
export function renderIssueSpec(issue: IssueSpecRead): string {
  return `# ${issue.title}\n\nLabels: ${issue.labels.join(", ")}\n\n${issue.body}`;
}

/**
 * What a prompt shows when the claim-time read failed: never a blank block,
 * which an agent reads as "no requirements". The title comes from the planned
 * card, which the host already holds.
 */
export function unreadIssueSpec(issueNumber: number, title: string): string {
  return (
    `# ${title}\n\n` +
    `(The text of issue #${issueNumber} could not be read from GitHub when ` +
    `this ticket was claimed, and this sandbox has no GitHub access to read ` +
    `it. Work from the title above; if that is not enough to build the ` +
    `ticket safely, stop and say so.)`
  );
}
