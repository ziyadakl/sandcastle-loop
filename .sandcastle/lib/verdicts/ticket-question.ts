/**
 * The one product question an agent may hand back instead of building
 * (spec #1334 fix pass): the ticket does not say what was wanted, so the
 * agent names the exact question it leaves open, and the loop stops that
 * ticket for the owner (`stopped:ticket-unclear` + `needs-human`) with the
 * question written onto the issue body.
 *
 * The test-writing AI says it in its JSON envelope (`marker:
 * "TICKET_UNCLEAR"` plus `ticketQuestion`). The builder has no envelope on a
 * stop, so it ends with the bare `TICKET_UNCLEAR` marker and puts the
 * question in a `<ticket-question>…</ticket-question>` block — read here.
 */

import { extractMarker } from "./parse.js";
import { IMPLEMENTER_MARKERS } from "./markers.js";

/** The marker either agent ends on when the ticket leaves a product question open. */
export const TICKET_UNCLEAR_MARKER = "TICKET_UNCLEAR" as const;

const QUESTION_BLOCK_RE = /<ticket-question>([\s\S]*?)<\/ticket-question>/i;

/** How much of a builder's own words stand in for a question it did not
 *  put in the block — enough to read, never the whole transcript. */
const FALLBACK_TAIL_CHARS = 1500;

/**
 * The builder's product question, or `undefined` when its output does not
 * end on `TICKET_UNCLEAR`. A builder that ends on the marker but forgot the
 * block still stops: its own closing words stand in for the question, so the
 * owner is never handed a stop with nothing to answer.
 */
export function builderTicketQuestion(stdout: string): string | undefined {
  let marker: string;
  try {
    marker = extractMarker(stdout, IMPLEMENTER_MARKERS);
  } catch {
    return undefined;
  }
  if (marker !== TICKET_UNCLEAR_MARKER) return undefined;
  const block = QUESTION_BLOCK_RE.exec(stdout)?.[1]?.trim();
  if (block !== undefined && block.length > 0) return block;
  const before = stdout.slice(0, stdout.lastIndexOf(TICKET_UNCLEAR_MARKER)).trim();
  return before.length > 0
    ? before.slice(-FALLBACK_TAIL_CHARS)
    : "(the builder named no question)";
}

/**
 * Thrown by the builder (or the fixer) when it answered `TICKET_UNCLEAR`.
 * Caught by the pipeline, which stops the ticket for the owner — never
 * handed to the fixer: a fix pass cannot answer a product question.
 */
export class TicketUnclearError extends Error {
  constructor(readonly question: string) {
    super(`the builder says the ticket leaves a product question open: ${question.slice(0, 300)}`);
    this.name = "TicketUnclearError";
  }
}
