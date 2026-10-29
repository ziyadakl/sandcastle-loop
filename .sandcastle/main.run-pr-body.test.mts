/**
 * tokenmaxxing#29: the run PR body follows Matt Pocock's `pr` skill —
 * Summary, Evidence, Merge Danger (door and blast radius) — and keeps the
 * loop's own bookkeeping (the `Closes #N` lines, warnings, the run report)
 * below those three sections.
 */
import { describe, expect, it } from "vitest";

import { classifyChange } from "./lib/state/merge-rule.js";
import type { ChangedFile } from "./lib/state/merge-rule.js";
import { buildRunPrBody } from "./main.mts";

const files: ChangedFile[] = [{ path: "apps/nextjs/src/app/page.tsx", status: "M", additions: 12, deletions: 3 }];
const facts = { files, issueCount: 2, promotionFailed: false, breakerTripped: false, previouslyShippedCount: 0, migrationSql: new Map<string, string>() };

describe("buildRunPrBody", () => {
  it("leads with the pr skill's three sections, in order, then the Closes lines", () => {
    const body = buildRunPrBody({
      branch: "sandcastle/run-1",
      shippedIssueNums: [11, 12],
      files,
      change: classifyChange(facts),
    });

    const summary = body.indexOf("## Summary");
    const evidence = body.indexOf("## Evidence");
    const danger = body.indexOf("## Merge Danger");
    const closes = body.indexOf("Closes #11\nCloses #12");
    expect(summary).toBe(0);
    expect(evidence).toBeGreaterThan(summary);
    expect(danger).toBeGreaterThan(evidence);
    expect(closes).toBeGreaterThan(danger);

    expect(body).toContain("Autonomous run `sandcastle/run-1`: 2 issue(s) certified by the loop.");
    expect(body).toContain("  apps/nextjs/src/app/page.tsx  (+12 -3)");
    expect(body).toContain("<!-- sandcastle:merge-rule:start -->\n## Merge Danger");
    expect(body).toContain("**Door:** two-way");
    expect(body).toContain("**Blast Radius:** small");
    expect(body).toContain("**Merge rule:** the loop merges this itself once every check is green.");
  });

  it("says up front when the change waits for Alex", () => {
    const body = buildRunPrBody({
      branch: "sandcastle/run-1",
      shippedIssueNums: [11],
      files: [{ path: "packages/db/migrations/0142_x.sql", status: "A", additions: 4, deletions: 0 }],
      change: classifyChange({
        ...facts,
        files: [{ path: "packages/db/migrations/0142_x.sql", status: "A", additions: 4, deletions: 0 }],
        migrationSql: new Map([["packages/db/migrations/0142_x.sql", "ALTER TABLE deals DROP COLUMN wall;"]]),
      }),
    });
    expect(body).toContain("**Door:** one-way");
    expect(body).toContain(
      "**Merge rule:** waits for Alex (one-way door: deletes or rewrites existing data (packages/db/migrations/0142_x.sql: drops the column deals.wall)",
    );
  });

  it("keeps the breaker and promotion warnings and the previously-shipped list", () => {
    const body = buildRunPrBody({
      branch: "b",
      shippedIssueNums: [1],
      files,
      change: classifyChange({ ...facts, promotionFailed: true }),
      opts: {
        promotionFailed: true,
        breakerTrip: "3 consecutive quarantine(s) ≥ limit 3",
        previouslyShipped: [{ number: 900, title: "stranded" }],
      },
    });
    expect(body).toContain("CUT SHORT by the circuit breaker");
    expect(body).toContain("A final promotion FAILED during this run.");
    expect(body).toContain("- #900 stranded");
  });

  it("without a readable diff, still writes the sections and leaves the merge to Alex", () => {
    const body = buildRunPrBody({ branch: "b", shippedIssueNums: [1], files: undefined, change: undefined });
    expect(body).toContain("## Summary");
    expect(body).toContain("## Merge Danger");
    expect(body).toContain("**Merge rule:** waits for Alex (the loop could not read this branch's diff).");
  });
});
