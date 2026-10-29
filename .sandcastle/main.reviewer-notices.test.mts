/**
 * The reviewer's per-dispatch notices — the prompt slots that are EMPTY on an
 * ordinary pass and filled only when the reviewer must read the ticket
 * differently.
 *
 * Piece L: "a prompt naming a field is not evidence the field arrives". Each
 * notice is proven the way #911's CHECK_WRITER_* fields were: (1) the REAL
 * prompt file, through the REAL substitution function, and (2) the REAL
 * `runReviewer` dispatch, proven to actually SEND the value.
 *
 * (This file used to hold the rescue road's ship-gate tests too. Spec #1334
 * SG deleted that road — the fixer ships through `shipAfterMigrations`, whose
 * own tests cover the harness, proof gate, protected-path lock and
 * wrong-database fence.)
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { commitInto, git } from "./__fixtures__/git-repo.js";
import { applyPromptArgs } from "./lib/prompt-args.js";
import { reviewSituationNotice } from "./lib/pipeline/review-situation.js";
import { runReviewer } from "./main.mts";

const REVIEW_PROMPT_PATH = new URL("./review-prompt.md", import.meta.url)
  .pathname;

/** A real one-commit repo, a fake sandbox that captures every dispatch, and
 *  the bare ctx `runReviewer` reads. */
function reviewerHarness(issueNumber: number): {
  readonly tip: string;
  readonly sb: unknown;
  readonly ctx: unknown;
  readonly captured: { promptArgs?: Record<string, string> }[];
  readonly cleanup: () => void;
} {
  const repo = mkdtempSync(path.join(tmpdir(), "sandcastle-reviewer-notices-"));
  git(repo, "init", "-q", "-b", "run");
  git(repo, "config", "user.email", "test@test");
  git(repo, "config", "user.name", "test");
  commitInto(repo, { "README.md": "seed\n" }, "init");
  const tip = commitInto(repo, { "x.txt": "x\n" }, "feature");
  const captured: { promptArgs?: Record<string, string> }[] = [];
  return {
    tip,
    captured,
    sb: {
      run: async (spec: { promptArgs?: Record<string, string> }) => {
        captured.push(spec);
        return { stdout: "ALL_CLEAR", iterations: [] };
      },
    },
    ctx: {
      args: { repoRoot: repo, branch: "run", reviewerModel: "stub" },
      ticketOrdinal: 1,
      issueNumber,
      issue: { branch: "run" },
      deps: { log: () => {}, logError: () => {} },
    },
    cleanup: () => rmSync(repo, { recursive: true, force: true }),
  };
}

describe("review-prompt.md's {{REVIEW_SITUATION}} box actually arrives (spec #1334, SG)", () => {
  it("the box is real: the prompt carries the slot, and a filled value renders inside it", () => {
    const raw = readFileSync(REVIEW_PROMPT_PATH, "utf8");
    expect(raw).toContain("<review-situation>\n{{REVIEW_SITUATION}}\n</review-situation>");
    const rendered = applyPromptArgs(raw.replace(/\{\{(?!REVIEW_SITUATION)[A-Z_]+\}\}/g, ""), {
      REVIEW_SITUATION: "SENTINEL-SITUATION",
    });
    expect(rendered).toContain("<review-situation>\nSENTINEL-SITUATION\n</review-situation>");
  });

  it("runReviewer SENDS the notice only on a pass that reviews work no build produced, and an empty value otherwise", async () => {
    const h = reviewerHarness(1334);
    try {
      await runReviewer(h.sb as never, h.ctx as never, h.tip, undefined, undefined, {
        situation: { kind: "resumed-built", evidence: "the saved work is finished" },
      });
      await runReviewer(h.sb as never, h.ctx as never, h.tip, undefined, undefined, {});
      expect(h.captured).toHaveLength(2);
      const notice = h.captured[0]!.promptArgs?.REVIEW_SITUATION ?? "";
      expect(notice).toContain("RESUMED, FINISHED WORK");
      expect(notice).toContain("the saved work is finished");
      expect(h.captured[1]!.promptArgs?.REVIEW_SITUATION).toBe("");
    } finally {
      h.cleanup();
    }
  });

  it("the already-built notice asks the reviewer to confirm or refute, and says what each answer does", () => {
    const notice = reviewSituationNotice({
      kind: "already-built",
      evidence: "deal-total.ts:40 already does this",
      onMain: true,
    });
    expect(notice).toContain("CONFIRM OR REFUTE");
    expect(notice).toContain("closes as done");
    expect(notice).toContain("a builder then builds it");
    expect(notice).toContain("origin/main");
    // A missing certification envelope is expected on this pass, never a finding.
    expect(notice).toContain("NOT a finding");
  });
});

describe("the first-test fall-through notice (#1198 A)", () => {
  it("#1198 A: runReviewer tells the reviewer, in the dispatch itself, when its pass is the ONLY gate the ticket has", async () => {
    // The rest of `review-prompt.md` tells this agent, correctly, that its own
    // run of the check is a pre-flight and the ship-time harness decides. On a
    // fall-through ticket that harness run does not happen. A reviewer that
    // waves something through believing a second instrument will catch it is
    // the one way #1198 A could ship worse code than it means to.
    const repo2 = mkdtempSync(
      path.join(tmpdir(), "sandcastle-first-test-fallthrough-review-"),
    );
    try {
      git(repo2, "init", "-q", "-b", "run");
      git(repo2, "config", "user.email", "test@test");
      git(repo2, "config", "user.name", "test");
      commitInto(repo2, { "README.md": "seed\n" }, "init");
      const tip = commitInto(repo2, { "x.txt": "x\n" }, "feature");

      const captured: { promptArgs?: Record<string, string> }[] = [];
      const sb = {
        run: async (spec: { promptArgs?: Record<string, string> }) => {
          captured.push(spec);
          return { stdout: "ALL_CLEAR", iterations: [] };
        },
      };
      const ctx = {
        args: { repoRoot: repo2, branch: "run", reviewerModel: "stub" },
        ticketOrdinal: 1,
        issueNumber: 1198,
        issue: { branch: "run" },
        deps: { log: () => {}, logError: () => {} },
      };

      await runReviewer(sb as never, ctx as never, tip, undefined, undefined, {
        checkWriterFallThrough: {
          reason: "no-failing-check",
          detail: "the check passed against the unchanged code",
        },
      });
      // EMPTY on an ordinary ticket — same discipline as the verdict-format
      // re-ask. A prompt paragraph that appears every time is one nobody reads.
      await runReviewer(sb as never, ctx as never, tip, undefined, undefined, {});

      const notice = captured[0]!.promptArgs?.CHECK_WRITER_FALL_THROUGH ?? "";
      expect(notice).toContain("YOUR PASS IS THE ONLY");
      // It must name WHICH way the first test failed — "it could never have
      // failed" and "we could not run it" are different things for the
      // reviewer to weigh.
      expect(notice).toContain("passed against the unchanged code");
      // And it must NOT tell the reviewer to raise its bar: a reviewer told to
      // be stricter refuses working code, which is the failure #1198 exists to
      // stop, arriving one stage later having cost a build.
      expect(notice).toContain("Do not raise your bar");
      expect(captured[1]!.promptArgs?.CHECK_WRITER_FALL_THROUGH).toBe("");

      // The rendered prompt has no unfilled placeholder left in it.
      //
      // Spelt as a list rather than as a defaulted render on purpose: a
      // default spread into the args makes the assertion blind to whether
      // `runReviewer` actually sends the key.
      const raw = readFileSync(REVIEW_PROMPT_PATH, "utf8");
      const sent = captured[0]!.promptArgs!;
      // The same pattern `applyPromptArgs` itself looks keys up with
      // (lib/mac-host-sandbox.ts), so a lowercase or digit-bearing
      // placeholder cannot slip past this either.
      const unfilled = [
        ...new Set(
          [...raw.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)].map(
            (m) => m[1]!,
          ),
        ),
      ]
        .filter((key) => !(key in sent))
        .map((key) => `{{${key}}}`);
      expect(unfilled).toEqual([]);
    } finally {
      rmSync(repo2, { recursive: true, force: true });
    }
  });
});

/**
 * Spec #1334 review fix: the ship-time run of the first test only RECORDS a
 * red result and ships the ticket labelled `shipped-without-first-test`, and
 * `stopped:could-not-grade` / `stopped:check-disagreement` stop nothing any
 * more. A reviewer told a later machine run decides would mark the first test
 * N/A on trust and ship untested work, so the prompt must say its pass is the
 * last gate.
 */
describe("review-prompt.md tells the reviewer its pass is the last gate (spec #1334)", () => {
  const raw = readFileSync(REVIEW_PROMPT_PATH, "utf8");

  it("claims no later machine run that decides shipping, and no stop that no longer exists", () => {
    expect(raw).not.toMatch(/PRE-FLIGHT/);
    expect(raw).not.toMatch(/decides whether\s+the ticket ships/);
    expect(raw).not.toContain("stopped:could-not-grade");
    expect(raw).not.toContain("stopped:check-disagreement");
    expect(raw).not.toMatch(/break the tie yourself/);
    expect(raw).not.toMatch(/stops the ticket\s+for a human/);
  });

  it("says the pass is the last gate, a red first test blocks, and unrunnable is not a waiver", () => {
    expect(raw).toContain("**Your pass is the last gate on this ticket.**");
    expect(raw).toContain("A red first test blocks.");
    expect(raw).toContain("**An unrunnable first test is not a waiver.**");
    expect(raw).toMatch(/If the first test itself is wrong[\s\S]{0,400}`GROUNDS: WRONG-CHECK \(reason\)`/);
  });

  it("names the one ship-time road back to the fixer: an edited first test that fails once put back", () => {
    expect(raw).toMatch(
      /`shipped-without-first-test` — except that if the builder edited the first\s+test and the test fails once put back, the ticket goes back to the fixer\./,
    );
  });
});
