/**
 * Issue #1225 — the error-classification family, lifted out of `main.mts` (the
 * loop orchestrator) as ONE cohesive module. Every member reads an error
 * message and answers one question about it: is this failure permanent, a
 * rate-limit, a transient server fault, an output-token-cap hit, or a stall?
 *
 * The predicates are pure — a string in, a boolean out, no I/O and no state —
 * which is why they can live here and be tested directly rather than only
 * through whatever pipeline path happens to reach them.
 *
 * ## The scope line, and why it is drawn here
 *
 * Issue #1216 attempted this same extraction and REVERTED it. The reason:
 * `isRateLimitError` also gates the model-fallback circuit breaker in
 * `runMain`, so moving only the pipeline's classifiers left the family split
 * across two files with the shared `isPermanentError` guard duplicated.
 *
 * The line that fixes it: every PURE classifier moves here, and nothing else.
 * The stateful neighbours these predicates sit beside in `main.mts` stay put —
 * the breaker's `fallbackHistory` map, the per-issue `deferralCounts`, and
 * `__resetTransientStateForTests` (which also clears unrelated staging-worktree
 * and lock-TTL state, so it could never travel with the family anyway). The
 * breaker keeps its gate by importing {@link isRateLimitError} from here.
 *
 * Do not move the stateful pieces in later "for tidiness": they are run-scoped
 * mutable state owned by the orchestrator, and this module would stop being
 * pure the moment they arrived.
 */

/** Negative guard shared by the three retryable-error predicates below
 * (`isRateLimitError`, `isTransientServerError`, `isOutputCapError`):
 * permanent errors that won't recover via retry. Matched as snake_case SDK
 * slugs (won't hit prose) or JSON-shaped numeric codes.
 *
 * Exported for direct testing only. Every production caller reaches it
 * through one of those three predicates — do not add a direct caller without
 * deciding which of them should have covered the case instead. */
export function isPermanentError(msg: string): boolean {
  return /\b(invalid_api_key|invalid_request_error|authentication_error|permission_error|not_found_error|model_not_found|insufficient_quota|account_deactivated)\b|"code"\s*:\s*1113\b|"code"\s*:\s*1110\b/i.test(
    msg,
  );
}

/** Match common shapes of rate-limit / quota errors across providers. */
export function isRateLimitError(msg: string): boolean {
  if (isPermanentError(msg)) return false;
  return /rate[- ]?limit|\b429\b|rate_limit_error|\bquota\b|usage limit/i.test(
    msg,
  );
}

/** Match transient HTTP 5xx / upstream-infra-unhealthy errors. Distinct from
 * rate-limit because these shouldn't trigger a model fallback — they're not
 * a problem with the chosen model, just bad luck on the provider's
 * infrastructure. Used at the pipeline catch level to defer instead of
 * quarantine.
 *
 * Patterns are intentionally context-anchored. A bare `\b5\d{2}\b` would
 * mis-classify "Postgres on port 5432" or "vite on 5173" as transient.
 * Each alternative requires HTTP-error context: Anthropic prose, JSON SDK
 * slugs in `"type":...` shape, the 529 numeric (Anthropic-specific, rare
 * elsewhere), or the full "500 Internal Server Error" / "503 Service
 * Unavailable" / "502 Bad Gateway" / "504 Gateway Timeout" phrases.
 *
 * One inherited redundancy, named so nobody writes a test that cannot fail:
 * the JSON `"type": "overloaded_error"` shape is fully subsumed by the
 * standalone `\boverloaded_error\b` alternative beside it. Narrowing the JSON
 * alternative changes no answer. It is kept for readability and NOT removed
 * here, because this module is a behaviour-preserving move; removing it would
 * be its own ticket.
 */
export function isTransientServerError(msg: string): boolean {
  if (isPermanentError(msg)) return false;
  return /the server had an error|"type"\s*:\s*"(?:api_error|overloaded_error)"|\boverloaded_error\b|\b529\b|\bservice unavailable\b|\bbad gateway\b|\bgateway timeout\b|\b500 internal server error\b/i.test(
    msg,
  );
}

/** Combined predicate for the pipeline-catch defer decision. Either kind of
 * transient error (rate-limit OR 5xx) → defer rather than quarantine. */
export function isTransientError(msg: string): boolean {
  return isRateLimitError(msg) || isTransientServerError(msg);
}

/**
 * Match an output-token-cap failure: the model's response hit the
 * `max_tokens` / maximum-output-tokens ceiling and the SDK surfaced it as an
 * error rather than a usable completion. Before this predicate existed, such
 * a message matched none of the classifiers above and fell through to a
 * SILENT generic quarantine — operators saw "pipeline halted" with no clue
 * the real cause was a truncated response (audit issue #2).
 *
 * Treated as bounded-retryable (see the pipeline catch): a re-run can produce
 * a shorter response, or the raised `CLAUDE_CODE_MAX_OUTPUT_TOKENS` default
 * (see `maxOutputTokensEnv`) can give the model enough headroom. Bounded by
 * MAX_DEFERRALS so it can't loop forever on a genuinely too-large task.
 *
 * Guarded by `isPermanentError` first, matching the sibling predicates
 * (`isRateLimitError` / `isTransientServerError`): a permanent-error slug
 * (e.g. `invalid_api_key`) always wins, even if cap-ish phrasing also
 * appears in the message.
 *
 * Patterns are anchored to phrasing that co-occurs with the cap so bare words
 * ("token", "output", "exceeds") don't false-positive on unrelated prose, and
 * so permanent (non-retryable) errors that merely mention "maximum" don't
 * get misclassified as a retryable output-cap — notably HTTP-413 ("Payload
 * exceeds the maximum allowed size") and too-high-config validation errors
 * ("max_tokens: 65536 exceeds the maximum of 32768"). Both mention "exceeds
 * the maximum" but neither is a genuine runtime output-truncation, and
 * retrying can't fix either (audit #2 rework):
 *   - `max_tokens` (not followed by `: N` / `= N`) — SDK / API snake_case
 *                                        slug for a genuine runtime cap hit
 *                                        ("max_tokens reached"); the negative
 *                                        lookahead excludes the
 *                                        config-validation comparison shape
 *                                        ("max_tokens: 65536 exceeds...",
 *                                        "max_tokens: 4096 > 8192") which is
 *                                        a permanent too-high-config error,
 *                                        not a runtime truncation
 *   - `maximum output tokens?`           — Anthropic prose (with optional
 *                                        "the", singular or plural "token")
 *   - `output too long`                  — generic truncation phrasing
 *   - `exceeds the maximum output tokens?` — token-anchored variant of the
 *                                        generic "exceeds the maximum" (the
 *                                        bare/unanchored form was dropped —
 *                                        it false-positived on HTTP-413 and
 *                                        config-validation errors)
 *   - `Claude'?s response exceeded`      — Claude-specific overflow phrasing,
 *                                        apostrophe optional
 *
 * One inherited redundancy, named so nobody writes a test that cannot fail:
 * `exceeds the maximum output tokens?` is fully subsumed by the
 * `maximum output tokens?` alternative above it, so deleting it changes no
 * answer. It is kept because it documents the anchored replacement for the
 * bare "exceeds the maximum" form that was dropped, and NOT removed here,
 * because this module is a behaviour-preserving move.
 */
export function isOutputCapError(msg: string): boolean {
  if (isPermanentError(msg)) return false;
  return /\bmax_tokens\b(?!\s*[:=]\s*\d)|maximum output tokens?|output too long|exceeds the maximum output tokens?|claude'?s response exceeded/i.test(
    msg,
  );
}

/**
 * Stall-shape error matcher. An error message matches when the underlying
 * failure was the sandbox going unresponsive (SDK idle timer firing, host
 * wall-clock watchdog firing, or a node-level ETIMEDOUT on supporting
 * calls) — distinct from a code-level failure like "reviewer marked
 * HAS_BLOCKERS" or "test assertion failed". Used in exactly three places in
 * `main.mts` (verified 2026-09-06; this list is the drift protection, so
 * correct it if a site moves):
 *   1. The per-issue pipeline catch (around runIssuePipeline) sets
 *      IssueOutcome.stalled when this matches the thrown error.
 *   2. `runMain`'s post-merge reviewer retries ONCE on the same model
 *      instead of quarantining, because a stall means the reviewer never
 *      got to a verdict — and quarantining an already-merged batch
 *      destroys good code (observed in a real run).
 *   3. `runMain`'s completion breaker counts a stalled rejection toward the
 *      sandbox-health streak, exactly like a stalled fulfilled outcome.
 * Kept as a single shared constant so those call sites can't drift.
 *
 * Carries no `g` flag on purpose: a global regex advances `lastIndex` between
 * `.test()` calls, so the shared constant would alternate its answer across
 * those call sites.
 *
 * Patterns:
 *   - "hard ceiling"            — withHardCeiling watchdog.
 *                                  Also produced by `runBuilderIterations`
 *                                  (`lib/builder-progress.ts`) when the
 *                                  implementer batch's SHARED wall-clock
 *                                  deadline passes between passes — that
 *                                  throw is deliberately prefixed the same
 *                                  way so it classifies identically.
 *   - "agent idle for"          — SDK AgentIdleTimeoutError message stem
 *                                  (`Agent idle for N seconds — no output
 *                                  received`, from the SDK's Orchestrator —
 *                                  no line number, it drifts on every bump)
 *   - "AgentIdleTimeoutError"   — SDK error tag, in case the message text
 *                                  changes upstream but the class name stays
 *   - "no output received"      — secondary SDK phrase, defensive
 *   - "ETIMEDOUT"               — node net-level timeout (rare here)
 */
export const STALL_RE =
  /hard ceiling|agent idle for|AgentIdleTimeoutError|no output received|ETIMEDOUT/i;
