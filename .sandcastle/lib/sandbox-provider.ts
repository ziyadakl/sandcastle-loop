import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { envForModel } from "../providers.js";
import { macHostSandbox } from "./mac-host-sandbox.js";

import type {
  TopLevelRunSpec,
  CreateSandboxSpec,
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
];

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
  readonly hooks: unknown;
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
      const result = await sandcastle.run({
        sandbox: buildSandbox(containerEnv, spec.mounts),
        cwd: spec.cwd ?? config.repoRoot,
        name: spec.name,
        maxIterations: spec.maxIterations ?? 1,
        agent: sandcastle.claudeCode(spec.model, {
          env: envForModel(spec.model),
        }),
        promptFile: spec.promptFile,
        promptArgs: spec.promptArgs,
        idleTimeoutSeconds: spec.idleTimeoutSeconds,
        completionSignal: config.completionSignal,
        signal: spec.signal,
      } as Parameters<typeof sandcastle.run>[0]);
      return { stdout: result.stdout, commits: result.commits };
    },
    async createSandbox(spec) {
      const handle = await sandcastle.createSandbox({
        branch: spec.branch,
        sandbox: buildSandbox(spec.sandboxEnv, spec.mounts),
        cwd: config.repoRoot,
        hooks: config.hooks,
        copyToWorktree: config.copyToWorktree,
        timeouts: { copyToWorktreeMs: config.copyToWorktreeMs },
      } as Parameters<typeof sandcastle.createSandbox>[0]);
      return {
        branch: handle.branch,
        worktreePath: handle.worktreePath,
        async run(opts) {
          const r = await handle.run({
            name: opts.name,
            maxIterations: opts.maxIterations ?? 1,
            agent: sandcastle.claudeCode(opts.model, {
              env: envForModel(opts.model),
            }),
            promptFile: opts.promptFile,
            promptArgs: opts.promptArgs,
            idleTimeoutSeconds: opts.idleTimeoutSeconds,
            completionSignal: config.completionSignal,
            signal: opts.signal,
          } as Parameters<typeof handle.run>[0]);
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
      // Per-call sandboxEnv lands in the mac-host construction here — closes
      // the prior FOLLOW_UPS.md §3 documented gap where the mac-host path
      // only honored construction-time env.
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
          return { stdout: r.stdout, commits: r.commits };
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
