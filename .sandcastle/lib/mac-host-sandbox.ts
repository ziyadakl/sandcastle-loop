import path from "node:path";
import { tmpdir } from "node:os";
import {
  existsSync,
  rmSync,
  readFileSync,
  mkdtempSync,
  copyFileSync,
  appendFileSync,
} from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { worktreePathFor as canonicalWorktreePathFor } from "./worktree-path.js";
import {
  unlockOwnWorktree,
  type WorktreeGit,
  type WorktreeGitResult,
} from "./paths/worktree-lock.js";
import {
  EXEC_KILL_GRACE_MS,
  EXEC_OUTPUT_TAIL_CHARS,
  type SandboxCommandRunner,
  type SandboxExecOptions,
  type SandboxExecResult,
} from "./sandbox-exec.js";
import { backendForModel } from "../providers.js";
import {
  wipRef,
  wipMirrorFetchRefspec,
  resolveReuseDecision,
  makeSyncGitRunner,
} from "./state/index.js";
import { applyPromptArgs } from "./prompt-args.js";
import { sandboxAgentSettingsArgs } from "./sandbox-agent-settings.js";
import {
  NO_GITHUB_ACCESS_TOKEN,
  withoutGithubCredentials,
} from "./github-credential-env.js";

// Fields shared by every spec passed to spawnAgent. The buildArgs callback
// reads from this base so callers can declare it once without picking which
// concrete spec type they want — TS function-parameter contravariance makes
// `(spec: MacHostRunSpec) =>` unassignable to a wider union slot, but the
// base type sidesteps that trap.
export interface MacHostRunSpecBase {
  readonly name: string;
  readonly maxIterations?: number;
  readonly model: string;
  readonly promptFile: string;
  readonly promptArgs?: Record<string, string>;
  readonly idleTimeoutSeconds?: number;
  readonly signal?: AbortSignal;
}

export interface MacHostSandboxOptions {
  readonly repoRoot: string;
  readonly env?: Record<string, string>;
  /**
   * Override the binary spawned to run the agent. Default `claude` from PATH.
   * Test code injects a fake binary here for deterministic behavior.
   * `SANDCASTLE_MAC_HOST_CLAUDE_BIN` is consulted as a fallback when this
   * option is omitted.
   *
   * If you set `claudeBin` WITHOUT `buildArgs`, the legacy single-positional
   * form is used: the binary is invoked as `claudeBin <promptFullPath>` and
   * stdin is closed. This matches the historical `/bin/cat <promptFile>` test
   * seam shape. For full control over argv and stdin, also set `buildArgs`.
   */
  readonly claudeBin?: string;
  /**
   * Build the argv passed to the binary. When set, stdin receives the
   * substituted prompt text (production-equivalent behavior). When omitted,
   * args default to production flags if no binary override is in effect, or
   * to `[promptFullPath]` (legacy positional seam) if a binary override is.
   */
  readonly buildArgs?: (spec: MacHostRunSpecBase) => readonly string[];
  /**
   * Cross-host sync opt-in ("branch reuse on pickup"). When true
   * AND a WIP checkpoint ref exists on origin for an issue-shaped branch, the
   * per-issue worktree is cut from that checkpoint instead of force-reset from
   * HEAD. Defaults to `false` (undefined) — with it off the worktree-add path
   * is byte-for-byte today's unconditional `-B <branch>` from HEAD, so a
   * single-host consumer never fetches/ls-remotes a WIP ref. Threaded from
   * `crossHostSyncEnabled()` via the provider factory.
   */
  readonly crossHostSync?: boolean;
}

export interface MacHostCreateSpec {
  readonly branch: string;
}

export interface MacHostTopLevelRunSpec extends MacHostRunSpecBase {
  readonly cwd?: string;
}

export interface MacHostRunSpec extends MacHostRunSpecBase {}

export interface MacHostRunHandle {
  readonly stdout: string;
  readonly commits: readonly { sha: string }[];
  // Reserved for future sessionFilePath integration:
  readonly iterations?: readonly {
    readonly sessionFilePath?: string;
    readonly sessionId?: string;
  }[];
}

export interface MacHostSandboxHandle {
  readonly branch: string;
  readonly worktreePath: string;
  run(spec: MacHostRunSpec): Promise<MacHostRunHandle>;
  /**
   * Run one command inside this sandbox — which, on mac-host, IS the host, in
   * the per-issue worktree. Present so the test-verification gate has ONE code
   * path across providers instead of a host-side branch it would have to keep
   * in sync; see `./sandbox-exec.ts` for why the gate cannot run on the host on
   * the docker path.
   *
   * Typed as the standalone {@link SandboxCommandRunner} rather than redeclared
   * as a method: the gate is handed this function on its own, so a signature
   * that permitted a `this`-dependent implementation would be lying about how
   * it is called.
   */
  readonly exec: SandboxCommandRunner;
  close(): Promise<void>;
}

export interface MacHostSandboxFactory {
  createSandbox(spec: MacHostCreateSpec): Promise<MacHostSandboxHandle>;
  run(spec: MacHostTopLevelRunSpec): Promise<MacHostRunHandle>;
}

function absoluteWorktreePath(repoRoot: string, branch: string): string {
  return path.join(repoRoot, canonicalWorktreePathFor(branch));
}

/**
 * The repo's canonical sync git runner, narrowed for the lock helpers.
 *
 * `makeSyncGitRunner` is DECLARED as `GitRunner`, whose result type allows a
 * Promise; its implementation is synchronous and its object shape is already
 * exactly what the lock helpers read. Narrowing it in one place reuses that
 * canonical runner instead of hand-rolling a fourth copy of the same
 * try/catch — which is what this replaced.
 */
const lockGit: WorktreeGit = (cwd, ...gitArgs) =>
  makeSyncGitRunner()(cwd, ...gitArgs) as WorktreeGitResult;

function preCleanWorktree(
  repoRoot: string,
  wtPath: string,
  branch: string,
): void {
  // Mirror main.mts:1745-1772 — three-tier cleanup so a stale registration
  // or orphan dir never blocks a fresh `git worktree add`.
  // Issue #1260: a worktree left behind by a KILLED run is still LOCKED, and
  // both `git worktree remove --force` and `git worktree prune` refuse a
  // locked worktree. Drop our own lock first.
  //
  // OUTSIDE the `existsSync` gate, deliberately — mirrors `createSandboxRaw`
  // in main.mts. A killed run can leave the REGISTRATION locked with its
  // DIRECTORY gone; gate the unlock on the directory and nothing can ever
  // clear it, so the next `git worktree add` dies on "a missing but locked
  // worktree" and the branch is wedged until a human intervenes.
  //
  // Keyed on the BRANCH and resolved through git, so it can only release a
  // lock this loop took for this branch — never a hand-taken one, and never a
  // sibling's, which a derived path could reach. The runner is the repo's
  // canonical `makeSyncGitRunner`.
  if (unlockOwnWorktree(repoRoot, branch, lockGit) === "refused") {
    // Never silent: on a refusal the remove below fails, `rmSync` cannot touch
    // the registration and prune cannot clear it either, so the branch stops
    // working with no other trace of why.
    console.error(
      `[issue-branch=${branch}] its stale worktree is locked by something ` +
        `this loop did not lock — leaving it alone. This branch cannot be ` +
        `worked until that is cleared by hand: git worktree unlock ${wtPath}`,
    );
  }
  if (existsSync(wtPath)) {
    try {
      execFileSync(
        "git",
        ["worktree", "remove", "--force", wtPath],
        { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch {
      rmSync(wtPath, { recursive: true, force: true });
    }
  }
  try {
    execFileSync("git", ["worktree", "prune"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // best-effort
  }
}

function readCommitsSince(wtPath: string, forkSha: string): { sha: string }[] {
  try {
    const out = execFileSync(
      "git",
      ["log", "--format=%H", `${forkSha}..HEAD`],
      { cwd: wtPath, stdio: ["ignore", "pipe", "ignore"] },
    ).toString("utf8");
    return out.split("\n").filter(Boolean).map((sha) => ({ sha }));
  } catch {
    return [];
  }
}

/**
 * Stage `.sandcastle/AGENTS.md` to the worktree root for codex runs — the
 * mac-host mirror of the docker `onSandboxReady` hook (`stageCodexAgentsMd` in
 * main.mts). Codex reads `AGENTS.md` from its cwd (the worktree root), but ours
 * ships at `.sandcastle/AGENTS.md`, so it must be copied up.
 *
 * Same guards as the docker hook:
 *   - No-clobber: skip when the source is absent OR the project already has its
 *     own root `AGENTS.md` (never overwrite a consumer's file).
 *   - Git-exclude our copy so the agent can't commit it. `.git` is a FILE in a
 *     worktree, so a literal `.git/info/exclude` path fails ("Not a directory")
 *     — resolve it via `git rev-parse --git-path info/exclude`, which is correct
 *     in both worktrees and plain repos. Best-effort: a failed exclude is not
 *     fatal to the run.
 *
 * Called only on the per-sandbox (worktree) path, never the top-level run path,
 * whose cwd is the real repo root — mirroring docker, which has no top-level
 * hook and must not litter the operator's working tree.
 */
/**
 * Build the `iterations` array the provider forwards to the skill-discipline
 * gate. A present session id yields a single-iteration array the gate resolves
 * by id; an absent one yields `[]` (the pre-session-id status quo). Shared by
 * the claude (forced `--session-id`) and codex (recovered `thread_id`) resolve
 * sites so the shape stays identical across backends.
 */
function iterationsFor(
  sessionId: string | undefined,
): readonly { readonly sessionId: string }[] {
  return sessionId !== undefined ? [{ sessionId }] : [];
}

/**
 * Recover a codex run's session id from its `--json` stdout stream so the
 * skill-discipline gate can locate the rollout afterward. Codex has no
 * `--session-id` lever (unlike claude, which we force), so the id is only ever
 * exposed as a `{"type":"thread.started","thread_id":"<id>"}` event — the SAME
 * shape the docker path parses (`parseCodexStreamLine` in the SDK). The rollout
 * lands at `~/.codex/sessions/YYYY/MM/DD/rollout-*-<thread_id>.jsonl`, and
 * `findCodexSessionOnHost` matches on that trailing `<thread_id>`. Returns
 * undefined when no such line is present, in which case iterations stays `[]`
 * and the run behaves exactly as before this capture existed (no regression,
 * just no gate coverage — the pre-fix status quo).
 */
function extractCodexThreadId(jsonlStdout: string): string | undefined {
  for (const line of jsonlStdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (
      typeof obj === "object" &&
      obj !== null &&
      (obj as { type?: unknown }).type === "thread.started" &&
      typeof (obj as { thread_id?: unknown }).thread_id === "string"
    ) {
      return (obj as { thread_id: string }).thread_id;
    }
  }
  return undefined;
}

function stageCodexAgentsMdIntoWorktree(wtPath: string): void {
  const src = path.join(wtPath, ".sandcastle", "AGENTS.md");
  const dst = path.join(wtPath, "AGENTS.md");
  if (!existsSync(src) || existsSync(dst)) return;
  // Fail-closed, matching the docker mirror's `|| true`: AGENTS.md
  // delivery is best-effort cosmetic, so BOTH the copy and the git-exclude are
  // inside the try — a failure here must never abort the run.
  try {
    copyFileSync(src, dst);
    const rel = execFileSync(
      "git",
      ["rev-parse", "--git-path", "info/exclude"],
      { cwd: wtPath, stdio: ["ignore", "pipe", "ignore"] },
    )
      .toString("utf8")
      .trim();
    const exPath = path.resolve(wtPath, rel);
    const existing = existsSync(exPath) ? readFileSync(exPath, "utf8") : "";
    const alreadyExcluded = existing
      .split("\n")
      .some((line) => line.trim() === "AGENTS.md");
    if (!alreadyExcluded) {
      const prefix =
        existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
      appendFileSync(exPath, `${prefix}AGENTS.md\n`);
    }
  } catch {
    // best-effort: copy/exclude failure does not fail the run.
  }
}

async function spawnAgent(
  cwd: string,
  runSpec: MacHostRunSpec | MacHostTopLevelRunSpec,
  env: Record<string, string>,
  forkSha: string | null,
  opts: MacHostSandboxOptions,
): Promise<MacHostRunHandle> {
  const promptFullPath = path.join(cwd, runSpec.promptFile);
  if (!existsSync(promptFullPath)) {
    throw new Error(`prompt file not found: ${promptFullPath}`);
  }
  const rawPrompt = readFileSync(promptFullPath, "utf8");
  const promptText = applyPromptArgs(rawPrompt, runSpec.promptArgs ?? {});

  // Spawn mode drives three policies (argv shape, stdin piping, exit-code
  // handling) off the same upstream choice — encode it once.
  //   - production: default `claude` binary, production flags (now including
  //     the loop's own `--settings`, see sandboxAgentSettingsArgs below),
  //     prompt via stdin, non-zero exit fails.
  //   - explicit-args: caller supplied buildArgs; same stdin/exit policy as
  //     production but argv comes from the callback.
  //   - legacy-positional: caller supplied only claudeBin (option or env
  //     var); argv is `[promptFullPath]`, stdin is closed, non-zero exit is
  //     tolerated. Used by /bin/cat-style test seams.
  // The previous NODE_ENV === "test" implicit branch is intentionally gone
  // — that seam was global-state that could leak into production.
  const envBin = process.env.SANDCASTLE_MAC_HOST_CLAUDE_BIN;
  const mode: "production" | "explicit-args" | "legacy-positional" =
    opts.buildArgs !== undefined
      ? "explicit-args"
      : opts.claudeBin !== undefined || envBin !== undefined
        ? "legacy-positional"
        : "production";
  // In production mode `opts.claudeBin`/`envBin` are undefined by construction
  // (either would have forced legacy mode above), so the production branch only
  // ever consults the dedicated test override — keeping production argv intact.
  // That override is an env var, NOT an options field, mirroring the codex
  // sibling `SANDCASTLE_MAC_HOST_CODEX_BIN` (which likewise never changes
  // `mode`): it exists so the production argv — chiefly the forced
  // `--session-id` and its threading into `iterations` — is reachable by a fake
  // binary in tests. Defaults to `claude`, so unset = no behavior change.
  const claudeBin =
    mode === "production"
      ? process.env.SANDCASTLE_MAC_HOST_PRODUCTION_CLAUDE_BIN ?? "claude"
      : opts.claudeBin ?? envBin ?? "claude";
  // Force a known session id in the production claude path so the
  // skill-discipline gate can locate the run's session JSONL afterward.
  // Claude writes the session to `~/.claude/projects/<slug>/<id>.jsonl`, and
  // the SDK's `findClaudeSessionOnHost` scans every project dir for that
  // `<id>.jsonl` filename — so passing `--session-id` is the one lever that
  // survives the host/worktree slug encoding. We stay on plain `--print`
  // (NOT `--output-format json`) precisely so stdout still streams the verdict
  // text incrementally: the verdict parser AND the idle timer are untouched.
  // Only "production" mode gets an id — the test seams (explicit-args /
  // legacy-positional) keep `sessionId` undefined and behave exactly as before.
  const sessionId = mode === "production" ? randomUUID() : undefined;
  const claudeArgs =
    mode === "explicit-args"
      ? [...opts.buildArgs!(runSpec)]
      : mode === "legacy-positional"
        ? [promptFullPath]
        : [
            "--print",
            "--session-id", sessionId!,
            "--model", runSpec.model,
            "--dangerously-skip-permissions",
            // 2026-09-04 loop-config fix: `--settings` outranks project and
            // local settings in Claude Code's own precedence, so this pins
            // the loop's config (disableAllHooks, outputStyle: "default",
            // claudeMdExcludes) even when the worktree's own
            // .claude/settings.local.json is missing or under --no-staging.
            // See lib/sandbox-agent-settings.ts for the shared source of
            // truth this and the worktree file both render from.
            ...sandboxAgentSettingsArgs(),
          ];
  // Codex backend: when the model id resolves to the codex backend,
  // spawn the `codex` binary instead of `claude`. This swaps the binary and
  // argv at the spawn site below.
  //
  // codex exec reads the prompt from stdin (no positional prompt arg) and
  // writes ONLY its final agent message to the `-o <file>` path. Its stdout
  // under `--json` is JSONL events, NOT the final message — so for parity with
  // the claude path (whose stdout IS the final message that parseVerdict
  // consumes) we must read the `-o` file back and return THAT as `stdout`. The
  // JSONL stream is still buffered/echoed below to drive the idle timer and
  // give live visibility.
  const isCodex = backendForModel(runSpec.model) === "codex";

  // `mode` is a CLAUDE-only concept (its three values all key off claude test
  // seams), so codex must not inherit claude's stdin/exit policy from it. Codex
  // always pipes the prompt to stdin and always fails on non-zero exit. For
  // claude, `isCodex` is false so these are byte-equivalent to the originals.
  const pipePromptToStdin = isCodex || mode !== "legacy-positional";
  const failOnNonZero = isCodex || mode !== "legacy-positional";

  const codexBin = process.env.SANDCASTLE_MAC_HOST_CODEX_BIN ?? "codex";
  // Last-message sink lives in tmpdir, never the worktree: concurrent sessions
  // share the working tree, and a file in cwd risks being committed by the
  // agent. Absolute path so codex's `-C <cwd>` rebasing can't relocate it.
  const codexOutFile = isCodex
    ? path.join(mkdtempSync(path.join(tmpdir(), "sandcastle-codex-")), "last-message.txt")
    : "";
  // `--dangerously-bypass-approvals-and-sandbox` is required for headless
  // operation: without it codex blocks on interactive approval prompts that
  // have no TTY to answer them. The docker path passes the SAME flag (via the
  // sandcastle SDK's codex args), so this is not a mac-host-specific relaxation.
  // The difference is the mitigation: docker runs codex inside the container
  // sandbox, whereas on mac-host the agent runs on the host — its isolation is
  // the per-sandbox git worktree (`-C cwd`, a throwaway checkout), NOT codex's
  // own sandbox. That worktree boundary is the safety model here.
  const codexArgs = [
    "exec",
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "-m", runSpec.model,
    "-C", cwd,
    "-o", codexOutFile,
  ];
  const spawnBin = isCodex ? codexBin : claudeBin;
  const spawnArgs = isCodex ? codexArgs : claudeArgs;

  // KNOWN, ACCEPTED EXPOSURE (spec #1334, owner decision): this agent keeps
  // the host's HOME, so it can read `~/.ssh` and push over SSH. The env scrub
  // below removes GitHub tokens only. Production runs the docker path, which
  // mounts no `~/.ssh`; closing this on mac-host needs a separate HOME.
  const childEnv = agentChildEnv(process.env, env);
  const idleMs = (runSpec.idleTimeoutSeconds ?? 600) * 1000;

  return await new Promise<MacHostRunHandle>((resolve, reject) => {
    let settled = false;
    const safeReject = (err: Error) => {
      if (!settled) {
        settled = true;
        // Parity with the docker provider's stream sniffer (#1133 item 1): the
        // production claude path FORCES `--session-id`, so on a throw path (idle
        // timeout, abort, non-zero exit) the id is already known here — no
        // sniffing needed. Stamp it onto the error so the judge's transport
        // catch can resolve the partial transcript (mac-host writes it straight
        // to the host's real `~/.claude/projects/<slug>/<id>.jsonl`) and record
        // a truthful FLOOR. Undefined in the test-seam modes, which stamps
        // nothing and degrades to today's no-cost behaviour.
        if (sessionId !== undefined) {
          (err as { capturedSessionId?: string }).capturedSessionId = sessionId;
        }
        reject(err);
      }
    };
    const safeResolve = (val: MacHostRunHandle) => {
      if (!settled) { settled = true; resolve(val); }
    };

    const child = spawn(spawnBin, spawnArgs, {
      cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Pass the prompt according to the resolved stdin policy: production and
    // explicit buildArgs callers receive prompt text on stdin; legacy
    // positional-arg seams close stdin so /bin/cat doesn't block.
    if (pipePromptToStdin) {
      child.stdin.end(promptText);
    } else {
      child.stdin.end();
    }

    // Wire abort signal — kill the child and reject before it can settle normally.
    const onAbort = () => {
      child.kill("SIGTERM");
      safeReject(new Error(`run "${runSpec.name}": aborted`));
    };
    if (runSpec.signal) {
      if (runSpec.signal.aborted) {
        child.kill("SIGTERM");
        safeReject(new Error(`run "${runSpec.name}": already aborted before spawn`));
      } else {
        runSpec.signal.addEventListener("abort", onAbort);
      }
    }

    let stdoutBuf = "";
    let stderrBuf = "";
    let lastChunkAt = Date.now();
    const idleTimer = setInterval(() => {
      if (Date.now() - lastChunkAt > idleMs) {
        clearInterval(idleTimer);
        child.kill("SIGTERM");
        safeReject(new Error(`run "${runSpec.name}": idle timeout after ${idleMs}ms`));
      }
    }, 5_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      lastChunkAt = Date.now();
      stdoutBuf += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      lastChunkAt = Date.now();
      stderrBuf += chunk;
      process.stderr.write(chunk);
    });
    child.on("error", (err: Error) => {
      clearInterval(idleTimer);
      runSpec.signal?.removeEventListener("abort", onAbort);
      safeReject(err);
    });
    child.on("close", (code: number | null) => {
      clearInterval(idleTimer);
      runSpec.signal?.removeEventListener("abort", onAbort);
      if (code !== 0 && failOnNonZero) {
        safeReject(new Error(
          `run "${runSpec.name}" exited ${code}: ${stderrBuf.slice(-500)}`,
        ));
        return;
      }
      // commits: read git log on the worktree branch since createSandbox,
      // or return [] when running outside any worktree (forkSha === null).
      const commits = forkSha !== null ? readCommitsSince(cwd, forkSha) : [];
      // Codex parity: return the `-o` last-message file (the final agent text),
      // NOT the JSONL stdout buffer, so it flows through parseVerdict exactly
      // like the claude path. Read it before cleanup; a 0-exit with a missing
      // or unreadable file is a hard error (no fallback to the JSONL buffer,
      // which would feed garbage to the verdict parser).
      if (isCodex) {
        let finalMessage: string;
        try {
          finalMessage = readFileSync(codexOutFile, "utf8");
        } catch (err) {
          rmSync(path.dirname(codexOutFile), { recursive: true, force: true });
          safeReject(new Error(
            `run "${runSpec.name}": codex exited 0 but its last-message file ` +
              `was not written (${codexOutFile}): ${(err as Error).message}`,
          ));
          return;
        }
        rmSync(path.dirname(codexOutFile), { recursive: true, force: true });
        // Thread the codex session id (recovered from the JSONL stream) back so
        // the provider forwards it to the skill-discipline gate, exactly as the
        // claude branch forwards its forced `--session-id`. Without this every
        // typed codex issue false-quarantines despite invoking its skills.
        const codexThreadId = extractCodexThreadId(stdoutBuf);
        safeResolve({
          stdout: finalMessage,
          commits,
          iterations: iterationsFor(codexThreadId),
        });
        return;
      }
      // Thread the forced session id back so the provider adapter can forward
      // it to the skill-discipline gate (resolveSessionFilePath → by-id scan).
      // undefined in the test-seam modes, which is fine — iterations stays [].
      safeResolve({
        stdout: stdoutBuf,
        commits,
        iterations: iterationsFor(sessionId),
      });
    });
  });
}

/**
 * The environment a mac-host agent (and every command run in its worktree)
 * gets: the host's environment with the sandbox env over it — the agent is a
 * plain host child process, so it inherits everything the loop process holds —
 * MINUS every GitHub credential, plus a `GH_TOKEN` that cannot authenticate
 * (spec #1334, slice SB; see {@link NO_GITHUB_ACCESS_TOKEN} for why removing
 * the variable alone would let `gh` fall back to the host's stored login).
 *
 * Known residual, by design of mac-host: the agent still runs with the host's
 * `HOME`, so `~/.ssh` stays readable and pushing over SSH is not blocked here.
 * Nothing in any prompt asks for a push, and the docker path, which is the one
 * production runs, mounts no `~/.ssh` at all.
 */
export function agentChildEnv(
  processEnv: NodeJS.ProcessEnv,
  env: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  return {
    ...withoutGithubCredentials({ ...processEnv, ...env }),
    GH_TOKEN: NO_GITHUB_ACCESS_TOKEN,
  };
}

/**
 * Options for {@link _execInWorktree}: the shared exec contract plus the
 * sandbox env this provider must inject itself. Named rather than spelled as
 * an inline intersection at the one exported seam — "exec options plus env" is
 * a pair that travels together, i.e. a type wanting to exist.
 */
export interface MacHostExecOptions extends SandboxExecOptions {
  /**
   * Sandbox env merged over `process.env`, exactly as `spawnAgent` does for
   * agent runs. Required, not optional: forgetting it is invisible — the
   * command runs, just unconfigured, and a suite needing DATABASE_URL reports
   * inconclusive instead of verifying anything.
   */
  readonly env: Record<string, string>;
}

/**
 * IO: run `command` through the host shell in `cwd`. Never throws — a spawn
 * failure becomes `exitCode: null` with the reason on stderr, because the
 * caller (the test-verification gate) must distinguish "could not run" from
 * "ran and failed" and an exception erases that distinction.
 *
 * Bounding is Node's own `timeout`, NOT the POSIX `timeout` binary the docker
 * provider uses: macOS ships no `timeout` in the base system (it is `gtimeout`
 * from coreutils, if installed at all), so relying on it here would make the
 * bound silently vanish on exactly the hosts this path serves.
 *
 * The bound is delivered to the PROCESS GROUP, not just the direct child. With
 * `shell: true` the killed pid is the shell's immediate command — a `pnpm` that
 * has already forked `vitest`. Signalling only that pid leaves the grandchild
 * alive holding the inherited stdout pipe, which both keeps a test run burning
 * CPU and can delay `close` indefinitely. `detached: true` puts the child in
 * its own group so `process.kill(-pid)` reaches the whole tree.
 *
 * Exported under the `_` prefix (the convention `_execViaSdkSandbox` follows)
 * because the triage below — spawn error vs bound vs ordinary exit — is the
 * error-prone part, and it is otherwise unreachable from a test. There is
 * deliberately NO injected `spawn` seam: the tests drive real processes,
 * because every behaviour here (exit codes, signal delivery to a process
 * group, stream close ordering) is a process behaviour that a mock could only
 * assert agrees with itself.
 */
export function _execInWorktree(
  cwd: string,
  command: string,
  opts: MacHostExecOptions,
): Promise<SandboxExecResult> {
  return new Promise((resolvePromise) => {
    const proc = spawn(command, {
      cwd,
      shell: true,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: agentChildEnv(process.env, opts.env),
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    // Truncate on every chunk rather than accumulating and slicing at the end:
    // a failing vitest run emits megabytes, and holding all of it to throw
    // 99% away is how a bounded gate becomes an unbounded memory spike.
    proc.stdout?.on("data", (c: Buffer) => {
      stdout = (stdout + c.toString()).slice(-EXEC_OUTPUT_TAIL_CHARS);
    });
    proc.stderr?.on("data", (c: Buffer) => {
      stderr = (stderr + c.toString()).slice(-EXEC_OUTPUT_TAIL_CHARS);
    });

    /** Signal the whole group, falling back to the single pid if it is gone. */
    const killTree = (signal: NodeJS.Signals): void => {
      try {
        if (proc.pid !== undefined) process.kill(-proc.pid, signal);
      } catch {
        // ESRCH: already dead, or never grouped. Best-effort by design — a
        // failed kill must not become an exception on the ship path.
        try {
          proc.kill(signal);
        } catch {
          /* nothing left to signal */
        }
      }
    };

    let killTimer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs !== undefined) {
      killTimer = setTimeout(() => {
        // `timedOut` is tracked HERE rather than inferred from the exit signal
        // at close. Inferring would report ANY signal death (an OOM kill, an
        // operator's Ctrl-C) as a timeout; this flag is set only by our own
        // bound, so the reason string in the run log stays true.
        timedOut = true;
        killTree("SIGTERM");
        graceTimer = setTimeout(
          () => killTree("SIGKILL"),
          EXEC_KILL_GRACE_MS,
        );
        graceTimer.unref?.();
      }, opts.timeoutMs);
      killTimer.unref?.();
    }
    const done = (result: SandboxExecResult): void => {
      if (settled) return;
      settled = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      resolvePromise(result);
    };

    proc.on("error", (err) => {
      done({
        stdout,
        stderr: stderr || err.message,
        exitCode: null,
        timedOut: false,
      });
    });
    proc.on("close", (code) => {
      done({ stdout, stderr, exitCode: code, timedOut });
    });
  });
}

export function macHostSandbox(
  opts: MacHostSandboxOptions,
): MacHostSandboxFactory {
  const { repoRoot } = opts;

  return {
    async createSandbox(spec) {
      const wtPath = absoluteWorktreePath(repoRoot, spec.branch);
      preCleanWorktree(repoRoot, wtPath, spec.branch);
      // Branch reuse on pickup. When cross-host sync is on and a WIP
      // checkpoint exists on origin for this issue, cut the worktree from that
      // checkpoint tip (fetch into the mirror + `-B <branch> <wipRef>`) so the
      // implementer continues the committed partial work. Otherwise — and ALWAYS
      // when the flag is off — the existing unconditional `-B <branch>` from
      // HEAD runs byte-for-byte unchanged (no fetch/ls-remote, no new git auth).
      // The ref name is single-sourced from `wipRef`; existence from `wipRefExists`
      // via the canonical sync GitRunner adapter over execFileSync.
      const gitRunner = makeSyncGitRunner();
      // Decision (reuse vs fresh) is single-sourced in state/branch-checkpoint's
      // resolveReuseDecision so this path and the docker path cannot diverge. It
      // preserves the flag-FIRST short-circuit: with sync off (or a non-issue
      // branch) it issues NO ls-remote/origin git — the inert-when-off contract.
      // The materialization below stays mac-host-specific (worktree add from
      // the WIP mirror ref) — only the decision and the fetch refspec are shared.
      const r = await resolveReuseDecision({
        syncEnabled: opts.crossHostSync ?? false,
        branch: spec.branch,
        repoRoot,
        git: gitRunner,
      });
      if (r.reuse) {
        // Fetch INTO the local WIP mirror (`+<ref>:<ref>`), not just to
        // FETCH_HEAD: the mirror is the lease pushWipRef checkpoints against, so
        // a resumed host that never writes it can never check its own work back
        // in. Refspec is single-sourced in wipMirrorFetchRefspec, whose header
        // carries the argument; the worktree is then cut from the mirror we just
        // wrote rather than FETCH_HEAD, so the ref we lease against and the ref
        // we work from are provably the same commit.
        execFileSync("git", ["fetch", "origin", wipMirrorFetchRefspec(r.issue)], {
          cwd: repoRoot,
          stdio: ["ignore", "pipe", "pipe"],
        });
        execFileSync(
          "git",
          ["worktree", "add", "-B", spec.branch, wtPath, wipRef(r.issue)],
          { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
        );
      } else {
        execFileSync(
          "git",
          ["worktree", "add", "-B", spec.branch, wtPath],
          { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
        );
      }
      const forkSha = execFileSync(
        "git",
        ["rev-parse", "HEAD"],
        { cwd: wtPath, stdio: ["ignore", "pipe", "ignore"] },
      ).toString("utf8").trim();

      return {
        branch: spec.branch,
        worktreePath: wtPath,
        // Straight from the shared `resolveReuseDecision` above, so the
        // check-writer can tell a worktree cut from a WIP checkpoint from a
        // fresh one (issue #916, defect 2 — see
        // `SandboxHandle.resumedFromCheckpoint` in main.mts). The docker
        // provider sets the same value from the same decision.
        resumedFromCheckpoint: r.reuse,
        async run(runSpec): Promise<MacHostRunHandle> {
          // Codex-only, no-clobber, git-excluded AGENTS.md delivery into the
          // worktree — the mac-host mirror of the docker onSandboxReady hook.
          // Per-sandbox path only; the top-level run() below (cwd = repo root)
          // must never have our copy written into it.
          if (backendForModel(runSpec.model) === "codex") {
            stageCodexAgentsMdIntoWorktree(wtPath);
          }
          return await spawnAgent(wtPath, runSpec, opts.env ?? {}, forkSha, opts);
        },
        // `opts.env` is the SAME sandbox env `spawnAgent` merges over
        // `process.env` (see childEnv there). Without it a suite needing
        // DATABASE_URL from `.sandcastle/.env` would run unconfigured and
        // report inconclusive — a silent asymmetry against the docker path,
        // where those variables are baked into the container.
        exec: (command, execOpts) =>
          _execInWorktree(wtPath, command, {
            ...execOpts,
            env: opts.env ?? {},
          }),
        async close() {
          preCleanWorktree(repoRoot, wtPath, spec.branch);
        },
      };
    },

    async run(spec): Promise<MacHostRunHandle> {
      const effectiveCwd = spec.cwd ?? repoRoot;
      const forkSha = execFileSync(
        "git",
        ["rev-parse", "HEAD"],
        { cwd: effectiveCwd, stdio: ["ignore", "pipe", "ignore"] },
      ).toString("utf8").trim();
      return await spawnAgent(effectiveCwd, spec, opts.env ?? {}, forkSha, opts);
    },
  };
}
