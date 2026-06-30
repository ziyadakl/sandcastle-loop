/**
 * `sandcastle-watch` — a live terminal dashboard for an in-flight sandcastle
 * loop. It polls `<repoRoot>/.sandcastle/status.json` (or `--status <path>`)
 * every 250ms, folds each read through the pure `reduce` reducer, and renders
 * the resulting `ViewState` with Ink.
 *
 * The dashboard runs on the alternate screen buffer (htop/lazygit/k9s style):
 * `render(<App/>)` repaints in place. Two things keep that flicker-free:
 *   - the reducer DEDUPS — an unchanged poll returns the SAME `ViewState`
 *     reference, so React/Ink skip the repaint entirely (a quiet feed, e.g. a
 *     long merge between heartbeats, never repaints unchanged content); and
 *   - the render is SIZED TO FIT the terminal height (`computeRecentCap` trims
 *     the elastic "recent" strip) so content never exceeds the viewport — Ink
 *     can't scroll-jitter content it never overflows. The alt screen hides
 *     scrollback but does NOT prevent scroll-on-overflow, so fitting is on us.
 * An input sink puts the TTY in raw mode so scroll keystrokes don't echo as
 * escape-sequence spam.
 *
 * VISUAL LANGUAGE (see docs/adr/0008). Two ideas keep it legible on ANY theme:
 *   1. Real color is rationed — one warm-coral accent (#FB8359, a brightened
 *      take on the brand coral) for the brand label + live work, plus a small
 *      semantic set (merged-green / needs-you-amber / requeued-blue). Nothing
 *      else gets a hue.
 *   2. Secondary text (titles, numbers, separators) is one muted grey
 *      (`MUTED_FG`), brightened from the original ANSI dim per the user's
 *      "less muted" preference — readable on a dark theme, still subdued.
 * Exactly ONE rounded border — the bounded "running" panel, the live region —
 * because an outer card around the unbounded lists fights inline render (that's
 * the Phase-2 alt-screen). Zones are separated by thin rules, not blank lines.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { render, Box, Text, useApp, useInput } from "ink";
// `React` must be imported by default, not just the named hooks: a consumer
// with no root tsconfig falls to esbuild's classic `React.createElement` JSX
// transform (tsx resolves jsx config from cwd, not this file's dir), which
// needs `React` in scope or `render(<App/>)` throws `ReferenceError`. Harmless
// under the automatic transform — do NOT "tidy" it as unused. See ADR 0008 and
// tests/watch-viewer-portability.test.ts.
import React, { useEffect, useState } from "react";

import { reduce, type ReadResult, type ViewState } from "./reducer.js";
import { computeRecentCap } from "./layout.js";
import type {
  IssuePhase,
  RunActivity,
  SandcastleStatus,
  StatusIssue,
} from "../lib/status/schema.js";

const POLL_MS = 250;

/**
 * Count-row treatment. `"filled"` renders solid status pills (more "elements",
 * higher contrast); `"text"` renders restrained glyph+count+label in the status
 * color (closer to lazygit/k9s minimalism). One-line swap so both can be judged
 * from a real screen — see ADR 0008.
 */
const PILL_STYLE: "filled" | "text" = "filled";

const NO_COLOR = Boolean(process.env["NO_COLOR"]);
/** Apply the adaptive dim attribute — unless the user asked for NO_COLOR. */
const DIM = !NO_COLOR;

/**
 * Hues only. Secondary text uses the terminal's default foreground (full
 * brightness — see MUTED_FG), so the palette holds just the accent + semantic
 * status colors + the inverse-text ink for filled pills. Hex so true-color
 * terminals get the exact accent; `tint()` collapses every color to the
 * terminal default under NO_COLOR.
 *   accent — #FB8359, a brightened coral (brand value #D77757 felt washed out;
 *            brightened per the user's "less muted" preference).
 *   blue   — #6FB0F2, a brightened take on the Anthropic brand blue (#6A9BCC).
 */
const C = {
  accent: "#FB8359", // brand label + live/active work — the ONLY accent
  blue: "#7CBEFF", // requeued / informational
  success: "#8FE86A", // merged
  warning: "#FFC83D", // needs-you (the call-to-action) + stale
  error: "#FB6258", // outdated / failures
  ink: "#1B1A18", // dark fg painted on a filled (light) pill — inverse text
  neutral: "#6E6B64", // the one neutral fill: the "waiting" banner pill bg
} as const;

/**
 * Secondary text (issue titles, numbers, separators) renders in the terminal's
 * DEFAULT foreground — i.e. full brightness, the same as the running-panel
 * title. Earlier muted-grey hexes (#948E85 → #C6C0B6) looked identical on the
 * user's terminal: a non-truecolor color level quantizes close greys to one
 * shade, so nudging the hex did nothing. Dropping the color entirely sidesteps
 * that — the theme's own foreground shows through, bright on any color level.
 */
const MUTED_FG: string | undefined = undefined;

/** Fixed column widths — the running/recent rows share one grid so they align. */
const W = { marker: 2, num: 6, title: 38, phase: 13 } as const;
/** Outer width of the running panel = grid + paddingX(1·2) + border(1·2). */
const RULE_W = W.marker + W.num + W.title + W.phase + 4;
/** Phases where the issue is actively being worked by an agent. */
const ACTIVE_PHASES: ReadonlySet<IssuePhase> = new Set<IssuePhase>([
  "implementer",
  "reviewer",
  "implementer-retry",
  "recovery",
  "merge",
]);

/** Phases that are terminal for the current iteration (the "recent" strip). */
const TERMINAL_PHASES: ReadonlySet<IssuePhase> = new Set<IssuePhase>([
  "merged",
  "needs-human",
  "deferred",
]);

/** A color prop that collapses to `undefined` when NO_COLOR is set. */
function tint(color: string): string | undefined {
  return NO_COLOR ? undefined : color;
}

// ---------------------------------------------------------------------------
// argv + IO (impure; kept at the edges so the render tree stays pure)
// ---------------------------------------------------------------------------

function parseStatusPath(argv: readonly string[]): string {
  const i = argv.indexOf("--status");
  if (i !== -1 && i + 1 < argv.length) {
    return argv[i + 1]!;
  }
  return path.join(process.cwd(), ".sandcastle", "status.json");
}

/** Read the status file into a `ReadResult` the reducer understands. */
function readStatus(filePath: string): ReadResult {
  try {
    return { ok: true, raw: readFileSync(filePath, "utf8") };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return { ok: false, kind: code === "ENOENT" ? "enoent" : "ioerror", error };
  }
}

// ---------------------------------------------------------------------------
// presentation helpers
// ---------------------------------------------------------------------------

const PHASE_LABEL: Record<IssuePhase, string> = {
  planned: "planned",
  implementer: "implementing",
  reviewer: "reviewing",
  "implementer-retry": "retrying",
  recovery: "recovering",
  merge: "merging",
  merged: "merged",
  "needs-human": "needs-you",
  deferred: "deferred",
};

/**
 * Run-level activity → panel subtitle. The schema field is a permissive string
 * (see schema.ts), so `activityLabel` falls back to the raw word + "…" for any
 * value a NEWER loop emits that this viewer doesn't know yet — never silently
 * back to "idle".
 */
const ACTIVITY_LABEL: Record<RunActivity, string> = {
  planning: "planning…",
  merging: "merging…",
  reviewing: "reviewing merge…",
  cleanup: "cleaning up…",
};

function activityLabel(activity: string): string {
  return ACTIVITY_LABEL[activity as RunActivity] ?? `${activity}…`;
}

const BANNER_TEXT: Record<NonNullable<ViewState["banner"]>, string> = {
  waiting: "waiting for loop…",
  stale: "stale — loop may have stopped",
  outdated: "viewer out of date — run an update",
  done: "done — loop finished",
  stopped: "stopped — loop halted",
  unhealthy: "unhealthy — promotion failed, work stranded",
};

// `done` is deliberately NEUTRAL, not a celebratory green: the worker currently
// also routes a Ctrl-C'd run through finish("done") (main.mts SIGINT note), so a
// "done" feed is not a guaranteed success. Revisit once that lands finish("stopped").
const BANNER_COLOR: Record<NonNullable<ViewState["banner"]>, string> = {
  waiting: C.neutral,
  stale: C.warning,
  outdated: C.error,
  done: C.neutral,
  stopped: C.neutral,
  // A failed promotion is a real failure — paint it red, not neutral.
  unhealthy: C.error,
};

const BANNER_GLYPH: Record<NonNullable<ViewState["banner"]>, string> = {
  waiting: "○",
  stale: "●",
  outdated: "●",
  done: "✓",
  stopped: "■",
  unhealthy: "✗",
};

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + "…";
}

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

/** A thin full-width horizontal rule — the zone separator (adaptive dim). */
function Rule({ width = RULE_W }: { width?: number }) {
  return <Text color={MUTED_FG}>{"─".repeat(width)}</Text>;
}

/** ` · ` separator, adaptive dim. */
function Sep() {
  return <Text color={MUTED_FG}> · </Text>;
}

/**
 * A status count. `filled` paints a solid pill (dark inverse text on the status
 * color); `text` paints glyph+count+label in the status color. A zero count is
 * muted to adaptive dim in both modes so the eye skips it.
 */
function Pill({
  glyph,
  count,
  label,
  color,
}: {
  glyph: string;
  count: number;
  label: string;
  color: string;
}) {
  const muted = count === 0;
  if (PILL_STYLE === "text") {
    return (
      <Text color={muted ? undefined : tint(color)} dimColor={muted && DIM}>
        {glyph}
        {count} {label}
      </Text>
    );
  }
  return (
    <Text
      backgroundColor={muted ? undefined : tint(color)}
      color={muted ? undefined : tint(C.ink)}
      dimColor={muted && DIM}
      bold={!muted}
    >
      {" "}
      {glyph}
      {count} {label}{" "}
    </Text>
  );
}

// ---------------------------------------------------------------------------
// components
// ---------------------------------------------------------------------------

function Header({ run }: { run: SandcastleStatus["run"] }) {
  return (
    <Box>
      <Text bold color={tint(C.accent)}>
        sandcastle
      </Text>
      <Sep />
      <Text>{run.repo}</Text>
      <Sep />
      <Text color={MUTED_FG}>{run.branch}</Text>
      <Sep />
      <Text color={MUTED_FG}>
        iter {run.iterations.current}/{run.iterations.total}
      </Text>
    </Box>
  );
}

function Counts({
  totals,
  state,
}: {
  totals: SandcastleStatus["totals"];
  state: SandcastleStatus["state"];
}) {
  return (
    <Box>
      <Pill glyph="✓" count={totals.merged} label="merged" color={C.success} />
      <Text> </Text>
      <Pill
        glyph="⚠"
        count={totals.needsHuman}
        label="needs-you"
        color={C.warning}
      />
      <Text> </Text>
      <Pill
        glyph="↻"
        count={totals.requeued}
        label="requeued"
        color={C.blue}
      />
      <Text> </Text>
      <Pill glyph="▶" count={totals.running} label="running" color={C.accent} />
      {/* Run-level health pill: `unhealthy` is a terminal RUN state (a failed
          final promotion), not a per-issue total — so it's driven off
          `status.state`, shown as a single red flag only when the run died
          unhealthy. A Pill with count 0 renders dimmed/absent, so the healthy
          case stays clean. */}
      {state === "unhealthy" ? (
        <>
          <Text> </Text>
          <Pill glyph="✗" count={1} label="unhealthy" color={C.error} />
        </>
      ) : null}
    </Box>
  );
}

/** One live issue: the aligned grid row, with an optional dim detail sub-line. */
function IssueRow({ issue }: { issue: StatusIssue }) {
  const flagged = issue.attention === true;
  return (
    <Box flexDirection="column">
      <Box>
        <Box width={W.marker}>
          <Text color={tint(C.warning)}>{flagged ? "⚠" : " "}</Text>
        </Box>
        <Box width={W.num}>
          <Text color={MUTED_FG}>#{issue.number}</Text>
        </Box>
        <Box width={W.title}>
          <Text>{truncate(issue.title, W.title - 1)}</Text>
        </Box>
        <Box width={W.phase}>
          <Text color={tint(C.accent)}>{PHASE_LABEL[issue.phase]}</Text>
        </Box>
      </Box>
      {issue.detail ? (
        <Box>
          <Box width={W.marker + W.num}>
            <Text> </Text>
          </Box>
          <Text color={MUTED_FG}>
            {truncate(issue.detail, W.title + W.phase - 1)}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * The one bordered panel: the live region. Border hugs the fixed-width grid.
 * When no issue is in an active phase, the run-level `activity` (planning /
 * merging / reviewing / cleanup — the cross-issue steps that own no issue) is
 * shown so the panel never falsely reads "idle" while the loop is busy. Only a
 * truly idle feed (no active issues AND no activity) shows the idle copy.
 */
function RunningPanel({
  active,
  activity,
}: {
  active: readonly StatusIssue[];
  activity?: string;
}) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={tint(C.accent)}
      paddingX={1}
    >
      <Text bold color={tint(C.accent)}>
        ▶ running
      </Text>
      {active.length > 0 ? (
        active.map((issue) => <IssueRow key={issue.number} issue={issue} />)
      ) : activity ? (
        <Text color={tint(C.accent)}>{activityLabel(activity)}</Text>
      ) : (
        <Text color={MUTED_FG}>idle — no active issues</Text>
      )}
    </Box>
  );
}

// The recent strip renders either history entries (primary) or live issues
// (fallback); both satisfy this minimal shared shape.
type RecentItem = Pick<StatusIssue, "number" | "title" | "phase">;

function RecentRow({ issue }: { issue: RecentItem }) {
  // Recent rows: full-brightness semantic hue (merged-green / needs-you-amber)
  // or default fg (deferred). The running panel's border + position carry the
  // hierarchy now — the labels render bright per the user's "brighten" request.
  const statusColor =
    issue.phase === "merged"
      ? C.success
      : issue.phase === "needs-human"
        ? C.warning
        : undefined;
  const glyph =
    issue.phase === "merged" ? "✓" : issue.phase === "needs-human" ? "⚠" : "↻";
  return (
    <Box>
      <Box width={W.marker}>
        <Text color={statusColor ? tint(statusColor) : undefined}>
          {glyph}
        </Text>
      </Box>
      <Box width={W.num}>
        <Text color={MUTED_FG}>#{issue.number}</Text>
      </Box>
      <Box width={W.title}>
        <Text color={MUTED_FG}>{truncate(issue.title, W.title - 1)}</Text>
      </Box>
      <Box width={W.phase}>
        <Text color={statusColor ? tint(statusColor) : undefined}>
          {PHASE_LABEL[issue.phase]}
        </Text>
      </Box>
    </Box>
  );
}

function Banner({ banner }: { banner: NonNullable<ViewState["banner"]> }) {
  return (
    <Box marginTop={1}>
      <Text
        backgroundColor={tint(BANNER_COLOR[banner])}
        color={tint(C.ink)}
        bold
      >
        {" "}
        {BANNER_GLYPH[banner]} {BANNER_TEXT[banner]}{" "}
      </Text>
    </Box>
  );
}

export function Dashboard({
  state,
  rows = Number.POSITIVE_INFINITY,
}: {
  state: ViewState;
  /** Terminal height; defaults to ∞ (show everything) when rendered headless. */
  rows?: number;
}) {
  const { status, banner } = state;

  // No snapshot yet — only a banner (or a bare hint) to show.
  if (!status) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold color={tint(C.accent)}>
          sandcastle
        </Text>
        {banner ? <Banner banner={banner} /> : null}
      </Box>
    );
  }

  const active = status.issues.filter((i) => ACTIVE_PHASES.has(i.phase));
  // The completed strip is backed by the persistent, cross-iteration `history`
  // (newest first). It falls back to the current batch's terminal issues when
  // history is absent/empty (e.g. a status.json written by a pre-history loop),
  // so the strip never regresses to empty for older feeds.
  const recentAll: RecentItem[] =
    status.history.length > 0
      ? [...status.history].reverse()
      : status.issues.filter((i) => TERMINAL_PHASES.has(i.phase));

  // Lines rendered AROUND the recent strip, using the panel's REAL body height
  // (idle/activity = 1 line; otherwise each active issue is 1 line + 1 if it
  // carries a detail sub-line). Keep this in sync with the JSX below.
  const panelBodyLines =
    active.length === 0
      ? 1
      : active.reduce((n, i) => n + 1 + (i.detail ? 1 : 0), 0);
  const coreLines =
    1 /* root marginTop */ +
    1 /* Header */ +
    1 /* Rule */ +
    1 /* Counts */ +
    1 /* panel marginTop */ +
    (3 + panelBodyLines) /* panel: border×2 + title + body */ +
    (banner ? 2 /* banner marginTop + line */ : 0);
  const cap = computeRecentCap({
    rows,
    coreLines,
    recentTotal: recentAll.length,
  });
  const recent = recentAll.slice(0, cap);
  const hiddenRecent = recentAll.length - recent.length;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Header run={status.run} />
      <Rule />
      <Counts totals={status.totals} state={status.state} />

      <Box marginTop={1}>
        <RunningPanel active={active} activity={status.activity} />
      </Box>

      {recent.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={MUTED_FG}>recent</Text>
          <Rule />
          {recent.map((issue, idx) => (
            <RecentRow key={`${issue.number}-${idx}`} issue={issue} />
          ))}
          {hiddenRecent > 0 ? (
            <Text color={MUTED_FG}> +{hiddenRecent} more</Text>
          ) : null}
        </Box>
      ) : null}

      {banner ? <Banner banner={banner} /> : null}
    </Box>
  );
}

function App({ statusPath }: { statusPath: string }) {
  const { exit } = useApp();
  const [view, setView] = useState<ViewState>({ status: null, banner: null });
  // Terminal height drives how much we render (see `computeRecentCap`). Tracked
  // in state — separate from the data path — so a resize forces a re-fit even
  // when the reducer dedups an unchanged poll to the same reference.
  const [rows, setRows] = useState<number>(process.stdout.rows ?? 24);

  // Input sink → raw mode. Without an active input hook Ink leaves the TTY in
  // cooked mode, so scrolling — which the terminal translates to cursor-key
  // escape sequences while the alt-screen is up — gets ECHOED as `^[[A`/`^[[B`
  // spam below the render. Consuming input flips the TTY to raw mode, so those
  // keystrokes are swallowed instead of printed. `q` quits; Ctrl-C still exits
  // via Ink's default. Inactive when stdin isn't a TTY, so a non-interactive
  // stdin never trips Ink's raw-mode-unsupported throw.
  useInput(
    (input) => {
      if (input === "q") exit();
    },
    { isActive: process.stdin.isTTY === true },
  );

  useEffect(() => {
    const tick = () => {
      const read = readStatus(statusPath);
      setView((prev) => reduce(prev, read, Date.now()));
    };
    tick(); // paint immediately rather than wait a full interval
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
  }, [statusPath]);

  useEffect(() => {
    const onResize = (): void => setRows(process.stdout.rows ?? 24);
    process.stdout.on("resize", onResize);
    return () => {
      process.stdout.removeListener("resize", onResize);
    };
  }, []);

  return <Dashboard state={view} rows={rows} />;
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

// Alternate screen buffer (the lazygit/htop/k9s behaviour): the dashboard draws
// on a fresh full screen, so the shell scrollback — including npm's `> tsx …`
// preamble — is hidden while we run and restored verbatim on quit. `1049h`
// enters the alt buffer, `2J` clears it, `H` homes the cursor; `1049l` leaves.
const ENTER_ALT_SCREEN = "\x1b[?1049h\x1b[2J\x1b[H";
const LEAVE_ALT_SCREEN = "\x1b[?1049l";

function main(): void {
  if (!process.stdout.isTTY) {
    process.stdout.write("sandcastle-watch needs a TTY\n");
    process.exit(0);
  }
  const statusPath = parseStatusPath(process.argv.slice(2));

  process.stdout.write(ENTER_ALT_SCREEN);
  // Restore the normal screen on every exit path (clean quit, Ctrl-C, kill) so
  // we never strand the terminal in the alt buffer. Idempotent double-write is
  // harmless; `exit` must stay synchronous, and a bare stdout write is.
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    process.stdout.write(LEAVE_ALT_SCREEN);
  };
  process.on("exit", restore);

  const app = render(<App statusPath={statusPath} />);
  app.waitUntilExit().then(restore, restore);
}

// Only take over the terminal when run directly (`tsx …/sandcastle-watch.tsx`);
// importing the module for a render check must NOT trigger the TTY guard.
const isEntry = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntry) {
  main();
}
