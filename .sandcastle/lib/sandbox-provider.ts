import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import * as sandcastle from "@ai-hero/sandcastle";
import type { AgentStreamEvent, SandboxHooks } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { envForModel, backendForModel } from "../providers.js";
import { macHostSandbox } from "./mac-host-sandbox.js";
import {
  wrapWithPosixTimeout,
  TIMEOUT_EXIT_CODE,
  TIMEOUT_KILL_EXIT_CODE,
  type SandboxCommandRunner,
  type SandboxExecOptions,
  type SandboxExecResult,
} from "./sandbox-exec.js";
import {
  runWithStuckDetection,
  type StreamEvent,
} from "./stuck-detector.js";

const execFileAsync = promisify(execFile);

/** HEAD SHA of a worktree (the pre-run base for stuck-abort commit recovery). */
async function gitHeadSha(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "HEAD"]);
  return stdout.trim();
}

/**
 * Commits made in `cwd` between `startSha` (exclusive) and the current tip,
 * oldest-first (so `.at(-1)` is the newest — the tip the pipeline treats as
 * the implementer's latest commit). Empty when nothing was committed.
 */
async function gitCommitsSince(
  cwd: string,
  startSha: string,
): Promise<readonly { sha: string }[]> {
  const { stdout } = await execFileAsync("git", [
    "-C",
    cwd,
    "log",
    "--format=%H",
    `${startSha}..HEAD`,
  ]);
  return stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .reverse()
    .map((sha) => ({ sha }));
}

import type {
  TopLevelRunSpec,
  SandboxRunSpec,
  RunHandle,
} from "../main.mjs";

// Mount shape used at the call site — matches what callers pass.
type Mount = { hostPath: string; sandboxPath: string; readonly?: boolean };

// Auth mounts — sandcastle's docker provider does NOT auto-mount these.
// Without them, `claude` inside the container can't see the host's session
// and fails with "Not logged in". The host's `~/.config/gh` login is
// deliberately NOT mounted (spec #1334, slice SB): no role in a ticket's
// sandbox may hold a GitHub credential — the host reads the ticket and writes
// every label — and that mount carried a real `repo`-scoped token on the VPS
// even with `GH_TOKEN` gone from the env. Note: we
// deliberately do NOT mount ~/.gitconfig — single-file Docker bind mounts
// fail with "Device or resource busy" when git config rewrites the file via
// the standard write-temp-then-rename pattern. Instead we pass GIT_*
// env vars (see buildGitEnv in main.mts).
const AUTH_MOUNTS: readonly Mount[] = [
  { hostPath: "~/.claude", sandboxPath: "/home/agent/.claude" },
  // Codex subscription auth. Read-write so the in-container `codex`
  // can refresh the token file mid-run. PRODUCTION mechanism (locked): a shared
  // read-write bind-mount, NOT per-sandbox copy-in. The loop runs up to
  // `maxConcurrent` (default 3) sandboxes at once, all sharing this one file.
  // Under OAuth refresh-token rotation, copy-in is the WORSE model — each
  // sandbox holds its own copy, so the first to rotate invalidates every
  // sibling AND the host, a permanent desync needing a manual `codex login`.
  // The shared mount instead converges everyone on one always-current file; its
  // only residual risk is a transient race if two sandboxes refresh at the same
  // instant, and that self-heals at the file level on the next read. So
  // bind-mount dominates copy-in regardless of whether the token rotates.
  // The container uid tracks the host uid (see containerUid below), so the
  // agent can write this mount on any machine. Harmless for claude/kimi/glm
  // runs (ignored).
  { hostPath: "~/.codex", sandboxPath: "/home/agent/.codex" },
];

/**
 * Pick the agent backend for a model. Codex models run
 * `sandcastle.codex` (subscription auth via the mounted `~/.codex`); everything
 * else runs `claudeCode` with the provider's endpoint env. Both call sites
 * (top-level run + per-sandbox run) route through here so the choice is made in
 * exactly one place.
 */
function agentForModel(model: string) {
  return backendForModel(model) === "codex"
    ? sandcastle.codex(model)
    : sandcastle.claudeCode(model, { env: envForModel(model) });
}

/**
 * Auth mounts whose host directory actually exists, warning once per skip.
 *
 * Docker refuses to create a sandbox when ANY bind-mount source is missing
 * ("Mount hostPath does not exist"), and the SDK surfaces that as a planner
 * failure — so one absent OPTIONAL credential dir kills every iteration of the
 * run before a single issue is claimed. That is exactly what happened on the
 * Netcup VPS, which has no `~/.codex` because codex was never set up there:
 * iteration 1 died with `Mount hostPath does not exist: ~/.codex`, the loop
 * exited "with nothing to ship", and nothing in the message suggested that an
 * unused backend's credential dir was the cause.
 *
 * These mounts are per-backend credentials, so a missing one is a
 * degradation, not a fault: a run that never uses codex does not need
 * `~/.codex`. Skip it and say so. A run that DOES use the missing backend
 * still fails, but at the agent with a legible "not logged in", not at
 * sandbox construction with a path error.
 *
 * `extra` mounts are deliberately NOT filtered — those are worktrees and
 * caller-supplied paths that the run genuinely depends on, so a missing one
 * should keep failing loudly.
 */
const skipWarned = new Set<string>();
export function existingAuthMounts(
  mounts: readonly Mount[] = AUTH_MOUNTS,
  exists: (p: string) => boolean = existsSync,
  home: string = os.homedir(),
  warn: (msg: string) => void = (msg) => console.warn(msg),
): Mount[] {
  return mounts.filter((m) => {
    const hostPath = m.hostPath.startsWith("~/")
      ? path.join(home, m.hostPath.slice(2))
      : m.hostPath;
    if (exists(hostPath)) return true;
    if (!skipWarned.has(hostPath)) {
      skipWarned.add(hostPath);
      warn(
        `[mounts] skipping ${m.hostPath} — not present on this host (${hostPath}). ` +
          `Agents that need those credentials will report "not logged in"; ` +
          `everything else is unaffected.`,
      );
    }
    return false;
  });
}

function buildMounts(extra?: readonly Mount[]): { mounts: Mount[] } {
  const auth = existingAuthMounts();
  return extra && extra.length > 0
    ? { mounts: [...auth, ...extra] }
    : { mounts: auth };
}

// Provider-facing specs — orchestrator-facing TopLevelRunSpec / SandboxRunSpec
// plus an AbortSignal injected by the orchestrator's withCeiling wrapper.

export interface ProviderTopLevelSpec extends TopLevelRunSpec {
  readonly signal?: AbortSignal;
}

export interface ProviderRunSpec extends SandboxRunSpec {
  readonly signal?: AbortSignal;
}

export interface ProviderCreateSpec {
  readonly branch: string;
  readonly mounts?: readonly Mount[];
  // Per-call env baked into the sandbox at construction (closes the
  // FOLLOW_UPS.md §3 per-handle env gap on the mac-host path).
  readonly sandboxEnv: Record<string, string>;
}

export interface ProviderSandboxHandle {
  readonly branch: string;
  readonly worktreePath?: string;
  run(opts: ProviderRunSpec): Promise<RunHandle>;
  /**
   * Run one command INSIDE the sandbox. REQUIRED here, unlike the
   * orchestrator-facing `SandboxHandle` where it is optional: both shipped
   * providers implement it, and a provider that quietly lost `exec` would
   * disable the test-verification gate with no signal at all — inconclusive
   * never blocks, so nothing downstream would notice. Making it required turns
   * that into a compile error. See `./sandbox-exec.ts`.
   */
  readonly exec: SandboxCommandRunner;
  close(): Promise<void>;
}

export interface SandboxProvider {
  topLevelRun(spec: ProviderTopLevelSpec): Promise<RunHandle>;
  createSandbox(spec: ProviderCreateSpec): Promise<ProviderSandboxHandle>;
}

// ---------------------------------------------------------------------------
// Host-side session-id sniffer (issue #1133 item 1)
// ---------------------------------------------------------------------------
//
// A judge round killed by its idle timeout throws out of `run()` with no result
// object, so the session id that a clean run forwards through `iterations` never
// reaches the caller — and the round's token spend goes unrecorded even though
// the partial transcript is already on the host (Claude writes it straight to
// the bind-mounted `~/.claude/projects/<slug>/<id>.jsonl` as it runs). The only
// thing missing on the throw path is the id itself.
//
// So we sniff it off the agent's raw output stream. Claude Code's very first
// stream-json line is a `{"type":"system","subtype":"init","session_id":…}`
// record; the SDK surfaces every raw stdout line to `onAgentStreamEvent` as an
// `{ type:"raw"; line }` event when a `logging` callback is wired. We latch the
// first init line's `session_id` and, if the run then throws, stamp that id onto
// the error so the caller can resolve the partial transcript by id and record a
// truthful FLOOR (never invented, never an overcount). Absent an init line
// before the throw, the id stays undefined and the caller degrades to today's
// exact no-cost behaviour.

/** The property a failed `run()` stamps its sniffed session id onto. */
interface CapturedSessionIdCarrier {
  capturedSessionId?: string;
}

/**
 * Stamp a sniffed agent session id onto an error thrown by `run()`, so the
 * caller's catch can attribute a partial-floor cost to a round that produced no
 * result object. A no-op when no id was sniffed (undefined/empty) or the throw
 * value is not a mutable object — both degrade to today's no-cost path.
 */
export function attachCapturedSessionId(
  err: unknown,
  sessionId: string | undefined,
): void {
  if (sessionId === undefined || sessionId === "") return;
  if (typeof err !== "object" || err === null) return;
  try {
    (err as CapturedSessionIdCarrier).capturedSessionId = sessionId;
  } catch {
    // Frozen or exotic error object — nothing to record, degrade silently.
  }
}

/**
 * Read the session id a failed `run()` stamped onto its error, if any. Returns
 * `undefined` when the error carries none — the caller then behaves exactly as
 * it did before the sniffer existed.
 */
export function capturedSessionIdFromError(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const v = (err as CapturedSessionIdCarrier).capturedSessionId;
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * A one-shot session-id sniffer for the agent's raw output stream. Feed it every
 * {@link AgentStreamEvent}; the FIRST Claude Code
 * `{type:"system",subtype:"init"}` line's `session_id` is latched and every
 * later event is ignored (short-circuit after the first hit). A non-`raw` event,
 * a malformed JSON line, or an init line without a string `session_id` all leave
 * the latch untouched — the sniffer never throws, mirroring the never-throw
 * contract the SDK already applies to this callback.
 */
export function makeSessionIdSniffer(): {
  readonly onEvent: (event: AgentStreamEvent) => void;
  readonly sessionId: () => string | undefined;
} {
  let captured: string | undefined;
  return {
    onEvent(event: AgentStreamEvent): void {
      if (captured !== undefined) return;
      if (event.type !== "raw") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.line);
      } catch {
        return;
      }
      if (typeof parsed !== "object" || parsed === null) return;
      const p = parsed as {
        type?: unknown;
        subtype?: unknown;
        session_id?: unknown;
      };
      if (
        p.type === "system" &&
        p.subtype === "init" &&
        typeof p.session_id === "string" &&
        p.session_id !== ""
      ) {
        captured = p.session_id;
      }
    },
    sessionId: () => captured,
  };
}

// ---------------------------------------------------------------------------
// Docker adapter
// ---------------------------------------------------------------------------

/** The SDK sandbox surface this adapter's `exec` needs. */
type SdkExec = (
  command: string,
  opts?: { onLine?: (line: string) => void },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

/**
 * Adapt the SDK's `Sandbox.exec` to the loop's narrower
 * {@link SandboxExecResult}, adding the one thing the SDK does not have: a
 * bound.
 *
 * Two details are load-bearing.
 *
 * 1. The bound is POSIX `timeout` INSIDE the container, not a host-side
 *    `Promise.race`. The SDK's exec takes no signal and no timeout, so a race
 *    would resolve the promise while leaving `pnpm test` running in the
 *    container until teardown. `node:22-bookworm-slim` ships coreutils, so
 *    `timeout` is really there.
 * 2. `onLine` is passed — with an empty callback — purely to opt into the SDK's
 *    `BoundedTail` capture. Without it the docker provider accumulates every
 *    chunk of stdout in an unbounded array (chunk-CP3TYXZA.js), and a failing
 *    vitest run is megabytes of stack traces. The empty function is not dead
 *    code; it is the flag that switches capture from unbounded to a 64KB tail.
 *
 * `cwd` is deliberately not forwarded: the SDK defaults it to the sandbox's
 * repo directory, which is the in-container path of the bind-mounted worktree.
 * See `./sandbox-exec.ts`.
 */
/**
 * Wall-clock bound applied when a caller does NOT pass `timeoutMs` (2026-08-31
 * freeze). Before this, an omitted `timeoutMs` meant the command ran UNBOUNDED
 * inside the container — exactly the class of hang that froze the loop for 6.5h
 * (an in-sandbox install with no timeout). Now a caller that forgets a bound is
 * still killed. Deliberately SLACKER than every explicit gate bound (lint 10m,
 * per-package test 8m) so it only ever fires as a backstop for a caller that set
 * none, never racing a gate's own in-sandbox kill-and-report.
 */
export const DEFAULT_SANDBOX_EXEC_TIMEOUT_MS = 15 * 60_000;

export async function _execViaSdkSandbox(
  sdkExec: SdkExec,
  command: string,
  opts?: SandboxExecOptions,
): Promise<SandboxExecResult> {
  // Bound EVERY exec, defaulting when the caller omits one (2026-08-31 freeze):
  // an unbounded `docker exec` is an INDEFINITE freeze the recovery chain never
  // sees. An explicit `timeoutMs` is still honoured exactly as before; only the
  // no-timeout path changes, from unbounded to the default backstop above.
  const effectiveTimeoutMs = opts?.timeoutMs ?? DEFAULT_SANDBOX_EXEC_TIMEOUT_MS;
  const bounded = wrapWithPosixTimeout(command, effectiveTimeoutMs);
  const result = await sdkExec(bounded, { onLine: () => {} });
  // Every path is now bounded, so a coreutils timeout exit (124 / SIGKILL 137)
  // always means the bound fired.
  const timedOut =
    result.exitCode === TIMEOUT_EXIT_CODE ||
    result.exitCode === TIMEOUT_KILL_EXIT_CODE;
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    timedOut,
  };
}

// ---------------------------------------------------------------------------
// Abort → real termination (docker)
// ---------------------------------------------------------------------------

/**
 * POSIX `sh` that kills every process inside the sandbox container EXCEPT the
 * container's PID 1 keep-alive and the killer's own process tree.
 *
 * WHY A SHELL COMMAND AND NOT A SIGNAL. The SDK gives us no handle on the agent
 * process. It runs the agent as `spawn("docker", ["exec", …, "sh", "-c", cmd])`
 * with no `AbortSignal` and no timeout (`dist/chunk-CP3TYXZA.js:214-265`), it
 * generates the container name internally and never exposes it
 * (`containerName = "sandcastle-" + randomUUID()`, same file, line 133), and the
 * handle it hands back offers only `exec` / `copyFileIn` / `copyFileOut` /
 * `close`. Killing the host-side `docker exec` client would not help either —
 * the docker daemon keeps the in-container process running. `exec` is therefore
 * the ONLY channel that reaches the process, and from inside the container
 * `/proc` is the only way to find it.
 *
 * WHY NOT MATCH THE AGENT BY NAME. The binary differs per backend (`claude`,
 * `codex`, and whatever `agentForModel` grows next), a Node CLI's `comm` is not
 * its wrapper's name, and a miss here fails silently — which is the exact class
 * of bug this whole change exists to remove. "Everything that is not PID 1 and
 * not us" needs no such table and stays correct when a new backend lands.
 *
 * WHY THAT IS SAFE. The container is single-purpose and single-tenant: one
 * sandbox per issue (concurrent issues get their own container), and the loop
 * never overlaps an agent run with an `exec` gate — the test-verification and
 * migration gates run only after `run()` has returned. So at the moment the
 * ceiling fires, the only things alive besides PID 1 are the agent we are
 * abandoning and its children.
 *
 * WHY PID 1 SURVIVES. `.sandcastle/Dockerfile` ends `ENTRYPOINT ["sleep",
 * "infinity"]` purely to hold the container open between `docker exec`s. The
 * fixer REUSES this same sandbox (`main.mts` passes the live handle
 * straight into `runFixer`), so killing PID 1 would stop the container and
 * take the fixer down with it.
 *
 * IDEMPOTENT AND SAFE WHEN NOTHING IS RUNNING. `kill` on an already-dead or
 * already-reaped pid is swallowed by `2>/dev/null`, the loop simply finds
 * nothing to kill, and the command still `exit 0`s.
 *
 * VERIFIED against a real `sandcastle:<project>` image on 2026-08-07: a
 * `docker exec` sh (PPid 0) plus its node child were both killed, PID 1 `sleep`
 * survived, and re-running the command was a no-op. Note the killed child is
 * left as a `Z (zombie)` reparented to PID 1 — `sleep` never reaps — so it stays
 * visible in `/proc`. It is dead: no CPU, no output, no file handles.
 */
export const KILL_SANDBOX_PROCESSES_COMMAND = [
  // Everything we must NOT kill: PID 1, ourselves, and our ancestors (the
  // `timeout`/`sh` hops `wrapWithPosixTimeout` adds around this command).
  'keep=" 1 $$ "',
  'p=$(awk \'/^PPid:/{print $2}\' /proc/$$/status 2>/dev/null)',
  'while [ -n "$p" ] && [ "$p" != 0 ] && [ "$p" != 1 ]; do' +
    ' keep="$keep$p ";' +
    " p=$(awk '/^PPid:/{print $2}' /proc/$p/status 2>/dev/null);" +
    " done",
  "for d in /proc/[0-9]*; do" +
    " pid=${d#/proc/};" +
    ' case "$keep" in *" $pid "*) continue;; esac;' +
    ' kill -9 "$pid" 2>/dev/null;' +
    " done",
  "exit 0",
].join("; ");

/** How long the kill command itself may take before it is abandoned. */
const KILL_COMMAND_TIMEOUT_MS = 30_000;

/**
 * The result of the abort-triggered kill, as awaited by a caller that must know
 * the container process is dead before it reads files that process could touch.
 *
 *   - `killed: false` — the signal never aborted (or the listener was detached
 *     before any abort), so nothing needed killing.
 *   - `killed: true, ok: true` — the kill `exec` returned.
 *   - `killed: true, ok: false` — the kill `exec` failed (also routed to
 *     `onError`); the process may still be alive, and the caller knows it.
 */
export type SandboxKillOutcome =
  | { readonly killed: false }
  | { readonly killed: true; readonly ok: true }
  | { readonly killed: true; readonly ok: false; readonly error: Error };

export interface SandboxTermination {
  /** Remove the abort listener. ALWAYS call it (a `finally` is the right place)
   *  so a completed run does not leave a listener on a long-lived signal. */
  readonly detach: () => void;
  /**
   * Resolves once the abort-triggered kill has finished — or immediately, with
   * `killed: false`, when the signal never fired. NEVER rejects: a failed kill
   * resolves `ok: false` and is also routed to `onError`, so awaiting it can
   * never turn an aborted run into an unhandled rejection.
   *
   * AWAIT THIS before the next role reads files the aborted agent could still be
   * writing (issue #1133 item 2). The SDK only races the abort against the run;
   * the `docker exec` it left behind is provably gone only once the kill `exec`
   * has returned, so a caller that trusts the check bytes after an abort must
   * wait for this rather than fire-and-forget.
   */
  readonly whenSettled: Promise<SandboxKillOutcome>;
}

/**
 * Make an `AbortSignal` actually stop the agent running inside the sandbox.
 *
 * The hard ceiling (`withHardCeiling` in `main.mts`) aborts a signal and the SDK
 * merely races that abort against the run — the agent's `docker exec` is never
 * cancelled, so it keeps running, keeps burning the container, and keeps writing
 * into files the next role reads. On 2026-08-07 the issue-#803 implementer
 * outlived its own abort by 2h28m and was still appending to
 * `/tmp/sandcastle-e2e-it1.log` while the recovery reviewer graded that very
 * file. This closes that gap by issuing a real kill over the one channel the SDK
 * does expose, `exec`.
 *
 * AWAITED AND REPORTED (issue #1133 item 2). This was fire-and-forget, on the
 * argument that a doomed run must not wait on its own cleanup. But the judge's
 * disagreement round reads the check the aborted agent may still be editing, and
 * a kill nobody waits for guarantees nothing about whether that process is dead
 * when the next role looks. So the kill is now awaitable via {@link
 * SandboxTermination.whenSettled}: a caller that trusts the check after an abort
 * waits for it, while an ordinary completed run resolves it immediately with
 * `killed: false` and pays nothing. It still never REJECTS — every error routes
 * to `onError` AND resolves `ok: false` — and the `exec` is bounded by
 * {@link KILL_COMMAND_TIMEOUT_MS}, so a wedged docker daemon caps the wait
 * rather than hanging the run.
 */
export function terminateSandboxProcessesOnAbort(opts: {
  readonly signal?: AbortSignal;
  readonly exec: SandboxCommandRunner;
  readonly onError?: (err: Error) => void;
}): SandboxTermination {
  const { signal, exec, onError } = opts;
  if (!signal) {
    return { detach: () => {}, whenSettled: Promise.resolve({ killed: false }) };
  }

  let resolveSettled!: (outcome: SandboxKillOutcome) => void;
  const whenSettled = new Promise<SandboxKillOutcome>((resolve) => {
    resolveSettled = resolve;
  });

  let fired = false;
  const kill = (): void => {
    // Idempotent at the JS level too: `abort` fires once, but a caller may also
    // hand us an already-composed signal that another layer aborts again.
    if (fired) return;
    fired = true;
    void exec(KILL_SANDBOX_PROCESSES_COMMAND, {
      timeoutMs: KILL_COMMAND_TIMEOUT_MS,
    }).then(
      () => resolveSettled({ killed: true, ok: true }),
      (err: unknown) => {
        const e = err instanceof Error ? err : new Error(String(err));
        onError?.(e);
        resolveSettled({ killed: true, ok: false, error: e });
      },
    );
  };

  if (signal.aborted) {
    kill();
    return { detach: () => {}, whenSettled };
  }
  signal.addEventListener("abort", kill, { once: true });
  const detach = (): void => {
    signal.removeEventListener("abort", kill);
    // Detached before any abort → the kill will never fire, so settle
    // `whenSettled` here or a caller awaiting it would hang forever. If the
    // abort already fired, `whenSettled` is owned by the in-flight `exec`.
    if (!fired) resolveSettled({ killed: false });
  };
  return { detach, whenSettled };
}

/**
 * Hard per-container limits (spec #1368, decision 1). On 2026-10-13 one `grep`
 * inside one sandbox grew to 18 GB and froze the whole server. Each container
 * now dies alone at its own ceiling. The server's `sandcastle.slice` holds the
 * shared 20 GB cap for all containers together. Swap equal to memory means the
 * container gets no swap. `memory`, `memorySwap`, `pidsLimit` and
 * `cgroupParent` come from the patched `@ai-hero/sandcastle`
 * (`patches/@ai-hero__sandcastle@0.12.0.patch`).
 */
export const CONTAINER_MEMORY = "8g";
export const CONTAINER_MEMORY_SWAP = "8g";
export const CONTAINER_PIDS_LIMIT = 4096;
export const CONTAINER_CGROUP_PARENT = "sandcastle.slice";

export interface DockerProviderConfig {
  readonly imageName: string;
  readonly repoRoot: string;
  readonly hooks: SandboxHooks;
  readonly copyToWorktree: readonly string[];
  readonly copyToWorktreeMs: number;
  readonly completionSignal: readonly string[];
  /**
   * Loop-cost ticket 03 — opt-in (`--stuck-detector`), docker-only. When true,
   * the per-issue implementer run attaches a live stuck-detector that aborts a
   * demonstrably-spinning session and hands its committed work to the reviewer.
   * Default/undefined = off = byte-for-byte today's run path.
   */
  readonly stuckDetector?: boolean;
}

export function makeDockerProvider(
  config: DockerProviderConfig,
  containerEnv: Record<string, string>,
): SandboxProvider {
  const buildSandbox = (
    sandboxEnv: Record<string, string>,
    extra?: readonly Mount[],
  ) =>
    docker({
      imageName: config.imageName,
      env: sandboxEnv,
      // Must match the uid the IMAGE was built with, which
      // `sandcastle docker build-image` sets to the BUILD HOST's own uid/gid
      // via the AGENT_UID/AGENT_GID build args. Both sides therefore track
      // the host, and the bind-mounted ~/.claude / ~/.codex
      // are owned by the same user inside and out.
      //
      // This was hardcoded to 1001 (the retired Hostinger "hub" deploy user).
      // On the Netcup VPS, where deploy is 1000, that made the 0600
      // `.credentials.json` unreadable and `~/.claude` unwritable inside every
      // container — subscription auth dead on arrival, with no error until an
      // agent reported "Not logged in". Do NOT re-hardcode either side.
      //
      // An image built before this change (agent user at 1001) will now fail
      // the SDK's `checkImageUid` guard with an explicit UID-mismatch error
      // rather than running and silently failing auth — rebuild the image.
      containerUid: process.getuid?.() ?? 1001,
      containerGid: process.getgid?.() ?? 1001,
      memory: CONTAINER_MEMORY,
      memorySwap: CONTAINER_MEMORY_SWAP,
      pidsLimit: CONTAINER_PIDS_LIMIT,
      cgroupParent: CONTAINER_CGROUP_PARENT,
      ...buildMounts(extra),
    });
  return {
    async topLevelRun(spec) {
      // [...config.completionSignal] sheds the `readonly` so the SDK's
      // mutable `string[]` signature is satisfied without a whole-object cast.
      const result = await sandcastle.run({
        sandbox: buildSandbox(containerEnv, spec.mounts),
        cwd: spec.cwd ?? config.repoRoot,
        name: spec.name,
        maxIterations: spec.maxIterations ?? 1,
        agent: agentForModel(spec.model),
        promptFile: spec.promptFile,
        promptArgs: spec.promptArgs,
        idleTimeoutSeconds: spec.idleTimeoutSeconds,
        completionSignal: [...config.completionSignal],
        signal: spec.signal,
      });
      // Forward per-iteration session metadata (sessionFilePath/sessionId) so
      // the run-level roles (planner, merger, post-merge reviewer/fixer) can
      // resolve their session JSONL for Phase-1 cost telemetry — same shape the
      // createSandbox `run` path below forwards. Absent on test seams → [].
      return {
        stdout: result.stdout,
        commits: result.commits,
        iterations: result.iterations?.map((it) => ({
          sessionFilePath: it.sessionFilePath,
          sessionId: it.sessionId,
        })),
      };
    },
    async createSandbox(spec) {
      const handle = await sandcastle.createSandbox({
        branch: spec.branch,
        sandbox: buildSandbox(spec.sandboxEnv, spec.mounts),
        cwd: config.repoRoot,
        hooks: config.hooks,
        copyToWorktree: [...config.copyToWorktree],
        timeouts: { copyToWorktreeMs: config.copyToWorktreeMs },
      });
      const execInSandbox: SandboxCommandRunner = (command, execOpts) =>
        _execViaSdkSandbox((cmd, o) => handle.exec(cmd, o), command, execOpts);
      return {
        branch: handle.branch,
        worktreePath: handle.worktreePath,
        async run(opts) {
          /**
           * Every call that hands a signal to the SDK goes through here, so the
           * kill is attached to the signal the SDK ACTUALLY receives — which is
           * not always `opts.signal`. On the stuck-detector path the SDK gets a
           * composed signal (`AbortSignal.any([ceiling, stuckController])`,
           * `lib/stuck-detector.ts`), and a stuck-abort orphans the agent
           * exactly like a ceiling-abort does; attaching to `opts.signal` alone
           * would leave that second case leaking.
           */
          const runAndKillOnAbort = async (
            runOpts: Parameters<typeof handle.run>[0] & {
              readonly signal?: AbortSignal;
            },
          ): Promise<Awaited<ReturnType<typeof handle.run>>> => {
            const { detach, whenSettled } = terminateSandboxProcessesOnAbort({
              signal: runOpts.signal,
              exec: execInSandbox,
              onError: (err) =>
                console.warn(
                  `[sandbox] could not kill the aborted agent in ${handle.branch}'s ` +
                    `container: ${err.message}. It may still be running — check ` +
                    `\`docker ps\` if the run log keeps growing.`,
                ),
            });
            try {
              return await handle.run(runOpts);
            } finally {
              // Await the kill before returning (issue #1133 item 2). On a clean
              // run `whenSettled` resolves immediately (`killed: false`) and this
              // costs nothing; on an ABORTED run it waits — bounded by the kill's
              // own timeout — so the orphaned `docker exec` is provably gone
              // before the next role reads the files it was writing. `detach`
              // first, so a clean run's `whenSettled` is resolved rather than
              // left pending.
              detach();
              await whenSettled;
            }
          };
          const baseRunOpts = {
            name: opts.name,
            maxIterations: opts.maxIterations ?? 1,
            agent: agentForModel(opts.model),
            promptFile: opts.promptFile,
            promptArgs: opts.promptArgs,
            idleTimeoutSeconds: opts.idleTimeoutSeconds,
            completionSignal: [...config.completionSignal],
          };
          type SdkRunResult = Awaited<ReturnType<typeof handle.run>>;
          const shape = (r: SdkRunResult) => ({
            stdout: r.stdout,
            commits: r.commits,
            iterations: r.iterations.map((it) => ({
              sessionFilePath: it.sessionFilePath,
              sessionId: it.sessionId,
            })),
          });

          // Stuck-detector path (ticket 03) — opt-in and only when the worktree
          // is on the host so we can recover its committed work after an abort.
          // Absent either condition, fall through to today's exact call.
          if (config.stuckDetector && handle.worktreePath) {
            const worktreePath = handle.worktreePath;
            return runWithStuckDetection({
              externalSignal: opts.signal,
              captureStartSha: () => gitHeadSha(worktreePath),
              recoverCommits: (startSha) =>
                gitCommitsSince(worktreePath, startSha),
              buildStuckResult: (commits, detail) => ({
                stdout: `[stuck-detector] run aborted — ${detail}`,
                commits,
                iterations: [],
                // Ticket 03: flag the graceful result so runImplementer routes
                // this partial work to the reviewer instead of tripping its
                // envelope/skill/no-commit gates (see main.mts runImplementer).
                stuckAborted: true,
              }),
              runOnce: (signal, onEvent) =>
                runAndKillOnAbort({
                  ...baseRunOpts,
                  signal,
                  logging: {
                    type: "file",
                    // Unique per issue+role so concurrent implementers don't
                    // share a log file. The SDK is already in file mode by
                    // default; passing it explicitly only adds the callback.
                    path: path.join(
                      config.repoRoot,
                      ".sandcastle",
                      "logs",
                      `${handle.branch.replace(/[^A-Za-z0-9._-]/g, "_")}-${opts.name}.log`,
                    ),
                    onAgentStreamEvent: (event) => onEvent(event as StreamEvent),
                  },
                }).then(shape),
            });
          }

          // The plain judge-round path (no stuck detector). Wire the SDK's
          // per-event callback purely to sniff the agent's session id off its
          // raw output stream, reusing the same unique per-issue+role log path
          // the stuck-detector path above already writes to. On an idle-timeout
          // throw the id is stamped onto the error so the caller can record a
          // partial-floor cost for the killed round (#1133 item 1); on a clean
          // run the sniffer is inert and `shape(r)` carries the id as before.
          const sniffer = makeSessionIdSniffer();
          try {
            const r = await runAndKillOnAbort({
              ...baseRunOpts,
              signal: opts.signal,
              logging: {
                type: "file",
                path: path.join(
                  config.repoRoot,
                  ".sandcastle",
                  "logs",
                  `${handle.branch.replace(/[^A-Za-z0-9._-]/g, "_")}-${opts.name}.log`,
                ),
                onAgentStreamEvent: sniffer.onEvent,
              },
            });
            return shape(r);
          } catch (err) {
            attachCapturedSessionId(err, sniffer.sessionId());
            throw err;
          }
        },
        exec: execInSandbox,
        close: async () => {
          await handle.close();
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// mac-host adapter
// ---------------------------------------------------------------------------

export interface MacHostProviderConfig {
  readonly repoRoot: string;
  /**
   * Cross-host sync opt-in. Threaded straight to
   * `MacHostSandboxOptions.crossHostSync` so the per-issue worktree-add can
   * reuse a WIP checkpoint. Defaults to `false` — flag-off is byte-for-byte
   * today's force-reset from HEAD.
   */
  readonly crossHostSync?: boolean;
}

export function makeMacHostProvider(
  config: MacHostProviderConfig,
  containerEnv: Record<string, string>,
): SandboxProvider {
  return {
    async topLevelRun(spec) {
      const factory = macHostSandbox({
        repoRoot: config.repoRoot,
        env: containerEnv,
      });
      const r = await factory.run({
        name: spec.name,
        maxIterations: spec.maxIterations ?? 1,
        model: spec.model,
        promptFile: spec.promptFile,
        promptArgs: spec.promptArgs,
        idleTimeoutSeconds: spec.idleTimeoutSeconds,
        cwd: spec.cwd,
        signal: spec.signal,
      });
      // Forward per-iteration session metadata for Phase-1 cost telemetry,
      // normalized to the SAME {sessionFilePath, sessionId} shape the docker
      // topLevelRun emits (avoids a latent shape-mismatch between providers).
      return {
        stdout: r.stdout,
        commits: r.commits,
        iterations: (r.iterations ?? []).map((it) => ({
          sessionFilePath: it.sessionFilePath,
          sessionId: it.sessionId,
        })),
      };
    },
    async createSandbox(spec) {
      // Per-call sandboxEnv lands in the mac-host construction here. The
      // previous SandboxFactoryHandles shape constructed the mac-host
      // sandbox once at orchestrator startup with `containerEnv` and could
      // not honor the per-call implementer-provider env that the docker
      // path threads via `sandcastle.claudeCode(model, { env })`. The new
      // shape closes that gap.
      const factory = macHostSandbox({
        repoRoot: config.repoRoot,
        env: spec.sandboxEnv,
        crossHostSync: config.crossHostSync,
      });
      const handle = await factory.createSandbox({ branch: spec.branch });
      return {
        branch: handle.branch,
        worktreePath: handle.worktreePath,
        run: async (opts) => {
          // Session-id-on-throw parity with the docker path (#1133 item 1) needs
          // no sniffer HERE: `MacHostRunSpec` exposes no stream callback, and
          // the mac-host helper already knows its own forced `--session-id`. It
          // stamps that id onto any error it throws (`spawnAgent`'s `safeReject`
          // in ./mac-host-sandbox.ts), which propagates through this passthrough
          // unchanged to the judge's transport catch. Nothing to add on the
          // failure path here; the clean path forwards the id via `iterations`.
          const r = await handle.run({
            name: opts.name,
            maxIterations: opts.maxIterations ?? 1,
            model: opts.model,
            promptFile: opts.promptFile,
            promptArgs: opts.promptArgs,
            idleTimeoutSeconds: opts.idleTimeoutSeconds,
            signal: opts.signal,
          });
          // Forward the per-iteration session metadata the mac-host helper now
          // captures (a forced `--session-id` per run) so the skill-discipline
          // gate can resolve the session JSONL and read the invoked skills.
          // Falls back to [] for the test seams that don't populate it.
          return { stdout: r.stdout, commits: r.commits, iterations: r.iterations ?? [] };
        },
        // On mac-host the "sandbox" IS the host, so this runs in the per-issue
        // worktree with the host's own toolchain. That is the only environment
        // available on this provider — but be clear about what it does NOT
        // guarantee: unlike the docker path, NOTHING here installs
        // dependencies. `macHostSandbox.createSandbox` does `preCleanWorktree`
        // + `git worktree add` and stops; there is no mac-host analogue of the
        // docker `onSandboxReady` hook (main.mts says so where that hook is
        // wired). So the worktree has a `node_modules` only if the implementer
        // agent happened to run an install during its own session.
        //
        // Consequence, recorded so the next reader does not re-derive it: on
        // mac-host this gate frequently reports INCONCLUSIVE rather than
        // verifying. That is the honest outcome and it never blocks a ticket.
        // The platform bug this rework fixed was macOS + DOCKER, which is the
        // configuration this repo actually runs; making mac-host verify would
        // need a dependency-install step on that path, which is a separate
        // change with its own cost.
        exec: (command, execOpts) => handle.exec(command, execOpts),
        close: () => handle.close(),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Factory entry point
// ---------------------------------------------------------------------------

export function buildSandboxProvider(
  args: {
    sandbox: "docker" | "mac-host";
    imageName: string;
    repoRoot: string;
    /** Branch-reuse opt-in, from `crossHostSyncEnabled()`. */
    crossHostSync?: boolean;
    /** Ticket 03 opt-in (`--stuck-detector`); docker-only, ignored on mac-host. */
    stuckDetector?: boolean;
  },
  containerEnv: Record<string, string>,
  dockerConfig?: Omit<DockerProviderConfig, "imageName" | "repoRoot">,
): SandboxProvider {
  if (args.sandbox === "mac-host") {
    return makeMacHostProvider(
      { repoRoot: args.repoRoot, crossHostSync: args.crossHostSync },
      containerEnv,
    );
  }
  if (!dockerConfig) {
    throw new Error("docker provider requires dockerConfig");
  }
  return makeDockerProvider(
    {
      ...dockerConfig,
      imageName: args.imageName,
      repoRoot: args.repoRoot,
      stuckDetector: args.stuckDetector,
    },
    containerEnv,
  );
}
