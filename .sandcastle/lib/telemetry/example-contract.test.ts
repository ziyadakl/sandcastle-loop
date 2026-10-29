/**
 * The committed fixture defends itself.
 *
 * `__fixtures__/telemetry-status.example.json` is what a status reader is
 * mission-control engineer builds their reader against before any real data
 * exists. It was originally verified by a THROWAWAY script that was never
 * committed and that re-typed the `cacheHitRatio` formula by hand — so it
 * encoded `cacheRead / (cacheRead + input)` while the producer computes
 * `cacheRead / (input + cacheWrite + cacheRead)`, and all seven non-null values
 * shipped wrong. Nothing could catch it, because the only checker was deleted.
 *
 * This file is that script, committed and permanent. The load-bearing rule:
 * every derived number is checked against the REAL producer imported from
 * `issue-ledger.js`. A re-typed formula here would reproduce the exact bug it
 * exists to prevent.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { SandcastleStatusSchema } from "../status/schema.js";
import { cacheHitRatio, zeroSplit } from "./issue-ledger.js";

// Resolved against this module, NOT the cwd:
// vitest can be invoked from either root.
const FIXTURE_URL = new URL(
  "../../__fixtures__/telemetry-status.example.json",
  import.meta.url,
);
const raw: unknown = JSON.parse(readFileSync(FIXTURE_URL, "utf8"));

describe("the committed status fixture", () => {
  it("parses, and round-trips without a single key being stripped", () => {
    const parsed = SandcastleStatusSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    // `.success` alone is NOT enough: `z.object` STRIPS unknown keys and still
    // succeeds, so a misspelled optional field would vanish silently. Strict
    // deep equality against the raw file is what proves nothing was dropped
    // and no default was injected.
    expect(parsed.success && parsed.data).toStrictEqual(raw);
  });

  it("computes every cacheHitRatio with the real producer", () => {
    const status = SandcastleStatusSchema.parse(raw);
    const efficiency = status.runTelemetry?.tokenEfficiency;
    expect(efficiency).toBeDefined();
    for (const [role, split] of Object.entries(efficiency ?? {})) {
      // `cacheHitRatio(split)` — the producer itself. Never a re-typed formula.
      expect({ role, ratio: split.cacheHitRatio }).toEqual({
        role,
        ratio: cacheHitRatio(split),
      });
    }
  });

  it("reconciles Σ priced issue cost + overhead to the run total", () => {
    const status = SandcastleStatusSchema.parse(raw);
    const rows = status.issueTelemetry ?? [];
    expect(rows.length).toBeGreaterThan(0);
    // Null-aware: a `null` row means "every model unpriced", never 0, so it is
    // EXCLUDED rather than summed — the same rule `ledger.ts` follows.
    const issueCost = rows.reduce(
      (sum, row) => (row.costUsd === null ? sum : sum + row.costUsd),
      0,
    );
    const overhead = status.runTelemetry?.overheadCostUsd;
    expect(typeof overhead).toBe("number");
    expect(issueCost + (overhead ?? 0)).toBe(status.totals.totalCostUsd);
  });

  it("makes each row's tokens the sum of its perRole splits", () => {
    const status = SandcastleStatusSchema.parse(raw);
    for (const row of status.issueTelemetry ?? []) {
      const summed = zeroSplit();
      for (const role of Object.values(row.perRole ?? {})) {
        if (role.tokens === undefined) continue;
        summed.input += role.tokens.input;
        summed.output += role.tokens.output;
        summed.cacheWrite += role.tokens.cacheWrite;
        summed.cacheRead += role.tokens.cacheRead;
      }
      expect({ issue: row.issue, tokens: row.tokens }).toEqual({
        issue: row.issue,
        tokens: summed,
      });
    }
  });
});
