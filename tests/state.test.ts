/**
 * Track D state-machine tests.
 *
 * Strategy:
 * - tmp dir per test for prd.json round-trips (real filesystem, real lock).
 * - `gh` CLI stubbed by mocking `node:child_process` execFile so transitionLabel
 *   / closeIssue / getIssueBody never shell out during tests.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mock node:child_process BEFORE importing the modules under test. -----
// We capture every execFile invocation so tests can assert call shape.
//
// `vi.hoisted` is required: vitest hoists `vi.mock` calls above any
// non-hoisted module-scope declarations, which would put the references in
// TDZ at factory-evaluation time. Hoisting the shared state alongside the
// mock keeps both at the top of the module.
type ExecFileCall = { file: string; args: string[] };

const { ghCalls, mockState } = vi.hoisted(() => {
  const ghCalls: ExecFileCall[] = [];
  const mockState: {
    resolver:
      | ((args: string[]) => string | { stdout: string; stderr?: string })
      | null;
  } = { resolver: null };
  return { ghCalls, mockState };
});

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
  const { promisify } = await import("node:util");
  // execFile signature is overloaded: (file, args, options, cb) is the form
  // promisify(execFile) uses. We honor that.
  const mockExecFile = (
    file: string,
    args: string[],
    _options: unknown,
    cb: (
      err: Error | null,
      stdout: string,
      stderr: string,
    ) => void,
  ) => {
    ghCalls.push({ file, args: [...args] });
    let stdout = "";
    let stderr = "";
    if (mockState.resolver) {
      const resolved = mockState.resolver(args);
      if (typeof resolved === "string") {
        stdout = resolved;
      } else {
        stdout = resolved.stdout;
        stderr = resolved.stderr ?? "";
      }
    }
    cb(null, stdout, stderr);
    return undefined as unknown as ReturnType<typeof actual.execFile>;
  };
  // Real `execFile` carries a `util.promisify.custom` symbol that makes
  // `promisify(execFile)` resolve to `{stdout, stderr}` instead of just the
  // second cb arg. Without copying that here, our replacement loses the
  // custom resolver and `runGh`'s destructuring receives the raw stdout
  // string. Mirror the contract of the real `execFile` exactly.
  (mockExecFile as unknown as Record<symbol, unknown>)[promisify.custom] = (
    file: string,
    args: string[],
    options?: unknown,
  ) =>
    new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      mockExecFile(file, args, options, (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      });
    });
  return {
    ...actual,
    execFile: mockExecFile,
  };
});

// Now safe to import — these pull in child_process via execFile/promisify.
import {
  claimStory,
  claimViaLabel,
  closeIssue,
  getPriorityFromLabels,
  isQuarantineLabel,
  listIssuesByLabel,
  listReadyIssues,
  loadPrd,
  markDone,
  markDoneViaLabel,
  pickNextEligibleStory,
  quarantineStoryInPrd,
  quarantineViaLabel,
  STATUS_LABELS,
  transitionLabel,
  withPrdLock,
} from "../src/state/index.js";
import type { PrdState } from "../src/types.js";

// --- Test fixtures --------------------------------------------------------

let tmpDir: string;

const SEED_PRD: PrdState = {
  stories: [
    { id: "S-001", title: "first story", status: "pending", ghIssue: 101 },
    { id: "S-002", title: "second story", status: "pending", ghIssue: 102 },
    { id: "S-003", title: "already done", status: "done", ghIssue: 103 },
    { id: "S-004", title: "in flight", status: "in_progress", ghIssue: 104 },
  ],
};

async function writePrd(state: PrdState): Promise<void> {
  await fs.writeFile(
    path.join(tmpDir, "prd.json"),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8",
  );
}

beforeEach(async () => {
  ghCalls.length = 0;
  mockState.resolver = null;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sandcastle-state-test-"));
  await writePrd(SEED_PRD);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// --- loadPrd --------------------------------------------------------------

describe("loadPrd", () => {
  it("reads and validates prd.json", async () => {
    const state = await loadPrd(tmpDir);
    expect(state.stories).toHaveLength(4);
    expect(state.stories[0]?.id).toBe("S-001");
  });

  it("throws on malformed JSON", async () => {
    await fs.writeFile(path.join(tmpDir, "prd.json"), "{ not json", "utf8");
    await expect(loadPrd(tmpDir)).rejects.toThrow(/not valid JSON/);
  });

  it("throws on schema mismatch", async () => {
    await fs.writeFile(
      path.join(tmpDir, "prd.json"),
      JSON.stringify({ stories: [{ id: "X", title: "t", status: "weird" }] }),
      "utf8",
    );
    await expect(loadPrd(tmpDir)).rejects.toThrow(/schema validation/);
  });
});

// --- claimStory -----------------------------------------------------------

describe("claimStory", () => {
  it("claims a pending story, transitions label, returns updated story", async () => {
    const claimed = await claimStory(tmpDir, "S-001");
    expect(claimed.status).toBe("in_progress");
    expect(claimed.id).toBe("S-001");

    // prd.json on disk reflects mutation
    const reread = await loadPrd(tmpDir);
    const s001 = reread.stories.find((s) => s.id === "S-001");
    expect(s001?.status).toBe("in_progress");

    // gh CLI was invoked exactly once with correct argv
    expect(ghCalls).toHaveLength(1);
    expect(ghCalls[0]).toEqual({
      file: "gh",
      args: [
        "issue",
        "edit",
        "101",
        "--add-label",
        "in-progress",
        "--remove-label",
        "ready-for-agent",
      ],
    });
  });

  it("throws when story is already in_progress (claim-fails-on-already-claimed)", async () => {
    await expect(claimStory(tmpDir, "S-004")).rejects.toThrow(
      /status 'in_progress'/,
    );
    // No gh call should have happened — failure is on the prd-side check.
    expect(ghCalls).toHaveLength(0);

    // And on-disk state is unchanged.
    const reread = await loadPrd(tmpDir);
    const s004 = reread.stories.find((s) => s.id === "S-004");
    expect(s004?.status).toBe("in_progress");
  });

  it("throws when story id doesn't exist", async () => {
    await expect(claimStory(tmpDir, "S-999")).rejects.toThrow(/not found/);
  });
});

// --- pickNextEligibleStory ------------------------------------------------

describe("pickNextEligibleStory", () => {
  it("claims the first pending story", async () => {
    const story = await pickNextEligibleStory(tmpDir);
    expect(story?.id).toBe("S-001");
    expect(story?.status).toBe("in_progress");
  });

  it("returns null when nothing is pending", async () => {
    await writePrd({
      stories: [
        { id: "A", title: "a", status: "done" },
        { id: "B", title: "b", status: "quarantined" },
        { id: "C", title: "c", status: "in_progress" },
      ],
    });
    const story = await pickNextEligibleStory(tmpDir);
    expect(story).toBeNull();
  });

  it("skips a pending story whose blockedBy points at an unfinished blocker", async () => {
    await writePrd({
      stories: [
        // S-001 is blocked by S-004, which is in_progress (not done) — must
        // be skipped. S-002 has no blockers and should be picked.
        {
          id: "S-001",
          title: "first story",
          status: "pending",
          ghIssue: 101,
          blockedBy: ["S-004"],
        },
        { id: "S-002", title: "second story", status: "pending", ghIssue: 102 },
        { id: "S-004", title: "in flight", status: "in_progress", ghIssue: 104 },
      ],
    });
    const story = await pickNextEligibleStory(tmpDir);
    expect(story?.id).toBe("S-002");
    expect(story?.status).toBe("in_progress");

    // S-001 must remain pending on disk — it was skipped, not claimed.
    const reread = await loadPrd(tmpDir);
    expect(reread.stories.find((s) => s.id === "S-001")?.status).toBe(
      "pending",
    );
  });

  it("picks a pending story when all of its blockers are done", async () => {
    await writePrd({
      stories: [
        // S-001 is blocked only by S-003, which is done — eligible.
        {
          id: "S-001",
          title: "first story",
          status: "pending",
          ghIssue: 101,
          blockedBy: ["S-003"],
        },
        { id: "S-003", title: "already done", status: "done", ghIssue: 103 },
      ],
    });
    const story = await pickNextEligibleStory(tmpDir);
    expect(story?.id).toBe("S-001");
    expect(story?.status).toBe("in_progress");
  });

  it("skips (does not throw on) a pending story with a dangling blockedBy reference", async () => {
    // Suppress the expected console.error for the dangling-blocker warning.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await writePrd({
        stories: [
          {
            id: "S-001",
            title: "first story",
            status: "pending",
            ghIssue: 101,
            blockedBy: ["S-DOES-NOT-EXIST"],
          },
          { id: "S-002", title: "second story", status: "pending", ghIssue: 102 },
        ],
      });
      const story = await pickNextEligibleStory(tmpDir);
      // S-001 is skipped (logged), S-002 is picked normally.
      expect(story?.id).toBe("S-002");
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});

// --- markDone -------------------------------------------------------------

describe("markDone", () => {
  it("sets status to done and appends a progress.txt line", async () => {
    await markDone(tmpDir, "S-001", "abc1234", 7, "first story shipped");

    const reread = await loadPrd(tmpDir);
    expect(reread.stories.find((s) => s.id === "S-001")?.status).toBe("done");

    const progress = await fs.readFile(
      path.join(tmpDir, "progress.txt"),
      "utf8",
    );
    expect(progress).toContain("[it=7]");
    expect(progress).toContain("S-001");
    expect(progress).toContain("first story shipped");
    expect(progress).toContain("abc1234");
  });

  it("throws when the story id is unknown", async () => {
    await expect(markDone(tmpDir, "S-999", "deadbee")).rejects.toThrow(
      /not found/,
    );
  });
});

// --- quarantineStoryInPrd -------------------------------------------------

describe("quarantineStoryInPrd", () => {
  it("sets status, reason, attempts, and quarantinedAt", async () => {
    const before = Date.now();
    await quarantineStoryInPrd(
      tmpDir,
      "S-002",
      "ladder-exhausted: impl rc=1, sonnet-rec rc=1, opus-rec rc=1",
      3,
    );

    const reread = await loadPrd(tmpDir);
    const s = reread.stories.find((x) => x.id === "S-002");
    // Bash-compat: quarantine writes "needs_human", not "quarantined".
    expect(s?.status).toBe("needs_human");
    expect(s?.attempts).toBe(3);
    expect(s?.quarantineReason).toMatch(/ladder-exhausted/);
    expect(s?.quarantinedAt).toBeDefined();
    // claimedBy/claimedAt must be cleared on quarantine.
    expect(s?.claimedBy).toBeUndefined();
    expect(s?.claimedAt).toBeUndefined();
    // ISO-8601 string parses to a real timestamp at-or-after `before`.
    expect(new Date(s?.quarantinedAt ?? "").getTime()).toBeGreaterThanOrEqual(
      before - 1000,
    );

    // GH transition for `from === "*"`: view labels first (none, since the
    // resolver wasn't set), then add the quarantine label. No status labels
    // exist on the issue in this fixture, so no --remove-label calls happen.
    // The first call is the view, the second is the add.
    expect(ghCalls).toHaveLength(2);
    expect(ghCalls[0]?.args).toEqual([
      "issue",
      "view",
      "102",
      "--json",
      "labels",
    ]);
    expect(ghCalls[1]?.args).toEqual([
      "issue",
      "edit",
      "102",
      "--add-label",
      "quarantine",
    ]);
    // The add call must not also remove a label — strips happen in their
    // own gh invocations.
    expect(ghCalls[1]?.args).not.toContain("--remove-label");
  });

  it("handles reason strings with shell metacharacters safely (no jq-injection equivalent)", async () => {
    // The bash version had to use env-var passthrough into jq to avoid this
    // injection vector. In TS we just mutate the in-memory object — the reason
    // string is preserved verbatim, no escaping needed.
    const sneaky = `'; DROP TABLE; \`rm -rf /\`; "$(echo pwned)" \\n \\` + `'`;
    await quarantineStoryInPrd(tmpDir, "S-001", sneaky, 1);
    const reread = await loadPrd(tmpDir);
    expect(reread.stories.find((s) => s.id === "S-001")?.quarantineReason).toBe(
      sneaky,
    );
  });
});

// --- gh wrappers (direct call, asserting argv shape) ----------------------

describe("transitionLabel", () => {
  it("removes from + adds to when from is concrete", async () => {
    await transitionLabel(42, "in-progress", "needs-review");
    expect(ghCalls).toHaveLength(1);
    expect(ghCalls[0]?.args).toEqual([
      "issue",
      "edit",
      "42",
      "--add-label",
      "needs-review",
      "--remove-label",
      "in-progress",
    ]);
  });

  it("when from is '*' and the issue has no labels, view + add only (no removes)", async () => {
    // Resolver is null in beforeEach, so `gh issue view` returns "".
    await transitionLabel(42, "*", "quarantine");
    // 1) view, 2) add. No removes.
    expect(ghCalls).toHaveLength(2);
    expect(ghCalls[0]?.args).toEqual([
      "issue",
      "view",
      "42",
      "--json",
      "labels",
    ]);
    expect(ghCalls[1]?.args).toEqual([
      "issue",
      "edit",
      "42",
      "--add-label",
      "quarantine",
    ]);
  });

  it("when from is '*', strips every existing status label before adding the new one", async () => {
    // Issue currently has in-progress + done + ready-for-agent (all status
    // labels). All three should be stripped, then needs-human added.
    mockState.resolver = (args) => {
      if (args[0] === "issue" && args[1] === "view") {
        return JSON.stringify({
          labels: [
            { name: "ready-for-agent" },
            { name: "in-progress" },
            { name: "done" },
          ],
        });
      }
      return "";
    };

    await transitionLabel(42, "*", "needs-human");

    // 1 view + 3 removes + 1 add = 5 calls.
    expect(ghCalls).toHaveLength(5);
    expect(ghCalls[0]?.args).toEqual([
      "issue",
      "view",
      "42",
      "--json",
      "labels",
    ]);

    // The three removes (order matches input order from the view response).
    const removeCalls = ghCalls
      .slice(1, 4)
      .map((c) => c.args.slice(-2)); // last two argv tokens are ["--remove-label", X]
    expect(removeCalls).toEqual([
      ["--remove-label", "ready-for-agent"],
      ["--remove-label", "in-progress"],
      ["--remove-label", "done"],
    ]);
    for (const c of ghCalls.slice(1, 4)) {
      expect(c.args[0]).toBe("issue");
      expect(c.args[1]).toBe("edit");
      expect(c.args[2]).toBe("42");
      expect(c.args).not.toContain("--add-label");
    }

    // Final add.
    expect(ghCalls[4]?.args).toEqual([
      "issue",
      "edit",
      "42",
      "--add-label",
      "needs-human",
    ]);
  });

  it("when from is '*', preserves non-status labels (priority:*, etc) and only strips status labels", async () => {
    // Issue has ["in-progress", "priority:high"]. After transitionLabel(*,
    // needs-human) it should keep priority:high, drop in-progress, gain
    // needs-human. We assert this via the gh argv shape: priority:high
    // should NEVER appear in any --remove-label call.
    mockState.resolver = (args) => {
      if (args[0] === "issue" && args[1] === "view") {
        return JSON.stringify({
          labels: [
            { name: "in-progress" },
            { name: "priority:high" },
          ],
        });
      }
      return "";
    };

    await transitionLabel(42, "*", "needs-human");

    // view + 1 remove (in-progress only) + 1 add = 3 calls.
    expect(ghCalls).toHaveLength(3);

    // The single remove targets in-progress, NOT priority:high.
    expect(ghCalls[1]?.args).toEqual([
      "issue",
      "edit",
      "42",
      "--remove-label",
      "in-progress",
    ]);

    // priority:high must never appear as a --remove-label target across any
    // call.
    for (const c of ghCalls) {
      const idx = c.args.indexOf("--remove-label");
      if (idx !== -1) {
        expect(c.args[idx + 1]).not.toBe("priority:high");
      }
    }

    // Final add: needs-human.
    expect(ghCalls[2]?.args).toEqual([
      "issue",
      "edit",
      "42",
      "--add-label",
      "needs-human",
    ]);
  });

  it("when from is '*' and the target label is already on the issue, does NOT redundantly strip it", async () => {
    // Edge case: target == an existing status label. We don't want to strip
    // and re-add (that'd create a brief window with no status label).
    mockState.resolver = (args) => {
      if (args[0] === "issue" && args[1] === "view") {
        return JSON.stringify({
          labels: [{ name: "needs-human" }, { name: "priority:low" }],
        });
      }
      return "";
    };

    await transitionLabel(42, "*", "needs-human");

    // view + add only — needs-human is not stripped because it equals `to`.
    // Add is still issued (idempotent on gh's side).
    expect(ghCalls).toHaveLength(2);
    expect(ghCalls[0]?.args[1]).toBe("view");
    expect(ghCalls[1]?.args).toEqual([
      "issue",
      "edit",
      "42",
      "--add-label",
      "needs-human",
    ]);
  });

  it("rejects non-positive issue numbers", async () => {
    await expect(transitionLabel(0, "a", "b")).rejects.toThrow(/invalid/);
  });
});

describe("closeIssue", () => {
  it("invokes gh issue close with --comment when provided", async () => {
    await closeIssue(99, "SANDCASTLE(it=3) closed by abc1234");
    expect(ghCalls).toHaveLength(1);
    expect(ghCalls[0]?.args).toEqual([
      "issue",
      "close",
      "99",
      "--comment",
      "SANDCASTLE(it=3) closed by abc1234",
    ]);
  });

  it("omits --comment when not provided", async () => {
    await closeIssue(99);
    expect(ghCalls[0]?.args).toEqual(["issue", "close", "99"]);
  });
});

// --- Locking: lock prevents concurrent writes -----------------------------

describe("withPrdLock", () => {
  it("serializes concurrent mutations (lock prevents racing writers)", async () => {
    // Two promises racing inside withPrdLock. Each reads the current counter,
    // bumps it, writes back. Without serialization the final value would be
    // less than 2 due to lost-update. With proper-lockfile it must be exactly 2.
    await fs.writeFile(
      path.join(tmpDir, "prd.json"),
      JSON.stringify({ stories: [] }),
      "utf8",
    );
    let counter = 0;
    const bump = () =>
      withPrdLock(tmpDir, async () => {
        const snapshot = counter;
        // Force interleave window.
        await new Promise((r) => setTimeout(r, 30));
        counter = snapshot + 1;
      });
    await Promise.all([bump(), bump()]);
    expect(counter).toBe(2);
  });

  it("releases the lock when the body throws", async () => {
    await expect(
      withPrdLock(tmpDir, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow(/boom/);
    // Subsequent acquisition must succeed (i.e. lock was released).
    await withPrdLock(tmpDir, async () => {
      // ok
    });
  });
});

// --- V1 label-state-machine helpers ---------------------------------------

describe("getPriorityFromLabels", () => {
  it("returns 'high' when priority:high is present", () => {
    expect(getPriorityFromLabels(["priority:high", "ready-for-agent"])).toBe(
      "high",
    );
  });

  it("returns 'medium' when priority:medium is present", () => {
    expect(getPriorityFromLabels(["priority:medium"])).toBe("medium");
  });

  it("returns 'low' when only priority:low is present", () => {
    expect(getPriorityFromLabels(["priority:low", "ready-for-agent"])).toBe(
      "low",
    );
  });

  it("defaults to 'medium' when no priority label is present", () => {
    expect(getPriorityFromLabels(["ready-for-agent", "bug"])).toBe("medium");
  });

  it("defaults to 'medium' for an empty label set", () => {
    expect(getPriorityFromLabels([])).toBe("medium");
  });

  it("picks the highest precedence when multiple priority labels are present", () => {
    // Shouldn't happen in practice, but if both are set we resolve to the
    // strictly highest (high > medium > low).
    expect(
      getPriorityFromLabels(["priority:low", "priority:high"]),
    ).toBe("high");
    expect(
      getPriorityFromLabels(["priority:medium", "priority:low"]),
    ).toBe("medium");
  });
});

describe("listReadyIssues", () => {
  it("queries the right gh argv and returns parsed, sorted issues", async () => {
    // Three issues, intentionally out-of-order so we can assert sort.
    // Expected order after sort:
    //   1. #11 priority:high (highest priority wins)
    //   2. #12 priority:medium, older createdAt
    //   3. #13 unlabeled (defaults medium), newer createdAt
    //   4. #14 priority:low (lowest)
    const canned = [
      {
        number: 13,
        title: "C - default medium, newest",
        body: "c-body",
        labels: [{ name: "ready-for-agent" }],
        createdAt: "2025-01-03T00:00:00Z",
      },
      {
        number: 14,
        title: "D - low",
        body: "d-body",
        labels: [{ name: "ready-for-agent" }, { name: "priority:low" }],
        createdAt: "2025-01-01T00:00:00Z",
      },
      {
        number: 11,
        title: "A - high",
        body: "a-body",
        labels: [{ name: "ready-for-agent" }, { name: "priority:high" }],
        createdAt: "2025-01-04T00:00:00Z",
      },
      {
        number: 12,
        title: "B - medium, oldest",
        body: "b-body",
        labels: [
          { name: "ready-for-agent" },
          { name: "priority:medium" },
        ],
        createdAt: "2025-01-02T00:00:00Z",
      },
    ];
    mockState.resolver = () => JSON.stringify(canned);

    const out = await listReadyIssues();

    // Argv shape — exact, in order.
    expect(ghCalls).toHaveLength(1);
    expect(ghCalls[0]).toEqual({
      file: "gh",
      args: [
        "issue",
        "list",
        "--state",
        "open",
        "--label",
        "ready-for-agent",
        "--json",
        "number,title,body,labels,createdAt",
        "--limit",
        "100",
      ],
    });

    // Sort: priority desc, then createdAt asc.
    expect(out.map((r) => r.number)).toEqual([11, 12, 13, 14]);
    // Labels are flattened to string[] (no {name} wrapping leaks out).
    expect(out[0]?.labels).toEqual(["ready-for-agent", "priority:high"]);
    // Body / title / createdAt round-trip.
    expect(out[0]?.title).toBe("A - high");
    expect(out[0]?.body).toBe("a-body");
    expect(out[0]?.createdAt).toBe("2025-01-04T00:00:00Z");
  });

  it("returns [] when gh returns an empty JSON array", async () => {
    mockState.resolver = () => "[]";
    const out = await listReadyIssues();
    expect(out).toEqual([]);
  });

  it("ties broken by createdAt ascending within the same priority bucket", async () => {
    const canned = [
      {
        number: 22,
        title: "newer",
        body: "",
        labels: [{ name: "priority:high" }],
        createdAt: "2025-02-01T00:00:00Z",
      },
      {
        number: 21,
        title: "older",
        body: "",
        labels: [{ name: "priority:high" }],
        createdAt: "2025-01-01T00:00:00Z",
      },
    ];
    mockState.resolver = () => JSON.stringify(canned);
    const out = await listReadyIssues();
    expect(out.map((r) => r.number)).toEqual([21, 22]);
  });
});

describe("claimViaLabel", () => {
  it("delegates to transitionLabel(ready-for-agent -> in-progress) with correct argv", async () => {
    await claimViaLabel(77);
    expect(ghCalls).toHaveLength(1);
    expect(ghCalls[0]).toEqual({
      file: "gh",
      args: [
        "issue",
        "edit",
        "77",
        "--add-label",
        "in-progress",
        "--remove-label",
        "ready-for-agent",
      ],
    });
  });

  it("rejects non-positive issue numbers", async () => {
    await expect(claimViaLabel(0)).rejects.toThrow(/invalid/);
    await expect(claimViaLabel(-3)).rejects.toThrow(/invalid/);
    await expect(claimViaLabel(1.5)).rejects.toThrow(/invalid/);
  });
});

describe("markDoneViaLabel", () => {
  it("transitions in-progress->done THEN closes with the summary as a comment", async () => {
    await markDoneViaLabel(88, "shipped in iteration 4");

    // Two gh calls, in the right order.
    expect(ghCalls).toHaveLength(2);

    // 1) Label transition: add done, remove in-progress.
    expect(ghCalls[0]).toEqual({
      file: "gh",
      args: [
        "issue",
        "edit",
        "88",
        "--add-label",
        "done",
        "--remove-label",
        "in-progress",
      ],
    });

    // 2) Close with comment.
    expect(ghCalls[1]).toEqual({
      file: "gh",
      args: [
        "issue",
        "close",
        "88",
        "--comment",
        "shipped in iteration 4",
      ],
    });
  });

  it("rejects invalid issue numbers without making any gh call", async () => {
    await expect(markDoneViaLabel(0, "x")).rejects.toThrow(/invalid/);
    expect(ghCalls).toHaveLength(0);
  });
});

describe("quarantineViaLabel", () => {
  it("transitions in-progress->needs-human, posts a comment, does NOT close", async () => {
    await quarantineViaLabel(55, "ladder-exhausted; verifier still failing");

    // Exactly two gh invocations: label edit + comment. No `issue close`.
    expect(ghCalls).toHaveLength(2);

    expect(ghCalls[0]).toEqual({
      file: "gh",
      args: [
        "issue",
        "edit",
        "55",
        "--add-label",
        "needs-human",
        "--remove-label",
        "in-progress",
      ],
    });

    expect(ghCalls[1]).toEqual({
      file: "gh",
      args: [
        "issue",
        "comment",
        "55",
        "--body",
        "ladder-exhausted; verifier still failing",
      ],
    });

    // Belt + braces: no gh call should be `issue close`.
    for (const c of ghCalls) {
      expect(c.args[0] === "issue" && c.args[1] === "close").toBe(false);
    }
  });

  it("rejects invalid issue numbers without making any gh call", async () => {
    await expect(quarantineViaLabel(-1, "nope")).rejects.toThrow(/invalid/);
    expect(ghCalls).toHaveLength(0);
  });
});

// --- Fix #12: isQuarantineLabel + STATUS_LABELS ---------------------------

describe("isQuarantineLabel", () => {
  it("returns true for the canonical 'needs-human' spelling", () => {
    expect(isQuarantineLabel("needs-human")).toBe(true);
  });

  it("returns true for the legacy 'quarantine' spelling", () => {
    expect(isQuarantineLabel("quarantine")).toBe(true);
  });

  it("returns false for any other label", () => {
    for (const lbl of [
      "in-progress",
      "ready-for-agent",
      "done",
      "priority:high",
      "Needs-Human", // case-sensitive — GH labels are too
      "QUARANTINE",
      "",
      "needs_human", // underscore variant is the prd.json status, not a GH label
    ]) {
      expect(isQuarantineLabel(lbl)).toBe(false);
    }
  });
});

describe("STATUS_LABELS", () => {
  it("contains exactly the v1 status labels (canonical + legacy quarantine)", () => {
    // Order is load-bearing for transitionLabel('*', X)'s strip pass — keep
    // this in sync with src/state/gh.ts.
    expect([...STATUS_LABELS]).toEqual([
      "ready-for-agent",
      "in-progress",
      "done",
      "needs-human",
      "quarantine",
    ]);
  });
});

// --- Fix bonus: listIssuesByLabel -----------------------------------------

describe("listIssuesByLabel", () => {
  it("invokes gh with the right argv, parses, and sorts by issue number ascending", async () => {
    // Three issues, intentionally out-of-order. listIssuesByLabel must sort
    // ascending by `number` for deterministic recovery.
    const canned = [
      {
        number: 17,
        title: "third",
        labels: [{ name: "in-progress" }, { name: "priority:medium" }],
      },
      {
        number: 5,
        title: "first",
        labels: [{ name: "in-progress" }],
      },
      {
        number: 11,
        title: "second",
        labels: [{ name: "in-progress" }, { name: "priority:high" }],
      },
    ];
    mockState.resolver = () => JSON.stringify(canned);

    const out = await listIssuesByLabel("in-progress");

    // Argv shape: list --label <X> --state open --json number,title,labels --limit 100.
    expect(ghCalls).toHaveLength(1);
    expect(ghCalls[0]).toEqual({
      file: "gh",
      args: [
        "issue",
        "list",
        "--label",
        "in-progress",
        "--state",
        "open",
        "--json",
        "number,title,labels",
        "--limit",
        "100",
      ],
    });

    // Sorted ascending by number.
    expect(out.map((r) => r.number)).toEqual([5, 11, 17]);

    // Shape: labels flattened to string[], no { name } leakage.
    expect(out[0]).toEqual({
      number: 5,
      title: "first",
      labels: ["in-progress"],
    });
    expect(out[1]).toEqual({
      number: 11,
      title: "second",
      labels: ["in-progress", "priority:high"],
    });
    expect(out[2]).toEqual({
      number: 17,
      title: "third",
      labels: ["in-progress", "priority:medium"],
    });
  });

  it("returns [] when gh returns an empty JSON array", async () => {
    mockState.resolver = () => "[]";
    const out = await listIssuesByLabel("in-progress");
    expect(out).toEqual([]);
  });

  it("returns [] when gh returns empty stdout", async () => {
    mockState.resolver = () => "";
    const out = await listIssuesByLabel("in-progress");
    expect(out).toEqual([]);
  });

  it("rejects an empty label string without making any gh call", async () => {
    await expect(listIssuesByLabel("")).rejects.toThrow(/non-empty/);
    expect(ghCalls).toHaveLength(0);
  });

  it("throws on output whose shape doesn't match the Zod schema", async () => {
    mockState.resolver = () =>
      JSON.stringify([{ number: "not a number", title: "x", labels: [] }]);
    await expect(listIssuesByLabel("in-progress")).rejects.toThrow(
      /unexpected gh output shape/,
    );
  });
});
