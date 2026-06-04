# ADR 0008 — Sandcastle: a read-only TUI viewer over a structured status feed

**Status:** Accepted
**Date:** 2026-06-04
**Related:** plan `docs/superpowers/plans/2026-06-04-sandcastle-viewer-tui.md`;
CONTEXT.md terms **Sandcastle viewer**, **Status feed**, **Orchestrator stream**.

> Renumbered from 0007 → 0008: `0007` was taken by `0007-sdk-0.7.0-upgrade.md`
> when the SDK 0.7.0 bump merged to `main` while this work sat on its branch.

## Context

The orchestrator stream (`.sandcastle/main.mts` stdout, redirected to a file and
watched via `tail -f` in a tmux pane) is the surface a human scans to triage a
running loop: "is anything stuck, does anything need me, is there a reason to
stop." As an append-only chronological log it is a poor fit for that job — you
reconstruct current state by scrolling, and ~85 ad-hoc `log()` lines bury the
signal. The user wants the watch pane to be a "clean, professional, extremely
polished TUI" in the style of Claude Code / Codex / opencode.

The hard constraint: the **loop runs detached/overnight, concurrent
(`--max-concurrent 2`), and its output is read from files**. The SDK already
encodes this — it drops to plain `FileDisplay` (no Clack) when writing to a log.
You cannot `tail -f` an alternate-screen render loop, and an in-loop TUI would
only exist while a terminal is attached.

Three shapes were considered:

- **A — Foreground TUI inside the loop.** The loop renders Ink when attached,
  falls back to plain logs when detached. Simplest (one program) but couples
  watching to running: you lose the polish the moment it runs headless, which is
  the normal case here. Rejected — fights the detached/overnight reality.
- **B — Separate read-only viewer over a structured status feed.** The loop stays
  headless and additionally writes a typed snapshot; a standalone viewer reads it
  and renders the dashboard. Decouples watching from running; attach/detach
  freely; the loop never depends on a viewer.
- **C — Rich viewer that parses the human log stream.** No new producer surface,
  but couples the viewer to log prose; brittle and breaks whenever a line's
  wording changes. Rejected.

## Decision

We chose **B**. Concretely (settled):

- **Worker/viewer split.** The loop is never restyled into a TUI. It stays an
  append-only, pipe/file/detach-safe producer. A separate, **read-only**
  `sandcastle-watch` renders the live dashboard in the watch pane in place of
  `tail -f`. It never writes and never touches the loop.
- **Status feed contract.** The loop additionally writes
  `.sandcastle/status.json` — a single in-memory status object, mutated centrally
  and re-serialized **atomically** (write-tmp + `rename`) on each transition,
  against a schema shared between worker and viewer. The loop is the sole writer;
  the viewer (and potentially the `/sandcastle-status` skill) are readers.
- **Viewer reads by polling** `status.json` every ~250ms — not `fs.watch`, which
  the atomic `rename` silently breaks after the first swap.
- **Built with Ink** (React-for-terminals), the library behind the cited tools.
- **Cost is not load-bearing.** SDK `usage` is Claude-Code-only and `undefined`
  for the kimi/glm runs this loop uses; dollar cost would also need a price
  table. Token/cost fields are optional/best-effort, kept out of Phase 1.

## Resolved: where the viewer and its dependency footprint live (was the open trade-off)

The load-bearing question was **B1 (bundle the viewer inside the round-tripped
`.sandcastle/` payload) vs B2 (keep it a sibling outside the payload)**, because
`.sandcastle/` is *copied* into every consumer repo and overwritten on
`/sandcastle-update`, and Ink pulls React into a folder that had zero runtime UI
deps.

**Resolved to B2**, as built:

- The **producer** — the only addition to the copied payload — is
  `.sandcastle/lib/status/{schema,store}.ts`. `store.ts` imports **only**
  `node:fs`/`node:path` (no React, no Ink); the payload stays lean.
- The **viewer** (Ink/React) lives in `tools/watch/`
  (`sandcastle-watch.tsx` + `reducer.ts`), **outside** `.sandcastle/`. `ink`,
  `react`, and `@types/react` are `devDependencies`, and a `sandcastle:watch`
  npm script runs it. Watchers opt in; non-watchers never pay for Ink.

This keeps the loop's runtime footprint unchanged and matches the ADR's original
recommendation.

## Implementation — Phase 1 (2026-06-04, built and green)

The status feed + dashboard are implemented and covered (585 tests green,
typecheck clean). Design decisions made during the build:

- **Single rounded "running" panel, not a full outer card.** The dashboard wraps
  only the *bounded* "running" list in one rounded panel rather than boxing the
  whole screen — boxing the unbounded screen made inline repaint fragile.
- **Alt-screen buffer.** The viewer takes over a fresh full screen and restores
  the shell on quit (scrollback history still lives in the log + agent
  transcripts). *(The interactive alt-screen enter/exit is verified by design but
  needs a real TTY to eyeball; tests cover the render, not the terminal takeover.)*
- **Adaptive-dim palette.** All secondary text uses the terminal's own ANSI
  `dim` attribute instead of hardcoded gray hexes, so it stays legible across
  light/dark themes. The Claude-Code coral accent (`#D77757`) and brand blue
  (`#6A9BCC`) are verified against the actual binary.
- **State-aware banner.** The viewer's reducer honors `status.state`
  (`done` / `stopped` / `restarting`) instead of inferring everything from
  write-age — a finished run renders `✓ done — loop finished` rather than a false
  `stale` alarm. The worker now emits `finish("stopped")` on a SIGINT/SIGTERM
  shutdown (previously it mislabeled an interrupt as `done`), which makes the
  `stopped` banner reachable; the worker→feed wiring (`ok→merged`,
  `quarantined/error→needs-human`, `deferred→requeued`, plus the finish state) is
  proven by execution-level tests, not just by reading.
- **Heartbeat liveness.** The worker writes a keep-alive every 2 min
  (`HEARTBEAT_MS = 120_000`); the viewer waits 3 min of silence
  (`STALE_AFTER_MS = 180_000`) before warning `stale`. Both constants live in the
  **shared schema** so worker and viewer can't drift. The timer is `unref`'d (never
  holds the process open) and `finish()` stops it.

## Consequences

- The loop gains a small serialize-on-transition responsibility and a new
  artifact (`status.json`); the human log is otherwise untouched (a separate,
  cheaper "polished stream" cleanup remains possible later).
- A torn or non-atomic write, or per-issue slice writes under concurrency, would
  make the viewer flicker/error — atomicity and a single central writer are
  load-bearing, not nice-to-haves. Every store mutator is strictly synchronous so
  the atomic tmp+rename can't tear.
- The alt-screen dashboard trades native tmux scrollback in that pane for a
  pinned glance surface (history still lives in the log and agent transcripts).
- Phase 1 (status feed + dashboard) is independently shippable and is itself the
  polished dashboard; Phases 2–3 add progress/cost/keybindings and optional
  history.
