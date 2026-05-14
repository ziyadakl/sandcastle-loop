/**
 * Verdict extraction and validation.
 *
 * Two layers:
 *
 *   1. {@link extractMarker} — pure string discipline. Splits text into lines,
 *      finds the LAST non-empty line, optionally strips markdown decoration,
 *      checks against the allowed marker set. Throws a typed
 *      {@link MarkerNotFoundError} on failure (never returns null —
 *      callers can't accidentally fall through).
 *
 *   2. {@link parseVerdict} — concatenates assistant text out of a
 *      `claude -p --output-format stream-json` blob (each line is a JSON
 *      envelope) and runs a Zod schema over the resulting JSON payload
 *      embedded in that text. Throws a {@link VerdictParseError} on schema
 *      failure with the offending text included so the caller can log it.
 *
 * This file is deliberately decoupled from sandcastle's Output.object helper:
 * Output.object only works when maxIterations === 1, but the loop runs
 * implementer/reviewer/fixer with maxIterations > 1 (they're allowed to
 * iterate inside one orchestrator call). Track C will choose whether to
 * combine: for single-iter calls, it can pass result.output through this
 * file's schemas to double-check; for multi-iter calls, it passes the raw
 * stream-json buffer through extractAssistantText + parseVerdict.
 */

import type { ZodType } from "zod";
import { ZodError } from "zod";
import {
  HALT_PROMISE,
  canonicalizeMarker,
  stripDecoration,
} from "./markers.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when no acceptable marker line is found. The bash version's failure
 * mode was to default-fall-through (`HAS_BLOCKERS`, `BLOCKED`); we throw
 * instead so the caller MUST decide what to do.
 */
export class MarkerNotFoundError extends Error {
  public readonly allowed: readonly string[];
  public readonly lastLine: string;
  public readonly textPreview: string;
  public constructor(
    allowed: readonly string[],
    lastLine: string,
    textPreview: string,
  ) {
    super(
      `No acceptable marker found on the last non-empty line. ` +
        `Expected one of [${allowed.join(", ")}]. ` +
        `Last line was: ${JSON.stringify(lastLine)}. ` +
        `Text preview: ${JSON.stringify(textPreview)}.`,
    );
    this.name = "MarkerNotFoundError";
    this.allowed = allowed;
    this.lastLine = lastLine;
    this.textPreview = textPreview;
  }
}

/**
 * Thrown when the agent emitted a marker but the structured payload that
 * should accompany it does not pass Zod validation. Includes the offending
 * raw text so the caller can surface it in run logs.
 */
export class VerdictParseError extends Error {
  public readonly cause: ZodError | Error;
  public readonly rawText: string;
  public constructor(
    message: string,
    cause: ZodError | Error,
    rawText: string,
  ) {
    super(
      `${message}\n--- offending text (first 2000 chars) ---\n` +
        `${rawText.slice(0, 2000)}\n--- end ---`,
    );
    this.name = "VerdictParseError";
    this.cause = cause;
    this.rawText = rawText;
  }
}

// ---------------------------------------------------------------------------
// Marker extraction
// ---------------------------------------------------------------------------

export type MarkerMode = "tolerant" | "strict";

export interface ExtractMarkerOptions {
  /**
   * "tolerant" (default): allows surrounding markdown decoration on the last
   * non-empty line — `**ALL_CLEAR**`, `### HAS_BLOCKERS`, etc. Matches the
   * bash awk regex `^[[:space:][:punct:]]*X[[:space:][:punct:]]*$` discipline
   * but never accepts `<promise>HALT</promise>` decoration as a bare HALT
   * (the wrapped form is always canonicalized to "HALT" exactly, never to
   * any other marker).
   *
   * "strict": the last non-empty line must be EXACTLY the marker (or the
   * `<promise>HALT</promise>` element for HALT), with only leading/trailing
   * whitespace allowed. This is the discipline the new prompts enforce.
   */
  mode?: MarkerMode;
}

/**
 * Find the last non-empty line of `text` and return whichever marker from
 * `allowed` it matches. Throws {@link MarkerNotFoundError} on any failure.
 *
 * Implementation note: we deliberately do NOT scan the whole text for the
 * markers and pick the last hit. The bash awk script does last-non-empty-line
 * specifically because earlier mentions are usually reasoning ("I considered
 * emitting ALL_CLEAR but..."). Free-text mid-paragraph mentions of marker
 * words MUST NOT count.
 */
export function extractMarker<M extends string>(
  text: string,
  allowed: readonly M[],
  options: ExtractMarkerOptions = {},
): M {
  const mode: MarkerMode = options.mode ?? "tolerant";

  // Split on \n (handles \r\n by stripping \r per line). Empty trailing line
  // from a trailing newline is naturally filtered by the "non-empty" pass.
  const lines = text.split(/\r?\n/);

  let lastNonEmpty = "";
  for (const line of lines) {
    if (line.trim().length > 0) lastNonEmpty = line;
  }

  const allowedSet = new Set<string>(allowed);
  const preview = text.length > 600 ? `${text.slice(0, 600)}…` : text;

  if (lastNonEmpty.length === 0) {
    throw new MarkerNotFoundError(allowed, "", preview);
  }

  if (mode === "strict") {
    // Allow only leading/trailing whitespace around the bare marker token,
    // OR the literal `<promise>HALT</promise>` element if HALT is allowed.
    const trimmed = lastNonEmpty.trim();
    const canonical = canonicalizeMarker(trimmed);
    // canonicalizeMarker turns "<promise>HALT</promise>" into "HALT"; for
    // every other input it just trims. To honor strict-mode exactness we
    // reject anything where canonical !== trimmed AND the input wasn't the
    // exact promise element.
    const acceptable =
      canonical === trimmed || trimmed === HALT_PROMISE;
    if (acceptable && allowedSet.has(canonical)) {
      return canonical as M;
    }
    throw new MarkerNotFoundError(allowed, lastNonEmpty, preview);
  }

  // Tolerant mode: strip decoration around the last non-empty line, then
  // check against the allowed set. The strip function special-cases the
  // promise form so `<promise>HALT</promise>` resolves to "HALT" but never
  // unwraps via the generic punctuation strip (which would otherwise let
  // unrelated markers absorb angle brackets).
  const stripped = stripDecoration(lastNonEmpty);
  if (allowedSet.has(stripped)) {
    return stripped as M;
  }
  throw new MarkerNotFoundError(allowed, lastNonEmpty, preview);
}

// ---------------------------------------------------------------------------
// stream-json assistant-text concatenation
// ---------------------------------------------------------------------------

/**
 * Shape of a single line in `claude -p --output-format stream-json`. Only
 * fields we actually consume are typed; `unknown` everywhere else.
 *
 * Each line is a JSON object envelope. We care about envelopes where
 * `type === "assistant"`; their `message.content[]` is an array of content
 * blocks. We pick the blocks whose `type === "text"` and concatenate their
 * `text` fields, in stream order.
 */
interface AssistantTextBlock {
  type: "text";
  text: string;
}

interface AssistantEnvelope {
  type: "assistant";
  message?: {
    content?: ReadonlyArray<unknown>;
  };
}

function isAssistantEnvelope(value: unknown): value is AssistantEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { type?: unknown };
  return v.type === "assistant";
}

function isAssistantTextBlock(value: unknown): value is AssistantTextBlock {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { type?: unknown; text?: unknown };
  return v.type === "text" && typeof v.text === "string";
}

/**
 * Concatenate assistant text from a `claude -p --output-format stream-json`
 * blob. Equivalent to the bash one-liner:
 *
 *   echo "$STREAM" | grep '^{' | jq -r 'select(.type == "assistant").message.content[]? | select(.type == "text").text // empty'
 *
 * Lines that are not valid JSON are silently skipped (matching the bash
 * `grep '^{'` prefilter — Claude sometimes emits non-JSON debug lines).
 */
export function extractAssistantText(rawStreamJson: string): string {
  const lines = rawStreamJson.split(/\r?\n/);
  const chunks: string[] = [];
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isAssistantEnvelope(parsed)) continue;
    const content = parsed.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (isAssistantTextBlock(block)) chunks.push(block.text);
    }
  }
  return chunks.join("");
}

// ---------------------------------------------------------------------------
// Verdict parsing (stream-json -> assistant text -> Zod -> typed object)
// ---------------------------------------------------------------------------

export interface ParseVerdictOptions {
  /**
   * If true, treat the input as already-extracted assistant text (skip the
   * stream-json envelope-strip step). Useful for tests and for callers that
   * already used sandcastle's Output.object/Output.string helpers.
   */
  alreadyAssistantText?: boolean;
  /**
   * Override the default JSON-extraction strategy. By default we look for
   * the FIRST `{ ... }` JSON block in the assistant text and try to parse
   * it. If your agent wraps the JSON in a known XML tag (e.g. `<verdict>`)
   * pass that tag here to extract from inside it instead.
   */
  jsonTag?: string;
}

/**
 * Return every fenced ```json``` block in the text, **last fence first**.
 * Accepts info-strings `json`, `JSON`, and `jsonc`. The opening fence may
 * carry trailing whitespace before the newline; the closing fence may carry
 * leading whitespace before the backticks.
 *
 * The implement prompt directs agents to put the certification envelope
 * "immediately before your final marker," so the last fenced block is the
 * canonical envelope. Earlier fenced blocks (e.g. story-by-story progress
 * summaries) get tried only as fallback by `parseVerdict` if the last
 * block fails schema validation.
 */
export function extractAllJsonFences(text: string): string[] {
  const fenceRegex = /```(?:json|JSON|jsonc)[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g;
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = fenceRegex.exec(text)) !== null) {
    blocks.push(m[1].trim());
  }
  return blocks.reverse();
}

/**
 * Pull a JSON object substring out of arbitrary text. Strategy:
 *   1. If `tag` is provided, look for the inner content of `<tag>...</tag>`
 *      (case-sensitive; matches bash conventions).
 *   2. Otherwise, return the LAST fenced ```json``` block in the text.
 *
 * The previous behaviour brace-walked from the first `{`, which matched
 * prose like `style={{ transform }}` and earlier-emitted JSON like
 * progress summaries — producing "Zod schema validation failed" errors on
 * perfectly valid runs (#132, #123). Brace-walking has been removed: if
 * an agent emits no fenced block, that is a real prompt-following failure
 * that should surface, not be silently patched over.
 *
 * Returns null if no candidate is found. Callers wanting fallback through
 * earlier fenced blocks should use `extractAllJsonFences` directly.
 */
export function extractJsonCandidate(text: string, tag?: string): string | null {
  if (tag !== undefined && tag.length > 0) {
    // Build the regex without using `.` across newlines via `[\s\S]` so we
    // don't depend on a specific runtime's `s` flag support.
    const open = `<${tag}>`;
    const close = `</${tag}>`;
    const start = text.indexOf(open);
    if (start === -1) return null;
    const end = text.indexOf(close, start + open.length);
    if (end === -1) return null;
    return text.slice(start + open.length, end).trim();
  }
  const fences = extractAllJsonFences(text);
  return fences.length > 0 ? fences[0] : null;
}

/**
 * Parse a typed verdict from raw `claude -p --output-format stream-json`
 * output (or already-extracted assistant text — see options). Steps:
 *
 *   1. Concatenate assistant text from stream-json envelopes (skipped iff
 *      `options.alreadyAssistantText`).
 *   2. Locate a JSON object substring (either inside a configured XML tag or
 *      via brace-walking).
 *   3. JSON.parse it.
 *   4. Run the supplied Zod schema.
 *
 * Throws {@link VerdictParseError} on any of: missing assistant text, no
 * JSON candidate found, invalid JSON, or schema mismatch. The error message
 * always carries the offending text so callers can log it for forensics.
 */
export function parseVerdict<T>(
  rawStreamJson: string,
  schema: ZodType<T>,
  options: ParseVerdictOptions = {},
): T {
  const assistantText = options.alreadyAssistantText
    ? rawStreamJson
    : extractAssistantText(rawStreamJson);

  if (assistantText.trim().length === 0) {
    throw new VerdictParseError(
      "No assistant text could be extracted from the input. " +
        "Either the stream-json blob has no `assistant` envelopes or it's malformed.",
      new Error("empty assistant text"),
      rawStreamJson,
    );
  }

  // Tagged path: single shot, unchanged from prior behaviour.
  if (options.jsonTag !== undefined) {
    const candidate = extractJsonCandidate(assistantText, options.jsonTag);
    if (candidate === null) {
      throw new VerdictParseError(
        `Could not find a JSON object inside <${options.jsonTag}> tags.`,
        new Error("no json candidate"),
        assistantText,
      );
    }
    return parseAndValidate(candidate, schema, candidate);
  }

  // Fenced-block path: try each ```json``` block from last to first. Agents
  // are instructed to place the envelope "immediately before" their final
  // marker, so the last fenced block is the canonical envelope. We still
  // fall through to earlier blocks on validation failure — defends against
  // an agent that emits a malformed last block but a valid earlier one.
  const fences = extractAllJsonFences(assistantText);
  if (fences.length === 0) {
    throw new VerdictParseError(
      "Could not find a fenced ```json``` block in assistant text.",
      new Error("no json fence"),
      assistantText,
    );
  }
  let lastError: VerdictParseError | null = null;
  for (const fence of fences) {
    try {
      return parseAndValidate(fence, schema, fence);
    } catch (err) {
      if (err instanceof VerdictParseError) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  throw new VerdictParseError(
    `Found ${fences.length} fenced json block(s) in assistant text; none matched the schema. ` +
      `Last error: ${lastError?.message ?? "unknown"}`,
    lastError ?? new Error("no fence matched schema"),
    assistantText,
  );
}

function parseAndValidate<T>(candidate: string, schema: ZodType<T>, offending: string): T {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(candidate);
  } catch (err) {
    const cause = err instanceof Error ? err : new Error(String(err));
    throw new VerdictParseError(
      `JSON.parse failed on the extracted candidate: ${cause.message}`,
      cause,
      offending,
    );
  }
  const result = schema.safeParse(parsedJson);
  if (!result.success) {
    throw new VerdictParseError(
      `Zod schema validation failed: ${result.error.message}`,
      result.error,
      offending,
    );
  }
  return result.data;
}
