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
type ExecFileCall = { file: string; args: string[] };
const ghCalls: ExecFileCall[] = [];

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
  return {
    ...actual,
    // execFile signature is overloaded: (file, args, options, cb) is the form
    // promisify(execFile) uses. We honor that.
    execFile: (
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
      // Default success — individual tests can override stdout below by
      // peeking at args[0] etc. Default empty stdout/stderr is fine for the
      // label/close paths that don't read output.
      cb(null, "", "");
      return undefined as unknown as ReturnType<typeof actual.execFile>;
    },
  };
});

// Now safe to import — these pull in child_process via execFile/promisify.
import {
  claimStory,
  closeIssue,
  loadPrd,
  markDone,
  pickNextEligibleStory,
  quarantineStoryInPrd,
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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-state-test-"));
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

    // GH transition was add-only (from === "*").
    expect(ghCalls).toHaveLength(1);
    expect(ghCalls[0]?.args).toEqual([
      "issue",
      "edit",
      "102",
      "--add-label",
      "quarantine",
    ]);
    // No --remove-label arg should be present.
    expect(ghCalls[0]?.args).not.toContain("--remove-label");
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

  it("only adds when from is '*'", async () => {
    await transitionLabel(42, "*", "quarantine");
    expect(ghCalls[0]?.args).not.toContain("--remove-label");
    expect(ghCalls[0]?.args).toContain("--add-label");
  });

  it("rejects non-positive issue numbers", async () => {
    await expect(transitionLabel(0, "a", "b")).rejects.toThrow(/invalid/);
  });
});

describe("closeIssue", () => {
  it("invokes gh issue close with --comment when provided", async () => {
    await closeIssue(99, "RALPH(it=3) closed by abc1234");
    expect(ghCalls).toHaveLength(1);
    expect(ghCalls[0]?.args).toEqual([
      "issue",
      "close",
      "99",
      "--comment",
      "RALPH(it=3) closed by abc1234",
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
