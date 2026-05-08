/**
 * Wave 2 / N3: retry-with-backoff for `transitionLabel`.
 *
 * Mocks `node:child_process.execFile` so the underlying `runGh` call can be
 * driven through deterministic success/failure sequences. Sleep is injected
 * via the `_sleep` test seam so vitest doesn't actually wait for the
 * 500/1500/4000ms backoffs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type ExecFileCall = { file: string; args: string[] };

const { ghCalls, mockState } = vi.hoisted(() => {
  const ghCalls: ExecFileCall[] = [];
  /**
   * Resolver returns either a fixed result for every call, or a per-call
   * sequence (consumed front-to-back). When the sequence is exhausted, the
   * default resolver applies.
   */
  const mockState: {
    sequence:
      | Array<{ kind: "ok"; stdout: string } | { kind: "err"; err: Error }>
      | null;
  } = { sequence: null };
  return { ghCalls, mockState };
});

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
  const { promisify } = await import("node:util");

  const mockExecFile = (
    file: string,
    args: string[],
    _options: unknown,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    ghCalls.push({ file, args: [...args] });
    if (mockState.sequence && mockState.sequence.length > 0) {
      const next = mockState.sequence.shift()!;
      if (next.kind === "err") {
        cb(next.err, "", "");
      } else {
        cb(null, next.stdout, "");
      }
    } else {
      // Default: succeed silently.
      cb(null, "", "");
    }
    return undefined as unknown as ReturnType<typeof actual.execFile>;
  };
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

import { transitionLabel } from "../src/state/gh.js";

beforeEach(() => {
  ghCalls.length = 0;
  mockState.sequence = null;
});

/** No-op sleep so tests don't actually wait for the 500/1500/4000ms backoffs. */
const noopSleep = async (_ms: number): Promise<void> => {};

describe("transitionLabel — Wave 2 / N3 retry-with-backoff", () => {
  it("retries and succeeds when the underlying call fails twice then succeeds", async () => {
    // Sequence: fail, fail, ok. transitionLabel(num, "in-progress",
    // "needs-human") only issues a single underlying gh call (the concrete-
    // from path), so each attempt corresponds to exactly one execFile call.
    mockState.sequence = [
      { kind: "err", err: new Error("gh API 503 (transient)") },
      { kind: "err", err: new Error("gh API 502 (transient)") },
      { kind: "ok", stdout: "" },
    ];

    await transitionLabel(42, "in-progress", "needs-human", noopSleep);

    // Three attempts total (2 failures + 1 success).
    expect(ghCalls).toHaveLength(3);
    // All three calls used the same argv shape (the retry didn't morph the
    // request).
    for (const call of ghCalls) {
      expect(call.args).toEqual([
        "issue",
        "edit",
        "42",
        "--add-label",
        "needs-human",
        "--remove-label",
        "in-progress",
      ]);
    }
  });

  it("throws after 3 failures (retry exhaustion preserves the original error message)", async () => {
    mockState.sequence = [
      { kind: "err", err: new Error("gh API 503 (transient)") },
      { kind: "err", err: new Error("gh API 502 (transient)") },
      { kind: "err", err: new Error("gh API 504 (final)") },
    ];

    await expect(
      transitionLabel(42, "in-progress", "needs-human", noopSleep),
    ).rejects.toThrow(/gh API 504 \(final\)/);

    expect(ghCalls).toHaveLength(3);
  });

  it("does NOT retry validation errors — invalid issueNum throws immediately with no gh call", async () => {
    await expect(
      transitionLabel(0, "in-progress", "needs-human", noopSleep),
    ).rejects.toThrow(/transitionLabel: invalid issueNum/);
    // Validation rejected before the retry loop started — no gh ever ran.
    expect(ghCalls).toHaveLength(0);
  });

  it("does NOT retry validation errors — empty fromLabel throws immediately with no gh call", async () => {
    await expect(
      transitionLabel(42, "", "needs-human", noopSleep),
    ).rejects.toThrow(/'fromLabel' must be a non-empty string/);
    expect(ghCalls).toHaveLength(0);
  });

  it("does NOT retry validation errors — empty 'to' label throws immediately with no gh call", async () => {
    await expect(
      transitionLabel(42, "in-progress", "", noopSleep),
    ).rejects.toThrow(/'to' label must be non-empty/);
    expect(ghCalls).toHaveLength(0);
  });

  it("succeeds on the first attempt without sleeping when the gh call works", async () => {
    // Sleep injection that throws if invoked — proves the green path never
    // pays the backoff.
    const fatalSleep = async (_ms: number): Promise<void> => {
      throw new Error("sleep should not be called on the green path");
    };
    mockState.sequence = [{ kind: "ok", stdout: "" }];

    await transitionLabel(42, "in-progress", "needs-human", fatalSleep);

    expect(ghCalls).toHaveLength(1);
  });
});
