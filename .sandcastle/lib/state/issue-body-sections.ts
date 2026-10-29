/**
 * The parts of a GitHub issue body a PERSON wrote, separated from the parts
 * that are machine output or verbatim quoted material.
 *
 * Two readers needed the identical split and each had grown its own half:
 *
 *  - `lib/checkwriter/proof-demand.ts` cuts the loop's own appended report
 *    sections out before it looks for a deletion authorisation, because the
 *    stop report it writes quotes the very sentence it is scanning for — the
 *    gate would otherwise forge its own permission slip.
 *  - `lib/state/blocked-by.ts` (the `Blocked-by:` gate) has the same problem
 *    twice over: a machine section can quote a `Blocked by: #N` line back at
 *    it, and so can a fenced code block in a ticket that is ABOUT this gate.
 *    Either one would block a ticket forever on a blocker it never declared.
 *
 * One module, so a third machine section added next year is excluded from
 * both readers the day it is written rather than the day someone notices.
 */

/**
 * A CLOSED machine section: `<!-- sandcastle:<name>:start -->` … `:end -->`.
 *
 * Matched by NAME PATTERN rather than by a list of the known section names,
 * so a section added later is covered without touching this file.
 */
export const MACHINE_SECTION_RE =
  /<!--\s*sandcastle:[^>]*?:start\s*-->[\s\S]*?<!--\s*sandcastle:[^>]*?:end\s*-->/g;

/**
 * An OPEN machine section — a start marker whose end never arrived, which is
 * what a body written by an interrupted run looks like. Everything after it is
 * discarded: a half-written machine section is still machine-written.
 */
export const UNTERMINATED_MACHINE_SECTION_RE =
  /<!--\s*sandcastle:[^>]*?:start\s*-->[\s\S]*$/;

/**
 * A fenced code block — ``` or ~~~ , with or without a language tag, closed or
 * left open at the end of the body.
 *
 * Text inside one is a QUOTATION, never a declaration: a ticket whose body
 * shows `Blocked by: #9` inside a fence is describing the syntax, not using
 * it. The fence must be at the start of a line (leading spaces allowed, as
 * markdown permits up to three) so a stray triple-backtick mid-sentence
 * cannot swallow the rest of the body.
 */
const FENCED_CODE_RE = /^[ \t]{0,3}(```+|~~~+)[^\n]*\n[\s\S]*?(?:^[ \t]{0,3}\1[^\n]*$|$)/gm;

/**
 * The part of an issue body the loop itself did not write — every
 * `<!-- sandcastle:…:start -->…:end -->` section removed, and an unterminated
 * one truncated away.
 *
 * Each removed span collapses to a newline rather than to nothing, so a
 * section sitting between two ordinary lines cannot silently join them into
 * one line and change how a line-oriented parser reads either.
 */
export function ownerAuthoredPart(issueBody: string): string {
  return issueBody
    .replace(MACHINE_SECTION_RE, "\n")
    .replace(UNTERMINATED_MACHINE_SECTION_RE, "\n");
}

/**
 * Did the PERSON who wrote this ticket name `path`? A plain substring match
 * over {@link ownerAuthoredPart}: the loop's own sections are cut out first,
 * because a stop report from an earlier refused attempt quotes the very path
 * and would otherwise make the next run report it as named in the ticket.
 * Display only (the run report's older-test line); nothing gates on it.
 */
export function namesPathInOwnerText(
  issueBody: string | undefined,
  path: string,
): boolean {
  return issueBody !== undefined && ownerAuthoredPart(issueBody).includes(path);
}

/**
 * The same body with every fenced code block removed as well — what a parser
 * looking for a DIRECTIVE (rather than for prose) should read.
 *
 * Kept separate from {@link ownerAuthoredPart} because the two readers differ:
 * the proof-demand gate deliberately still reads inside fences (an owner can
 * authorise a deletion in a fenced path list), while the `Blocked-by:` gate
 * must not.
 */
export function stripFencedCode(text: string): string {
  return text.replace(FENCED_CODE_RE, "\n");
}
