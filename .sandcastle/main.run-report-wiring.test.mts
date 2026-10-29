/**
 * ROT-GUARD (issue #1179): `lib/state/run-report.test.ts` proves the pure
 * builder (`buildRunReport`) in isolation, and `lib/state/gh.run-report.test.ts`
 * proves `upsertRunPrReport`'s marker-replace behaviour in isolation. Neither
 * one proves `main.mts`'s own `finishRun` actually CALLS them on every
 * termination path — that a refactor could not silently drop the report
 * while every pure test keeps passing. This file reads `main.mts` as TEXT
 * and pins the load-bearing wiring, the same grep-style approach
 * `main.scaled-timeout-wiring.test.mts` and `main.older-test-edit-wiring.test.mts`
 * use for the same class of silent-drop risk.
 *
 * A failure here does not necessarily mean a bug: a call site's own variable
 * names can legitimately change. It means the text needle below no longer
 * matches, which is exactly the signal to go re-verify the site still does
 * the right thing before updating the needle.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(path.join(import.meta.dirname, "main.mts"), "utf8");

/** Non-overlapping occurrences of a literal needle in main.mts. */
function count(needle: string): number {
  return SRC.split(needle).length - 1;
}

describe("issue #1179 — finishRun builds and renders the one end-of-run report on every exit", () => {
  it("finishRun computes the report via buildFinalRunReport, backed by buildRunReport", () => {
    expect(count("const buildFinalRunReport = (extra: {")).toBe(1);
    expect(count("return buildRunReport(input);")).toBe(1);
  });

  it("spec #1334 SE: the cost and per-ticket ledgers are declared ABOVE finishRun, so an early startup refusal can build the report", () => {
    // finishRun runs from two startup refusals that return before the rest
    // of runMain executes; a ledger declared below it would be read before
    // it exists, throw, and lose the report.
    const finishIdx = SRC.indexOf("const finishRun = async (): Promise<void> => {");
    expect(finishIdx).toBeGreaterThan(-1);
    expect(count("const costLedger = new CostLedger();")).toBe(1);
    expect(count("const issueLedger = new IssueLedger();")).toBe(1);
    expect(SRC.indexOf("const costLedger = new CostLedger();")).toBeLessThan(finishIdx);
    expect(SRC.indexOf("const issueLedger = new IssueLedger();")).toBeLessThan(finishIdx);
  });

  it("spec #1334 SE: the report input carries the run's cost, the older-test edits and why the run PR was held", () => {
    expect(SRC).toContain("totalUsd: costSummary.totalCostUsd,");
    expect(SRC).toContain("olderTestEdits: effectiveShipped.flatMap((n) =>");
    expect(SRC).toContain("heldRun: extra.heldRun,");
    expect(SRC).toContain("ctx.telemetry?.noteOlderTestEdits?.(");
    expect(SRC).toContain("namedInTicket: namesPathInOwnerText(ctx.issueBody, f.path),");
    expect(SRC).toContain("namedInTicket: f.namedInTicket,");
  });

  it("spec #1334 SE: the waiting count is read fresh at finish — every open waiting ticket, not only this run's", () => {
    const finishIdx = SRC.indexOf("const finishRun = async (): Promise<void> => {");
    const block = SRC.slice(finishIdx, finishIdx + 1500);
    expect(block).toContain("await deps.listIssuesByLabel(WAITING_FOR_SESSION_LABEL)");
    expect(count("buildFinalRunReport({ standingWaiting })")).toBe(3);
  });

  it("the report is filtered to THIS run's own records before any label is read off it", () => {
    expect(SRC).toContain("if (r.runId !== args.runId) continue;");
  });

  it("the retry budget's three lists reach the report input", () => {
    expect(SRC).toContain("requeued: effectiveRequeued.map(ticket),");
    expect(SRC).toContain(
      "waiting: waitingThisRun.map((w) => ({ ...ticket(w.number), note: w.note })),",
    );
    expect(SRC).toContain("alreadyWaitingAtStart.filter((n) => !waitingSet.has(n)).map(ticket)");
  });

  it("exit 1 — the nothing-to-ship path logs the report (no PR exists to carry it)", () => {
    const idx = SRC.indexOf('deps.log("run finished with nothing to ship — no push, no PR");');
    expect(idx).toBeGreaterThan(-1);
    expect(SRC.slice(idx, idx + 600)).toContain("deps.log(buildFinalRunReport({ standingWaiting }));");
  });

  it("exit 2 — the push-only (uncertified commits) path also logs the report", () => {
    const idx = SRC.indexOf("push to origin FAILED");
    expect(idx).toBeGreaterThan(-1);
    // The log-only render sits between the push result handling and this
    // branch's own `return`.
    const nextReturn = SRC.indexOf("return;", idx);
    expect(nextReturn).toBeGreaterThan(-1);
    expect(SRC.slice(idx, nextReturn)).toContain("deps.log(buildFinalRunReport({ standingWaiting }));");
  });

  it("exit 3 — the openRunPr path threads the report into opts.report", () => {
    expect(SRC).toContain("const report = buildFinalRunReport({ standingWaiting });");
    const idx = SRC.indexOf("const res = await deps.openRunPr(args.branch, shippedIssues, {");
    expect(idx).toBeGreaterThan(-1);
    expect(SRC.slice(idx, idx + 200)).toContain("report,");
  });

  it("exit 3 — after openRunPr reads the diff and the merge rule settles it, the report is REBUILT with why the PR waits, logged, and upserted", () => {
    const idx = SRC.indexOf("const res = await deps.openRunPr(args.branch, shippedIssues, {");
    const after = SRC.slice(idx, idx + 2400);
    // The merge rule settles BEFORE the report is rebuilt, so a hold for any
    // reason — the pre-merge check included — reaches the report.
    expect(after.indexOf("await deps.settleRunPr(")).toBeGreaterThan(-1);
    expect(after.indexOf("await deps.settleRunPr(")).toBeLessThan(
      after.indexOf("runHeldReasons(res.mergeRule?.change, settled)"),
    );
    expect(after).toContain("heldRun: { reasons: heldReasons }");
    // The run-log write the upsert's error text promises ("the report above
    // is still in the run log").
    expect(after).toContain("deps.log(finalReport);");
    expect(SRC).toContain("deps.upsertRunPrReport?.(args.branch, finalReport, thisHostId)");
  });

  it("openRunPr's own implementation embeds the report in a HOST-SCOPED marker section when opts.report is present (issue #1179 review, blocker 4)", () => {
    expect(count("if (opts?.report !== undefined) {")).toBe(1);
    const idx = SRC.indexOf("if (opts?.report !== undefined) {");
    expect(SRC.slice(idx, idx + 300)).toContain("runReportSectionStart(hostId)");
    expect(SRC.slice(idx, idx + 300)).toContain("runReportSectionEnd(hostId)");
    expect(SRC.slice(idx, idx + 300)).toContain("titleRunReport(opts.report, hostId)");
  });

  it("exit 3 — the run's own hostId is threaded into openRunPr so its section can be host-scoped", () => {
    expect(SRC).toContain("hostId: thisHostId,");
  });
});

describe("issue #1179 review — blocker 1: needsYou is derived from quarantineTerminalLabel, never from the rework record's outcome", () => {
  it("wraps the single deps.quarantine entry point so EVERY quarantine call is observed", () => {
    expect(count("deps.quarantine = async (n, reason, opts) => {")).toBe(1);
    const idx = SRC.indexOf("deps.quarantine = async (n, reason, opts) => {");
    expect(SRC.slice(idx, idx + 400)).toContain(
      "quarantineTerminalLabel(opts) === LABEL_NEEDS_HUMAN",
    );
  });

  it("the report's rework-outcome read no longer claims needsYou from the durable record (the dead-code arm the review found)", () => {
    // Before the fix: `needsYou: r.outcome === "needs-human"` — always false
    // for a quarantined issue, because `outcomeFor` in
    // `lib/telemetry/rework-record-input.ts` never writes that outcome for
    // one. It must not reappear.
    expect(SRC).not.toContain('needsYou: r.outcome === "needs-human"');
  });

  it("final review, BLOCKER K: quarantineNeedsYouThisRun is recorded AFTER the real quarantine write succeeds, never before it", () => {
    const idx = SRC.indexOf("deps.quarantine = async (n, reason, opts) => {");
    expect(idx).toBeGreaterThan(-1);
    const block = SRC.slice(idx, idx + 500);
    const awaitIdx = block.indexOf(
      "const result = await originalQuarantine(n, reason, opts);",
    );
    const setIdx = block.indexOf("quarantineNeedsYouThisRun.set(");
    expect(awaitIdx).toBeGreaterThan(-1);
    expect(setIdx).toBeGreaterThan(awaitIdx);
  });

  it("final review, BLOCKER K: the wrap always rebinds from the TRUE original (stashed once on deps), so a second runMain call on the same deps attaches one fresh layer rather than nesting or silently skipping the wrap", () => {
    expect(SRC).toContain(
      "const originalQuarantine = (depsWithOriginal[ORIGINAL_QUARANTINE] ??=\n    deps.quarantine.bind(deps));",
    );
  });

  it("an 'error' pipeline outcome (couldn't even quarantine) is pushed into its own accumulator and rendered at the top of Needs You", () => {
    expect(count("const erroredIssues: number[] = [];")).toBe(1);
    // #902 B5: the accounting loop's fulfilled branch is now `settleOutcome`,
    // whose param is `v` (the settled promise's value) rather than `s.value`.
    expect(SRC).toContain("erroredIssues.push(v.issueNumber);");
    expect(SRC).toContain("errored: erroredIssues.map(ticket),");
  });
});

describe("spec #1334 SC — the retry budget is recorded at every place an attempt can fail", () => {
  it("recordFailedAttempt is called from settleOutcome AND reportStopOutsidePipeline", () => {
    // The two call sites (the definition is spelled `recordFailedAttempt =`,
    // so it does not count). A re-graft that drops the
    // outside-pipeline site strands a stranded-promotion or rejected-staging
    // ticket on `quarantine` with no ledger: never retried, never waiting.
    expect(count("recordFailedAttempt(")).toBe(2);
    const outsideIdx = SRC.indexOf("const reportStopOutsidePipeline = async (");
    const settleIdx = SRC.indexOf("const settleOutcome = async (v: {");
    expect(SRC.indexOf("recordFailedAttempt(", outsideIdx)).toBeLessThan(
      SRC.indexOf("\n  };", outsideIdx),
    );
    expect(SRC.indexOf("recordFailedAttempt(", settleIdx)).toBeLessThan(
      SRC.indexOf("\n  };", settleIdx),
    );
  });

  it("a stop that went to the owner (needs-human) never spends from the budget", () => {
    // The skip itself is unit-tested on `createFailedAttemptRecorder`
    // (`lib/state/retry-budget.test.ts`); this pins that main.mts feeds it
    // the owner-road record.
    const defIdx = SRC.indexOf("const recordFailedAttempt = createFailedAttemptRecorder({");
    expect(defIdx).toBeGreaterThan(-1);
    expect(SRC.slice(defIdx, defIdx + 600)).toContain(
      "wentToOwner: (n) => quarantineNeedsYouThisRun.get(n) === true,",
    );
  });
});

describe("final review, BLOCKER I (kept): the sweep's report can never disagree with its write", () => {
  it("the stale batch listing only skips the round trip; what is reported comes from applyRetryDecision's own fresh decision", () => {
    const staleIdx = SRC.indexOf(
      "const staleDecision = decideRetry({ labels: issue.labels, body: issue.body });",
    );
    expect(staleIdx).toBeGreaterThan(-1);
    const applyIdx = SRC.indexOf(
      "const result = await deps.applyRetryDecision?.(issue.number);",
      staleIdx,
    );
    expect(applyIdx).toBeGreaterThan(staleIdx);
    const between = SRC.slice(staleIdx, applyIdx);
    expect(between).not.toContain("requeuedThisRun.push");
    expect(between).not.toContain("waitingThisRun.push");
    const after = SRC.slice(applyIdx, applyIdx + 900);
    expect(after).toContain('if (result.decision.action === "retry") {');
    expect(after).toContain('} else if (result.decision.action === "waiting") {');
  });

  it("gh.ts's applyRetryDecision decides on its OWN fresh body/labels fetch and returns that decision", () => {
    const ghSrc = readFileSync(path.join(import.meta.dirname, "lib/state/gh.ts"), "utf8");
    const fnIdx = ghSrc.indexOf("export async function applyRetryDecision(");
    const body = ghSrc.slice(fnIdx, ghSrc.indexOf("\n}\n", fnIdx));
    expect(body).toContain("await fetchIssueBodyAndLabels(issueNum, run);");
    expect(body).toContain("const decision = decideRetry({ labels, body });");
    expect(body).toContain("return { decision };");
  });
});

describe("spec #1334 SE — one fixed-format log line per ship, stop or crash", () => {
  it("logTicketEvent is defined once and called at every place a ticket's outcome is decided", () => {
    // 3 in settleOutcome (closed-already-built / stopped / crashed) + 1 in
    // logLanded (shipped, at the moment the run lands the ticket) + 2 in
    // settleRejection (generic throw, lease-backend fault) + 1 in
    // reportStopOutsidePipeline. The definition is spelled
    // `logTicketEvent = (`, so it does not count.
    expect(count("const logTicketEvent = (")).toBe(1);
    expect(count("logTicketEvent(")).toBe(7);
    const within = (fnStart: string, n: number): void => {
      const start = SRC.indexOf(fnStart);
      expect(start).toBeGreaterThan(-1);
      const body = SRC.slice(start, SRC.indexOf("\n  };", start));
      expect(body.split("logTicketEvent(").length - 1).toBe(n);
    };
    within("const settleOutcome = async (v: {", 3);
    within("const settleRejection = async (", 2);
    within("const reportStopOutsidePipeline = async (", 1);
    within("const logLanded = (", 1);
  });

  it("production's settleRunPr runs the pre-merge check (deps.verifyLand → the configured landCheck) before it lands, and refuses on a failure", () => {
    const idx = SRC.indexOf("async settleRunPr(branch, change, headSha) {");
    expect(idx).toBeGreaterThan(-1);
    const body = SRC.slice(idx, idx + 1200);
    expect(body).toContain("beforeLand: async (sha) => {");
    expect(body).toContain("const verified = await deps.verifyLand?.(sha);");
    expect(body).toContain("if (verified !== undefined && !verified.ok) throw new Error(verified.why);");
    expect(SRC).toContain("return await verifyLandAt(args.repoRoot, headSha);");
    expect(SRC).toContain('spawn(landCheck[0]!, landCheck.slice(1)');
  });

  it("the shipped line is written where the run LANDS a ticket — after both landing accounting writes, and nowhere else", () => {
    expect(count('logTicketEvent(n, "shipped")')).toBe(1);
    expect(count("logLanded(")).toBe(2);
    expect(SRC).toContain("promoteRes.failed,\n                args.branch,\n              );\n              // The fast-forward landed these on the run branch: NOW they\n              // shipped (even where the GitHub label flip failed after).\n              logLanded(fencedIssueNums);");
    expect(SRC).toContain("logLanded(mergedIssueNums);");
  });

  it("the line goes through deps.log via formatTicketEventLine, never logError", () => {
    const idx = SRC.indexOf("const logTicketEvent = (");
    const body = SRC.slice(idx, SRC.indexOf("\n  };", idx));
    expect(body).toContain("deps.log(");
    expect(body).toContain("formatTicketEventLine({");
    expect(body).not.toContain("logError");
  });
});

describe("issue #1179 review — blocker 3: no ticket ever double-counts across Shipped/Stopped/deferred", () => {
  it("shipped tickets that were later quarantined are pulled OUT of the shipped list and carry an explanatory note", () => {
    expect(SRC).toContain("shippedThenQuarantined");
    expect(SRC).toContain(
      "built successfully but failed to land in the final merge — not actually shipped",
    );
    expect(SRC).toContain("effectiveShipped");
  });

  it("deferred tickets that later shipped or quarantined within the same run drop out of the deferred list", () => {
    expect(SRC).toContain("effectiveDeferred");
    expect(SRC).toContain("!shippedSet.has(n) && !quarantinedSet.has(n)");
  });
});
