/**
 * `sandcastle-watch` — a live terminal dashboard for an in-flight sandcastle
 * loop. It polls `<repoRoot>/.sandcastle/status.json` (or `--status <path>`)
 * every 250ms, folds each read through the pure `reduce` reducer, and renders
 * the resulting `ViewState` with Ink.
 *
 * The dashboard runs on the alternate screen buffer (htop/lazygit/k9s style):
 * `render(<App/>)` repaints in place on every state change, and the reducer
 * keeps the last-good snapshot on screen across torn writes, so there's no
 * flicker to manage here. An input sink puts the TTY in raw mode so scroll
 * keystrokes don't echo as escape-sequence spam.
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
import type {
  IssuePhase,
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
/** Cap the "recent" strip so a long history can't grow the inline render. */
const RECENT_CAP = 6;

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

const BANNER_TEXT: Record<NonNullable<ViewState["banner"]>, string> = {
  waiting: "waiting for loop…",
  stale: "stale — loop may have stopped",
  outdated: "viewer out of date — run an update",
  done: "done — loop finished",
  stopped: "stopped — loop halted",
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
};

const BANNER_GLYPH: Record<NonNullable<ViewState["banner"]>, string> = {
  waiting: "○",
  stale: "●",
  outdated: "●",
  done: "✓",
  stopped: "■",
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

function Counts({ totals }: { totals: SandcastleStatus["totals"] }) {
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

/** The one bordered panel: the live region. Border hugs the fixed-width grid. */
function RunningPanel({ active }: { active: readonly StatusIssue[] }) {
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
      {active.length === 0 ? (
        <Text color={MUTED_FG}>idle — no active issues</Text>
      ) : (
        active.map((issue) => <IssueRow key={issue.number} issue={issue} />)
      )}
    </Box>
  );
}

function RecentRow({ issue }: { issue: StatusIssue }) {
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

export function Dashboard({ state }: { state: ViewState }) {
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
  const recentAll = status.issues.filter((i) => TERMINAL_PHASES.has(i.phase));
  const recent = recentAll.slice(0, RECENT_CAP);
  const hiddenRecent = recentAll.length - recent.length;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Header run={status.run} />
      <Rule />
      <Counts totals={status.totals} />

      <Box marginTop={1}>
        <RunningPanel active={active} />
      </Box>

      {recent.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={MUTED_FG}>recent</Text>
          <Rule />
          {recent.map((issue) => (
            <RecentRow key={issue.number} issue={issue} />
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

  return <Dashboard state={view} />;
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
