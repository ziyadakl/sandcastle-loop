/**
 * TEMPLATE COMMIT GUARD — a pure decision function backing the tracked
 * `.sandcastle/git-hooks/pre-commit` shim. It answers ONE question: should this
 * commit be blocked because an AGENT is hand-committing the sandcastle template?
 *
 * Root cause (incident behind commit dfb4e92): an agent edited-and-committed the
 * template directly instead of proposing the change. The fix is fail-closed but
 * NARROW — it fires only when BOTH hold:
 *   1. a staged path is inside the template (`.sandcastle/lib/**` or `skills/**`), and
 *   2. an agent/loop env marker is present (`CLAUDECODE` or `SANDCASTLE_LOOP`).
 *
 * A HUMAN maintainer commits these paths constantly and has NEITHER marker set,
 * so their commits pass untouched — the env gate is the whole point. No git I/O
 * here: the shim collects staged paths + env and hands them in, mirroring the
 * pure-lib / thin-runner split used across `lib/state/*`.
 */

/** The template path prefixes an agent must not hand-commit. `lib/` only — */
/** `.sandcastle/main.mts` and other non-lib template files are NOT guarded. */
const TEMPLATE_PREFIXES = [".sandcastle/lib/", "skills/"] as const;

/** Env vars that mark an agent/loop context (any truthy value counts). */
const AGENT_ENV_MARKERS = ["CLAUDECODE", "SANDCASTLE_LOOP"] as const;

export interface TemplateCommitInput {
  /** Staged paths, repo-relative (e.g. from `git diff --cached --name-only`). */
  readonly stagedPaths: readonly string[];
  /** The process environment to inspect for agent markers. */
  readonly env: Record<string, string | undefined>;
}

export interface TemplateCommitDecision {
  readonly blocked: boolean;
  /** Present only when blocked: why, and what to do instead. */
  readonly reason?: string;
}

function isTemplatePath(p: string): boolean {
  return TEMPLATE_PREFIXES.some((prefix) => p.startsWith(prefix));
}

function inAgentContext(env: Record<string, string | undefined>): boolean {
  return AGENT_ENV_MARKERS.some((k) => Boolean(env[k]));
}

/**
 * Decide whether to block this commit. `blocked` is true iff at least one staged
 * path is a template path AND an agent/loop env marker is present; otherwise the
 * commit is allowed (human maintainer, or a non-template change).
 */
export function blockTemplateCommit(input: TemplateCommitInput): TemplateCommitDecision {
  if (!inAgentContext(input.env)) return { blocked: false };

  const offending = input.stagedPaths.filter(isTemplatePath);
  if (offending.length === 0) return { blocked: false };

  const reason =
    "sandcastle: refusing to commit the template from an agent context " +
    `(CLAUDECODE / SANDCASTLE_LOOP set). Guarded paths staged:\n` +
    offending.map((p) => `  - ${p}`).join("\n") +
    "\n\nAgents must NEVER edit-and-commit the sandcastle template directly " +
    "(.sandcastle/lib/**, skills/**). Output a proposal via /sandcastle-feedback " +
    "instead, and let a human maintainer review and land it.";

  return { blocked: true, reason };
}
