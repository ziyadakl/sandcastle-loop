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
import { backendForModel } from "../providers.js";
import {
  wipRef,
  resolveReuseDecision,
  makeSyncGitRunner,
} from "./state/index.js";

const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

// Mirrors the SDK's substitutePromptArgs contract for the keys this repo
// uses: same placeholder regex, fail-loud on unmatched key. Does NOT inject
// SOURCE_BRANCH/TARGET_BRANCH built-ins or preprocess !`...` shell blocks —
// see FOLLOW_UPS.md.
export function applyPromptArgs(
  prompt: string,
  args: Record<string, string>,
): string {
  return prompt.replace(PLACEHOLDER_PATTERN, (_match, key: string) => {
    if (!(key in args)) {
      throw new Error(
        `Prompt argument "{{${key}}}" has no matching value in promptArgs`,
      );
    }
    return args[key];
  });
}

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
   * Cross-host sync opt-in (ADR 0021 §2 "branch reuse on pickup"). When true
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
  close(): Promise<void>;
}

export interface MacHostSandboxFactory {
  createSandbox(spec: MacHostCreateSpec): Promise<MacHostSandboxHandle>;
  run(spec: MacHostTopLevelRunSpec): Promise<MacHostRunHandle>;
}

function absoluteWorktreePath(repoRoot: string, branch: string): string {
  return path.join(repoRoot, canonicalWorktreePathFor(branch));
}

function preCleanWorktree(repoRoot: string, wtPath: string): void {
  // Mirror main.mts:1745-1772 — three-tier cleanup so a stale registration
  // or orphan dir never blocks a fresh `git worktree add`.
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
  // Fail-closed (ADR 0010), matching the docker mirror's `|| true`: AGENTS.md
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
  //   - production: default `claude` binary, production flags, prompt via
  //     stdin, non-zero exit fails.
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
          ];
  // Codex backend (ADR 0012): when the model id resolves to the codex backend,
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

  const childEnv = { ...process.env, ...env };
  const idleMs = (runSpec.idleTimeoutSeconds ?? 600) * 1000;

  return await new Promise<MacHostRunHandle>((resolve, reject) => {
    let settled = false;
    const safeReject = (err: Error) => {
      if (!settled) { settled = true; reject(err); }
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

export function macHostSandbox(
  opts: MacHostSandboxOptions,
): MacHostSandboxFactory {
  const { repoRoot } = opts;

  return {
    async createSandbox(spec) {
      const wtPath = absoluteWorktreePath(repoRoot, spec.branch);
      preCleanWorktree(repoRoot, wtPath);
      // ADR 0021 §2 branch reuse on pickup. When cross-host sync is on and a WIP
      // checkpoint exists on origin for this issue, cut the worktree from that
      // checkpoint tip (fetch + `-B <branch> FETCH_HEAD`) so the implementer
      // continues the committed partial work. Otherwise — and ALWAYS when the
      // flag is off — the existing unconditional `-B <branch>` from HEAD runs
      // byte-for-byte unchanged (no fetch/ls-remote, no new git auth). The ref
      // name is single-sourced from `wipRef`; existence from A2's `wipRefExists`
      // via the canonical sync GitRunner adapter over execFileSync.
      const gitRunner = makeSyncGitRunner();
      // Decision (reuse vs fresh) is single-sourced in state/branch-checkpoint's
      // resolveReuseDecision so this path and the docker path cannot diverge. It
      // preserves the flag-FIRST short-circuit: with sync off (or a non-issue
      // branch) it issues NO ls-remote/origin git — the inert-when-off contract.
      // The materialization below stays mac-host-specific (worktree add from
      // FETCH_HEAD) — only the decision is shared.
      const r = await resolveReuseDecision({
        syncEnabled: opts.crossHostSync ?? false,
        branch: spec.branch,
        repoRoot,
        git: gitRunner,
      });
      if (r.reuse) {
        execFileSync("git", ["fetch", "origin", wipRef(r.issue)], {
          cwd: repoRoot,
          stdio: ["ignore", "pipe", "pipe"],
        });
        execFileSync(
          "git",
          ["worktree", "add", "-B", spec.branch, wtPath, "FETCH_HEAD"],
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
        async close() {
          preCleanWorktree(repoRoot, wtPath);
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
