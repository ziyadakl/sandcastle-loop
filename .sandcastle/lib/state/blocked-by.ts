/**
 * The `Blocked-by:` rule, as CODE.
 *
 * A ticket declares its dependencies in its body — `Blocked by: #N` inline, or
 * a `## Blocked by` heading with `#N` refs under it. Until 2026-09-03 the ONLY
 * thing honouring that declaration was the planner AGENT, an LLM following a
 * prose rule in a prompt file. On 2026-09-03 it misread one: its own log said
 * "#1065 — no blockers in body → eligible" while line 1 of #1065's body read
 * `Blocked-by: #1038`, and #1038 was open and dealt in the same refill. Both
 * tickets edited the same file; only an unrelated guard stopped the collision.
 * Then it misread the same queue the other way, dropping a ticket whose
 * blockers were both closed. The prompt file is gone, and so is the agent.
 *
 * This file is now read by both things that decide what may be worked:
 * `eligibleForPlanning` (`./eligible-set.ts`), which builds the plan, and
 * `blockedByGate` (`main.mts`), which re-checks every card again at deal time
 * because a blocker can change label while a card waits on the stack.
 */

import { LABEL_DONE, LABEL_SHIPPED_LOCAL } from "./gh.js";
import {
  ownerAuthoredPart,
  stripFencedCode,
} from "./issue-body-sections.js";
import { collectIssueRefs } from "./issue-refs.js";

/** The slice of an open-issue listing this module needs: number + labels. */
export interface OpenIssueLabels {
  readonly number: number;
  readonly labels: readonly string[];
}

/**
 * A blocker wearing one of these is finished as far as the queue is concerned,
 * even though it is still OPEN.
 *
 * ⚠️ Load-bearing, exactly as in the prompt. The loop no longer closes an
 * issue when it finishes it: it stops at `shipped-local` and leaves it open,
 * because the work sits on a run branch that has not reached the default
 * branch yet. Resolve blockers on ABSENCE alone and every ticket carrying a
 * `Blocked by:` reference becomes permanently blocked.
 */
export const BLOCKER_RESOLVING_LABELS: readonly string[] = [
  LABEL_SHIPPED_LOCAL,
  LABEL_DONE,
];

/**
 * Extract the issue numbers a body declares it is blocked by. Recognises TWO
 * forms:
 *   1. Inline directive `Blocked by: #N` / hyphenated `Blocked-by: #N`, both
 *      case-insensitively with flexible whitespace. A single line may name
 *      several blockers (`Blocked by: #313, #314`); each `#N` after the
 *      directive (up to the end of that line) is captured.
 *   2. Markdown header `## Blocked by` (any heading level, no colon) followed
 *      by `#N` refs on the lines below — collected until the next blank line
 *      or the next heading.
 * Returns a de-duplicated, ascending list merged across both forms.
 *
 * TWO regions of the body are cut out BEFORE either form is looked for, and
 * both cuts are load-bearing rather than tidy-minded:
 *   - The loop's own `<!-- sandcastle:…:start -->…:end -->` sections. The stop
 *     report, the criterion amendment and the run report all quote a ticket's
 *     text back into its own body, so a ticket stopped once for being blocked
 *     would re-declare its own blocker forever after the blocker had closed.
 *   - Fenced code blocks. A ticket ABOUT this gate — this one, for instance —
 *     shows `Blocked by: #9` inside a fence to explain the syntax. Reading a
 *     quotation as a declaration blocks that ticket on an issue nobody meant.
 * Both cuts come from `./issue-body-sections.ts`, shared with the check-writer's
 * proof-demand gate, which needs the same machine-section split.
 *
 * ⚠️ THIS IS THE BLOCKER GATE — it was not, until 2026-09-03, when the rule
 * lived in an LLM's prompt. It feeds {@link unresolvedBlockers}, which is read
 * by `eligibleForPlanning` (`./eligible-set.ts`) when the host builds the plan
 * and by `main.mts`'s `blockedByGate` when a worker picks a card up. Break
 * this parser and blocked tickets get dispatched out of order.
 */
export function parseBlockedBy(rawBody: string): number[] {
  if (typeof rawBody !== "string" || rawBody.length === 0) return [];
  // A DECLARATION only ever lives in text a person wrote outside a code fence.
  // See the two cuts described above.
  const body = stripFencedCode(ownerAuthoredPart(rawBody));
  const found = new Set<number>();
  // Canonical `#N` sweep (shared with parseSupersededBy); this parser dedupes
  // via `found` and returns ascending below, so first-seen order is irrelevant.
  const addRefs = (text: string): void => {
    for (const n of collectIssueRefs(text)) found.add(n);
  };
  // Form 1 — inline directive: `Blocked by: #N` (case-insensitive, hyphen ok).
  // Match the directive, then sweep the rest of that line for `#N` tokens.
  const directive = /blocked[\s-]*by\s*:\s*([^\n\r]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = directive.exec(body)) !== null) {
    addRefs(m[1] ?? "");
  }
  // Form 2 — markdown header: a `## Blocked by` / `### Blocked by` heading (no
  // colon) followed by `#N` refs on the lines below it. Collect refs until the
  // next blank line or the next heading.
  const lines = body.split(/\r?\n/);
  const header = /^\s*#{1,6}\s*blocked[\s-]*by\s*$/i;
  for (let i = 0; i < lines.length; i++) {
    if (!header.test(lines[i]!)) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!;
      if (line.trim() === "") break; // blank line ends the block
      if (/^\s*#{1,6}\s/.test(line)) break; // next markdown heading ends it
      addRefs(line);
    }
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * The blockers named by `body` that are STILL unresolved, given the full set
 * of open issues with their labels. Empty list = nothing is holding this
 * ticket back and it may be dealt.
 *
 * A blocker `#N` is RESOLVED when either:
 *   - `#N` is ABSENT from `openIssues` (closed or merged), or
 *   - `#N` is present and carries `shipped-local` or `done`
 *     ({@link BLOCKER_RESOLVING_LABELS}).
 * Otherwise it is UNRESOLVED — regardless of its other labels. `in-progress`,
 * `needs-human` and `quarantine` are all still blocking: a blocker a person
 * must act on and a blocker the loop failed on are treated identically here.
 *
 * `openIssues` MUST be the full open set across ALL labels, never a
 * label-filtered slice — a blocker that moved to `quarantine` disappears from
 * a `ready-for-agent` listing while remaining open and still blocking, and
 * reading "absent" off such a slice is exactly the out-of-order dispatch this
 * gate exists to make impossible.
 *
 * ⚠️ `opts.listingTruncated` INVERTS the absence clause, and it is not
 * optional bookkeeping. `listOpenIssuesWithBodies` asks `gh` for at most 500
 * rows; a listing that came back AT that cap may be missing rows, so "absent"
 * stops meaning "closed" and starts meaning "cannot see it". Resolving on
 * absence there is the fail-OPEN direction — a blocker cut off the end of a
 * capped listing would read as finished and its dependent would be dealt while
 * it was still building, the exact collision this gate exists to prevent. Pass
 * `true` whenever the listing hit its cap and every declared blocker that is
 * not present is treated as UNRESOLVED instead.
 */
export function unresolvedBlockers(
  body: string,
  openIssues: readonly OpenIssueLabels[],
  opts: { readonly listingTruncated?: boolean } = {},
): number[] {
  const declared = parseBlockedBy(body);
  if (declared.length === 0) return [];
  const labelsByNumber = new Map<number, readonly string[]>(
    openIssues.map((i) => [i.number, i.labels]),
  );
  const out: number[] = [];
  for (const n of declared) {
    const labels = labelsByNumber.get(n);
    if (labels === undefined) {
      // Absent. On a COMPLETE listing that means closed or merged → resolved.
      // On a listing at its cap it means unreadable → still blocking.
      if (opts.listingTruncated === true) out.push(n);
      continue;
    }
    if (labels.some((l) => BLOCKER_RESOLVING_LABELS.includes(l))) continue;
    out.push(n);
  }
  return out;
}

/**
 * One human-readable line naming why a pick is being skipped, for the run log
 * and for whoever reads it in the morning:
 * `blocked by #1038 (open, labels: in-progress, type:backend)`.
 *
 * A blocker that is not in `openIssues` at all can only reach here via the
 * truncated-listing path above, and it gets its own wording — telling the
 * reader the listing was capped is the difference between a ticket that is
 * genuinely waiting on a sibling and one waiting on a repo with too many open
 * issues to list, which is a thing a person can go and fix.
 */
export function describeUnresolvedBlockers(
  blockers: readonly number[],
  openIssues: readonly OpenIssueLabels[],
): string {
  const labelsByNumber = new Map<number, readonly string[]>(
    openIssues.map((i) => [i.number, i.labels]),
  );
  const parts = blockers.map((n) => {
    const labels = labelsByNumber.get(n);
    if (labels === undefined) {
      return `#${n} (not in the capped open-issue listing — cannot be proven resolved)`;
    }
    return `#${n} (open, labels: ${labels.length > 0 ? labels.join(", ") : "none"})`;
  });
  return `blocked by ${parts.join(", ")}`;
}
