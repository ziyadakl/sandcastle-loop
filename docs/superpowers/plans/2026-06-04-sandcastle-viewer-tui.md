# Plan: `sandcastle-watch` — a polished read-only TUI viewer

**Date:** 2026-06-04
**Status:** design (grill-with-docs session)
**Decision owner:** Ziyad

## Goal

Replace `tail -f /tmp/sandcastle.log` in the watch pane with a clean,
professional, always-current TUI dashboard — the look of Claude Code / Codex /
opencode — for periodic triage glances ("is anything stuck, does anything need
me, is there a reason to stop").

## Core architectural decision: worker / viewer split

The sandcastle **loop stays exactly as it is** — a headless background process,
launched detached, append-only output, pipe/file/tail-safe. We do **not** turn
the loop into a TUI (it runs detached overnight; an in-loop TUI would only exist
while attached and would break the moment it runs headless).

Instead we add a **separate, read-only viewer** (`sandcastle-watch`) that runs in
the watch pane and renders the dashboard. The viewer never writes, never touches
the loop, and can be opened/closed/attached/detached freely. The loop never
depends on anyone watching.

```
  worker (loop, headless)  ──writes──▶  status feed  ──reads──▶  viewer (Ink TUI)
  .sandcastle/main.mts                  .sandcastle/status.json   sandcastle-watch
```

### Why a structured status feed, not parsing the human log

The viewer reads a typed snapshot, **not** the human sentences in
`/tmp/sandcastle.log`. Parsing pretty prose is fragile and couples the viewer to
log wording. The loop already holds all this state internally (it builds those
log lines from real data) — we just also serialize it.

- `.sandcastle/status.json` — current snapshot, rewritten **atomically**
  (write tmp + `rename`) on every state transition so the viewer never reads a
  half-written file. Typed with zod (already a dep); schema shared from
  `src/`/`lib/` so worker and viewer validate against the same contract.
- (Phase 3, optional) `.sandcastle/events.ndjson` — append-only JSONL of
  transitions, for in-TUI scrollback/history.

The human log (`/tmp/sandcastle.log`) is left untouched by this work (a separate,
cheaper "polished stream" cleanup can happen later if wanted).

### Status snapshot — first-cut contract

```ts
type SandcastleStatus = {
  schemaVersion: number;
  run: { branch: string; repo: string; startedAt: string;
         iterations: { current: number; total: number };
         maxConcurrent: number };
  totals: { merged: number; needsHuman: number; requeued: number;
            running: number;
            // cost is BEST-EFFORT only: SDK `usage` is Claude-Code-only and
            // undefined for kimi/glm runs; dollar cost also needs a price
            // table. Do NOT feature it in Phase 1. Optional, may be absent.
            tokens?: number; cost?: number };
  issues: Array<{
    number: number; title: string; branch: string;
    phase: "planned" | "implementer" | "reviewer" | "merge"
         | "implementer-retry" | "merged" | "needs-human" | "deferred";
    detail?: string;            // e.g. "HAS_BLOCKERS · escalate→opus-4.7"
    startedAt?: string;         // for elapsed/spinner
    attention?: boolean;        // drives the ⚠ highlight
  }>;
  updatedAt: string;
};
```

## Build phases

**Phase 1 — feed + minimal viewer (the win).**
- Loop writes `status.json` atomically on each transition (reuse the points that
  already call `log()` for iteration start, plan, per-issue phase changes,
  merge/quarantine outcomes).
- `sandcastle-watch`: Ink app rendering header (run + iteration + counts),
  a row per running issue, a recent-results strip. **Polls `status.json`
  every ~250ms**, re-renders on change — do NOT use `fs.watch` on the file:
  atomic write does `rename`, which swaps the inode and silently kills a
  file watcher after the first update. A glance surface tolerates 250ms
  latency; polling is simpler and robust.
- Run via `npm run sandcastle:watch` (and/or a `sandcastle-watch` bin).

**Phase 2 — polish.**
- Progress bar across iterations, cost, per-issue elapsed + spinner, loud
  exception styling (⚠ needs-human / HAS_BLOCKERS / errors), requeue/deferred.
- Keybindings: `q` quit, `↵` open the focused issue's agent transcript
  (`.sandcastle/logs/<branch>-<name>.log`) via `$PAGER`/`less +F`.
- Color theme matching the SDK's existing `styleText` palette; respect
  `NO_COLOR`.

**Phase 3 — optional.**
- `events.ndjson` for in-TUI scrollback/history; resize handling; theming;
  possibly fold `status.json` into the existing `/sandcastle-status` skill so
  the snapshot powers both the live viewer and the pull-based status check.

## Trade-offs / things to flag

- **New dependency footprint.** Ink pulls React into `.sandcastle/`, which today
  has zero runtime UI deps. The viewer should be optional/isolated so a consumer
  who never runs it doesn't pay for it at loop runtime.
- **Template round-trip.** `.sandcastle/` is copied into consumer repos and
  overwritten on `/sandcastle-update`. The viewer + its deps must ship in the
  template exhaustively (see memory: template-port-must-be-exhaustive), or
  consumers regress on next update.
- **Ink render mode.** Inline render preserves some tmux scrollback but can look
  messy; full-screen (alt-screen) gives a pinned dashboard but replaces native
  scrollback in that pane. Decide in Phase 1; pinned likely wins for a glance
  surface (history lives in the log / agent transcripts anyway).
- **Atomic write is load-bearing.** Without tmp+rename the viewer will
  intermittently read a torn JSON and flicker/error.
- **One central status object, serialized centrally.** Under
  `--max-concurrent 2` the loop mutates per-issue state from interleaved async
  contexts. Hold a single in-memory status object, mutate it in one place, and
  re-serialize the whole thing on each change. Do NOT let each issue write its
  own slice of `status.json` — concurrent writers clobber each other.

## Open questions (deferred — not blocking Phase 1)

- Inline vs full-screen Ink render.
- Ship as `.sandcastle/watch.mts` (single file) vs `.sandcastle/lib/watch/`
  (module) — leaning single entry + small lib.
- Whether to also clean the human stream now or defer entirely.
