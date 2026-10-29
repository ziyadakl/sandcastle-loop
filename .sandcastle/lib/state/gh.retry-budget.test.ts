/**
 * Spec #1334, SC — the `gh`-facing half of the retry budget, with a fake `gh`
 * so no real process or network is touched. The pure rules are in
 * `retry-budget.test.ts`; this file pins the fetch → decide → write wiring:
 * one fresh fetch of body AND labels together, one edit.
 */
import { describe, expect, it, vi } from "vitest";

import {
  LABEL_READY,
  STATUS_LABELS,
  applyRetryDecision,
  recordRetryAttempt,
  warnIfHitLimit,
} from "./gh.js";
import {
  WAITING_FOR_SESSION_LABEL,
  appendRetryAttempt,
  type RetryAttempt,
} from "./retry-budget.js";

const attempt = (costUsd: number | null, note: string): RetryAttempt => ({
  whenIso: "2026-10-10T03:12:00.000Z",
  runId: "sandcastle/queue-20261010",
  host: "my-server",
  costUsd,
  note,
});

function fakeGh(view: { body: string; labels: string[] }) {
  const calls: string[][] = [];
  const runGh = vi.fn(async (args: string[]) => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "view") {
      return {
        stdout: JSON.stringify({
          body: view.body,
          labels: view.labels.map((name) => ({ name })),
        }),
        stderr: "",
      };
    }
    return { stdout: "", stderr: "" };
  });
  const edits = () => calls.filter((c) => c[0] === "issue" && c[1] === "edit");
  const views = () => calls.filter((c) => c[0] === "issue" && c[1] === "view");
  return { runGh, calls, edits, views };
}

const bodyOf = (edit: string[]) => edit[edit.indexOf("--body") + 1]!;

describe("recordRetryAttempt — one fresh fetch, one edit", () => {
  it("a first failure writes the ledger and leaves the ticket on quarantine for the next run", async () => {
    const gh = fakeGh({ body: "Ticket.", labels: ["quarantine", "stopped:run-fault"] });
    const result = await recordRetryAttempt(7, attempt(40, "stopped:run-fault"), {
      runGh: gh.runGh,
    });
    expect(result.decision).toEqual({ action: "retry", spentUsd: 40 });
    expect(gh.views()).toHaveLength(1);
    expect(gh.views()[0]).toEqual(["issue", "view", "7", "--json", "body,labels"]);
    expect(gh.edits()).toHaveLength(1);
    expect(bodyOf(gh.edits()[0]!)).toContain("$40.00 · stopped:run-fault");
    expect(gh.edits()[0]).not.toContain("--add-label");
  });

  it("the third attempt moves the ticket to waiting-for-session in the SAME edit", async () => {
    const gh = fakeGh({
      body: appendRetryAttempt(
        appendRetryAttempt("Ticket.", attempt(10, "stopped:run-fault")),
        attempt(10, "stopped:reviewer-refused"),
      ),
      labels: ["quarantine", "stopped:run-fault"],
    });
    const result = await recordRetryAttempt(7, attempt(12, "stopped:run-fault"), {
      runGh: gh.runGh,
    });
    expect(result.decision).toEqual({
      action: "waiting",
      reason: "attempts-spent",
      attempts: 3,
    });
    expect(gh.edits()).toHaveLength(1);
    const edit = gh.edits()[0]!;
    expect(edit).toEqual(
      expect.arrayContaining([
        "--remove-label",
        "quarantine",
        "--add-label",
        WAITING_FOR_SESSION_LABEL,
      ]),
    );
    // The stop label stays on: it is the "why" index.
    expect(edit.filter((a) => a === "stopped:run-fault")).toHaveLength(0);
  });
});

describe("applyRetryDecision — the run-start sweep, re-decided on a fresh fetch", () => {
  it("retry: removes quarantine and every stopped:* label, adds ready-for-agent", async () => {
    const gh = fakeGh({
      body: appendRetryAttempt("Ticket.", attempt(40, "stopped:run-fault")),
      labels: ["quarantine", "stopped:run-fault", "stopped:reviewer-refused", "type:feature"],
    });
    const result = await applyRetryDecision(9, { runGh: gh.runGh });
    expect(result.decision.action).toBe("retry");
    const edit = gh.edits()[0]!;
    expect(edit).toEqual(
      expect.arrayContaining([
        "--remove-label",
        "quarantine",
        "--remove-label",
        "stopped:run-fault",
        "--remove-label",
        "stopped:reviewer-refused",
        "--add-label",
        LABEL_READY,
      ]),
    );
    expect(edit).not.toContain("type:feature");
    expect(edit).not.toContain("--body");
  });

  it("stale caller state is ignored: a ticket already back on ready-for-agent is a no-op", async () => {
    const gh = fakeGh({
      body: appendRetryAttempt("Ticket.", attempt(40, "stopped:run-fault")),
      labels: [LABEL_READY],
    });
    const result = await applyRetryDecision(9, { runGh: gh.runGh });
    expect(result.decision.action).toBe("skip");
    expect(gh.edits()).toHaveLength(0);
  });

  it("waiting: swaps quarantine for waiting-for-session", async () => {
    const gh = fakeGh({
      body: appendRetryAttempt(appendRetryAttempt("Ticket.", attempt(60, "A")), attempt(45, "B")),
      labels: ["quarantine", "stopped:run-fault"],
    });
    const result = await applyRetryDecision(9, { runGh: gh.runGh });
    expect(result.decision.action).toBe("waiting");
    expect(result.decision).toEqual({ action: "waiting", reason: "budget-spent", spentUsd: 105 });
    expect(gh.edits()[0]).toEqual(
      expect.arrayContaining([
        "--remove-label",
        "quarantine",
        "--add-label",
        WAITING_FOR_SESSION_LABEL,
      ]),
    );
  });
});

describe("STATUS_LABELS", () => {
  it("contains waiting-for-session, so a wildcard transition clears it", () => {
    expect(STATUS_LABELS).toContain(WAITING_FOR_SESSION_LABEL);
  });
});

/**
 * Deferable finding 6 (moved here from the deleted auto-requeue test file):
 * `listOpenIssuesWithBodies` — the retry sweep's source of candidates — caps
 * at `--limit 500`, but its call into the shared `warnIfHitLimit(count, fn)`
 * once passed no third argument, so the helper's hardcoded `count === 100`
 * check could never fire for it. `warnIfHitLimit` now takes the caller's own
 * limit; these pin both the default and the explicit 500.
 */
describe("warnIfHitLimit — the threshold is per-caller, not a hardcoded 100", () => {
  it("still warns at the default 100 when no limit is passed (listReadyIssues, listIssuesByLabel)", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    warnIfHitLimit(100, "listReadyIssues");
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("100 results"));
    spy.mockRestore();
  });

  it("does NOT warn at 100 when the caller's limit is 500 (listOpenIssuesWithBodies's real cap)", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    warnIfHitLimit(100, "listOpenIssuesWithBodies", 500);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("warns at 500 when the caller's limit is 500", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    warnIfHitLimit(500, "listOpenIssuesWithBodies", 500);
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("listOpenIssuesWithBodies returned exactly 500 results"),
    );
    spy.mockRestore();
  });
});
