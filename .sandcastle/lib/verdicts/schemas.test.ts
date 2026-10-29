import { describe, expect, it } from "vitest";

import type { ImplementerOutput } from "../types.js";
import { ImplementerOutputSchema } from "./schemas.js";

/** A clean, minimal STORY_COMPLETE that runs an e2e check against the host DB. */
function validE2eComplete(
  over: Partial<ImplementerOutput> = {},
): ImplementerOutput {
  return {
    marker: "STORY_COMPLETE",
    storyType: "ui",
    e2eRequired: true,
    e2eActuallyRan: true,
    testCommandUsed: "pnpm --filter @acme/nextjs e2e -- some.spec.ts",
    e2eAssertionLine: "✓ shows the deal (1.2s)",
    outputNotFiltered: true,
    testReachedFeature: true,
    ...over,
  };
}

describe("ImplementerOutputSchema — test-database override guard (#1025)", () => {
  it("accepts a clean command that leaves the host-exported POSTGRES_URL alone", () => {
    expect(ImplementerOutputSchema.safeParse(validE2eComplete()).success).toBe(
      true,
    );
  });

  it("REJECTS a STORY_COMPLETE whose testCommandUsed sets POSTGRES_URL (the #1015 override)", () => {
    const res = ImplementerOutputSchema.safeParse(
      validE2eComplete({
        testCommandUsed:
          'env POSTGRES_URL="$PG_URL" DATABASE_URL="$PG_URL" pnpm --filter @acme/nextjs e2e -- some.spec.ts',
      }),
    );
    expect(res.success).toBe(false);
    if (!res.success) {
      const msg = JSON.stringify(res.error.issues);
      expect(msg).toContain("POSTGRES_URL");
      expect(msg.toLowerCase()).toContain("testcommandused");
    }
  });

  it("REJECTS a testCommandUsed that sets only DATABASE_URL", () => {
    const res = ImplementerOutputSchema.safeParse(
      validE2eComplete({
        testCommandUsed: "DATABASE_URL=postgres://x pnpm e2e",
      }),
    );
    expect(res.success).toBe(false);
  });

  it("does NOT apply the override guard to a HALT (soft fields may be anything)", () => {
    const res = ImplementerOutputSchema.safeParse({
      marker: "HALT",
      haltReason: "could not run",
      storyType: "ui",
      e2eRequired: true,
      e2eActuallyRan: false,
      testCommandUsed: 'POSTGRES_URL="$PG_URL" pnpm e2e',
      e2eAssertionLine: null,
      outputNotFiltered: true,
      testReachedFeature: false,
    });
    // A HALT is the implementer admitting defeat; the override guard is about
    // trusting a GREEN run, so it must not fire here.
    expect(res.success).toBe(true);
  });

  it("carries an optional host-observed database name when present", () => {
    const res = ImplementerOutputSchema.safeParse(
      validE2eComplete({ observedDatabase: "sc_job_agent_issue_1_1_a" }),
    );
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.observedDatabase).toBe("sc_job_agent_issue_1_1_a");
    }
  });

  it("leaves observedDatabase absent when not supplied (host fills it post-parse)", () => {
    const res = ImplementerOutputSchema.safeParse(validE2eComplete());
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.observedDatabase).toBeUndefined();
    }
  });

  it("carries an optional host-decided commitTouchedUi (#871) when present, absent otherwise", () => {
    const withUi = ImplementerOutputSchema.safeParse(
      validE2eComplete({ commitTouchedUi: true }),
    );
    expect(withUi.success).toBe(true);
    if (withUi.success) expect(withUi.data.commitTouchedUi).toBe(true);

    const without = ImplementerOutputSchema.safeParse(validE2eComplete());
    expect(without.success).toBe(true);
    if (without.success) expect(without.data.commitTouchedUi).toBeUndefined();
  });
});
