/**
 * The reviewer's final word — issue #1082 fault 4, built under issue #1128.
 *
 * WHAT BROKE. On 2026-08-15 ticket #1038 was stopped with `[issue=1038] round-3
 * grant denied: sweep1 unparsable`, preceded by `ERROR: reviewer (issue=1038)
 * emitted no verdict`. The reviewer had APPROVED the work, in words, using the
 * exact approval token — it just wrote the token into a sentence instead of
 * onto a line of its own. `extractMarker` skipped the two trailing sign-off
 * lines correctly, landed on the sentence, and refused it.
 *
 * That refusal is correct and is pinned here. `lib/verdicts/parse.ts:104-109`
 * states why: the upward walk stops at the first line that is neither blank nor
 * a sign-off, because walking further — or scanning the body — would let "I
 * considered ALL_CLEAR but…" stand in for a verdict nobody gave. That direction
 * fails OPEN, and issue #1082 names the open direction as an immediate launch
 * gate. So the parser is left exactly as strict as it was, and the FIX is at
 * the call site: `runReviewer` re-asks ONCE, carrying an explicit instruction
 * to put the bare token alone on the final line.
 *
 * Three things are proven, and only the first was true before this change:
 *   1. The verbatim #1038 reply still fails extraction (the walk was NOT
 *      widened, and no marker is dug out of the body).
 *   2. The re-ask actually CARRIES the instruction — the first dispatch sends
 *      an empty reminder, the second a real one naming the failing shape.
 *   3. It is bounded to one re-ask: two dispatches, never a third round.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { commitInto, git } from "./__fixtures__/git-repo.js";
import { applyPromptArgs } from "./lib/prompt-args.js";
import { MarkerNotFoundError, extractMarker } from "./lib/verdicts/index.js";
import { runReviewer } from "./main.mts";

const REVIEW_PROMPT_PATH = new URL("./review-prompt.md", import.meta.url)
  .pathname;

/**
 * The reply that stopped ticket #1038, verbatim from `/tmp/sandcastle-vps.log`
 * on the server, as quoted in issue #1082.
 */
const ISSUE_1038_REPLY = [
  "The last leftover waiter finishing. The review stands as delivered, with the verdict ALL_CLEAR.",
  "",
  "Unverified: nothing.",
  "Skipped: nothing.",
].join("\n");

let repo: string;
let tip: string;

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), "sandcastle-reviewer-reask-"));
  git(repo, "init", "-q", "-b", "run");
  git(repo, "config", "user.email", "test@test");
  git(repo, "config", "user.name", "test");
  commitInto(repo, { "README.md": "seed\n" }, "init");
  tip = commitInto(repo, { "x.txt": "x\n" }, "feature");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

/** A sandbox stub that replays `replies` in order and records every dispatch. */
function stubSandbox(replies: readonly string[]) {
  const captured: { promptArgs?: Record<string, string> }[] = [];
  const sb = {
    run: async (spec: { promptArgs?: Record<string, string> }) => {
      captured.push(spec);
      const reply = replies[captured.length - 1] ?? replies.at(-1) ?? "";
      return { stdout: reply, iterations: [] };
    },
  };
  return { sb, captured };
}

function stubCtx(logged: string[]) {
  return {
    args: { repoRoot: repo, branch: "run", reviewerModel: "stub" },
    ticketOrdinal: 1,
    issueNumber: 1038,
    issue: { branch: "run" },
    deps: {
      log: () => {},
      logError: (m: string) => {
        logged.push(m);
      },
    },
  };
}

describe("the #1038 reply is still refused by the parser (do NOT widen the walk)", () => {
  it("throws MarkerNotFoundError, and blames the sentence rather than the sign-off", () => {
    let thrown: unknown;
    try {
      extractMarker(ISSUE_1038_REPLY, ["ALL_CLEAR", "HAS_BLOCKERS"] as const);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MarkerNotFoundError);
    // The two sign-off lines ARE skipped — the walk lands on the prose line,
    // which is the line a failure must blame.
    expect((thrown as MarkerNotFoundError).lastLine).toContain(
      "The review stands as delivered",
    );
  });

  it("does not dig the token out of the body of a hedged reply", () => {
    // The repair this change deliberately did NOT make. If the body were
    // scanned, this would read as an approval — a check reporting green when
    // it should report red.
    const hedged = [
      "I considered ALL_CLEAR but the 500 leak stands.",
      "",
      "The verdict is being withheld.",
    ].join("\n");
    expect(() =>
      extractMarker(hedged, ["ALL_CLEAR", "HAS_BLOCKERS"] as const),
    ).toThrow(MarkerNotFoundError);
  });
});

describe("review-prompt.md tells the reviewer the failing shape", () => {
  const baseArgs: Record<string, string> = {
    ITERATION: "1",
    ISSUE_NUMBER: "1038",
    ISSUE_SPEC: "# the ticket text, read on the host",
    COMMIT_SHA: "deadbeef",
    REVIEW_BASE: "main",
    BRANCH: "run",
    IMPLEMENTER_REBUTTAL: "",
    SKILLS_INVOKED: "(none invoked)",
    IMPLEMENTER_CERTIFICATION: "(no certification)",
    CHECK_WRITER_CHECK_PATH: "",
    CHECK_WRITER_CHECK_COMMAND: "",
    CHECK_WRITER_SCREEN: "",
    CHECK_WRITER_FALL_THROUGH: "",
    REVIEW_SITUATION: "",
    VERDICT_FORMAT_REMINDER: "",
  };

  it("carries the exact shape that failed, marked as what NOT to do", () => {
    const rendered = applyPromptArgs(readFileSync(REVIEW_PROMPT_PATH, "utf8"), {
      ...baseArgs,
    });
    expect(rendered).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(rendered).toContain("with the verdict ALL_CLEAR.");
    expect(rendered).toContain("Do NOT end like this");
  });

  it("has a substitution point for the re-ask instruction", () => {
    const raw = readFileSync(REVIEW_PROMPT_PATH, "utf8");
    expect(raw).toContain("{{VERDICT_FORMAT_REMINDER}}");
    // Proves the placeholder is real rather than decorative: omit its value and
    // substitution throws instead of silently rendering blank.
    const withoutReminder = { ...baseArgs };
    delete withoutReminder.VERDICT_FORMAT_REMINDER;
    expect(() => applyPromptArgs(raw, withoutReminder)).toThrow(
      /VERDICT_FORMAT_REMINDER.*has no matching value/,
    );
  });
});

describe("runReviewer re-asks once, with the instruction (issue #1128)", () => {
  it("recovers the verdict the #1038 reviewer actually gave", async () => {
    const logged: string[] = [];
    const { sb, captured } = stubSandbox([ISSUE_1038_REPLY, "ALL_CLEAR"]);
    const result = await runReviewer(
      sb as never,
      stubCtx(logged) as never,
      tip,
      undefined,
      undefined,
      {},
    );

    expect(result.marker).toBe("ALL_CLEAR");
    // Exactly two dispatches — the review, then the format re-ask.
    expect(captured).toHaveLength(2);
    // The FIRST pass must not nag a reviewer that has done nothing wrong yet.
    expect(captured[0]!.promptArgs?.VERDICT_FORMAT_REMINDER).toBe("");
    // The SECOND carries the instruction, and names the shape that failed.
    const reminder = captured[1]!.promptArgs?.VERDICT_FORMAT_REMINDER ?? "";
    expect(reminder).toContain("with the verdict ALL_CLEAR.");
    // It must ask for a REAL review: every run is a fresh session
    // (`lib/mac-host-sandbox.ts:335`), so it can neither claim prior memory nor
    // skip the CATEGORY SWEEP the ticket is withheld without.
    expect(reminder).toContain("CATEGORY SWEEP");
    expect(reminder).toContain("in full");
    expect(reminder).not.toContain("Do NOT review it");
    expect(reminder).not.toContain("do NOT re-run any check");
    expect(reminder).not.toContain("SAME verdict you already reached");
    expect(reminder.length).toBeGreaterThan(0);
    // And it is visible in the log as a re-ask, not as a silent retry.
    expect(logged.join("\n")).toContain("bare token alone on the final line");
  });

  it("is bounded to ONE re-ask — a second unreadable reply throws", async () => {
    const logged: string[] = [];
    const { sb, captured } = stubSandbox([ISSUE_1038_REPLY, ISSUE_1038_REPLY]);
    await expect(
      runReviewer(sb as never, stubCtx(logged) as never, tip, undefined, undefined, {}),
    ).rejects.toBeInstanceOf(MarkerNotFoundError);
    // Two dispatches, never a third review round.
    expect(captured).toHaveLength(2);
  });

  it("does not re-ask at all when the verdict is readable", async () => {
    const logged: string[] = [];
    const { sb, captured } = stubSandbox([
      ["Findings: none.", "", "ALL_CLEAR", "", "Unverified: nothing."].join(
        "\n",
      ),
    ]);
    const result = await runReviewer(
      sb as never,
      stubCtx(logged) as never,
      tip,
      undefined,
      undefined,
      {},
    );
    expect(result.marker).toBe("ALL_CLEAR");
    expect(captured).toHaveLength(1);
  });
});
