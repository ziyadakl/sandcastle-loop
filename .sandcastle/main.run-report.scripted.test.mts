/**
 * Spec #1334 SE, scripted end to end through the real `runMain`: what the
 * end-of-run report and the run log say after a run. Asserts only OUTPUT —
 * the report text handed to the pull request and the run log lines.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ChangeClass } from "./lib/state/merge-rule.js";
import { git } from "./__fixtures__/git-repo.js";
import {
  IMPLEMENTER_STORY_COMPLETE,
  initRepoWithOrigin,
  makeArgs,
  scriptedRun,
} from "./__fixtures__/scripted-run.mts";
import { SONNET_FIXTURE } from "./lib/cost/__fixtures__/expected.js";
import { TICKET_EVENT_LINE_RE } from "./lib/state/run-report.js";
import { runMain } from "./main.mts";

const BRANCH = "sandcastle/scripted-run-report";

describe("scripted run: the run report's numbers and the per-ticket log line", () => {
  let repo: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ repo, cleanup } = initRepoWithOrigin("sc-run-report-"));
    git(repo, "checkout", "-q", "-b", BRANCH);
  });

  afterEach(() => {
    cleanup();
  });

  it("a shipped ticket logs one TICKET line, and the report leads with the three numbers and counts every waiting ticket", async () => {
    const reports: string[] = [];
    const { deps, captured } = scriptedRun({
      issueNumber: 601,
      title: "Show the team total",
      branch: "agent/issue-601",
      answers: {
        implementer: {
          stdout: IMPLEMENTER_STORY_COMPLETE,
          commits: [{ sha: "abc123", subject: "work" }],
          iterations: [{ sessionFilePath: SONNET_FIXTURE }],
        },
      },
      deps: {
        // Two tickets parked by EARLIER runs: the count is the standing one.
        listIssuesByLabel: async (label: string) =>
          label === "waiting-for-session"
            ? [
                { number: 90, title: "parked earlier", labels: ["waiting-for-session"] },
                { number: 91, title: "parked by a peer", labels: ["waiting-for-session"] },
              ]
            : [],
        openRunPr: async (_branch, _shipped, opts) => {
          if (opts?.report !== undefined) reports.push(opts.report);
          return { url: "https://example.invalid/pr/7" };
        },
      },
    });

    const result = await runMain(
      makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 1 }),
      deps,
    );

    expect(result.shippedIssues).toEqual([601]);
    const ticketLines = captured.logs.filter((l) => TICKET_EVENT_LINE_RE.test(l));
    expect(ticketLines).toHaveLength(1);
    expect(ticketLines[0]).toMatch(/^TICKET #601 shipped label=- cost=\$\d+\.\d{2}$/);

    expect(reports).toHaveLength(1);
    const report = reports[0]!;
    expect(report).toMatch(/- Dollars per shipped ticket: \$\d+\.\d{2} \(\$\d+\.\d{2} spent ÷ 1 shipped\)/);
    expect(report).not.toContain("n/a — nothing shipped");
    expect(report).toContain("- Waiting for a session: 2");
    expect(report).toContain("- Reached you: 0");
    expect(report).toContain("## Nothing needs you.");
    // The report also reaches the run log, as the upsert's error text promises.
    expect(captured.logs).toContain(report);
  });

  it("the shipped line is written when the run LANDS the ticket, not when its pipeline ends", async () => {
    // One timeline: every log line, plus a marker the moment the merger —
    // the step that lands the ticket on the run branch — is dispatched.
    const timeline: string[] = [];
    const { deps } = scriptedRun({
      issueNumber: 603,
      branch: "agent/issue-603",
      answers: {
        other: () => {
          timeline.push("<merger dispatched>");
          return "";
        },
      },
      deps: { log: (line: string) => void timeline.push(line) },
    });

    await runMain(makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 1 }), deps);

    const ticketLines = timeline.filter((l) => TICKET_EVENT_LINE_RE.test(l));
    expect(ticketLines).toEqual([expect.stringMatching(/^TICKET #603 shipped /)]);
    const shippedAt = timeline.indexOf(ticketLines[0]!);
    const pipelineEndedAt = timeline.findIndex((l) => l.startsWith("[issue=603] shipped (marker="));
    const mergerAt = timeline.indexOf("<merger dispatched>");
    expect(pipelineEndedAt).toBeGreaterThan(-1);
    expect(mergerAt).toBeGreaterThan(pipelineEndedAt);
    expect(shippedAt).toBeGreaterThan(mergerAt);
  });

  it("a ticket the reviewer confirms already built logs its own outcome word, never `shipped`", async () => {
    const { deps, captured } = scriptedRun({
      issueNumber: 604,
      branch: "agent/issue-604",
      answers: {
        "check-writer": [
          "reasoning",
          "```json",
          JSON.stringify({
            marker: "ALREADY_BUILT",
            inherited: false,
            alreadyBuiltEvidence: "packages/api/src/deal-total.ts:40 already does this",
          }),
          "```",
          "",
          "ALREADY_BUILT",
        ].join("\n"),
      },
      deps: {
        locateAlreadyBuiltWork: async () => ({ onMain: true, onStaging: false }),
      },
    });

    await runMain(makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 1 }), deps);

    const ticketLines = captured.logs.filter((l) => TICKET_EVENT_LINE_RE.test(l));
    expect(ticketLines).toEqual([expect.stringMatching(/^TICKET #604 closed-already-built label=- cost=/)]);
  });

  it("a run PR holding a data-destroying migration rebuilds the report: it reaches the owner once, and the rebuilt report is what is logged and written to the PR", async () => {
    const MIGRATION = "packages/db/migrations/0150_drop_old_table.sql";
    const change: ChangeClass = {
      door: "one-way",
      doorReasons: [`deletes or rewrites existing data (${MIGRATION}: drops a table)`],
      blastRadius: "small",
      blastReasons: [],
      destructiveMigrations: [MIGRATION],
    };
    const upserted: string[] = [];
    const { deps, captured } = scriptedRun({
      issueNumber: 602,
      branch: "agent/issue-602",
      deps: {
        openRunPr: async () => ({
          url: "https://example.invalid/pr/8",
          mergeRule: { change, headSha: "abc123" },
        }),
        upsertRunPrReport: async (_branch, report) => {
          upserted.push(report);
          return { updated: true };
        },
        settleRunPr: async () => ({ merged: false, why: "one-way door" }),
      },
    });

    await runMain(makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 1 }), deps);

    expect(upserted).toHaveLength(1);
    const report = upserted[0]!;
    expect(report).toContain("## Needs you:");
    expect(report).toContain(MIGRATION);
    expect(report).toContain("- Reached you: 1");
    expect(captured.logs).toContain(report);
  });

  it.each([
    [
      "the change is too large to merge itself",
      {
        door: "two-way",
        doorReasons: [],
        blastRadius: "large",
        blastReasons: ["14 files changed (more than 10)"],
        destructiveMigrations: [],
      },
      { merged: false, why: "large blast radius: 14 files changed (more than 10)" },
      "14 files changed (more than 10)",
    ],
    [
      "it edits a migration already on main",
      {
        door: "one-way",
        doorReasons: ["edits a migration already on the default branch (packages/db/migrations/0100_x.sql)"],
        blastRadius: "small",
        blastReasons: [],
        destructiveMigrations: [],
      },
      { merged: false, why: "one-way door: edits a migration already on the default branch" },
      "edits a migration already on the default branch",
    ],
    [
      "the pre-merge check failed",
      {
        door: "two-way",
        doorReasons: [],
        blastRadius: "small",
        blastReasons: [],
        destructiveMigrations: [],
      },
      { merged: false, why: "the pre-merge check (pnpm verify:land) failed: typecheck failed" },
      "the pre-merge check (pnpm verify:land) failed: typecheck failed",
    ],
  ] as const)(
    "a run PR left waiting because %s reaches the owner once, with the reason",
    async (_name, change, settled, reason) => {
      const upserted: string[] = [];
      const { deps } = scriptedRun({
        issueNumber: 605,
        branch: "agent/issue-605",
        deps: {
          openRunPr: async () => ({
            url: "https://example.invalid/pr/9",
            mergeRule: { change: change as unknown as ChangeClass, headSha: "abc123" },
          }),
          upsertRunPrReport: async (_branch, report) => {
            upserted.push(report);
            return { updated: true };
          },
          settleRunPr: async () => settled,
        },
      });

      await runMain(makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 1 }), deps);

      expect(upserted).toHaveLength(1);
      expect(upserted[0]).toContain("- Reached you: 1");
      expect(upserted[0]).toContain("## Needs you:");
      expect(upserted[0]).toContain(reason);
    },
  );

  it("a run PR the loop merged itself reaches nobody", async () => {
    const upserted: string[] = [];
    const { deps } = scriptedRun({
      issueNumber: 606,
      branch: "agent/issue-606",
      deps: {
        openRunPr: async () => ({
          url: "https://example.invalid/pr/10",
          mergeRule: {
            change: {
              door: "two-way",
              doorReasons: [],
              blastRadius: "small",
              blastReasons: [],
              destructiveMigrations: [],
            } as unknown as ChangeClass,
            headSha: "abc123",
          },
        }),
        upsertRunPrReport: async (_branch, report) => {
          upserted.push(report);
          return { updated: true };
        },
        settleRunPr: async () => ({ merged: true, why: "two-way door, small blast radius, every check green" }),
      },
    });

    await runMain(makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 1 }), deps);

    expect(upserted[0]).toContain("- Reached you: 0");
  });
});
