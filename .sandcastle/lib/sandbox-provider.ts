import * as sandcastle from "@ai-hero/sandcastle";
import type { SandboxHooks } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { envForModel, backendForModel } from "../providers.js";
import { macHostSandbox } from "./mac-host-sandbox.js";

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
      return { stdout: result.stdout, commits: result.commits };
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
          const r = await handle.run({
            name: opts.name,
            maxIterations: opts.maxIterations ?? 1,
            agent: agentForModel(opts.model),
            promptFile: opts.promptFile,
            promptArgs: opts.promptArgs,
            idleTimeoutSeconds: opts.idleTimeoutSeconds,
            completionSignal: [...config.completionSignal],
            signal: opts.signal,
          });
          return {
            stdout: r.stdout,
            commits: r.commits,
            iterations: r.iterations.map((it) => ({
              sessionFilePath: it.sessionFilePath,
              sessionId: it.sessionId,
            })),
          };
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
      return { stdout: r.stdout, commits: r.commits };
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
          // Always return an iterations array (empty on mac-host until the
          // mac-host helper populates per-iteration session metadata —
          // tracked separately) so the consumer's RunHandle.iterations
          // field is consistently typed across providers.
          return { stdout: r.stdout, commits: r.commits, iterations: [] };
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
  args: { sandbox: "docker" | "mac-host"; imageName: string; repoRoot: string },
  containerEnv: Record<string, string>,
  dockerConfig?: Omit<DockerProviderConfig, "imageName" | "repoRoot">,
): SandboxProvider {
  if (args.sandbox === "mac-host") {
    return makeMacHostProvider({ repoRoot: args.repoRoot }, containerEnv);
  }
  if (!dockerConfig) {
    throw new Error("docker provider requires dockerConfig");
  }
  return makeDockerProvider(
    { ...dockerConfig, imageName: args.imageName, repoRoot: args.repoRoot },
    containerEnv,
  );
}
