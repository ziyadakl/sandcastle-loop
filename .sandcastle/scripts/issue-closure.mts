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

import { getIssueClosure, parseSupersededBy } from "../lib/state/gh.js";

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
