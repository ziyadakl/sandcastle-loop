/**
 * Spec #1334 fix pass, item 1: an unclear ticket. The test-writing AI or the
 * builder may answer `TICKET_UNCLEAR`, naming the exact product question the
 * ticket leaves open. The loop then stops that ticket for the owner —
 * `stopped:ticket-unclear` + `needs-human` — and writes the question onto the
 * issue body. No other road leads here.
 *
 * Drives the REAL `runMain` with scripted agents and asserts only the run's
 * output: shipped or not, the stop label, the owner hand-off, the question on
 * the ticket, which agents ran.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { git } from "./__fixtures__/git-repo.js";
import { initRepoWithOrigin, makeArgs, scriptedRun } from "./__fixtures__/scripted-run.mts";
import { runMain } from "./main.mts";

const QUESTION =
  "Should a deal split between two Agents count each Agent's $1,000 once, or the whole $2,000 for each?";

const CHECK_WRITER_UNCLEAR = [
  "I read the ticket and cannot tell what a pass looks like.",
  "```json",
  JSON.stringify({ marker: "TICKET_UNCLEAR", inherited: false, ticketQuestion: QUESTION }),
  "```",
  "",
  "TICKET_UNCLEAR",
].join("\n");

const BUILDER_UNCLEAR = [
  "I started building and hit a product question the ticket does not answer.",
  "",
  `<ticket-question>${QUESTION}</ticket-question>`,
  "",
  "TICKET_UNCLEAR",
].join("\n");

describe("an unclear ticket stops for the owner, with the question on it (spec #1334 fix pass)", () => {
  let repo: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ repo, cleanup } = initRepoWithOrigin("sc-unclear-"));
  });

  afterEach(() => {
    cleanup();
  });

  function start(issue: number): string {
    const branch = `agent/issue-${issue}`;
    git(repo, "checkout", "-q", "-b", branch);
    return branch;
  }
  it("the test-writing AI answers TICKET_UNCLEAR: the ticket stops before any build, for the owner, with the question written on it", async () => {
    const issue = 1401;
    const branch = start(issue);
    const { deps, captured } = scriptedRun({
      issueNumber: issue,
      branch,
      worktreePath: repo,
      answers: { "check-writer": CHECK_WRITER_UNCLEAR },
    });

    const result = await runMain(
      makeArgs({ repoRoot: repo, branch, iterations: 1, recoveryEnabled: true }),
      deps,
    );

    expect(result.shippedIssues).toEqual([]);
    expect(captured.specs.some((n) => n.startsWith("implementer"))).toBe(false);
    expect(captured.stops.map((s) => s.label)).toEqual(["stopped:ticket-unclear"]);
    expect(captured.stops[0]!.detail).toContain(QUESTION);
    expect(captured.quarantines).toHaveLength(1);
    expect(captured.quarantines[0]!.opts).toEqual({ stopLabel: "stopped:ticket-unclear" });
  });

  it("the builder answers TICKET_UNCLEAR: the ticket stops for the owner with the question on it — never handed to the fixer", async () => {
    const issue = 1402;
    const branch = start(issue);
    const { deps, captured } = scriptedRun({
      issueNumber: issue,
      branch,
      worktreePath: repo,
      answers: { implementer: { stdout: BUILDER_UNCLEAR, commits: [] } },
    });

    const result = await runMain(
      makeArgs({ repoRoot: repo, branch, iterations: 1, recoveryEnabled: true }),
      deps,
    );

    expect(result.shippedIssues).toEqual([]);
    expect(captured.specs.some((n) => n.startsWith("fixer"))).toBe(false);
    expect(captured.specs.some((n) => n.startsWith("reviewer"))).toBe(false);
    expect(captured.stops.map((s) => s.label)).toEqual(["stopped:ticket-unclear"]);
    expect(captured.stops[0]!.detail).toContain(QUESTION);
    expect(captured.quarantines).toHaveLength(1);
    expect(captured.quarantines[0]!.opts).toEqual({ stopLabel: "stopped:ticket-unclear" });
  });
});
