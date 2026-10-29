/**
 * The one place the STORED record shape and the SCORED record shape are made to
 * agree — and the only place that is allowed to know both.
 *
 * `rework-store.ts` (the writer) and `rework-rate.ts` (the pure scorer) do not
 * import each other, on purpose: the scorer takes a structural record so it can
 * be exercised with plain object literals and can never be dragged into the
 * store's zod/fs dependencies. The cost of that separation is that nothing made
 * the two shapes agree — the store writes
 * `models: Record<string, RoleModelEntry>` (a per-role LADDER) while the scorer
 * groups on `models?: Record<string, string>` (role → one model id), and a
 * single flattening helper in one CLI was all that bridged them. If either side
 * changed, the report kept compiling and printed a by-model table attributing
 * issues to the wrong models.
 *
 * So the bridge lives here, typed off BOTH sides via `import type` (erased at
 * runtime, so neither module gains a runtime dependency on the other): the
 * signatures below are written as `ReworkRecord[...] -> ReworkIssueRecord[...]`
 * rather than as concrete types, which makes drift on either side a typecheck
 * failure in this file instead of a silently wrong table.
 */
import type { ReworkIssueRecord } from "./rework-rate.js";
import type { ReworkOutcome, ReworkRecord } from "./rework-store.js";

/**
 * Static assertion that every outcome the store can WRITE is an outcome the
 * scorer can READ. Purely a type-level check — it compiles to nothing.
 *
 * If the store's enum gains a member (say `"abandoned"`), this line fails to
 * compile, which is the entire point: without it the new outcome would flow
 * into the scorer typed as an unknown string, be treated as "not shipped", and
 * quietly drop those issues out of every aggregate with no error anywhere.
 */
type _OutcomesAgree = ReworkOutcome extends NonNullable<
  ReworkIssueRecord["outcome"]
>
  ? true
  : never;
/** Instantiating the assertion is what makes the compiler evaluate it. */
const _outcomesAgree: _OutcomesAgree = true;
void _outcomesAgree;

/**
 * Flatten the stored ladder to what the scorer groups on: role → the model that
 * role DEFAULTS to. Escalation targets are deliberately excluded — the record
 * states the ladder that was configured, not the rungs that were climbed, and
 * crediting an escalation model for an issue it may never have touched would
 * put a fabricated row in the by-model table.
 *
 * Returns `undefined` (absent) when nothing usable survived, including for an
 * empty ladder: `{}` would claim "measured, no roles", which is a claim the
 * record did not make. Absent ≠ empty, as everywhere else in `lib/telemetry/`.
 *
 * The signature is the drift guard — both halves are read off the two record
 * types, so a change to `RoleModelEntry` or to the scorer's `models` field
 * fails HERE rather than producing a wrong table.
 */
export function flattenModels(
  models: ReworkRecord["models"],
): ReworkIssueRecord["models"] {
  if (models === undefined) return undefined;
  const out: Record<string, string> = {};
  let any = false;
  for (const [role, entry] of Object.entries(models)) {
    if (typeof entry?.default !== "string" || entry.default === "") continue;
    out[role] = entry.default;
    any = true;
  }
  return any ? out : undefined;
}
