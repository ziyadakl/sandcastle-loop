#!/usr/bin/env tsx

/**
 * Issue-closure probe for the completion skill (Stage 4 adjudication). Given an
 * issue number it prints whether the close is PROVEN (`COMPLETED`) or UNPROVEN
 * (any other reason — `NOT_PLANNED`, `DUPLICATE`, …), and on a "superseded by
 * #N" close it lists the successor issue(s) whose landing must be verified by
 * content on main. This is the runnable primitive the completion agent invokes
 * instead of hand-running `gh issue view` — the enforced counterpart to the
 * prose in `skills/sandcastle-complete/SKILL.md`.
 *
 * Thin by design: all logic lives in ../lib/state/gh.ts (`getIssueClosure` +
 * `parseSupersededBy`), tested there. Mirrors scan-ops-config.mts.
 *   `tsx .sandcastle/scripts/issue-closure.mts <issueNumber>`
 */

import {
  fetchIssueLabels,
  getIssueClosure,
  parseSupersededBy,
} from "../lib/state/gh.js";

function fail(msg: string): never {
  console.error(`sandcastle:issue-closure: ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const [arg] = process.argv.slice(2);
  const issueNum = Number(arg);
  if (!Number.isInteger(issueNum) || issueNum <= 0) {
    fail(`usage: issue-closure.mts <issueNumber> (got '${arg ?? ""}')`);
  }

  const { state, stateReason, closeText } = await getIssueClosure(issueNum);

  if (state !== "closed") {
    // Since 2026-07-30 an OPEN issue carrying `shipped-local` is the NORMAL
    // end state of a loop run, not an anomaly: the loop stops there and the
    // run PR's `Closes #N` closes the issue when a human merges it. So "open"
    // here is a real answer, not a missing one.
    const labels = await fetchIssueLabels(issueNum).catch(() => [] as string[]);
    if (labels.includes("shipped-local")) {
      console.log(
        `#${issueNum}: OPEN + shipped-local — certified by the loop, on a run ` +
          `branch, NOT yet on main. Nothing to adjudicate: merging the run PR ` +
          `closes it. If no run PR exists, that is the thing to chase.`,
      );
      return;
    }
    console.log(`#${issueNum}: OPEN — not closed, nothing to adjudicate.`);
    return;
  }
  if (stateReason === "COMPLETED") {
    console.log(
      `#${issueNum}: closed COMPLETED — still verify the feature is present on main by content (Rule 3).`,
    );
    return;
  }

  const reason = stateReason ?? "(no reason)";
  const lines = [
    `#${issueNum}: closed ${reason} — UNPROVEN. A non-COMPLETED close is not evidence of ship.`,
  ];
  const successors = parseSupersededBy(closeText);
  if (successors.length > 0) {
    lines.push(
      `  superseded-by: ${successors
        .map((n) => `#${n}`)
        .join(", ")} — follow the chain: prove each successor's behaviour landed on main by content before treating this scope as shipped.`,
    );
  } else {
    lines.push(
      `  no "superseded by #N" successor named — treat as needs-salvage/dead unless content on main proves the behaviour shipped.`,
    );
  }
  console.log(lines.join("\n"));
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
