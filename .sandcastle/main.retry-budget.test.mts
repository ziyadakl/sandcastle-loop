/**
 * Scripted runs for the retry budget (spec #1334, SC): "the retry budget ends
 * at $100 or after three attempts, whichever comes first". Each case drives the REAL `runMain`
 * with stand-in agents and asserts only what the run DID — which tickets it
 * re-queued, which it moved to waiting, what the run report says.
 *
 * The GitHub side is two `Deps` members (`applyRetryDecision`,
 * `recordRetryAttempt`), stubbed here over a mutable in-memory issue list
 * using the real pure rule (`decideRetry`), so the stubs agree with
 * production on every decision and no `gh` process is ever spawned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { git } from "./__fixtures__/git-repo.js";
import { initRepoWithOrigin, makeArgs, scriptedRun } from "./__fixtures__/scripted-run.mts";
import {
  WAITING_FOR_SESSION_LABEL,
  appendRetryAttempt,
  decideRetry,
  type RetryAttempt,
  type RetryDecision,
} from "./lib/state/retry-budget.js";
import { runMain, type Deps } from "./main.mts";

interface Row {
  number: number;
  title: string;
  body: string;
  labels: string[];
}

const attempt = (costUsd: number, note: string): RetryAttempt => ({
  whenIso: "2026-10-09T03:00:00.000Z",
  runId: "sandcastle/queue-20261009",
  host: "my-server",
  costUsd,
  note,
});

const ledger = (...attempts: RetryAttempt[]): string =>
  attempts.reduce((b, a) => appendRetryAttempt(b, a), "A ticket.\n\nTarget: subject exists");

/** Production's label moves, applied to the in-memory row. */
function applyLabels(row: Row, decision: RetryDecision): void {
  if (decision.action === "retry") {
    row.labels = ["ready-for-agent"];
  } else if (decision.action === "waiting") {
    row.labels = [
      ...row.labels.filter((l) => l !== "quarantine"),
      WAITING_FOR_SESSION_LABEL,
    ];
  }
}

/** Deps stubs for the two retry-budget GitHub effects, over `rows`. */
function retryDeps(rows: Row[]) {
  const applied: number[] = [];
  const recorded: { n: number; attempt: RetryAttempt }[] = [];
  const find = (n: number): Row => {
    const row = rows.find((r) => r.number === n);
    if (row === undefined) throw new Error(`no row #${n}`);
    return row;
  };
  const deps: Partial<Deps> = {
    listOpenIssuesWithBodies: (async () =>
      rows.map((r) => ({ ...r, labels: [...r.labels] }))) as unknown as Deps["listOpenIssuesWithBodies"],
    applyRetryDecision: async (n: number) => {
      applied.push(n);
      const row = find(n);
      const decision = decideRetry(row);
      applyLabels(row, decision);
      return { decision };
    },
    recordRetryAttempt: async (n: number, a: RetryAttempt) => {
      recorded.push({ n, attempt: a });
      const row = find(n);
      row.body = appendRetryAttempt(row.body, a);
      const decision = decideRetry(row);
      if (decision.action === "waiting") applyLabels(row, decision);
      return { decision };
    },
  };
  return { deps, applied, recorded };
}

describe("scripted run: the retry budget ends at $100 or after three attempts", () => {
  let repo: string;
  let cleanup: () => void;
  const BRANCH = "sandcastle/scripted-run";

  beforeEach(() => {
    ({ repo, cleanup } = initRepoWithOrigin("sc-retry-budget-"));
    git(repo, "checkout", "-q", "-b", BRANCH);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    cleanup();
  });

  it("at run start: re-queues a ticket under budget, moves an over-budget one and a thrice-tried one to waiting, and leaves an old stop and a live-leased one alone", async () => {
    const Q = ["quarantine", "stopped:run-fault"];
    const rows: Row[] = [
      { number: 601, title: "under budget", body: ledger(attempt(40, "stopped:run-fault")), labels: [...Q] },
      {
        number: 602,
        title: "over budget",
        body: ledger(attempt(60, "stopped:run-fault"), attempt(45, "stopped:reviewer-refused")),
        labels: [...Q],
      },
      {
        number: 603,
        title: "tried three times",
        body: ledger(
          attempt(5, "stopped:run-fault"),
          attempt(5, "stopped:reviewer-refused"),
          attempt(5, "stopped:checks-tampered"),
        ),
        labels: ["quarantine", "stopped:reviewer-refused"],
      },
      { number: 604, title: "older stop, no ledger", body: "A ticket.", labels: [...Q] },
      { number: 605, title: "leased elsewhere", body: ledger(attempt(10, "stopped:run-fault")), labels: [...Q] },
    ];
    const retry = retryDeps(rows);
    // Leases on, so a peer's LIVE lease on #605 is honoured.
    vi.stubEnv("SANDCASTLE_CROSS_HOST_LEASE", "1");
    let report = "";
    const { deps } = scriptedRun({
      issueNumber: 601,
      branch: "agent/issue-601",
      deps: {
        ...retry.deps,
        leaseState: async (n: number) => (n === 605 ? "live" : "absent"),
        openRunPr: (async (_b: string, _s: unknown, opts?: { report?: string }) => {
          report = opts?.report ?? "";
          return { url: "https://example.invalid/pr/1" };
        }) as unknown as Deps["openRunPr"],
      },
    });

    const result = await runMain(makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 1 }), deps);

    expect(retry.applied.sort()).toEqual([601, 602, 603]);
    expect(result.shippedIssues).toEqual([601]);
    expect(rows.find((r) => r.number === 602)!.labels).toContain(WAITING_FOR_SESSION_LABEL);
    expect(rows.find((r) => r.number === 603)!.labels).toContain(WAITING_FOR_SESSION_LABEL);
    expect(rows.find((r) => r.number === 604)!.labels).toEqual(Q);
    expect(rows.find((r) => r.number === 605)!.labels).toEqual(Q);

    const lines = report.split("\n");
    expect(lines.filter((l) => l.includes("#602"))).toHaveLength(1);
    expect(lines.find((l) => l.includes("#602"))).toMatch(/\$105\.00 of \$100/);
    expect(lines.filter((l) => l.includes("#603"))).toHaveLength(1);
    expect(lines.find((l) => l.includes("#603"))).toMatch(/tried 3 times/);
    expect(report).not.toContain("#604");
    expect(report).not.toContain("#605");
  });

  it("at failure time: a ticket failing its third attempt is recorded once and moved to waiting, with one report line", async () => {
    const rows: Row[] = [
      {
        number: 611,
        title: "fails again",
        // Two earlier attempts that ended differently: the kind of failure
        // is never compared, only the count.
        body: ledger(attempt(5, "stopped:reviewer-refused"), attempt(5, "unlabelled:HALT")),
        labels: ["ready-for-agent"],
      },
    ];
    const retry = retryDeps(rows);
    const { deps, captured } = scriptedRun({
      issueNumber: 611,
      branch: "agent/issue-611",
      answers: { implementer: new Error("the builder fell over") },
      deps: {
        ...retry.deps,
        // The real quarantine puts the literal label on; mirror it.
        quarantine: (async (n: number) => {
          const row = rows.find((r) => r.number === n)!;
          row.labels = ["quarantine"];
        }) as unknown as Deps["quarantine"],
        reportStop: (async (n: number, r: { label: string; detail: string }) => {
          captured.stops.push({ label: r.label, detail: r.detail });
          rows.find((x) => x.number === n)!.labels.push(r.label);
        }) as unknown as Deps["reportStop"],
      },
    });

    await runMain(makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 1 }), deps);

    expect(captured.stops.at(-1)?.label).toBe("stopped:run-fault");
    expect(retry.recorded).toHaveLength(1);
    expect(retry.recorded[0]!.n).toBe(611);
    expect(retry.recorded[0]!.attempt.note).toBe("stopped:run-fault");
    expect(rows[0]!.labels).toContain(WAITING_FOR_SESSION_LABEL);
    const reportLines = captured.logs.join("\n").split("\n").filter((l) => l.includes("#611"));
    expect(reportLines.filter((l) => /tried 3 times/.test(l))).toHaveLength(1);
  });

  it("--dry-run touches no ledger and no label", async () => {
    const rows: Row[] = [
      {
        number: 621,
        title: "would be re-queued",
        body: ledger(attempt(5, "stopped:run-fault")),
        labels: ["quarantine", "stopped:run-fault"],
      },
    ];
    const retry = retryDeps(rows);
    const { deps } = scriptedRun({ issueNumber: 621, branch: "agent/issue-621", deps: retry.deps });

    await runMain(makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 1, dryRun: true }), deps);

    expect(retry.applied).toEqual([]);
    expect(retry.recorded).toEqual([]);
  });

  it("a stop that goes to the owner (an unclear ticket) never spends from the budget", async () => {
    const rows: Row[] = [
      { number: 631, title: "unclear", body: "A server ticket with no target block.", labels: ["ready-for-agent"] },
    ];
    const retry = retryDeps(rows);
    const { deps, captured } = scriptedRun({
      issueNumber: 631,
      branch: "agent/issue-631",
      deps: { ...retry.deps, getIssueBody: async () => rows[0]!.body },
    });

    await runMain(makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 1 }), deps);

    expect(captured.stops.at(-1)?.label).toBe("stopped:ticket-unclear");
    expect(retry.recorded).toEqual([]);
  });
});
