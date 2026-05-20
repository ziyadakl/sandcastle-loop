/**
 * Tests for {@link withHardCeiling} — the outer wall-clock watchdog that
 * wraps every SDK `run` / `handle.run` call.
 *
 * The SDK's own `idleTimeoutSeconds` resets on every output line, so an
 * agent stuck in a trickle-output loop (observed on affinity-tracker:
 * tsc retries after a host-level OOM kills the tsc child silently) can
 * hang for hours. `withHardCeiling` fires regardless of output activity.
 *
 * Evidence the SDK's inner timer fails to fire in practice: on the
 * affinity-tracker VPS, the loop was launched with the default 1200s
 * implementer idle timeout (no `--implementer-timeout-sec` override), and
 * issues #100 and #107 sat idle for 98 and 55 minutes respectively
 * without the SDK aborting — ~3-5x the configured timeout.
 */
import { describe, it, expect } from "vitest";
import { withHardCeiling } from "../.sandcastle/main.mjs";

describe("withHardCeiling", () => {
  it("aborts a hanging invoke and rejects with the ceiling error", async () => {
    const ceilingMs = 50;
    const hangs = (signal: AbortSignal) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });

    const promise = withHardCeiling(ceilingMs, "test-hang", hangs);
    await expect(promise).rejects.toThrow(
      /hard ceiling: test-hang exceeded 0s wall-clock/,
    );
  });

  it("resolves normally when invoke completes before the ceiling fires", async () => {
    const ceilingMs = 5_000;
    const fast = (_signal: AbortSignal) => Promise.resolve("done");

    await expect(withHardCeiling(ceilingMs, "test-fast", fast)).resolves.toBe(
      "done",
    );
  });

  it("clears the timer on success so it can't fire after resolution", async () => {
    const ceilingMs = 30;
    let abortFired = false;
    const fastWithAbortSpy = (signal: AbortSignal) => {
      signal.addEventListener("abort", () => {
        abortFired = true;
      });
      return Promise.resolve("done");
    };

    const result = await withHardCeiling(
      ceilingMs,
      "test-clear",
      fastWithAbortSpy,
    );
    expect(result).toBe("done");

    // Wait past the original ceiling. If the timer didn't clear on success,
    // the abort would fire here and flip the flag.
    await new Promise((r) => setTimeout(r, 100));
    expect(abortFired).toBe(false);
  });

  it("propagates an invoke rejection unchanged when the ceiling has not fired", async () => {
    const ceilingMs = 5_000;
    const fails = (_signal: AbortSignal) =>
      Promise.reject(new Error("inner failure"));

    await expect(
      withHardCeiling(ceilingMs, "test-fail", fails),
    ).rejects.toThrow("inner failure");
  });

  it("passes a fresh AbortSignal to the invoke (not already aborted)", async () => {
    let observedAborted: boolean | null = null;
    const inspect = (signal: AbortSignal) => {
      observedAborted = signal.aborted;
      return Promise.resolve("done");
    };

    await withHardCeiling(5_000, "test-signal", inspect);
    expect(observedAborted).toBe(false);
  });

  it("labels the error with both the call name and the ceiling in seconds", async () => {
    const ceilingMs = 1500;
    const hangs = (signal: AbortSignal) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });

    try {
      await withHardCeiling(ceilingMs, 'top-level run "planner"', hangs);
      throw new Error("expected withHardCeiling to reject");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain('top-level run "planner"');
      expect(msg).toContain("exceeded 2s wall-clock"); // 1500ms rounds to 2s
    }
  });
});
