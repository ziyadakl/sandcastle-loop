import { describe, expect, it } from "vitest";
import type { AgentStreamEvent } from "@ai-hero/sandcastle";
import type { SandboxCommandRunner } from "./sandbox-exec.js";
import {
  attachCapturedSessionId,
  capturedSessionIdFromError,
  existingAuthMounts,
  KILL_SANDBOX_PROCESSES_COMMAND,
  makeSessionIdSniffer,
  terminateSandboxProcessesOnAbort,
} from "./sandbox-provider.js";

/**
 * Regression cover for the 2026-08-05 launch failure: the Netcup VPS has no
 * `~/.codex` (codex was never set up there), docker refused the sandbox with
 * "Mount hostPath does not exist", and the loop exited on iteration 1 having
 * claimed nothing. A per-backend credential dir that this run does not use
 * must not be able to end the run.
 */
describe("existingAuthMounts", () => {
  const MOUNTS = [
    { hostPath: "~/.claude", sandboxPath: "/home/agent/.claude" },
    { hostPath: "~/.codex", sandboxPath: "/home/agent/.codex" },
  ] as const;

  const silent = () => {
    /* swallow the skip warning */
  };

  it("drops an auth mount whose host dir is absent", () => {
    const kept = existingAuthMounts(
      MOUNTS,
      (p) => p === "/home/you/.claude",
      "/home/you",
      silent,
    );
    expect(kept.map((m) => m.hostPath)).toEqual(["~/.claude"]);
  });

  it("keeps every mount when all host dirs exist", () => {
    const kept = existingAuthMounts(MOUNTS, () => true, "/home/you", silent);
    expect(kept).toHaveLength(2);
  });

  it("expands a leading ~/ against the given home, not the literal path", () => {
    const seen: string[] = [];
    existingAuthMounts(
      MOUNTS,
      (p) => {
        seen.push(p);
        return true;
      },
      "/home/you",
      silent,
    );
    expect(seen).toEqual(["/home/you/.claude", "/home/you/.codex"]);
  });

  it("leaves a non-tilde host path untouched", () => {
    const seen: string[] = [];
    existingAuthMounts(
      [{ hostPath: "/var/lib/creds", sandboxPath: "/home/agent/creds" }],
      (p) => {
        seen.push(p);
        return true;
      },
      "/home/you",
      silent,
    );
    expect(seen).toEqual(["/var/lib/creds"]);
  });

  it("warns once, naming the resolved path, when a mount is skipped", () => {
    const warnings: string[] = [];
    existingAuthMounts(
      [{ hostPath: "~/.only-here", sandboxPath: "/home/agent/.only-here" }],
      () => false,
      "/home/you",
      (m) => warnings.push(m),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("/home/you/.only-here");
  });
});

/**
 * Regression cover for the 2026-08-07 issue-#803 orphan.
 *
 * The hard ceiling fired at `2026-08-07T06:46:36.664Z` (run banner
 * `05:46:36.664Z` + 3600s) and the loop moved straight on to a recovery pass.
 * The implementer it had just "aborted" went on writing into
 * `.sandcastle/logs/agent-issue-803-implementer.log` until `09:15:27.804Z` —
 * 2h28m later — and was still `tee`-ing into `/tmp/sandcastle-e2e-it1.log`
 * while the recovery reviewer graded that same file.
 *
 * Cause: the SDK only RACES the abort against the run
 * (`dist/index.js:316-323`); the agent itself is a bare
 * `spawn("docker", ["exec", …])` with no signal wiring
 * (`dist/chunk-CP3TYXZA.js:214-265`). Aborting rejected a promise and killed
 * nothing. These tests pin the kill that closes that gap.
 */
describe("terminateSandboxProcessesOnAbort", () => {
  const noExec: SandboxCommandRunner = () => {
    throw new Error("exec must not be called");
  };

  function recordingExec(): {
    exec: SandboxCommandRunner;
    calls: { command: string; timeoutMs?: number }[];
  } {
    const calls: { command: string; timeoutMs?: number }[] = [];
    return {
      calls,
      exec: async (command, opts) => {
        calls.push({ command, timeoutMs: opts?.timeoutMs });
        return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
      },
    };
  }

  it("kills inside the sandbox when the ceiling aborts", async () => {
    const { exec, calls } = recordingExec();
    const controller = new AbortController();
    terminateSandboxProcessesOnAbort({ signal: controller.signal, exec });

    expect(calls).toHaveLength(0); // nothing killed while the run is healthy
    controller.abort(new Error("hard ceiling: exceeded 3600s wall-clock"));
    await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe(KILL_SANDBOX_PROCESSES_COMMAND);
  });

  it("bounds the kill so a wedged daemon cannot hang the abort", async () => {
    const { exec, calls } = recordingExec();
    const controller = new AbortController();
    terminateSandboxProcessesOnAbort({ signal: controller.signal, exec });
    controller.abort();
    await Promise.resolve();
    expect(calls[0]!.timeoutMs).toBeGreaterThan(0);
  });

  it("kills immediately when handed an already-aborted signal", async () => {
    const { exec, calls } = recordingExec();
    terminateSandboxProcessesOnAbort({
      signal: AbortSignal.abort(new Error("already dead")),
      exec,
    });
    await Promise.resolve();
    expect(calls).toHaveLength(1);
  });

  it("kills once, not once per abort event", async () => {
    const { exec, calls } = recordingExec();
    const controller = new AbortController();
    terminateSandboxProcessesOnAbort({ signal: controller.signal, exec });
    controller.abort();
    controller.signal.dispatchEvent(new Event("abort"));
    await Promise.resolve();
    expect(calls).toHaveLength(1);
  });

  it("does not kill after the run finished and detached", async () => {
    const { exec, calls } = recordingExec();
    const controller = new AbortController();
    const { detach } = terminateSandboxProcessesOnAbort({
      signal: controller.signal,
      exec,
    });
    detach(); // the `finally` in the provider's run wrapper
    controller.abort();
    await Promise.resolve();
    expect(calls).toHaveLength(0);
  });

  // Issue #1133 item 2 — the kill is now AWAITABLE and REPORTED, so a caller
  // that reads the check after an abort can wait until the orphaned process is
  // provably gone rather than fire-and-forget.
  it("whenSettled resolves `killed: false` when the run completed without an abort", async () => {
    const { exec } = recordingExec();
    const controller = new AbortController();
    const { detach, whenSettled } = terminateSandboxProcessesOnAbort({
      signal: controller.signal,
      exec,
    });
    detach(); // the provider's `finally`, on a clean run
    await expect(whenSettled).resolves.toEqual({ killed: false });
  });

  it("whenSettled reports a successful kill after an abort", async () => {
    const { exec, calls } = recordingExec();
    const controller = new AbortController();
    const { whenSettled } = terminateSandboxProcessesOnAbort({
      signal: controller.signal,
      exec,
    });
    controller.abort(new Error("hard ceiling: exceeded 3600s wall-clock"));
    await expect(whenSettled).resolves.toEqual({ killed: true, ok: true });
    expect(calls).toHaveLength(1);
  });

  it("whenSettled reports a FAILED kill (ok:false) rather than hanging or rejecting", async () => {
    // The load-bearing case: the process may still be alive, and a caller that
    // awaited the kill before trusting the check now learns that plainly.
    const errors: Error[] = [];
    const controller = new AbortController();
    const { whenSettled } = terminateSandboxProcessesOnAbort({
      signal: controller.signal,
      exec: () =>
        Promise.reject(new Error("docker exec failed: No such container")),
      onError: (err) => errors.push(err),
    });
    controller.abort();
    const outcome = await whenSettled;
    expect(outcome.killed).toBe(true);
    expect(outcome).toMatchObject({ killed: true, ok: false });
    // Reported through BOTH channels — the awaited outcome and onError.
    expect(errors.map((e) => e.message)).toEqual([
      "docker exec failed: No such container",
    ]);
  });

  it("whenSettled resolves `killed: false` immediately when there is no signal", async () => {
    await expect(
      terminateSandboxProcessesOnAbort({ signal: undefined, exec: noExec })
        .whenSettled,
    ).resolves.toEqual({ killed: false });
  });

  it("never rejects when the sandbox is already gone", async () => {
    const errors: Error[] = [];
    const controller = new AbortController();
    terminateSandboxProcessesOnAbort({
      signal: controller.signal,
      exec: () =>
        Promise.reject(new Error("docker exec failed: No such container")),
      onError: (err) => errors.push(err),
    });
    controller.abort();
    await Promise.resolve();
    await Promise.resolve();
    expect(errors.map((e) => e.message)).toEqual([
      "docker exec failed: No such container",
    ]);
  });

  it("is inert without a signal", () => {
    expect(() =>
      terminateSandboxProcessesOnAbort({ signal: undefined, exec: noExec }),
    ).not.toThrow();
  });
});

/**
 * The kill command runs inside `node:22-bookworm-slim`, which ships NO procps —
 * verified 2026-08-07 against the real `sandcastle:my-project` image:
 * `which pkill pgrep ps killall` returns nothing while `which claude` returns a
 * path. So it may only use the shell and `/proc`. It must also spare PID 1
 * (`ENTRYPOINT ["sleep","infinity"]`), because the recovery pass reuses this
 * same container.
 */
describe("KILL_SANDBOX_PROCESSES_COMMAND", () => {
  it("needs no procps binary", () => {
    expect(KILL_SANDBOX_PROCESSES_COMMAND).not.toMatch(
      /\b(pkill|pgrep|killall|ps)\b/,
    );
  });

  it("spares PID 1 so the container outlives the kill", () => {
    expect(KILL_SANDBOX_PROCESSES_COMMAND).toContain('keep=" 1 $$ "');
  });

  it("reads the process table from /proc", () => {
    expect(KILL_SANDBOX_PROCESSES_COMMAND).toContain("/proc/[0-9]*");
  });

  it("succeeds even when it killed nothing", () => {
    expect(KILL_SANDBOX_PROCESSES_COMMAND.trimEnd()).toMatch(/exit 0$/);
  });
});

/**
 * The host-side session-id sniffer (issue #1133 item 1). A judge round killed by
 * its idle timeout throws with no result object, so the only way to attribute
 * its cost is to recover the agent's session id from the output stream before
 * the throw. These tests pin the three behaviours the catch relies on: an
 * `init` line yields the id, a malformed line is inert, and a throw before any
 * `init` line leaves the id undefined so the caller degrades to today's no-cost
 * path — never a lie.
 */
describe("makeSessionIdSniffer + the error session-id carrier", () => {
  const raw = (line: string): AgentStreamEvent => ({
    type: "raw",
    line,
    iteration: 0,
    timestamp: new Date(),
  });

  it("latches session_id from the first Claude `system/init` line", () => {
    const sniffer = makeSessionIdSniffer();
    expect(sniffer.sessionId()).toBeUndefined();
    sniffer.onEvent(
      raw(
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "sess-abc-123",
          cwd: "/repo",
        }),
      ),
    );
    expect(sniffer.sessionId()).toBe("sess-abc-123");
  });

  it("short-circuits after the first hit — a later init line cannot overwrite it", () => {
    const sniffer = makeSessionIdSniffer();
    sniffer.onEvent(
      raw(JSON.stringify({ type: "system", subtype: "init", session_id: "first" })),
    );
    sniffer.onEvent(
      raw(JSON.stringify({ type: "system", subtype: "init", session_id: "second" })),
    );
    expect(sniffer.sessionId()).toBe("first");
  });

  it("a malformed JSON line is inert — the sniffer never throws and the id stays undefined", () => {
    const sniffer = makeSessionIdSniffer();
    expect(() => sniffer.onEvent(raw("{not json at all"))).not.toThrow();
    expect(sniffer.sessionId()).toBeUndefined();
  });

  it("ignores non-raw events and non-init JSON — only the init line counts", () => {
    const sniffer = makeSessionIdSniffer();
    sniffer.onEvent({
      type: "text",
      message: "hello",
      iteration: 0,
      timestamp: new Date(),
    } as AgentStreamEvent);
    sniffer.onEvent(raw(JSON.stringify({ type: "assistant", session_id: "nope" })));
    sniffer.onEvent(
      raw(JSON.stringify({ type: "system", subtype: "other", session_id: "nope" })),
    );
    expect(sniffer.sessionId()).toBeUndefined();
  });

  it("attach + read round-trip: a sniffed id rides the thrown error to the caller", () => {
    const err = new Error("run \"judge-coverage\": idle timeout after 1800000ms");
    attachCapturedSessionId(err, "sess-xyz");
    expect(capturedSessionIdFromError(err)).toBe("sess-xyz");
  });

  it("a pre-init throw leaves the id undefined, so attach is a no-op and the caller costs nothing", () => {
    const sniffer = makeSessionIdSniffer();
    // No init line ever arrived before the timeout — today's behaviour.
    const err = new Error("run \"judge-coverage\": idle timeout after 1800000ms");
    attachCapturedSessionId(err, sniffer.sessionId());
    expect(capturedSessionIdFromError(err)).toBeUndefined();
  });

  it("attaching undefined or empty never stamps a property", () => {
    const a = new Error("x");
    attachCapturedSessionId(a, undefined);
    expect(capturedSessionIdFromError(a)).toBeUndefined();
    const b = new Error("y");
    attachCapturedSessionId(b, "");
    expect(capturedSessionIdFromError(b)).toBeUndefined();
  });

  it("reading from a non-object throw value is undefined, never a throw", () => {
    expect(capturedSessionIdFromError("a string error")).toBeUndefined();
    expect(capturedSessionIdFromError(undefined)).toBeUndefined();
    expect(capturedSessionIdFromError(null)).toBeUndefined();
  });
});
