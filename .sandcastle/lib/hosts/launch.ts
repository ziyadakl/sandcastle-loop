// Multi-host control (workstream B4) — the per-host LAUNCH safety gate.
//
// `runLaunch` factors the prose pre-flight from the sandcastle-run / -stop
// skills into real, testable code: it runs the six safety checks IN ORDER on a
// single host and short-circuits to a {@link HostResult} on the first failure —
// it NEVER forces anything (no `git pull`, no `git reset`, no token forwarding).
// Only when every gate passes does it build + exec the launch command detached.
//
// The transport is an INJECTED collaborator ({@link LaunchDeps.exec}): tests
// drive the gate DECISIONS with a fake exec and never touch real ssh/git. The
// real exec (local spawn vs `ssh <alias> -- <argv>`) lives in the thin
// ../scripts/launch.mts runner, mirroring the check-upstream.ts / .mts split.

import { isLocalHost, type HostConfig } from "./registry.js";
import type { HostOutcome, HostResult } from "./result.js";

/**
 * The fixed set of agent modes a launch may request. `claude` (the default
 * Anthropic backend), `codex` (OpenAI backend, ADR 0012), and the two
 * claude-backend endpoint overrides `kimi` / `glm` (see providers.ts). This is
 * the launch surface's own axis — the skills ask the user for one of these four
 * and pass it through as `--mode`; it is deliberately distinct from the
 * narrower `AgentBackend` (claude|codex) and `ProviderName` (anthropic|kimi|glm)
 * types, neither of which covers this exact set.
 */
export const LAUNCH_MODES = ["claude", "codex", "kimi", "glm"] as const;
export type LaunchMode = (typeof LAUNCH_MODES)[number];

/** Type guard: is `s` one of the four canonical launch modes? */
export function isLaunchMode(s: string): s is LaunchMode {
  return (LAUNCH_MODES as readonly string[]).includes(s);
}

/** Result of running one argv on a host. Mirrors main.mts runGit's shape. */
export interface ExecResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export interface LaunchDeps {
  /**
   * Run `argv` on `host`: locally when `transport === "local"`, else over
   * `ssh <transport> -- <argv>`. The command runs with the host's repo checkout
   * as its working directory (so `$PWD` inside a `bash -lc` script is that
   * repo root — the pgrep cwd filter and the remote PATH prefix both rely on it).
   */
  exec: (host: HostConfig, argv: string[]) => Promise<ExecResult>;
}

export interface LaunchSpec {
  readonly branch: string;
  readonly mode: LaunchMode;
  readonly iterations: number;
  readonly base?: string;
  readonly action: "run" | "resume";
  readonly dryRun?: boolean;
}

/** Path of the per-host launch log; per-host (not shared) to avoid confounds. */
function logPath(host: HostConfig): string {
  return `/tmp/sandcastle-${host.name}.log`;
}

/**
 * The wrapper invocation + its flags (no detach wrapping). Per-host concurrency
 * comes from the REGISTRY (`host.maxConcurrent`), which always wins over any
 * spec-level hint. Split out so the detach forms below share one flag string.
 */
function wrapperInvocation(host: HostConfig, spec: LaunchSpec): string {
  const flags = [
    `--branch ${spec.branch}`,
    `--mode ${spec.mode}`,
    `--iterations ${spec.iterations}`,
    `--max-concurrent ${host.maxConcurrent}`,
  ];
  if (spec.base) flags.push(`--base ${spec.base}`);
  if (spec.action === "resume") flags.push("--resume");
  return `bash .sandcastle/sandcastle-wrapper.sh ${flags.join(" ")}`;
}

/**
 * Build the exact detached launch command string for `host`. The detach form
 * differs by transport:
 *
 * - local (macOS): `nohup <wrapper> > <log> 2>&1 </dev/null & disown` — NO
 *   `setsid` (it does not exist on macOS and mis-parses into a double launch).
 * - remote (ssh): the remote Linux shell reaps children when ssh closes, so it
 *   MUST `setsid nohup <wrapper> … </dev/null &` to survive the disconnect;
 *   prefixed with `PATH="$PWD/node_modules/.bin:$PATH"` because a
 *   non-interactive ssh shell has a minimal PATH and bare `tsx` won't resolve.
 *
 * This is returned verbatim in `HostResult.detail` for `--dry-run`, so it is the
 * single source of truth for both the dry-run preview and the real exec.
 */
export function buildLaunchCommand(host: HostConfig, spec: LaunchSpec): string {
  const wrapper = wrapperInvocation(host, spec);
  const log = logPath(host);
  if (isLocalHost(host)) {
    return `nohup ${wrapper} > ${log} 2>&1 </dev/null & disown`;
  }
  return `PATH="$PWD/node_modules/.bin:$PATH" setsid nohup ${wrapper} > ${log} 2>&1 </dev/null &`;
}

/**
 * The cwd-filtered pgrep from the sandcastle-stop skill, run ON the host over
 * exec. It is project-scoped: a bare `pgrep .sandcastle/main.mts` matches EVERY
 * repo's loop on the machine, so we keep only pids whose working directory is
 * this repo root (`$PWD`, since exec runs in the checkout). Non-empty stdout
 * means a live loop for THIS repo is already running.
 */
const PGREP_SCRIPT = [
  "for pid in $(pgrep -f '\\.sandcastle/main\\.mts (--iterations|--issue|--max-concurrent|--repo-root|--branch)'); do",
  '  cwd=$(lsof -a -d cwd -p "$pid" -Fn 2>/dev/null | sed -n "s/^n//p")',
  '  [ "$cwd" = "$PWD" ] && echo "$pid"',
  "done",
].join("\n");

function skip(host: HostConfig, outcome: HostOutcome, detail?: string): HostResult {
  return detail ? { host: host.name, outcome, detail } : { host: host.name, outcome };
}

/**
 * Run the launch safety gate for one host, short-circuiting on the first
 * failure. Order (each step is a `deps.exec` on the host):
 *
 *   1. reachable        — `true`; not ok -> `unreachable`
 *   2. not-running      — cwd-filtered pgrep; a surviving pid -> `already-running`
 *   3. clean tree       — `git status --porcelain`; non-empty -> `dirty-tree`
 *   4. ff-only update   — leave the host checked out ON `<branch>`, fast-
 *                         forwarded to origin's tip, WITHOUT ever force-resetting
 *                         (never pull, never reset — ff-only). `git fetch origin
 *                         <branch>` (fetch fails -> `diverged`); then if the
 *                         local branch exists (`git rev-parse --verify --quiet
 *                         refs/heads/<branch>`), `git checkout <branch>` + `git
 *                         merge --ff-only FETCH_HEAD` (non-ff -> `diverged`); if
 *                         it is absent locally, `git checkout -b <branch>
 *                         FETCH_HEAD` (create at the fetched tip — no reset).
 *                         Then re-verify HEAD is attached AND equals `<branch>`
 *                         via `git symbolic-ref --short HEAD` (ADR 0016);
 *                         detached OR wrong branch -> `preflight-error`. Step 3
 *                         already guaranteed a clean tree, so `git checkout` is
 *                         safe.
 *   5. auth             — `gh auth status` + `gh issue list -L 1`; either fails
 *                         -> `auth-failed`. No token is EVER forwarded — the
 *                         host uses its own credentials.
 *   6. launch           — build the command and, unless `dryRun`, exec it
 *                         detached -> `launched`. `dryRun` returns `launched`
 *                         with the command in `detail` WITHOUT exec'ing it.
 *
 * Any unexpected thrown error degrades to `preflight-error` rather than
 * crashing a multi-host sweep.
 */
export async function runLaunch(
  host: HostConfig,
  spec: LaunchSpec,
  deps: LaunchDeps,
): Promise<HostResult> {
  try {
    // 1. reachable
    const reach = await deps.exec(host, ["true"]);
    if (!reach.ok) return skip(host, "unreachable", reach.stderr.trim() || undefined);

    // 2. not already running (cwd-filtered pgrep on the host)
    const pgrep = await deps.exec(host, ["bash", "-lc", PGREP_SCRIPT]);
    if (pgrep.ok && pgrep.stdout.trim() !== "") {
      return skip(host, "already-running", `pid ${pgrep.stdout.trim().split(/\s+/)[0]}`);
    }

    // 3. clean working tree
    const status = await deps.exec(host, ["git", "status", "--porcelain"]);
    if (status.ok && status.stdout.trim() !== "") {
      return skip(host, "dirty-tree");
    }

    // 4. fast-forward-only update — never pull, never reset. Leave the host
    //    checked out ON spec.branch, fast-forwarded to origin's tip.
    const fetch = await deps.exec(host, ["git", "fetch", "origin", spec.branch]);
    if (!fetch.ok) return skip(host, "diverged", fetch.stderr.trim() || "fetch failed");

    const localExists = await deps.exec(host, [
      "git", "rev-parse", "--verify", "--quiet", `refs/heads/${spec.branch}`,
    ]);
    if (localExists.ok) {
      // Local branch exists: check it out, then ff-only merge origin's tip onto
      // it. Step 3 guaranteed a clean tree, so the checkout can't lose work.
      const checkout = await deps.exec(host, ["git", "checkout", spec.branch]);
      if (!checkout.ok) {
        return skip(host, "preflight-error", checkout.stderr.trim() || `checkout ${spec.branch} failed`);
      }
      const merge = await deps.exec(host, ["git", "merge", "--ff-only", "FETCH_HEAD"]);
      if (!merge.ok) return skip(host, "diverged", merge.stderr.trim() || undefined);
    } else {
      // Absent locally: create the branch at the fetched tip — no reset.
      const checkout = await deps.exec(host, ["git", "checkout", "-b", spec.branch, "FETCH_HEAD"]);
      if (!checkout.ok) {
        return skip(host, "preflight-error", checkout.stderr.trim() || `checkout -b ${spec.branch} failed`);
      }
    }

    // re-verify HEAD is attached AND equals spec.branch after the update (ADR 0016)
    const symref = await deps.exec(host, ["git", "symbolic-ref", "--short", "HEAD"]);
    const head = symref.stdout.trim();
    if (!symref.ok || head === "") {
      return skip(host, "preflight-error", "HEAD is detached after update");
    }
    if (head !== spec.branch) {
      return skip(host, "preflight-error", `HEAD is ${head} after update, expected ${spec.branch}`);
    }

    // 5. auth — host uses its OWN gh credentials; never forward a token
    const ghAuth = await deps.exec(host, ["gh", "auth", "status"]);
    if (!ghAuth.ok) return skip(host, "auth-failed", ghAuth.stderr.trim() || undefined);
    const ghIssue = await deps.exec(host, ["gh", "issue", "list", "-L", "1"]);
    if (!ghIssue.ok) return skip(host, "auth-failed", ghIssue.stderr.trim() || undefined);

    // 6. launch
    const command = buildLaunchCommand(host, spec);
    if (spec.dryRun) {
      return { host: host.name, outcome: "launched", detail: command };
    }
    const launched = await deps.exec(host, ["bash", "-lc", command]);
    if (!launched.ok) {
      return skip(host, "preflight-error", launched.stderr.trim() || "launch command failed");
    }
    return { host: host.name, outcome: "launched", detail: command };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return skip(host, "preflight-error", detail);
  }
}
