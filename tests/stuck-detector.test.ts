import { describe, it, expect } from "vitest";
import {
  createStuckDetector,
  runWithStuckDetection,
  StuckError,
  STUCK_THRESHOLD,
  type StreamEvent,
  type StuckRunResult,
} from "../.sandcastle/lib/stuck-detector.js";

const toolCall = (name: string, formattedArgs: string): StreamEvent => ({
  type: "toolCall",
  name,
  formattedArgs,
});
const text = (message: string): StreamEvent => ({ type: "text", message });

describe("createStuckDetector", () => {
  it("fires after exactly `threshold` identical consecutive tool calls", () => {
    const d = createStuckDetector({ threshold: 3 });
    const e = toolCall("Bash", "cat log.txt");
    expect(d.record(e).stuck).toBe(false); // count 1
    expect(d.record(e).stuck).toBe(false); // count 2
    const hit = d.record(e); // count 3 → threshold
    expect(hit.stuck).toBe(true);
    expect(hit.count).toBe(3);
    expect(hit.toolName).toBe("Bash");
  });

  it("does NOT fire on a varied read/edit investigation burst", () => {
    const d = createStuckDetector({ threshold: 3 });
    const events = [
      toolCall("Read", "a.ts"),
      toolCall("Read", "b.ts"),
      toolCall("Edit", "a.ts:12"),
      toolCall("Read", "c.ts"),
      toolCall("Bash", "npm test"),
      toolCall("Edit", "b.ts:40"),
    ];
    expect(events.some((e) => d.record(e).stuck)).toBe(false);
  });

  it("keeps counting across interleaved text events (poll loop with reasoning)", () => {
    // A background-poll spin: Bash(cat) → 'still running' → Bash(cat) → ...
    const d = createStuckDetector({ threshold: 4 });
    const poll = toolCall("Bash", "cat e2e.log");
    let lastStuck = false;
    for (let i = 0; i < 4; i++) {
      lastStuck = d.record(poll).stuck;
      d.record(text("still running, will check again"));
    }
    expect(lastStuck).toBe(true);
  });

  it("resets the streak when a different tool call intervenes", () => {
    const d = createStuckDetector({ threshold: 3 });
    const poll = toolCall("Bash", "cat e2e.log");
    expect(d.record(poll).stuck).toBe(false); // 1
    expect(d.record(poll).stuck).toBe(false); // 2
    expect(d.record(toolCall("Read", "x.ts")).stuck).toBe(false); // reset
    expect(d.record(poll).stuck).toBe(false); // 1 again
    expect(d.record(poll).stuck).toBe(false); // 2
    expect(d.record(poll).stuck).toBe(true); // 3 → fires
  });

  it("same tool, DIFFERENT args does not accumulate", () => {
    const d = createStuckDetector({ threshold: 3 });
    expect(d.record(toolCall("Read", "a.ts")).stuck).toBe(false);
    expect(d.record(toolCall("Read", "b.ts")).stuck).toBe(false);
    expect(d.record(toolCall("Read", "c.ts")).stuck).toBe(false);
  });

  it("defaults to STUCK_THRESHOLD when no threshold given", () => {
    const d = createStuckDetector();
    const e = toolCall("Bash", "cat log");
    let fired = false;
    for (let i = 0; i < STUCK_THRESHOLD; i++) fired = d.record(e).stuck;
    expect(STUCK_THRESHOLD).toBeGreaterThanOrEqual(5);
    expect(fired).toBe(true);
  });
});

describe("runWithStuckDetection", () => {
  const okResult: StuckRunResult = {
    stdout: "done",
    commits: [{ sha: "aaa" }],
    iterations: [],
  };

  it("passes the underlying result straight through on normal completion", async () => {
    let captured = 0;
    const r = await runWithStuckDetection<StuckRunResult>({
      captureStartSha: async () => "base",
      recoverCommits: async () => {
        captured++;
        return [];
      },
      buildStuckResult: (commits, detail) => ({
        stdout: `stuck: ${detail}`,
        commits,
        iterations: [],
      }),
      runOnce: async (_signal, _onEvent) => okResult,
    });
    expect(r).toEqual(okResult);
    expect(captured).toBe(0); // recovery never ran
  });

  it("on a stuck spin: aborts, recovers commits, returns a graceful result (→ reviewer)", async () => {
    const recovered = [{ sha: "c1" }, { sha: "c2" }];
    const r = await runWithStuckDetection<StuckRunResult>({
      threshold: 3,
      captureStartSha: async () => "base",
      recoverCommits: async (start) => {
        expect(start).toBe("base");
        return recovered;
      },
      buildStuckResult: (commits, detail) => ({
        stdout: `[stuck] ${detail}`,
        commits,
        iterations: [],
      }),
      runOnce: async (signal, onEvent) => {
        // Simulate the SDK: emit a poll spin, honor the abort by rejecting
        // with signal.reason (matches the SDK's documented abort contract).
        return await new Promise<StuckRunResult>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
          const poll = { type: "toolCall", name: "Bash", formattedArgs: "cat e2e.log" };
          for (let i = 0; i < 5; i++) onEvent(poll as StreamEvent);
        });
      },
    });
    expect(r.commits).toEqual(recovered);
    expect(r.stdout).toContain("Bash");
  });

  it("stuck spin with ZERO commits returns commits:[] (→ existing no-commit quarantine)", async () => {
    const r = await runWithStuckDetection<StuckRunResult>({
      threshold: 2,
      captureStartSha: async () => "base",
      recoverCommits: async () => [],
      buildStuckResult: (commits, detail) => ({
        stdout: `[stuck] ${detail}`,
        commits,
        iterations: [],
      }),
      runOnce: async (signal, onEvent) =>
        await new Promise<StuckRunResult>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
          const poll = { type: "toolCall", name: "Bash", formattedArgs: "x" };
          onEvent(poll as StreamEvent);
          onEvent(poll as StreamEvent);
        }),
    });
    expect(r.commits).toEqual([]);
  });

  it("rethrows an EXTERNAL abort (hard ceiling) — not treated as stuck", async () => {
    const external = new AbortController();
    const ceilingErr = new Error("hard ceiling exceeded");
    await expect(
      runWithStuckDetection<StuckRunResult>({
        externalSignal: external.signal,
        captureStartSha: async () => "base",
        recoverCommits: async () => {
          throw new Error("recovery must not run on ceiling abort");
        },
        buildStuckResult: () => okResult,
        runOnce: async (signal) =>
          await new Promise<StuckRunResult>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason));
            external.abort(ceilingErr);
          }),
      }),
    ).rejects.toBe(ceilingErr);
  });

  it("rethrows a genuine (non-abort) run error untouched", async () => {
    const boom = new Error("boom");
    await expect(
      runWithStuckDetection<StuckRunResult>({
        captureStartSha: async () => "base",
        recoverCommits: async () => [],
        buildStuckResult: () => okResult,
        runOnce: async () => {
          throw boom;
        },
      }),
    ).rejects.toBe(boom);
  });
});

describe("StuckError", () => {
  it("carries the tool name and repeat count", () => {
    const e = new StuckError("Bash", 6);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("StuckError");
    expect(e.toolName).toBe("Bash");
    expect(e.repeatCount).toBe(6);
    expect(e.message).toContain("Bash");
    expect(e.message).toContain("6");
  });
});
