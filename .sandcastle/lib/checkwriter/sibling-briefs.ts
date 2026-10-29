/**
 * What the OTHER tickets in this same loop run are building, in a form the
 * check-writer can read before it writes a line of its acceptance check.
 *
 * ## Why this exists
 *
 * The check-writer runs once per ticket, before that ticket's builder, and
 * until now it was handed exactly one ticket number: its own. That is fine
 * when a run holds one ticket. It is wrong the moment a run holds seventeen,
 * because the check it writes has to survive not just its own builder's diff
 * but every sibling builder's diff too — all of which land on the same
 * integration branch, hours later, on code the check-writer never saw.
 *
 * Every fault the 2026-08-11 batch of 17 tickets produced lived in that seam.
 * The sharpest one: a ticket added a guard refusing a second deal at an
 * address that already has one, while a sibling ticket's acceptance check
 * filed its fixture deals at a fixed, hard-coded address. Each ticket was
 * correct alone. Together, the second ticket's check refuses its own fixture
 * setup — a check that blocks itself, discovered only after both had shipped.
 * Nothing in the loop could have caught that, because no agent in the run was
 * ever shown two tickets at once.
 *
 * ## What a brief is, and what it deliberately is not
 *
 * A brief is the ticket's NUMBER, its TITLE and the OPENING of its body. It
 * is prompt context: a statement of intent about work that does not exist
 * yet, handed to a model so it can steer around it. Three consequences follow
 * and all three are deliberate:
 *
 *   - **The body is truncated** to {@link SIBLING_BODY_MAX_CHARS}, with the
 *     cut marked in the text itself. A run of seventeen tickets would
 *     otherwise push sixteen full ticket bodies into every check-writer's
 *     context, crowding out the thing it is actually being asked to grade.
 *     The marker matters as much as the cut: an unmarked fragment reads to a
 *     model as a complete ticket, and a model that believes it has read the
 *     whole neighbouring spec will confidently conclude things the missing
 *     half contradicts.
 *   - **Collection never throws.** A `gh` failure on one ticket degrades that
 *     one brief to title-only; it does not fail the other sixteen and it
 *     absolutely does not abort the run. This mirrors the fail-soft contract
 *     the ticket's OWN body fetch already carries in `runMain`.
 *   - **A brief authorises nothing.** It is read by a prompt and by nothing
 *     else. In particular it is NOT `PipelineCtx.issueBody`, which the
 *     ship-time removal gate reads to decide whether a person already agreed
 *     to a test deletion (`proof-demand.ts`'s `preauthorizedTestDeletions`).
 *     That gate must only ever read the ticket's OWN text: a design where a
 *     neighbouring ticket's body could pre-authorise this ticket's deletions
 *     would let any one ticket in a batch quietly widen what every other
 *     ticket is allowed to delete. Keeping these two fields separate — a
 *     separate type, a separate field, a separate collection point — is what
 *     makes that impossible rather than merely unlikely.
 *
 * This module doc is the ONE telling of the 2026-08-11 collision on the code
 * side; `PipelineCtx.siblingTickets` and `runMain`'s collection point in
 * `main.mts` point here rather than retelling it, so the story cannot end up
 * corrected in one place and stale in two. (`check-writer-prompt.md` states it
 * again in full on purpose — that copy is not documentation, it is the text a
 * model reads at dispatch time.)
 */

import { isUsableIssueNumber } from "./check-path.js";

/**
 * One other ticket in this run, as the check-writer sees it.
 *
 * `body` distinguishes two facts that a model must never see confused, so it
 * has three states rather than two:
 *
 *   - **absent** — the body could not be READ: a `gh` failure, or a caller
 *     with no fetcher at all.
 *   - **empty string** — the body was read and the ticket genuinely has none.
 *   - **anything else** — the body, trimmed and capped.
 *
 * The difference is not pedantry. "We could not read this ticket" invites a
 * check-writer to steer wide of a neighbour it cannot see; "this ticket says
 * nothing beyond its title" tells it there is nothing more to steer around.
 * {@link renderSiblingTickets} prints a different sentence for each, and the
 * easy mistake — collapsing both to `undefined` and printing the fetch-failure
 * sentence for an empty ticket — hands a model a fact that is simply untrue.
 *
 * A title-only brief is worth rendering either way — a neighbouring title
 * alone is often enough to warn a check-writer off a fixture value.
 */
export interface SiblingTicketBrief {
  readonly number: number;
  readonly title: string;
  readonly body?: string;
}

/**
 * How much of a sibling's body the check-writer gets. Sized to carry a
 * ticket's summary and its first requirement or two — the part that names the
 * rule a neighbouring check could collide with — without carrying its full
 * implementation notes. Exported so the test asserting the cut and the code
 * making it can never drift.
 */
export const SIBLING_BODY_MAX_CHARS = 1200;

/**
 * Appended verbatim when a body was cut. Reads as prose rather than as an
 * ellipsis alone so a model cannot mistake it for the ticket's own writing.
 */
const TRUNCATION_MARKER = "\n… (truncated)";

/**
 * What the check-writer is shown when it is the only ticket in the run.
 *
 * A REAL SENTENCE, not an empty string, and that is load-bearing twice over.
 * `applyPromptArgs` throws when a placeholder has no key, so the arg can never
 * simply be omitted; and a blank block reads to a model as "this section was
 * meant to have something in it", which invites it to go hunting for tickets
 * that are not there. The one-shot `--issue N` path takes this branch every
 * time it runs, so it is an ordinary case, not an error case.
 */
export const NO_SIBLING_TICKETS =
  "(no other tickets — yours is the only ticket in this run, so nothing " +
  "here constrains your check)";

/**
 * Shown in place of a body that could not be READ, so the gap is visibly a
 * fetch failure. Deliberately different prose from {@link BODY_EMPTY} — see
 * {@link SiblingTicketBrief} for why a model must not be told one when the
 * other is true.
 */
const BODY_UNAVAILABLE =
  "(this ticket's body could not be read — its title above is all we have)";

/** Shown for a ticket that was read fine and simply has no body. */
const BODY_EMPTY =
  "(this ticket has no body — its title above is the whole ticket)";

/**
 * The body a brief carries: trimmed, capped at {@link SIBLING_BODY_MAX_CHARS},
 * and marked when cut.
 *
 * The three-state return is the whole point (see {@link SiblingTicketBrief}):
 * `undefined` ONLY for a body that was never read — a non-string, which is
 * what a fetcher that resolves nothing hands back — and `""` for a body that
 * was read and is blank. This function is the single place the two are told
 * apart, so every caller inherits the distinction rather than re-deciding it.
 */
export function truncateSiblingBody(
  body: string | null | undefined,
): string | undefined {
  if (typeof body !== "string") return undefined;
  const trimmed = body.trim();
  if (trimmed.length <= SIBLING_BODY_MAX_CHARS) return trimmed;
  return trimmed.slice(0, SIBLING_BODY_MAX_CHARS) + TRUNCATION_MARKER;
}

/** The minimum a planned issue has to expose to become a brief. */
export interface PlannedTicket {
  readonly id: string;
  readonly title: string;
}

export interface CollectSiblingBriefsOptions {
  /**
   * Reads one issue's body markdown — in production `deps.getIssueBody`,
   * which shells to `gh`. OPTIONAL: a caller without one gets title-only
   * briefs, which is the same graceful degradation a `gh` failure produces,
   * so no caller has to special-case its absence.
   */
  readonly getIssueBody?: (issueNumber: number) => Promise<string | undefined>;
  /** Where a per-ticket fetch failure is reported. Never rethrown. */
  readonly logError?: (message: string) => void;
}

/**
 * Every planned ticket in this iteration as a brief, fetched CONCURRENTLY and
 * fail-soft per ticket.
 *
 * ## Collected once per iteration, not once per ticket
 *
 * The caller (`runMain`) builds this list ONCE, before the dispatch pool
 * starts, and hands each pipeline a filtered view of it. Collecting per
 * ticket would issue N² `gh` calls for an N-ticket run — 289 for the
 * 2026-08-11 batch — to produce N copies of the same answer.
 *
 * ## Never rejects
 *
 * A ticket whose body cannot be read degrades to title-only and is logged.
 * The returned promise resolves for every input, in input order, whatever
 * `gh` does. This is prompt context: losing a body costs the check-writer
 * some steering, while throwing here would cost the whole run.
 *
 * ## One predicate, two reactions
 *
 * A plan entry whose `id` is not a usable issue number is dropped rather than
 * rendered as `#NaN`. The test applied is {@link isUsableIssueNumber} — the
 * SAME function `runMain`'s dispatch pool applies to the same entry, not a
 * second opinion that could drift from it. What differs is the reaction, and
 * deliberately: the pool THROWS, because such an entry is a real fault in the
 * plan and somebody has to be told; this collector, which runs BEFORE the pool
 * and only feeds a prompt, drops it, because throwing here would take the
 * whole iteration down for a fault the pool is about to report properly a
 * moment later. Nothing is hidden — the entry still crashes its own dispatch.
 */
export async function collectSiblingBriefs(
  plan: readonly PlannedTicket[],
  opts: CollectSiblingBriefsOptions,
): Promise<readonly SiblingTicketBrief[]> {
  const numbered = plan
    .map((p) => ({ number: Number(p.id), title: p.title }))
    .filter((p) => isUsableIssueNumber(p.number));
  const { getIssueBody, logError } = opts;
  if (getIssueBody === undefined) return numbered;
  return await Promise.all(
    numbered.map(async ({ number, title }) => {
      try {
        const body = truncateSiblingBody(await getIssueBody(number));
        return { number, title, body };
      } catch (err) {
        // `String(err)` rather than `(err as Error).message`, which prints
        // `undefined` for anything thrown that is not an Error — and a
        // fail-soft log whose one job is naming the cause must not lose it.
        // Same shape as `verify-checks.ts`'s own catch.
        const reason = err instanceof Error ? err.message : String(err);
        logError?.(
          `could not read issue #${number}'s body for the sibling-ticket ` +
            `brief: ${reason} — the other tickets in this ` +
            `run will see its title only.`,
        );
        return { number, title };
      }
    }),
  );
}

/**
 * The run's briefs with `issueNumber`'s own entry removed — what one ticket's
 * check-writer is actually shown.
 *
 * Handing a ticket its own brief would be worse than merely redundant: the
 * prompt frames this list as work OTHER agents are doing concurrently, so a
 * check-writer reading its own ticket back would treat its own requirements
 * as a neighbour's constraint to steer around, which is the exact opposite of
 * what it is meant to do with them.
 */
export function siblingBriefsExcluding(
  briefs: readonly SiblingTicketBrief[] | undefined,
  issueNumber: number,
): readonly SiblingTicketBrief[] {
  return (briefs ?? []).filter((b) => b.number !== issueNumber);
}

/**
 * The delimiter tags that give this block its shape: `<sibling-ticket>`, which
 * this module writes, and the `<sibling-tickets>` wrapper
 * `check-writer-prompt.md` puts around the whole block. Matched in either
 * form, opening or closing, whatever the case and whatever the internal
 * spacing, because the point is what a MODEL will read as a tag, not what an
 * XML parser would.
 *
 * Used only through `String.replace`, which resets `lastIndex` itself, so the
 * `g` flag carries no state between calls.
 */
const BLOCK_DELIMITER_RE = /<\s*(\/?)\s*(sibling-tickets?)\s*>/gi;

/**
 * A ticket's own text, made unable to close the block it is being rendered
 * inside. The tag survives visibly as `&lt;/sibling-ticket&gt;` rather than
 * being stripped: a check-writer reading a neighbour that literally discusses
 * these tags should still see that it does.
 */
function escapeBlockDelimiters(text: string): string {
  return text.replace(BLOCK_DELIMITER_RE, "&lt;$1$2&gt;");
}

/** One brief's body line: the three states of `body`, in three sentences. */
function renderBody(body: string | undefined): string {
  if (body === undefined) return BODY_UNAVAILABLE;
  const trimmed = body.trim();
  if (trimmed.length === 0) return BODY_EMPTY;
  return escapeBlockDelimiters(trimmed);
}

/**
 * The briefs as the block that fills `{{SIBLING_TICKETS}}`.
 *
 * Numbers and titles are rendered on their own line rather than as XML
 * attributes, so a quote or a stray angle bracket in a title cannot break the
 * block's shape — and a shape a model has to guess at is worse than no shape
 * at all. That leaves exactly ONE sequence that can still break it: a
 * delimiter tag inside a ticket's own text. Which is not an exotic input —
 * the ticket that introduced this very module contains `</sibling-ticket>` in
 * its body — so every title and body goes through
 * {@link escapeBlockDelimiters} on the way in. (Escaping can push a body a few
 * characters past {@link SIBLING_BODY_MAX_CHARS}; the cap is a context budget,
 * not a boundary anything downstream measures.)
 *
 * `undefined` and `[]` render identically ({@link NO_SIBLING_TICKETS}): a ctx
 * that never collected siblings and a run that genuinely has none are the
 * same fact from the check-writer's side.
 */
export function renderSiblingTickets(
  briefs: readonly SiblingTicketBrief[] | undefined,
): string {
  if (briefs === undefined || briefs.length === 0) return NO_SIBLING_TICKETS;
  return briefs
    .map(
      (b) =>
        `<sibling-ticket>\n` +
        `#${b.number} — ${escapeBlockDelimiters(b.title)}\n\n` +
        `${renderBody(b.body)}\n` +
        `</sibling-ticket>`,
    )
    .join("\n\n");
}
