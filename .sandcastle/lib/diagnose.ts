/**
 * Pre-recovery hint emitter.
 *
 * Production sandbox is LLM-only (no host shell-exec surface), so we don't
 * run the fix ourselves; we tell the recovery model what command to run via
 * bash. The hint is fed into the recovery prompt as `DIAGNOSE_HINT` and the
 * model is instructed to execute it inside the sandbox before deeper
 * investigation.
 *
 * Patterns are ported verbatim from the frozen v1 diagnose archive
 * (`archive/recovery/diagnose.ts`) — only the three causes with actionable
 * fix commands. Causes without a safe auto-fix (dev-server-down,
 * node-version-mismatch) are intentionally omitted: a hint-only port adds
 * no value when there's no command to suggest.
 *
 * Adding a new cause: extend `DiagnoseCause`, append a rule to
 * `DIAGNOSIS_RULES`, write a sentence-form hint, extend the test matrix.
 */

/** Classifications we emit hints for. */
export type DiagnoseCause =
  | "migration-unapplied"
  | "deps-missing"
  | "playwright-not-installed";

/**
 * The hint returned for a matched halt cause. `hint` is a fully-formed
 * sentence the recovery prompt drops in verbatim — no further templating.
 */
export interface DiagnoseHint {
  readonly cause: DiagnoseCause;
  readonly hint: string;
}

interface DiagnosisRule {
  readonly cause: DiagnoseCause;
  readonly pattern: RegExp;
  readonly hint: string;
}

/**
 * Rules in priority order. Patterns are deliberately narrow — anchored to
 * the exact phrases the relevant tool emits (pg, Node module resolution,
 * Playwright), not generic keywords — so prose mentioning "playwright" or
 * "module" doesn't false-positive.
 */
const DIAGNOSIS_RULES: readonly DiagnosisRule[] = [
  {
    cause: "migration-unapplied",
    pattern:
      /relation "[^"]+" does not exist|(?:error|Error|PostgresError|42P01):\s+relation .+ does not exist/,
    hint:
      "DIAGNOSED HIGH-CONFIDENCE FAILURE: migrations not applied. Run `pnpm db:migrate` in the sandbox via bash, confirm exit 0, then re-attempt the failing step before doing anything else.",
  },
  {
    cause: "deps-missing",
    pattern:
      /Cannot find module '[^']+'|Cannot find package '[^']+'|ERR_MODULE_NOT_FOUND/,
    hint:
      "DIAGNOSED HIGH-CONFIDENCE FAILURE: a required package is not installed. Run `pnpm install` in the sandbox via bash, confirm exit 0, then re-attempt the failing step before doing anything else.",
  },
  {
    cause: "playwright-not-installed",
    pattern: /Executable doesn't exist at .*chromium|please install playwright/i,
    hint:
      "DIAGNOSED HIGH-CONFIDENCE FAILURE: Playwright's chromium binary is missing. Run `pnpm exec playwright install chromium` in the sandbox via bash, confirm exit 0, then re-attempt the failing step.",
  },
];

/**
 * Walk the rule list against the agent's halt output. Return the first
 * match's hint, or `null` when nothing matches (caller proceeds with
 * generic recovery).
 */
export function diagnoseHaltCause(errMsg: string): DiagnoseHint | null {
  if (typeof errMsg !== "string" || errMsg.length === 0) {
    return null;
  }
  for (const rule of DIAGNOSIS_RULES) {
    if (rule.pattern.test(errMsg)) {
      return { cause: rule.cause, hint: rule.hint };
    }
  }
  return null;
}
