/**
 * Spec #1334, SC — the retry budget's PURE half, as a plain table of cases.
 *
 * A ticket the loop failed on is retried on later runs until it has spent
 * $100 in total, or after three attempts, whichever comes first. Then it
 * waits for a session. The limits count money and attempts, never what kind
 * of failure it was. The ledger is a marker section in the issue BODY;
 * these cases pin how that ledger is read, appended to, and decided on.
 */
import { describe, expect, it } from "vitest";

import {
  RETRY_BUDGET_SECTION_END,
  RETRY_BUDGET_SECTION_START,
  RETRY_MAX_ATTEMPTS,
  RETRY_BUDGET_USD,
  WAITING_FOR_SESSION_LABEL,
  appendRetryAttempt,
  createFailedAttemptRecorder,
  decideRetry,
  readRetryLedger,
  type RetryAttempt,
  type RetryDecision,
} from "./retry-budget.js";

const attempt = (costUsd: number | null, note: string): RetryAttempt => ({
  whenIso: "2026-10-10T03:12:00.000Z",
  runId: "sandcastle/queue-20261010",
  host: "my-server",
  costUsd,
  note,
});

/** A body carrying a ledger of `attempts`, built only through the public
 *  appender — the same way a real run writes it. */
const ledgerBody = (...attempts: RetryAttempt[]): string =>
  attempts.reduce((body, a) => appendRetryAttempt(body, a), "Ticket description.");

const Q = ["quarantine", "stopped:run-fault"];

describe("decideRetry — the rule table", () => {
  const cases: {
    readonly name: string;
    readonly labels: readonly string[];
    readonly body: string;
    readonly expected: ReturnType<typeof decideRetry>;
  }[] = [
    {
      name: "a ticket not on quarantine is not the budget's to touch",
      labels: ["ready-for-agent"],
      body: ledgerBody(attempt(40, "stopped:run-fault")),
      expected: { action: "skip" },
    },
    {
      name: "quarantine with no ledger (an older stop, or a fresh acceptance ticket) is left alone",
      labels: Q,
      body: "Ticket description.",
      expected: { action: "skip" },
    },
    {
      name: "already waiting for a session",
      labels: [...Q, WAITING_FOR_SESSION_LABEL],
      body: ledgerBody(attempt(40, "stopped:run-fault")),
      expected: { action: "skip" },
    },
    {
      name: "needs-human only (the owner road) is never retried",
      labels: ["needs-human"],
      body: ledgerBody(attempt(40, "stopped:run-fault")),
      expected: { action: "skip" },
    },
    {
      name: "a ledger start marker with no end marker cannot be read — fail closed",
      labels: Q,
      body: `Ticket.\n\n${RETRY_BUDGET_SECTION_START}\n## Retry budget\n- 2026-10-10 · run r · host h · $40 · stopped:run-fault`,
      expected: { action: "waiting", reason: "unreadable" },
    },
    {
      name: "an attempt line whose amount is not a number cannot be read — fail closed",
      labels: Q,
      body: ledgerBody(attempt(40, "stopped:run-fault")).replace("$40.00", "$abc"),
      expected: { action: "waiting", reason: "unreadable" },
    },
    {
      name: "one $40 attempt",
      labels: Q,
      body: ledgerBody(attempt(40, "stopped:run-fault")),
      expected: { action: "retry", spentUsd: 40 },
    },
    {
      name: "$60 + $39.99, different failures — one cent under the cap",
      labels: Q,
      body: ledgerBody(attempt(60, "stopped:run-fault"), attempt(39.99, "stopped:reviewer-refused")),
      expected: { action: "retry", spentUsd: 99.99 },
    },
    {
      name: "$60 + $40, different failures — exactly at the cap",
      labels: Q,
      body: ledgerBody(attempt(60, "stopped:run-fault"), attempt(40, "stopped:reviewer-refused")),
      expected: { action: "waiting", reason: "budget-spent", spentUsd: 100 },
    },
    {
      name: "one $150 attempt overshoots the cap",
      labels: Q,
      body: ledgerBody(attempt(150, "stopped:run-fault")),
      expected: { action: "waiting", reason: "budget-spent", spentUsd: 150 },
    },
    {
      name: "an attempt of unknown cost counts as $0",
      labels: Q,
      body: ledgerBody(attempt(null, "stopped:run-fault"), attempt(30, "stopped:reviewer-refused")),
      expected: { action: "retry", spentUsd: 30 },
    },
    {
      name: "two attempts, the same failure both times — still retried (the kind of failure is never compared)",
      labels: Q,
      body: ledgerBody(attempt(10, "stopped:reviewer-refused"), attempt(10, "stopped:reviewer-refused")),
      expected: { action: "retry", spentUsd: 20 },
    },
    {
      name: "three attempts, all different failures, under $100 — attempts spent",
      labels: Q,
      body: ledgerBody(attempt(10, "A"), attempt(10, "B"), attempt(10, "C")),
      expected: { action: "waiting", reason: "attempts-spent", attempts: 3 },
    },
    {
      name: "a third attempt that also reaches $100 — the money is named first",
      labels: Q,
      body: ledgerBody(attempt(40, "A"), attempt(40, "B"), attempt(20, "C")),
      expected: { action: "waiting", reason: "budget-spent", spentUsd: 100 },
    },
    {
      name: "a stranded promotion's saved work must not be thrown away by a retry",
      labels: Q,
      body: `${ledgerBody(attempt(10, "stopped:run-fault"))}\n\nIts work is saved — do not simply re-queue this.`,
      expected: { action: "waiting", reason: "saved-work" },
    },
    {
      name: "the older build's wording for saved work is honoured too",
      labels: Q,
      body: `${ledgerBody(attempt(10, "stopped:run-fault"))}\n\nThis is NOT a plain re-queue.`,
      expected: { action: "waiting", reason: "saved-work" },
    },
    {
      name: "an old auto-requeue section alone (#1276's shape) is not a ledger",
      labels: Q,
      body:
        "Ticket.\n\n<!-- sandcastle:auto-requeue:start -->\n## Auto-requeue: environment fault\n\n" +
        "**Count:** 1\n<!-- sandcastle:auto-requeue:end -->",
      expected: { action: "skip" },
    },
  ];

  it.each(cases)("$name", ({ labels, body, expected }) => {
    expect(decideRetry({ labels, body })).toEqual(expected);
  });

  it("the caps are $100 and three attempts", () => {
    expect(RETRY_BUDGET_USD).toBe(100);
    expect(RETRY_MAX_ATTEMPTS).toBe(3);
  });

  it("an OLD ledger section, written while attempts carried a failure category, still parses and decides", () => {
    // Verbatim shape of a section written by the build that compared
    // categories: a category column on each line, and the old footer prose.
    const body = [
      "Ticket description.",
      "",
      RETRY_BUDGET_SECTION_START,
      "## Retry budget",
      "",
      "- 2026-10-09T03:12:00.000Z · run sandcastle/queue-20261009 · host my-server · $12.50 · review-refused",
      "- 2026-10-10T03:12:00.000Z · run sandcastle/queue-20261010 · host mac · $unknown · unlabelled:HALT",
      "",
      "**Spent:** $12.50 of $100",
      "",
      "The loop retries this ticket on its next run, until it has spent $100 in total or fails the same way twice in a row.",
      RETRY_BUDGET_SECTION_END,
    ].join("\n");
    const read = readRetryLedger(body);
    expect(read.kind).toBe("ok");
    expect(read.kind === "ok" ? read.attempts.map((a) => [a.costUsd, a.note]) : []).toEqual([
      [12.5, "review-refused"],
      [null, "unlabelled:HALT"],
    ]);
    expect(decideRetry({ labels: Q, body })).toEqual({ action: "retry", spentUsd: 12.5 });
  });
});

describe("the ledger round trip", () => {
  it("reads back exactly the attempts that were appended", () => {
    const a = attempt(41.27, "stopped:run-fault");
    const b = attempt(null, "unlabelled:HALT");
    expect(readRetryLedger(ledgerBody(a, b))).toEqual({ kind: "ok", attempts: [a, b] });
  });

  it("an absent ledger reads as absent, not as empty", () => {
    expect(readRetryLedger("Ticket description.")).toEqual({ kind: "absent" });
  });

  it("appending leaves everything outside the section byte-for-byte", () => {
    const before =
      "Ticket description.\n\n<!-- sandcastle:stop-report:start -->\n## Stopped\nwhy\n" +
      "<!-- sandcastle:stop-report:end -->";
    const after = appendRetryAttempt(before, attempt(5, "stopped:run-fault"));
    expect(after.startsWith(before)).toBe(true);
    const again = appendRetryAttempt(after, attempt(6, "stopped:reviewer-refused"));
    expect(again.startsWith(before)).toBe(true);
  });

  it("each append adds exactly one attempt line and keeps a running total", () => {
    const once = ledgerBody(attempt(5, "A"));
    const twice = appendRetryAttempt(once, attempt(6, "B"));
    const lines = (s: string) => s.split("\n").filter((l) => l.startsWith("- ")).length;
    expect(lines(twice) - lines(once)).toBe(1);
    expect(twice).toContain("**Spent:** $11.00 of $100");
  });

  it("a waiting ledger says why in plain words", () => {
    const body = ledgerBody(attempt(60, "A"), attempt(40, "B"));
    expect(body).toMatch(/waiting-for-session/);
    expect(ledgerBody(attempt(1, "A"), attempt(1, "B"), attempt(1, "C"))).toMatch(
      /tried 3 times/,
    );
  });
});

describe("createFailedAttemptRecorder", () => {
  const setup = (over: { dryRun?: boolean; owner?: boolean; label?: string; decision?: RetryDecision; fail?: boolean } = {}) => {
    const written: { n: number; attempt: RetryAttempt }[] = [];
    const waiting: { n: number; why: string }[] = [];
    const errors: string[] = [];
    const record = createFailedAttemptRecorder({
      dryRun: over.dryRun ?? false,
      wentToOwner: () => over.owner ?? false,
      costUsd: () => 12.5,
      stopLabel: () => over.label,
      runId: "run-1",
      host: () => "vps",
      now: () => new Date("2026-10-11T00:00:00.000Z"),
      record: async (n, attempt) => {
        if (over.fail === true) throw new Error("gh down");
        written.push({ n, attempt });
        return { decision: over.decision ?? { action: "skip" } };
      },
      onWaiting: (n, why) => waiting.push({ n, why }),
      logError: (line) => errors.push(line),
    });
    return { record, written, waiting, errors };
  };

  it("writes one attempt per ticket, noting the stop label", async () => {
    const t = setup({ label: "stopped:reviewer-refused" });
    await t.record(7, "HALT", "quarantined");
    await t.record(7, "HALT", "quarantined");
    expect(t.written).toEqual([
      {
        n: 7,
        attempt: {
          whenIso: "2026-10-11T00:00:00.000Z",
          runId: "run-1",
          host: "vps",
          costUsd: 12.5,
          note: "stopped:reviewer-refused",
        },
      },
    ]);
  });

  it("notes the marker, else the status, when no stop label was applied", async () => {
    const t = setup();
    await t.record(1, "HALT", "quarantined");
    await t.record(2, "", "error");
    expect(t.written.map((w) => w.attempt.note)).toEqual(["unlabelled:HALT", "unlabelled:error"]);
  });

  it("never spends on a dry run or on a stop that went to the owner", async () => {
    const dry = setup({ dryRun: true });
    await dry.record(1, "HALT", "quarantined");
    const owner = setup({ owner: true });
    await owner.record(1, "HALT", "quarantined");
    expect([...dry.written, ...owner.written]).toEqual([]);
  });

  it("reports a move to waiting-for-session in the budget's own words", async () => {
    const t = setup({ decision: { action: "waiting", reason: "attempts-spent", attempts: 3 } });
    await t.record(9, "HALT", "quarantined");
    expect(t.waiting).toEqual([{ n: 9, why: "tried 3 times without shipping — hand it to a session" }]);
  });

  it("logs a failed write and never throws", async () => {
    const t = setup({ fail: true });
    await expect(t.record(4, "HALT", "quarantined")).resolves.toBeUndefined();
    expect(t.errors).toEqual(["[issue=4] retry budget: recording this attempt failed — gh down"]);
  });
});
