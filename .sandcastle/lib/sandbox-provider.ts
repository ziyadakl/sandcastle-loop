import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import * as sandcastle from "@ai-hero/sandcastle";
import type { SandboxHooks } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { envForModel, backendForModel } from "../providers.js";
import { macHostSandbox } from "./mac-host-sandbox.js";
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
// Without them, `claude` and `gh` inside the container can't see the host's
// session and fail with "Not logged in" / "no auth" errors. Note: we
// deliberately do NOT mount ~/.gitconfig — single-file Docker bind mounts
// fail with "Device or resource busy" when git config rewrites the file via
// the standard write-temp-then-rename pattern. Instead we pass GIT_*
// env vars (see buildGitEnv in main.mts).
const AUTH_MOUNTS: readonly Mount[] = [
  { hostPath: "~/.claude", sandboxPath: "/home/agent/.claude" },
  { hostPath: "~/.config/gh", sandboxPath: "/home/agent/.config/gh" },
  // Codex subscription auth (ADR 0012). Read-write so the in-container `codex`
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
  // Container uid 1001 can write the mount (verified, ADR 0012). Harmless for
  // claude/kimi/glm runs (ignored).
  { hostPath: "~/.codex", sandboxPath: "/home/agent/.codex" },
];

/**
 * Pick the agent backend for a model (ADR 0012). Codex models run
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

function buildMounts(extra?: readonly Mount[]): { mounts: Mount[] } {
  return extra && extra.length > 0
    ? { mounts: [...AUTH_MOUNTS, ...extra] }
    : { mounts: [...AUTH_MOUNTS] };
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
  close(): Promise<void>;
}

export interface SandboxProvider {
  topLevelRun(spec: ProviderTopLevelSpec): Promise<RunHandle>;
  createSandbox(spec: ProviderCreateSpec): Promise<ProviderSandboxHandle>;
}

// ---------------------------------------------------------------------------
// Docker adapter
// ---------------------------------------------------------------------------

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
      containerUid: 1001,
      containerGid: 1001,
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
      return {
        branch: handle.branch,
        worktreePath: handle.worktreePath,
        async run(opts) {
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
                handle
                  .run({
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
                      onAgentStreamEvent: (event) =>
                        onEvent(event as StreamEvent),
                    },
                  })
                  .then(shape),
            });
          }

          const r = await handle.run({ ...baseRunOpts, signal: opts.signal });
          return shape(r);
        },
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
   * Cross-host sync opt-in (ADR 0021 §2). Threaded straight to
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
    /** ADR 0021 §2 branch-reuse opt-in, from `crossHostSyncEnabled()`. */
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
