/**
 * Type declarations for the plain-`.mjs` bounded-output filter. The runtime is
 * `.mjs` (so plain `node` can run it inside the sandbox worktree with no build
 * step); these declarations give the TS test + any TS caller a typed surface.
 */

/** Lines of the head kept verbatim. */
export const HEAD_LINES: number;

/** Lines of the tail kept verbatim. */
export const TAIL_LINES: number;

/** Matches failure/error lines that must survive bounding. */
export const FAILURE_RE: RegExp;

/** Matches end-of-run summary/tally lines that must survive bounding. */
export const SUMMARY_RE: RegExp;

/** True if a line is a failure or summary line worth keeping from the middle. */
export function isDiagnosticLine(line: string): boolean;

/** Reduce a command's combined output to a bounded head + tail + diagnostics. */
export function boundOutput(
  text: string,
  opts?: { headLines?: number; tailLines?: number },
): string;
