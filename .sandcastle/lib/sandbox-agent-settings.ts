import path from "node:path";
import os from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";

import { addToGitInfoExclude } from "./git/info-exclude.js";

/**
 * The sandboxed builder must run under the LOOP's Claude config, never the
 * launcher's own personal one.
 *
 * On 2026-09-04, the #1038 builder inherited the owner's interactive setup
 * wholesale: docker bind-mounts the whole `~/.claude` (`lib/sandbox-
 * provider.ts`, `AUTH_MOUNTS`) and mac-host spawns `claude` as a child of the
 * orchestrator with the host's own `HOME` (`lib/mac-host-sandbox.ts`,
 * production argv). Three things rode along on that mount/HOME and none of
 * them belong in an unattended run:
 *   1. `~/.claude/settings.json`'s a custom `outputStyle` — a persona
 *      written for a human conversation ("Where he must choose, give two
 *      options at most… and your pick").
 *   2. That same file's `UserPromptSubmit`/`Stop` hooks (`ste-style.sh`,
 *      `ste-gate.py`) — a Stop hook can literally block the agent from
 *      finishing a turn.
 *   3. `~/.claude/CLAUDE.md`'s "Ask, every time" rule for destructive ops —
 *      correct advice for a person, fatal for a agent that must never ask
 *      anyone anything.
 * The builder duly adopted the persona verbatim ("This session is you and
 * me talking, not the loop running unattended… Which do you want?"),
 * emitted no completion marker, and was restarted blind eleven times in one
 * hour before the 3600s hard ceiling killed it — two nights lost on code
 * that was already correct.
 *
 * The fix: before any agent runs in a worktree, the loop writes its OWN
 * `<worktree>/.claude/settings.local.json` — the exact file `/config`
 * itself writes for a human — so local settings (which Claude Code's
 * documented precedence ranks above project and user settings) override the
 * inherited persona and hooks. `disableAllHooks: true` is used rather than
 * disabling each hook individually because Claude Code MERGES hooks across
 * every scope that defines them (user, project, local) — there is no lever
 * that turns off only the user-level ones, so the only reliable kill is
 * global. `outputStyle: "default"` overrides a custom style. `claudeMdExcludes`
 * keeps the owner's user-level CLAUDE.md from being read at all — at BOTH
 * homes it can appear under, because the two sandbox providers disagree on
 * which one their `claude` process actually resolves. See
 * `SANDBOX_CLAUDE_HOME`'s own doc comment below for exactly which entry
 * fires on which provider; both are load-bearing, neither is dead weight.
 *
 * Accepted cost (recorded, not fixed here): `disableAllHooks` also silences
 * this REPO's own `.claude/settings.json` hooks inside the sandbox —
 * prettier-on-save and three advisory `PreToolUse` rails
 * (`ralph-stop-triggers.sh`, `ralph-bash-triggers.sh`,
 * `config-protection.sh`). Those rails were bypassable by the builder
 * anyway (it can overwrite the same settings file itself), so a host-side
 * port is the real fix and is tracked as a follow-up ticket; the prettier
 * gap gets one compensating sentence in every prompt whose agent writes or
 * edits repo files instead (`implement-prompt.md`'s LINT section,
 * `check-writer-prompt.md`, `merge-prompt.md`,
 * and `post-merge-fix-prompt.md` — not the read-only
 * `review-prompt.md` or `post-merge-review-prompt.md`).
 *
 * The `~/.claude` mount itself is NOT narrowed by this fix — the prompts
 * require `~/.claude/skills/simplify` and the `context7-docs` skill, both
 * of which live under the user's home directory.
 */

/** Repo-relative path of the settings file this module writes. */
export const SANDBOX_AGENT_SETTINGS_RELPATH = ".claude/settings.local.json";

/**
 * The docker image's agent user home directory (`.sandcastle/Dockerfile`,
 * `useradd -m … agent`, `USER ${AGENT_UID}:${AGENT_GID}`) — the container's
 * own `HOME` is `/home/agent`, so its `claude` process resolves the
 * user-level CLAUDE.md at `/home/agent/.claude/CLAUDE.md`. Docker also
 * bind-mounts the LAUNCHING host's `~/.claude` onto that exact path
 * (`AUTH_MOUNTS` in `lib/sandbox-provider.ts`), so that file really is the
 * owner's own `~/.claude/CLAUDE.md`, just read back under this container
 * path.
 *
 * **Which `claudeMdExcludes` entry fires depends on the provider, and both
 * are load-bearing — neither may be trimmed as dead weight:**
 * - **docker** (the production provider, the VPS): the container's `HOME`
 *   is `/home/agent`, so THIS entry (`agentClaudeMd`) is the one that
 *   matches and excludes the file; `hostClaudeMd` (the launching host's own
 *   home, e.g. `/home/you/.claude/CLAUDE.md`) matches nothing inside the
 *   container and is inert there.
 * - **mac-host**: `claude` runs as a direct child process inheriting the
 *   launching host's own `HOME` (`lib/mac-host-sandbox.ts`), so `hostClaudeMd`
 *   is the one that fires; `/home/agent` matches nothing on a bare Mac (no
 *   such directory exists outside a container) and is inert there.
 */
export const SANDBOX_CLAUDE_HOME = "/home/agent";

export interface SandboxAgentSettings {
  readonly disableAllHooks: true;
  readonly outputStyle: "default";
  readonly claudeMdExcludes: readonly string[];
}

/**
 * Pure: the settings object the loop wants every sandboxed agent to run
 * under. `home` is the host's `os.homedir()` by default — the same home
 * docker bind-mounts and mac-host inherits via its child process `HOME`.
 * De-duplicates `claudeMdExcludes` when `home` already equals
 * `SANDBOX_CLAUDE_HOME` (a docker run launched AS the agent user, or a test
 * passing that value directly) so the file never carries a redundant glob.
 */
export function sandboxAgentSettings(
  home: string = os.homedir(),
): SandboxAgentSettings {
  const hostClaudeMd = path.join(home, ".claude", "CLAUDE.md");
  const agentClaudeMd = path.join(
    SANDBOX_CLAUDE_HOME,
    ".claude",
    "CLAUDE.md",
  );
  const claudeMdExcludes =
    hostClaudeMd === agentClaudeMd
      ? [hostClaudeMd]
      : [hostClaudeMd, agentClaudeMd];
  return {
    disableAllHooks: true,
    outputStyle: "default",
    claudeMdExcludes,
  };
}

/** Pretty-printed JSON, exactly what `/config` itself writes, plus a trailing newline. */
export function renderSandboxAgentSettings(home?: string): string {
  return `${JSON.stringify(sandboxAgentSettings(home), null, 2)}\n`;
}

/**
 * The mac-host provider spawns `claude` directly (no worktree-relative
 * settings file is guaranteed to exist yet at spawn time under
 * `--no-staging`), so it additionally pins the SAME settings via `--settings`
 * — which the documented precedence ranks above even a local settings file.
 */
export function sandboxAgentSettingsArgs(home?: string): string[] {
  return ["--settings", JSON.stringify(sandboxAgentSettings(home))];
}

/**
 * Write `<worktreePath>/.claude/settings.local.json`, always overwriting
 * whatever was there, then make sure git will never see it as untracked —
 * appending the relpath to the COMMON git directory's `info/exclude`
 * (idempotent: skipped if already present), the same pattern
 * `stageCodexAgentsMdIntoWorktree` (`lib/mac-host-sandbox.ts`) uses for
 * AGENTS.md. From inside a linked worktree, `git rev-parse --git-path
 * info/exclude` resolves to the COMMON dir's `info/exclude` (verified: this
 * repo's own worktree checkout resolves there today), so this is a shared,
 * one-time write across every worktree cut from the same repo — belt to the
 * tracked `.gitignore` line's braces.
 *
 * Never throws: a failure writing the settings file itself calls `warn`
 * once and returns without attempting the exclude step; a failure only in
 * the exclude step (including a plain non-git directory, where `git
 * rev-parse` itself fails) still leaves the settings file written and
 * calls `warn` once.
 */
export function writeSandboxAgentSettings(
  worktreePath: string,
  opts: { home?: string; warn?: (message: string) => void } = {},
): void {
  const warn = opts.warn ?? ((): void => {});

  try {
    mkdirSync(path.join(worktreePath, ".claude"), { recursive: true });
    writeFileSync(
      path.join(worktreePath, SANDBOX_AGENT_SETTINGS_RELPATH),
      renderSandboxAgentSettings(opts.home),
    );
  } catch (err) {
    warn(
      `failed to write ${SANDBOX_AGENT_SETTINGS_RELPATH} into ` +
        `${worktreePath}: ${(err as Error).message}`,
    );
    return;
  }

  addToGitInfoExclude(worktreePath, SANDBOX_AGENT_SETTINGS_RELPATH, warn);
}
