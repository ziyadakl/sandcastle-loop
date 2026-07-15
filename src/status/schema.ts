/**
 * src-tree re-export SHIM for the status-feed schema.
 *
 * The status-feed schema has ONE canonical copy at
 * `.sandcastle/lib/status/schema.ts` (its own docstring: "SINGLE SOURCE OF
 * TRUTH … there is no twin"). The `src/state/*` tree is a byte-identical twin of
 * `.sandcastle/lib/state/*` that some tests import; `src/state/status-sync.ts`
 * imports its schema from `../status/schema.js`, which resolves HERE. Rather than
 * duplicate the 200-line zod schema (and violate its single-source-of-truth
 * invariant), this shim simply RE-EXPORTS the canonical module, so the src twin
 * type-checks and the test's `../src/state/status-sync.js` import chain resolves
 * to exactly the same schema the loop runs.
 */
export * from "../../.sandcastle/lib/status/schema.js";
