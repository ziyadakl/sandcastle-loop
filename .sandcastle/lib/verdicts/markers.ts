/**
 * Marker string constants and the strict marker-on-own-line discipline.
 *
 * Every load-bearing verdict in the loop is signalled by ONE of these markers
 * appearing as the LAST non-empty line of the agent's assistant text. The bash
 * driver (afk-ralph.sh) historically grepped free text and shipped 3 broken
 * stories overnight when an agent mentioned "ALL_CLEAR" mid-reasoning then
 * revised to HAS_BLOCKERS. We replicate the awk-tight discipline here.
 *
 * Three extraction modes:
 *   - tolerant: matches `^[[:space:][:punct:]]*MARKER[[:space:][:punct:]]*$`
 *     on the last non-empty line, allowing markdown decoration like
 *     `**ALL_CLEAR**`, `### HAS_BLOCKERS`, `> FIXED`, etc.
 *   - strict: matches `^[[:space:]]*MARKER[[:space:]]*$` only — bare on its
 *     own line, no surrounding chars. New prompts (prompt.md.local-fork,
 *     recovery-prompt.md.local-fork) instruct agents to use this form.
 *   - contains: the marker may appear anywhere in the last non-empty line,
 *     accepted iff exactly one allowed marker is present (post-merge reviewer
 *     only). See `ExtractMarkerOptions` in parse.ts for the authoritative def.
 *
 * The HALT promise is special: agents emit `<promise>HALT</promise>` rather
 * than the bare word HALT. The schemas store the canonical short form
 * ("HALT", "ALL_CLEAR", etc.) but extraction handles both surface forms.
 */

/** Implementer terminal markers. */
export const IMPLEMENTER_MARKERS = [
  "STORY_COMPLETE",
  "HALT",
  "RECOVERY_COMPLETE",
] as const;
export type ImplementerMarker = (typeof IMPLEMENTER_MARKERS)[number];

/** Reviewer terminal markers. */
export const REVIEWER_MARKERS = ["ALL_CLEAR", "HAS_BLOCKERS"] as const;
export type ReviewerMarker = (typeof REVIEWER_MARKERS)[number];

/** Fixer terminal markers. */
export const FIXER_MARKERS = ["FIXED", "BLOCKED"] as const;
export type FixerMarker = (typeof FIXER_MARKERS)[number];

/** Recovery agent terminal markers. */
export const RECOVERY_MARKERS = ["RECOVERY_COMPLETE", "HALT"] as const;
export type RecoveryMarker = (typeof RECOVERY_MARKERS)[number];

/** Union of every marker the loop knows about. */
export const ALL_MARKERS = [
  ...IMPLEMENTER_MARKERS,
  ...REVIEWER_MARKERS,
  ...FIXER_MARKERS,
] as const;
export type AnyMarker = (typeof ALL_MARKERS)[number];

/**
 * The HALT promise XML element. The bash driver looks for
 * `^<promise>HALT</promise>` at line-start; the new TS extractor accepts
 * either the short canonical "HALT" OR the wrapped form on its own line.
 */
export const HALT_PROMISE = "<promise>HALT</promise>" as const;

/**
 * Map a marker as it might appear in agent output (including the
 * `<promise>HALT</promise>` long form) to its canonical short name.
 * Used internally by the extractor; exported so callers writing custom
 * matchers stay consistent.
 */
export function canonicalizeMarker(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === HALT_PROMISE) return "HALT";
  return trimmed;
}

/**
 * Strip surrounding markdown punctuation (`*`, `#`, `>`, `_`, `~`, etc.) and
 * whitespace from a line, mirroring the bash awk regex
 * `^[[:space:][:punct:]]*X[[:space:][:punct:]]*$`. The bash version uses
 * POSIX [[:punct:]] which includes `<`, `>`, `/`, so the wrapped HALT promise
 * `<promise>HALT</promise>` would match a tolerant /HALT/ rule. We do NOT
 * want that — the wrapped form is its own canonical token. So this function
 * special-cases the promise: if the entire trimmed line equals the promise,
 * return "HALT"; otherwise, strip POSIX punctuation+whitespace.
 *
 * Note: keeping `<` and `>` in the strip set would let `<promise>HALT</promise>`
 * silently match a plain HALT rule. Instead we check for the exact promise
 * form first, then strip a narrower set of decoration characters that real
 * markdown uses.
 */
export function stripDecoration(line: string): string {
  const trimmed = line.trim();
  if (trimmed === HALT_PROMISE) return "HALT";
  // Strip leading/trailing markdown decoration: * _ ~ ` # > - = + . , : ; ! ?
  // and whitespace. Crucially we do NOT strip < or > so the promise form
  // can't be accidentally unwrapped to a bare HALT.
  return trimmed.replace(/^[\s*_~`#>\-=+.,:;!?]+|[\s*_~`#>\-=+.,:;!?]+$/g, "");
}
