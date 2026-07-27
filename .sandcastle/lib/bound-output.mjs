/**
 * Bounded-output filter for the implementer's heavy commands (unit tests,
 * lint, build, e2e). Loop-cost Ticket 01.
 *
 * WHY: the implementer shells out to `claude --print`; the CLI owns the
 * multi-turn conversation and REPLAYS every tool result each turn. A single
 * `pnpm test` / `playwright test` that dumps thousands of lines therefore
 * gets re-read on every subsequent turn — this is the ~60% cache-read cost
 * driver measured on the live budget run. Bounding what the AGENT SEES to a
 * head + tail + preserved diagnostics shrinks that pile permanently for the
 * rest of the session, and is safe-by-construction: if the agent needs more
 * than head+tail it just re-runs the command.
 *
 * WHY plain `.mjs` (not `.ts`): this runs INSIDE the sandbox worktree at
 * pipe-time as `<cmd> | node .sandcastle/lib/bound-output.mjs`. Plain `node`
 * is always present there; `tsx`/a build step are not guaranteed. This mirrors
 * the existing `node -e "…"` bounding already used in review-prompt.md, adding
 * nothing to the sandbox runtime surface. tsc's project globs cover only
 * `.mts` / `.ts`, so this `.mjs` file is intentionally outside the typecheck set.
 *
 * WHAT IT DOES NOT DO: it never changes the command's exit status (it is a
 * pure stdin→stdout text filter and always exits 0 itself). Callers preserve
 * the ORIGINAL command's pass/fail via bash `set -o pipefail` + `${PIPESTATUS[0]}`
 * (see implement-prompt.md). For e2e the FULL log is written by `tee` BEFORE
 * this filter, so the reviewer still reads the complete, untruncated log.
 *
 * @module bound-output
 */

/** Lines of the head kept verbatim. Keep as a constant so it is tunable. */
export const HEAD_LINES = 50;

/** Lines of the tail kept verbatim (where failures/summaries usually land). */
export const TAIL_LINES = 100;

/**
 * Lines matching this are ALWAYS surfaced even when they fall in the omitted
 * middle — failures/errors are the whole point of running the command, so they
 * must never be hidden by bounding. Deliberately does NOT match a bare
 * "passed"/"✓" (those are exactly the benign volume we want to drop).
 */
export const FAILURE_RE =
  /(?:\berrors?\b|\bfail(?:ed|ing|ure)?\b|\bexception\b|\bpanic\b|\btraceback\b|\bunhandled\b|assertionerror|npm err!|\bECONN\w*|\bENOENT\b|\bfatal\b|✗|✘|✖|❌|⨯|×)/i;

/**
 * Lines matching this are ALWAYS surfaced — end-of-run tallies the reviewer and
 * agent both need ("Tests 3 failed | 117 passed (120)", "Duration 4.2s", etc.).
 */
export const SUMMARY_RE =
  /(?:^\s*(?:test files|tests|duration|snapshots?|suites?|start at)\b|\b\d+\s+(?:passed|failed|skipped|pending|todo)\b|\((?:\d+)\s*(?:passed|failed|skipped)\))/i;

/**
 * A line worth keeping even from the omitted middle.
 * @param {string} line
 * @returns {boolean}
 */
export function isDiagnosticLine(line) {
  return FAILURE_RE.test(line) || SUMMARY_RE.test(line);
}

/**
 * Reduce a command's combined output to a bounded, agent-facing view.
 *
 * @param {string} text  Combined stdout+stderr of the command.
 * @param {{ headLines?: number, tailLines?: number }} [opts]
 * @returns {string} Bounded view. Short input is returned byte-for-byte.
 */
export function boundOutput(text, opts = {}) {
  if (typeof text !== "string" || text.length === 0) return text ?? "";

  const head = opts.headLines ?? HEAD_LINES;
  const tail = opts.tailLines ?? TAIL_LINES;

  // Preserve a single trailing newline through the split/join round-trip.
  const hadTrailingNewline = text.endsWith("\n");
  const body = hadTrailingNewline ? text.slice(0, -1) : text;
  const lines = body.split("\n");

  // Short enough to show in full — pass through byte-for-byte.
  if (lines.length <= head + tail) return text;

  const headLines = lines.slice(0, head);
  const tailLines = lines.slice(lines.length - tail);
  const middle = lines.slice(head, lines.length - tail);

  const preserved = middle.filter(isDiagnosticLine);
  const droppedCount = middle.length - preserved.length;

  const marker =
    preserved.length > 0
      ? `… ${droppedCount} lines omitted (${preserved.length} diagnostic line${
          preserved.length === 1 ? "" : "s"
        } preserved below) …`
      : `… ${droppedCount} lines omitted …`;

  const out = [...headLines, marker, ...preserved, ...tailLines].join("\n");
  return hadTrailingNewline ? out + "\n" : out;
}

/**
 * Read all of stdin as a UTF-8 string.
 * @returns {Promise<string>}
 */
function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

// CLI entrypoint: `<cmd> 2>&1 | node .sandcastle/lib/bound-output.mjs`.
// Best-effort — any failure falls back to passing input through untouched so
// bounding can never itself break a command's visibility. Always exits 0; the
// caller owns the real exit code via pipefail/PIPESTATUS.
const isMain =
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMain) {
  readStdin()
    .then((input) => {
      try {
        process.stdout.write(boundOutput(input));
      } catch {
        process.stdout.write(input);
      }
    })
    .catch(() => {
      /* stdin read failed — nothing to emit */
    });
}
