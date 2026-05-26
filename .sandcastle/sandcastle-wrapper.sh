#!/usr/bin/env bash
# sandcastle-wrapper.sh — loop on exit code 75 so the orchestrator can
# self-restart when one of its own statically-imported files changes on
# disk (typically: a recovery agent committed a fix and we need to pick
# it up). See docs/superpowers/plans/2026-05-26-orchestrator-hot-reload.md.

set -uo pipefail

RESTART_EXIT_CODE=75
MARKER_FILE=".sandcastle/.restart-remaining"

# Runner is overridable via env var (used by tests). Default is the
# production invocation. Parsed as an array so a multi-word runner like
# `tsx .sandcastle/main.mts` splits correctly.
if [ -n "${SANDCASTLE_RUNNER:-}" ]; then
  read -r -a RUNNER <<< "$SANDCASTLE_RUNNER"
else
  RUNNER=(tsx .sandcastle/main.mts)
fi

while true; do
  "${RUNNER[@]}" "$@"
  code=$?
  if [ "$code" -ne "$RESTART_EXIT_CODE" ]; then
    exit "$code"
  fi
  if [ ! -f "$MARKER_FILE" ]; then
    echo "[sandcastle-wrapper] orchestrator exited 75 but no marker file at $MARKER_FILE; refusing to loop blindly" >&2
    exit 1
  fi
  remaining=$(cat "$MARKER_FILE")
  rm -f "$MARKER_FILE"
  if ! [[ "$remaining" =~ ^[0-9]+$ ]] || [ "$remaining" -lt 1 ]; then
    echo "[sandcastle-wrapper] marker file contained invalid value: $remaining" >&2
    exit 1
  fi
  echo "[sandcastle-wrapper] restarting with $remaining iterations remaining"
  export SANDCASTLE_REMAINING_ITERATIONS="$remaining"
done
