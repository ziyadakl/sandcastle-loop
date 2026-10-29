/**
 * Tests for the sandbox exec seam's one piece of logic — the POSIX `timeout`
 * wrapper (`./sandbox-exec.ts`) — and for the docker adapter that translates
 * the SDK's exec into it (`_execViaSdkSandbox` in `./sandbox-provider.ts`).
 *
 * These two are tested together because they are one contract read from two
 * sides: the wrapper produces the string, the adapter interprets what comes
 * back. Splitting them would let the exit-code half drift from the
 * command-building half, which is precisely the pair that has to agree for a
 * timeout to be reported as a timeout instead of as a failing test suite.
 *
 * The constants asserted here are not invented — they were verified against a
 * live `sandcastle:my-project` container this session: `timeout` is GNU
 * coreutils 9.1, exceeding the bound yields exit 124, and a non-zero exit comes
 * back as an exit code rather than a thrown error.
 */
import { describe, expect, it } from "vitest";

import {
  TIMEOUT_EXIT_CODE,
  TIMEOUT_KILL_EXIT_CODE,
  wrapWithPosixTimeout,
} from "./sandbox-exec.js";
import {
  _execViaSdkSandbox,
  DEFAULT_SANDBOX_EXEC_TIMEOUT_MS,
} from "./sandbox-provider.js";

describe("wrapWithPosixTimeout", () => {
  it("wraps in `timeout -k 10s <sec>s sh -c '<command>'`", () => {
    expect(wrapWithPosixTimeout("pnpm test", 480_000)).toBe(
      "timeout -k 10s 480s sh -c 'pnpm test'",
    );
  });

  it("rounds UP to whole seconds, and never below 1s", () => {
    expect(wrapWithPosixTimeout("x", 1)).toContain(" 1s ");
    expect(wrapWithPosixTimeout("x", 1_500)).toContain(" 2s ");
    expect(wrapWithPosixTimeout("x", 0)).toContain(" 1s ");
  });

  // The reason the command is quoted at all: without it the wrapped command
  // would have to stay a single simple command forever, and the first pipeline
  // anyone wrote would break silently rather than loudly.
  it("escapes embedded single quotes with the standard '\\'' idiom", () => {
    expect(wrapWithPosixTimeout("echo 'hi there'", 1_000)).toBe(
      "timeout -k 10s 1s sh -c 'echo '\\''hi there'\\'''",
    );
  });

  it("keeps shell operators inside the quoted payload, not the wrapper", () => {
    const wrapped = wrapWithPosixTimeout("a && b | c", 1_000);
    expect(wrapped.startsWith("timeout -k 10s 1s sh -c '")).toBe(true);
    expect(wrapped.endsWith("'")).toBe(true);
    // The operators must be INSIDE the quotes — otherwise `timeout` would only
    // bound `a` and the rest would run unbounded.
    expect(wrapped.indexOf("&&")).toBeGreaterThan(wrapped.indexOf("sh -c '"));
  });
});

describe("_execViaSdkSandbox", () => {
  const ok = { stdout: "out", stderr: "err", exitCode: 0 };

  // 2026-08-31 freeze: an unbounded in-sandbox `pnpm install` hung the whole run
  // for 6.5h. Every exec is now wrapped by default, so a caller that forgets a
  // bound still cannot hang the loop.
  it("wraps with the DEFAULT bound when no timeout is given", async () => {
    let seen = "";
    await _execViaSdkSandbox(
      async (cmd) => {
        seen = cmd;
        return ok;
      },
      "pnpm test",
    );
    expect(seen).toBe(
      wrapWithPosixTimeout("pnpm test", DEFAULT_SANDBOX_EXEC_TIMEOUT_MS),
    );
  });

  it("wraps the command when a timeout is given", async () => {
    let seen = "";
    await _execViaSdkSandbox(
      async (cmd) => {
        seen = cmd;
        return ok;
      },
      "pnpm test",
      { timeoutMs: 60_000 },
    );
    expect(seen).toBe("timeout -k 10s 60s sh -c 'pnpm test'");
  });

  // Not decoration: the SDK's docker provider buffers stdout into an unbounded
  // array unless `onLine` is present, in which case it uses a 64KB BoundedTail.
  // A failing vitest run is megabytes. Dropping this callback would turn every
  // failing verification into a memory spike.
  it("passes onLine so the SDK bounds its capture", async () => {
    let sawOnLine = false;
    await _execViaSdkSandbox(async (_cmd, o) => {
      sawOnLine = typeof o?.onLine === "function";
      return ok;
    }, "pnpm test");
    expect(sawOnLine).toBe(true);
  });

  it("maps coreutils exit 124 to timedOut", async () => {
    const r = await _execViaSdkSandbox(
      async () => ({ ...ok, exitCode: TIMEOUT_EXIT_CODE }),
      "pnpm test",
      { timeoutMs: 1_000 },
    );
    expect(r.timedOut).toBe(true);
  });

  it("maps a SIGKILL escalation (137) to timedOut", async () => {
    const r = await _execViaSdkSandbox(
      async () => ({ ...ok, exitCode: TIMEOUT_KILL_EXIT_CODE }),
      "pnpm test",
      { timeoutMs: 1_000 },
    );
    expect(r.timedOut).toBe(true);
  });

  // 2026-08-31 freeze: every exec is now wrapped in `timeout -k`, including the
  // default-bound path, so coreutils exit 124 always means the wrapper fired.
  // There is no longer an unbounded path that could exit 124 for its own reasons.
  it("treats exit 124 as a timeout now that every path is bounded by default", async () => {
    const r = await _execViaSdkSandbox(
      async () => ({ ...ok, exitCode: TIMEOUT_EXIT_CODE }),
      "pnpm test",
    );
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(TIMEOUT_EXIT_CODE);
  });

  it("returns an ordinary non-zero exit untouched", async () => {
    const r = await _execViaSdkSandbox(
      async () => ({ stdout: "1 failed", stderr: "", exitCode: 1 }),
      "pnpm test",
      { timeoutMs: 1_000 },
    );
    expect(r).toEqual({
      stdout: "1 failed",
      stderr: "",
      exitCode: 1,
      timedOut: false,
    });
  });

  it("lets a transport rejection propagate — it is not a test result", async () => {
    await expect(
      _execViaSdkSandbox(async () => {
        throw new Error("docker exec failed");
      }, "pnpm test"),
    ).rejects.toThrow("docker exec failed");
  });
});
