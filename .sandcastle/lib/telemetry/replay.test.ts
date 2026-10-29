/**
 * $0 END-TO-END REPLAY of the telemetry pipeline.
 *
 * Every unit except the `main.mts` plumbing, wired in the real production
 * order, on realistic session data, in milliseconds and for zero dollars:
 *
 *   fixture JSONL
 *     → extractUsageFromSession   (the real parser, real token magnitudes)
 *     → IssueLedger + CostLedger  (per-issue and per-role accumulation)
 *     → TimingLedger              (wall-clock)
 *     → RunCounters / IssueTelemetryBag
 *     → buildTelemetryPayload     (the derivation under test)
 *     → a REAL createStatusStore writing to a real mkdtemp path
 *     → read the bytes back off disk
 *     → SandcastleStatusSchema.safeParse
 *
 * The last three steps are the point. `z.object` STRIPS unknown keys, so a
 * field a producer writes but the schema does not declare vanishes SILENTLY on
 * the way to every consumer — no error anywhere, just missing data
 * (`schema.ts:312-316`). Asserting on the in-memory payload alone would never
 * catch that. Parsing the bytes that actually landed on disk does.
 *
 * The fixtures carry no prose or conversation content — see
 * `lib/cost/__fixtures__/expected.ts` for the inventory and the typed
 * expected-value constants this file asserts against rather than re-deriving.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MULTI_MODEL_FIXTURE,
  MULTI_MODEL_HAIKU_DATED_COST_AFTER_FIX,
  MULTI_MODEL_SONNET_COST,
  NEVER_PRICED_MODEL,
  SONNET_COST,
  SONNET_FIXTURE,
  SONNET_TOTAL_TOKENS,
  SONNET_USAGE,
} from "../cost/__fixtures__/expected.js";
import { CostLedger } from "../cost/ledger.js";
import { extractUsageFromSession } from "../cost/session-usage.js";
import { TimingLedger } from "../cost/timing.js";
import { createStatusStore } from "../status/store.js";
import { SandcastleStatusSchema } from "../status/schema.js";
import type { RunIdentity, SandcastleStatus } from "../status/schema.js";
import { IssueTelemetryBag, RunCounters } from "./issue-bag.js";
import { IssueLedger } from "./issue-ledger.js";
import { buildTelemetryPayload } from "./payload.js";

const IDENTITY: RunIdentity = {
  profile: "budget",
  backend: "claude",
  roleModels: {
    implementer: {
      default: "claude-sonnet-5",
      escalations: ["claude-opus-4-5"],
    },
  },
  promptHashes: { "implement-prompt.md": "abc1234" },
};

/** The issue that shipped on the second implementer pass. */
const SHIPPED = 412;
/** The issue quarantined before any session resolved — bag data, no cost. */
const QUARANTINED = 77;
/**
 * A real, deliberately-unsorted path list for #412's diff, used to prove the
 * whole list — order and contents — survives bag → payload → disk → parse
 * intact, not just the `changedFiles` count.
 */
const SHIPPED_CHANGED_FILE_PATHS = [
  "packages/api/src/router/deal.ts",
  "apps/web/app/deal/page.tsx",
  "packages/db/src/schema.ts",
];
/**
 * Priced dollars in the reviewer's multi-model fixture: sonnet PLUS the dated
 * haiku id, which `pricing.ts` gained a rate row for. `zzz-not-a-model` is and
 * stays unpriced, so it contributes tokens but no dollars.
 */
const REVIEWER_COST =
  MULTI_MODEL_SONNET_COST + MULTI_MODEL_HAIKU_DATED_COST_AFTER_FIX;

describe("telemetry replay (end-to-end, $0)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sandcastle-replay-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Drive the whole pipeline exactly as a run would, then return the snapshot
   * as it was PARSED BACK off disk.
   */
  function replay(): {
    parsed: ReturnType<typeof SandcastleStatusSchema.safeParse>;
    status: SandcastleStatus;
    raw: Record<string, unknown>;
  } {
    const costLedger = new CostLedger();
    const issueLedger = new IssueLedger();
    const timingLedger = new TimingLedger();
    const runCounters = new RunCounters();
    const bags = new Map<number, IssueTelemetryBag>();

    // ── Issue #412: implementer first pass, reviewer blockers, retry, ships ──
    const shippedBag = new IssueTelemetryBag();
    bags.set(SHIPPED, shippedBag);

    // Implementer attempt 1 — a real fixture session.
    const pass1 = extractUsageFromSession(SONNET_FIXTURE);
    shippedBag.noteImplementerAttempt(1); // ORDINAL, not a retry event
    costLedger.add("implementer", pass1);
    issueLedger.addCost(SHIPPED, "implementer", pass1);
    issueLedger.addTiming(SHIPPED, "implementer", 90_000);
    timingLedger.add("implementer", 90_000);

    // Reviewer comes back with blockers.
    const review = extractUsageFromSession(MULTI_MODEL_FIXTURE);
    costLedger.add("reviewer", review);
    issueLedger.addCost(SHIPPED, "reviewer", review);
    issueLedger.addTiming(SHIPPED, "reviewer", 20_000);
    timingLedger.add("reviewer", 20_000);
    shippedBag.noteReviewerBlockers();
    runCounters.bump("reviewerBlockers");

    // Implementer attempt 2 — the RETRY. Ordinal on the bag, event on the run.
    const pass2 = extractUsageFromSession(SONNET_FIXTURE);
    shippedBag.noteImplementerAttempt(2);
    runCounters.bump("implementerRetries");
    costLedger.add("implementer", pass2);
    issueLedger.addCost(SHIPPED, "implementer", pass2);
    issueLedger.addTiming(SHIPPED, "implementer", 60_000);
    timingLedger.add("implementer", 60_000);

    shippedBag.noteDiff(240, 6, SHIPPED_CHANGED_FILE_PATHS);
    shippedBag.noteShipPath("implementer-retry");
    shippedBag.noteOutcome("ok");

    // ── Issue #77: quarantined with NO resolvable session (bag-only row) ──
    const quarantinedBag = new IssueTelemetryBag();
    bags.set(QUARANTINED, quarantinedBag);
    quarantinedBag.noteQuarantine("no verdict marker");
    // `noteQuarantine` deliberately does NOT set the outcome — both are needed.
    quarantinedBag.noteOutcome("quarantined");
    // Counts WITHOUT a path list — the third `noteDiff` argument is omitted,
    // not an empty array. Proves `changedFilePaths` stays ABSENT rather than
    // being serialised as `null` or `[]` when a caller never measured paths.
    quarantinedBag.noteDiff(10, 2);
    runCounters.bump("quarantines");
    runCounters.noteErrorClass({ noVerdict: true });

    // ── Batch roles: overhead, never charged to a ticket ──
    costLedger.add("planner", extractUsageFromSession(SONNET_FIXTURE));
    timingLedger.add("planner", 15_000);
    runCounters.noteSkillMiss("postMergeFixer", 2);

    // ── Assemble + persist through the REAL store ──
    const store = createStatusStore(
      {
        branch: "feat/replay",
        repo: "my-project",
        repoRoot: dir,
        startedAt: new Date().toISOString(),
        iterationsTotal: 1,
        maxConcurrent: 1,
        hostId: "host-a",
        runId: "run-1",
      },
      {
        path: join(dir, "status.json"),
        onError: (err) => {
          throw err; // a silent write failure would make this test assert nothing
        },
      },
    );
    // Identity is written EARLY in a real run; counters land at the end. The
    // two must merge into one object rather than clobbering each other.
    store.recordRunIdentity(IDENTITY);
    // The run total, so the reconciliation assertion below has a real left
    // side rather than an absent field that makes it vacuous.
    store.recordCost(costLedger.summary().totalCostUsd);

    const bagRows = new Map(
      [...bags].map(([issue, bag]) => [issue, bag.toRow()] as const),
    );
    const payload = buildTelemetryPayload({
      costSummary: costLedger.summary(),
      issueRows: issueLedger.rows(),
      issueBagRows: bagRows,
      runCounters: runCounters.toRunTelemetry(),
      runIdentity: IDENTITY,
    });
    if (payload.issueTelemetry !== undefined) {
      store.recordIssueTelemetry(payload.issueTelemetry);
    }
    if (payload.runTelemetry !== undefined) {
      store.recordRunTelemetry(payload.runTelemetry);
    }

    const raw = JSON.parse(
      readFileSync(join(dir, "status.json"), "utf8"),
    ) as Record<string, unknown>;
    const parsed = SandcastleStatusSchema.safeParse(raw);
    return { parsed, status: parsed.success ? parsed.data : ({} as never), raw };
  }

  it("round-trips through disk and parses cleanly", () => {
    const { parsed } = replay();
    expect(parsed.error?.issues).toBeUndefined();
    expect(parsed.success).toBe(true);
  });

  it("does NOT bump the schema version", () => {
    expect(replay().raw.schemaVersion).toBe(3);
  });

  describe("issueTelemetry", () => {
    it("emits one row per issue, ascending, including the bag-only one", () => {
      const { status } = replay();
      expect(status.issueTelemetry!.map((r) => r.issue)).toEqual([
        QUARANTINED,
        SHIPPED,
      ]);
    });

    it("attributes both implementer passes and the review to #412", () => {
      const { status } = replay();
      const row = status.issueTelemetry!.find((r) => r.issue === SHIPPED)!;
      // Two sonnet fixture sessions + the multi-model reviewer session.
      expect(row.costUsd).toBeCloseTo(SONNET_COST * 2 + REVIEWER_COST, 6);
      expect(row.wallMs).toBe(170_000);
      expect(row.tokens.input).toBe(SONNET_USAGE.inputTokens * 2 + 18);
      expect(row.perRole!.implementer).toEqual({
        costUsd: SONNET_COST * 2,
        tokens: {
          input: SONNET_USAGE.inputTokens * 2,
          output: SONNET_USAGE.outputTokens * 2,
          cacheWrite: SONNET_USAGE.cacheCreationInputTokens * 2,
          cacheRead: SONNET_USAGE.cacheReadInputTokens * 2,
        },
        wallMs: 150_000,
        runs: 2,
      });
    });

    it("carries the bag's counters onto the same row as the ledger's spine", () => {
      const { status } = replay();
      const row = status.issueTelemetry!.find((r) => r.issue === SHIPPED)!;
      expect(row.implementerAttempts).toBe(2);
      expect(row.reviewerBlockers).toBe(1);
      expect(row.changedLines).toBe(240);
      expect(row.changedFiles).toBe(6);
      expect(row.shipPath).toBe("implementer-retry");
      expect(row.outcome).toBe("ok");
    });

    it("round-trips changedFilePaths through disk, in order, with exact contents", () => {
      // Asserted off the PARSED, POST-DISK status — not `bag.toRow()` — because
      // the point of this harness is the plumbing between the bag and the
      // file. A unit test on the bag already proves the bag itself is right;
      // this proves the schema and the store actually carry the field across.
      const { status } = replay();
      const row = status.issueTelemetry!.find((r) => r.issue === SHIPPED)!;
      expect(row.changedFilePaths).toEqual(SHIPPED_CHANGED_FILE_PATHS);
    });

    it("keeps changedFilePaths ABSENT from the written JSON when no paths were measured", () => {
      // #77 has counts (changedLines/changedFiles) but never had noteDiff's
      // third argument supplied. ABSENT ≠ ZERO is load-bearing here: JSON has
      // no `undefined`, so a naive producer could easily serialise the missing
      // list as `null` instead of omitting the key entirely. Check the RAW
      // parsed JSON, not the zod-parsed `status` object, because `z.object`
      // would make an absent key and an explicit `null` both read as
      // `undefined` after parsing — only the raw bytes can tell them apart.
      const { raw, status } = replay();
      const rawRows = raw.issueTelemetry as Array<Record<string, unknown>>;
      const rawQuarantined = rawRows.find((r) => r.issue === QUARANTINED)!;
      expect(rawQuarantined.changedLines).toBe(10);
      expect(rawQuarantined.changedFiles).toBe(2);
      expect("changedFilePaths" in rawQuarantined).toBe(false);

      const row = status.issueTelemetry!.find((r) => r.issue === QUARANTINED)!;
      expect(row.changedFilePaths).toBeUndefined();
    });

    it("keeps the quarantined issue despite it having no cost data at all", () => {
      const { status } = replay();
      const row = status.issueTelemetry!.find((r) => r.issue === QUARANTINED)!;
      expect(row.quarantined).toBe(true);
      expect(row.outcome).toBe("quarantined");
      expect(row.costUsd).toBeNull();
      expect(row.wallMs).toBe(0);
    });

    it("charges NO batch role to any issue", () => {
      const { status } = replay();
      for (const row of status.issueTelemetry!) {
        for (const role of Object.keys(row.perRole ?? {})) {
          expect([
            "implementer",
            "reviewer",
            "critique",
            "recovery",
          ]).toContain(role);
        }
      }
    });
  });

  describe("runTelemetry", () => {
    it("preserves the EARLY identity write alongside the LATE counter write", () => {
      // The two land at different times into the same object; a replacing
      // write in either order would silently drop the other's work.
      const { status } = replay();
      expect(status.runTelemetry!.identity).toEqual(IDENTITY);
      expect(status.runTelemetry!.counters).toEqual({
        reviewerBlockers: 1,
        implementerRetries: 1,
        quarantines: 1,
        skillDisciplineMisses: { postMergeFixer: 2 },
      });
    });

    it("counts ONE retry for two implementer attempts", () => {
      // The headline number: retries = attempts − 1. Counting the first pass
      // as a retry would invert "33% needed a second pass" into nonsense.
      const { status } = replay();
      expect(status.runTelemetry!.counters!.implementerRetries).toBe(1);
      const row = status.issueTelemetry!.find((r) => r.issue === SHIPPED)!;
      expect(row.implementerAttempts).toBe(2);
    });

    it("buckets the error class", () => {
      expect(replay().status.runTelemetry!.errorClasses).toEqual({
        noVerdict: 1,
      });
    });

    it("reports the batch-role spend as overhead, not as issue cost", () => {
      const { status } = replay();
      expect(status.runTelemetry!.overheadCostUsd).toBeCloseTo(SONNET_COST, 6);
      const issueTotal = status
        .issueTelemetry!.map((r) => r.costUsd ?? 0)
        .reduce((a, b) => a + b, 0);
      // The reconciliation the split exists to make possible:
      // sum(issueTelemetry[].costUsd) + overheadCostUsd === the run total.
      // The unpriced model in the reviewer fixture is excluded from BOTH sides.
      expect(status.totals.totalCostUsd).toBeDefined();
      expect(issueTotal + status.runTelemetry!.overheadCostUsd!).toBeCloseTo(
        status.totals.totalCostUsd!,
        6,
      );
    });

    it("keeps the 4-way token split unflattened, with a real cache-hit ratio", () => {
      const { status } = replay();
      const eff = status.runTelemetry!.tokenEfficiency!.implementer!;
      expect(eff.input).toBe(SONNET_USAGE.inputTokens * 2);
      expect(eff.cacheWrite).toBe(SONNET_USAGE.cacheCreationInputTokens * 2);
      expect(eff.cacheRead).toBe(SONNET_USAGE.cacheReadInputTokens * 2);
      // cacheRead / (input + cacheWrite + cacheRead) — output excluded.
      expect(eff.cacheHitRatio).toBeCloseTo(
        (SONNET_USAGE.cacheReadInputTokens * 2) /
          (SONNET_USAGE.inputTokens * 2 +
            SONNET_USAGE.cacheCreationInputTokens * 2 +
            SONNET_USAGE.cacheReadInputTokens * 2),
        9,
      );
    });

    it("covers batch roles in tokenEfficiency (that rule is per-issue only)", () => {
      expect(
        replay().status.runTelemetry!.tokenEfficiency!.planner,
      ).toBeDefined();
    });

    it("never emits NaN, which would fail the whole snapshot parse", () => {
      const { raw } = replay();
      expect(JSON.stringify(raw)).not.toContain("NaN");
    });
  });

  describe("the unpriced model stays null, never 0", () => {
    it("keeps the reviewer's unpriced slice out of the dollar total", () => {
      const { status } = replay();
      const row = status.issueTelemetry!.find((r) => r.issue === SHIPPED)!;
      // `zzz-not-a-model` contributed tokens but no dollars.
      expect(row.perRole!.reviewer!.costUsd).toBeCloseTo(REVIEWER_COST, 6);
      expect(row.perRole!.reviewer!.tokens!.input).toBe(18);
    });

    it("still counts the unpriced model's TOKENS", () => {
      const { status } = replay();
      const eff = status.runTelemetry!.tokenEfficiency!.reviewer!;
      // 12 + 5 + 1 across the three models in the multi-model fixture.
      expect(eff.input).toBe(18);
      expect(NEVER_PRICED_MODEL).toBe("zzz-not-a-model");
    });
  });

  it("sanity-checks the fixture constants it leans on", () => {
    const entries = extractUsageFromSession(SONNET_FIXTURE);
    expect(entries).toEqual([{ model: "claude-sonnet-5", usage: SONNET_USAGE }]);
    expect(
      SONNET_USAGE.inputTokens +
        SONNET_USAGE.outputTokens +
        SONNET_USAGE.cacheCreationInputTokens +
        SONNET_USAGE.cacheReadInputTokens,
    ).toBe(SONNET_TOTAL_TOKENS);
  });
});
