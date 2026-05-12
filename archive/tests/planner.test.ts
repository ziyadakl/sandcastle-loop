/**
 * Planner unit tests. We mock `sandbox.run()` and assert:
 *
 *   1. With three priority-mixed, dependency-free issues, the planner returns
 *      the agent's priority-ordered list (high > medium > low, oldest within
 *      bucket) without modification.
 *   2. When an issue body says "Blocked by: #5", the dependencies map
 *      records it.
 *   3. When an issue body uses the synonym "Depends on #5", the planner
 *      still recognizes it. The differentiator vs. regex is in the PROMPT,
 *      so we additionally assert the prompt instructs the agent to recognize
 *      synonyms.
 *   4. Empty input returns { priorityOrder: [], dependencies: [] }.
 *   5. Malformed JSON inside <plan> throws PlannerError.
 *
 * Note on mocking: we don't mock @ai-hero/sandcastle's claudeCode (it's
 * harmless — just a factory that returns an agent provider object). We DO
 * stub sandbox.run() so the test never actually spins up Docker.
 */

import { describe, it, expect, vi } from "vitest";
import type {
  Sandbox,
  SandboxRunOptions,
  SandboxRunResult,
} from "@ai-hero/sandcastle";

import {
  runPlanner,
  buildPlannerPrompt,
  PlannerError,
  type PlannerInput,
  type PlannerOutput,
} from "../planner/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wrap a raw assistant-text payload (typically containing a <plan> block) in
 * a single Claude stream-json envelope so parseVerdict's default decode path
 * works exactly as it would in production.
 */
function streamJson(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  });
}

/** Build an isolated mock Sandbox whose `run()` returns a single canned blob. */
function mockSandboxWithStdout(stdout: string): {
  sandbox: Sandbox;
  runCalls: SandboxRunOptions[];
} {
  const runCalls: SandboxRunOptions[] = [];
  const run = vi.fn(async (opts: SandboxRunOptions): Promise<SandboxRunResult> => {
    runCalls.push(opts);
    return {
      iterations: [],
      stdout,
      commits: [],
      completionSignal: undefined,
    };
  }) as unknown as Sandbox["run"];

  const sandbox = {
    branch: "agent/planner-test",
    worktreePath: "/tmp/planner-test",
    run,
    interactive: vi.fn() as unknown as Sandbox["interactive"],
    close: vi.fn(async () => ({})) as Sandbox["close"],
    [Symbol.asyncDispose]: vi.fn(async () => {}),
  } as unknown as Sandbox;

  return { sandbox, runCalls };
}

/** Wrap a JSON object as the planner's expected `<plan>...</plan>` blob. */
function planTag(payload: PlannerOutput | { [k: string]: unknown }): string {
  return `<plan>${JSON.stringify(payload)}</plan>`;
}

// ---------------------------------------------------------------------------
// Test 1 — three issues, mixed priorities, no dependencies
// ---------------------------------------------------------------------------

describe("runPlanner — priority ordering", () => {
  it("returns the agent's priority-ordered list verbatim for mixed-priority dependency-free issues", async () => {
    const input: PlannerInput = {
      openIssues: [
        {
          number: 10,
          title: "low-prio task",
          body: "Just a small cleanup.",
          labels: ["ready-for-agent", "priority:low"],
          createdAt: "2026-04-01T00:00:00Z",
        },
        {
          number: 11,
          title: "high-prio task",
          body: "Critical fix.",
          labels: ["ready-for-agent", "priority:high"],
          createdAt: "2026-04-02T00:00:00Z",
        },
        {
          number: 12,
          title: "medium-prio task",
          body: "Normal feature work.",
          labels: ["ready-for-agent", "priority:medium"],
          createdAt: "2026-04-03T00:00:00Z",
        },
      ],
    };

    // Agent returns the correctly-sorted list: high (11), medium (12), low (10).
    const expected: PlannerOutput = {
      priorityOrder: [11, 12, 10],
      dependencies: [],
    };
    const { sandbox, runCalls } = mockSandboxWithStdout(
      streamJson(planTag(expected)),
    );

    const result = await runPlanner(sandbox, input);
    expect(result).toEqual(expected);
    // Sanity: planner is single-shot and uses the configured default model.
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0].maxIterations).toBe(1);
    expect(runCalls[0].name).toBe("planner");
  });
});

// ---------------------------------------------------------------------------
// Test 2 — "Blocked by: #N" recorded in dependencies
// ---------------------------------------------------------------------------

describe("runPlanner — dependency extraction", () => {
  it("records 'Blocked by: #N' in the dependencies map", async () => {
    const input: PlannerInput = {
      openIssues: [
        {
          number: 5,
          title: "foundation work",
          body: "Set up the schema.",
          labels: ["ready-for-agent", "priority:high"],
          createdAt: "2026-04-01T00:00:00Z",
        },
        {
          number: 9,
          title: "downstream feature",
          body: "Build the UI on top.\n\nBlocked by: #5",
          labels: ["ready-for-agent", "priority:high"],
          createdAt: "2026-04-02T00:00:00Z",
        },
      ],
    };

    const expected: PlannerOutput = {
      priorityOrder: [5, 9],
      dependencies: [{ issue: 9, blockedBy: [5] }],
    };
    const { sandbox } = mockSandboxWithStdout(streamJson(planTag(expected)));

    const result = await runPlanner(sandbox, input);
    expect(result.dependencies).toEqual([{ issue: 9, blockedBy: [5] }]);
    expect(result.priorityOrder).toEqual([5, 9]);
  });
});

// ---------------------------------------------------------------------------
// Test 3 — synonym recognition is asserted via the prompt itself
// ---------------------------------------------------------------------------

describe("runPlanner — synonym robustness (prompt-level)", () => {
  it("instructs the agent to recognize 'Depends on #N' (and other synonyms) as a blocker", () => {
    // The differentiator vs. regex: the agent reads natural language. We
    // assert that the prompt explicitly enumerates the synonym list, so the
    // planner doesn't silently miss real-world phrasing variants.
    const input: PlannerInput = {
      openIssues: [
        {
          number: 5,
          title: "foundation",
          body: "Set up the schema.",
          labels: ["ready-for-agent", "priority:high"],
          createdAt: "2026-04-01T00:00:00Z",
        },
        {
          number: 9,
          title: "downstream feature",
          body: "Build the UI on top.\n\nDepends on #5",
          labels: ["ready-for-agent", "priority:high"],
          createdAt: "2026-04-02T00:00:00Z",
        },
      ],
    };
    const prompt = buildPlannerPrompt(input);

    // The synonym list is the load-bearing part of the prompt. If a future
    // edit drops one of these phrasings, planner robustness regresses
    // silently — pin them with assertions.
    expect(prompt).toMatch(/Blocked by/i);
    expect(prompt).toMatch(/Depends on/i);
    expect(prompt).toMatch(/Requires/i);
    expect(prompt).toMatch(/Needs/i);
    expect(prompt).toMatch(/Waits on|Waiting on/i);
    // The actual issue body (with "Depends on #5") must be inlined so the
    // agent can see it.
    expect(prompt).toContain("Depends on #5");
    // The <plan> tag must appear in the resolved prompt — a future
    // Output.object({ tag: "plan" }) swap requires this.
    expect(prompt).toContain("<plan>");
  });

  it("end-to-end: with 'Depends on #5' in the body the planner returns the dependency", async () => {
    const input: PlannerInput = {
      openIssues: [
        {
          number: 5,
          title: "foundation",
          body: "Set up the schema.",
          labels: ["ready-for-agent", "priority:high"],
          createdAt: "2026-04-01T00:00:00Z",
        },
        {
          number: 9,
          title: "downstream feature",
          body: "Build the UI on top.\n\nDepends on #5",
          labels: ["ready-for-agent", "priority:high"],
          createdAt: "2026-04-02T00:00:00Z",
        },
      ],
    };
    const expected: PlannerOutput = {
      priorityOrder: [5, 9],
      dependencies: [{ issue: 9, blockedBy: [5] }],
    };
    const { sandbox } = mockSandboxWithStdout(streamJson(planTag(expected)));

    const result = await runPlanner(sandbox, input);
    expect(result).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// Test 4 — empty input
// ---------------------------------------------------------------------------

describe("runPlanner — empty input", () => {
  it("returns { priorityOrder: [], dependencies: [] } when there are no open issues", async () => {
    const empty: PlannerOutput = { priorityOrder: [], dependencies: [] };
    const { sandbox } = mockSandboxWithStdout(streamJson(planTag(empty)));

    const result = await runPlanner(sandbox, { openIssues: [] });
    expect(result).toEqual(empty);
  });
});

// ---------------------------------------------------------------------------
// Test 5 — malformed JSON inside <plan> throws PlannerError
// ---------------------------------------------------------------------------

describe("runPlanner — error handling", () => {
  it("throws PlannerError when the <plan> block contains malformed JSON", async () => {
    const malformed = streamJson(`<plan>{ not valid json at all }</plan>`);
    const { sandbox } = mockSandboxWithStdout(malformed);

    await expect(runPlanner(sandbox, { openIssues: [] })).rejects.toBeInstanceOf(
      PlannerError,
    );
  });

  it("throws PlannerError when the JSON shape doesn't match the schema", async () => {
    // priorityOrder contains a non-positive integer — schema rejects it.
    const bad = streamJson(
      `<plan>${JSON.stringify({
        priorityOrder: [-1],
        dependencies: [],
      })}</plan>`,
    );
    const { sandbox } = mockSandboxWithStdout(bad);

    await expect(runPlanner(sandbox, { openIssues: [] })).rejects.toBeInstanceOf(
      PlannerError,
    );
  });
});

// ---------------------------------------------------------------------------
// Test 6 — Fix #11: cross-field validation
//
// The planner's `<plan>` JSON must:
//   - have NO duplicates in priorityOrder
//   - only reference issue numbers that appeared in the input
//   - cover every input issue (priorityOrder is a permutation of the input set)
//   - reference only in-priorityOrder issues in `dependencies[i].issue`
//
// `dependencies[i].blockedBy` is intentionally NOT membership-checked: the
// loop checks blocker state at run-time, which means a blocker pointing at
// an already-closed issue must remain representable here.
// ---------------------------------------------------------------------------

describe("runPlanner — cross-field validation (Fix #11)", () => {
  const TWO_ISSUES: PlannerInput = {
    openIssues: [
      {
        number: 5,
        title: "first",
        body: "",
        labels: ["ready-for-agent"],
        createdAt: "2026-04-01T00:00:00Z",
      },
      {
        number: 9,
        title: "second",
        body: "",
        labels: ["ready-for-agent"],
        createdAt: "2026-04-02T00:00:00Z",
      },
    ],
  };

  it("rejects priorityOrder containing duplicates", async () => {
    const bad = streamJson(
      `<plan>${JSON.stringify({
        priorityOrder: [5, 5, 5],
        dependencies: [],
      })}</plan>`,
    );
    const { sandbox } = mockSandboxWithStdout(bad);
    await expect(runPlanner(sandbox, TWO_ISSUES)).rejects.toBeInstanceOf(
      PlannerError,
    );
  });

  it("rejects priorityOrder containing an issue not in the input", async () => {
    // Input has 5 and 9; planner emitted [42] which is not in the input.
    const bad = streamJson(
      `<plan>${JSON.stringify({
        priorityOrder: [42],
        dependencies: [],
      })}</plan>`,
    );
    const { sandbox } = mockSandboxWithStdout(bad);
    await expect(runPlanner(sandbox, TWO_ISSUES)).rejects.toBeInstanceOf(
      PlannerError,
    );
  });

  it("rejects priorityOrder that misses an input issue (not a permutation)", async () => {
    // Input has 5 and 9; planner emitted only [5]. Permutation check fails.
    const bad = streamJson(
      `<plan>${JSON.stringify({
        priorityOrder: [5],
        dependencies: [],
      })}</plan>`,
    );
    const { sandbox } = mockSandboxWithStdout(bad);
    await expect(runPlanner(sandbox, TWO_ISSUES)).rejects.toBeInstanceOf(
      PlannerError,
    );
  });

  it("rejects dependencies[i].issue pointing at an issue not in priorityOrder", async () => {
    const bad = streamJson(
      `<plan>${JSON.stringify({
        priorityOrder: [5, 9],
        // 999 isn't in priorityOrder → reject.
        dependencies: [{ issue: 999, blockedBy: [5] }],
      })}</plan>`,
    );
    const { sandbox } = mockSandboxWithStdout(bad);
    await expect(runPlanner(sandbox, TWO_ISSUES)).rejects.toBeInstanceOf(
      PlannerError,
    );
  });

  it("ACCEPTS blockedBy entries that are NOT in priorityOrder (closed-blocker case)", async () => {
    // The loop checks blocker state at run-time; a blocker referring to an
    // already-closed (and therefore not-in-input) issue must still validate
    // here. Otherwise the schema would force the planner to drop legitimate
    // historical dependency edges every time an upstream closes.
    const ok = streamJson(
      `<plan>${JSON.stringify({
        priorityOrder: [5, 9],
        // 100 is NOT in priorityOrder, but is permitted in blockedBy.
        dependencies: [{ issue: 9, blockedBy: [5, 100] }],
      })}</plan>`,
    );
    const { sandbox } = mockSandboxWithStdout(ok);
    const result = await runPlanner(sandbox, TWO_ISSUES);
    expect(result.priorityOrder).toEqual([5, 9]);
    expect(result.dependencies).toEqual([
      { issue: 9, blockedBy: [5, 100] },
    ]);
  });
});
