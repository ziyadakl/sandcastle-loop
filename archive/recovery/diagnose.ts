/**
 * Halt-cause diagnosis — pattern-matchers over agent halt output.
 *
 * The earlier "phase-1" multi-step recovery agent burned Opus on retries even
 * when the underlying problem was an unapplied migration or a dev server that
 * had crashed. This module is the cheap, deterministic pre-step: read the
 * halt output, classify the cause, suggest the argv that almost certainly
 * fixes it. The ladder runs the fix in-sandbox, retries with Sonnet, and
 * only escalates to Opus when diagnosis is `"unknown"` or the fix did not
 * un-stick the run.
 *
 * Patterns are intentionally narrow. A confident `"high"` match is worth a
 * cheap fix attempt; everything else punts to Opus. Adding a new cause
 * means: (1) extend `HaltCause`, (2) add one regex + fixCommand, (3) extend
 * the test matrix in `tests/recovery.test.ts`. No other code changes.
 */

/** Coarse classification of why an agent halted. */
export type HaltCause =
  | "dev-server-down"
  | "migration-unapplied"
  | "deps-missing"
  | "playwright-not-installed"
  | "node-version-mismatch"
  | "unknown";

/**
 * The diagnosis of a single halt event. `evidence` is the raw line from the
 * halt output that produced the match — surfaced verbatim in logs so a human
 * skimming a quarantine message can verify the diagnosis is plausible.
 */
export interface Diagnosis {
  /** Classification of the halt cause. */
  readonly cause: HaltCause;
  /** The exact substring(s) that triggered the match (or "(no match)"). */
  readonly evidence: string;
  /**
   * argv array for the fix command, e.g. `["pnpm", "install"]`. `null` when
   * the cause is identified but cannot be auto-fixed (dev server crashed,
   * Node version mismatch) — the caller treats `null` as "skip fix, escalate".
   */
  readonly fixCommand: readonly string[] | null;
  /** How sure the matcher is. `"low"` is reserved for the `"unknown"` fallback. */
  readonly confidence: "high" | "medium" | "low";
}

/**
 * Single rule entry: a regex tested against the halt output, the cause it
 * implies, and (optionally) the fix argv. `fixCommand: null` means the cause
 * is identifiable but no auto-fix is safe; the caller decides whether to
 * escalate or quarantine with the named cause.
 *
 * Order matters: rules are tested in declaration order and the first match
 * wins. Put more-specific patterns above broader ones.
 */
interface DiagnosisRule {
  readonly cause: Exclude<HaltCause, "unknown">;
  readonly pattern: RegExp;
  readonly fixCommand: readonly string[] | null;
  readonly confidence: "high" | "medium";
}

/**
 * Pattern matchers, in priority order. All are case-sensitive by default —
 * the strings we match against are stack traces / pnpm output / node engine
 * errors, all of which preserve case. Where casing varies in practice (e.g.
 * "Cannot find module" vs "cannot find module") we use the `i` flag.
 *
 * Deliberately narrow: each pattern is anchored to a string the relevant
 * tool actually emits, not a generic word like "module" or "database".
 */
const RULES: readonly DiagnosisRule[] = [
  // Dev server down — Node/Express/Vite/Next all surface this exact phrase
  // when a fetch hits a port nothing is listening on. We accept either
  // `connect ECONNREFUSED` (Node fetch / undici) or the longer
  // `ECONNREFUSED 127.0.0.1:PORT` / `ECONNREFUSED localhost:PORT` form.
  // Fix is environment-specific (which port? which command starts it?), so
  // we mark cause but return no auto-fix.
  {
    cause: "dev-server-down",
    pattern: /ECONNREFUSED\s+(?:[a-zA-Z0-9.\-]+:)?\d+|connect ECONNREFUSED/,
    fixCommand: null,
    confidence: "high",
  },

  // Migration unapplied — Postgres surface form. Drizzle/Prisma/raw pg all
  // bubble this up identically. We accept several leading prefixes:
  //   * bare:                relation "users" does not exist
  //   * lowercase prefix:    error: relation users does not exist
  //   * mixed-case prefix:   Error: relation "users" does not exist
  //   * Drizzle 0.30+:       PostgresError: relation "users" does not exist
  //   * Postgres SQLSTATE:   42P01: relation "users" does not exist
  // The leading word is matched case-insensitively (via inline `(?i:...)`
  // through the `i`-flagged alternation), but the SQL phrase
  // `relation ... does not exist` is matched case-sensitively because pg
  // never varies that surface form. The relation name is captured but
  // unused; we keep it tight to avoid matching prose like "the relation
  // between X and Y does not exist".
  {
    cause: "migration-unapplied",
    pattern:
      /relation "[^"]+" does not exist|(?:error|Error|PostgresError|42P01):\s+relation .+ does not exist/,
    fixCommand: ["pnpm", "db:migrate"],
    confidence: "high",
  },

  // Deps missing — Node module resolution failure. Surface forms covered:
  //   * CommonJS:        Cannot find module 'react'
  //   * ESM (CJS-style): Cannot find package 'react'
  //   * Node 20+ ESM:    Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'foo'
  //   * Imported-from:   Cannot find module './local' imported from /path/file.js
  //   * Standalone code: ERR_MODULE_NOT_FOUND  (sometimes appears alone in
  //                      shorter stack output without the surrounding sentence)
  // All indicate `pnpm install` is the right move (the imported-from form is
  // usually a missing dep too — a missing local file would have surfaced as a
  // build-time error long before runtime).
  {
    cause: "deps-missing",
    pattern:
      /Cannot find module '[^']+'|Cannot find package '[^']+'|ERR_MODULE_NOT_FOUND/,
    fixCommand: ["pnpm", "install"],
    confidence: "high",
  },

  // Playwright not installed — browser binaries missing. Playwright prints
  // a fairly stable "Executable doesn't exist at .../chromium" line, plus a
  // "please install playwright" hint in some versions.
  {
    cause: "playwright-not-installed",
    pattern: /Executable doesn't exist at .*chromium|please install playwright/i,
    fixCommand: ["pnpm", "exec", "playwright", "install", "chromium"],
    confidence: "high",
  },

  // Node engine mismatch — pnpm prints EBADENGINE; npm prints
  // "Unsupported engine". We can't auto-fix this (would need nvm/volta and
  // the right version), so cause is named but fix is null.
  {
    cause: "node-version-mismatch",
    pattern: /EBADENGINE|Unsupported engine/,
    fixCommand: null,
    confidence: "high",
  },
];

/**
 * Diagnose a single halt event from the agent's halt output (typically the
 * tail of stdout/stderr or the assistant's `<promise>HALT</promise>` prose).
 *
 * Returns the first rule that matches; falls back to `"unknown"` with
 * `confidence: "low"` when nothing matches. The fallback is intentional —
 * the caller (`runRecoveryDiagnosisOrEscalate`) reads `cause === "unknown"`
 * as "skip the cheap fix, escalate to Opus".
 */
export function diagnoseHaltCause(haltOutput: string): Diagnosis {
  // Defensive: callers may pass an empty string when the halt context has
  // neither lastAssistantText nor a reason. Treat that as "unknown" rather
  // than throwing — the ladder still has the option to escalate.
  if (typeof haltOutput !== "string" || haltOutput.length === 0) {
    return {
      cause: "unknown",
      evidence: "(no halt output provided)",
      fixCommand: null,
      confidence: "low",
    };
  }

  for (const rule of RULES) {
    const match = rule.pattern.exec(haltOutput);
    if (match !== null) {
      return {
        cause: rule.cause,
        // `match[0]` is the matched substring — the smallest fragment of
        // halt output that actually justifies the diagnosis. Truncated to
        // 200 chars so a runaway capture (e.g. a multi-line stack trace
        // somehow folded into one line) doesn't pollute logs.
        evidence: match[0].slice(0, 200),
        fixCommand: rule.fixCommand,
        confidence: rule.confidence,
      };
    }
  }

  return {
    cause: "unknown",
    evidence: "(no match)",
    fixCommand: null,
    confidence: "low",
  };
}
