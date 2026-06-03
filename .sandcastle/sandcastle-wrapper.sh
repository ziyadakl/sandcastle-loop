#!/usr/bin/env bash
# sandcastle-wrapper.sh — loop on exit code 75 so the orchestrator can
# self-restart when one of its own statically-imported files changes on
# disk (typically: a recovery agent committed a fix and we need to pick
# it up). See docs/superpowers/plans/2026-05-26-orchestrator-hot-reload.md.

set -uo pipefail

RESTART_EXIT_CODE=75
# NOTE: MARKER_FILE is resolved against the wrapper's CWD. If the user
# passes --repo-root /some/other/path to the orchestrator, the orchestrator
# writes the marker under that path while the wrapper looks here — the
# wrapper will exit 1 with "no marker file" instead of restarting. The
# loud failure is acceptable for the rarely-used --repo-root flag; if this
# bites in practice, parse --repo-root from "$@" here too.
MARKER_FILE=".sandcastle/.restart-remaining"

# Runner is overridable via env var (used by tests). Default is the
# production invocation. Parsed as an array so a multi-word runner like
# `tsx .sandcastle/main.mts` splits correctly.
if [ -n "${SANDCASTLE_RUNNER:-}" ]; then
  read -r -a RUNNER <<< "$SANDCASTLE_RUNNER"
else
  RUNNER=(tsx .sandcastle/main.mts)
fi

# Forward .sandcastle/.sandbox-flag as --sandbox to main.mts. The file is
# produced by the /sandcastle-profile skill when a profile is activated.
# Evaluated once at launch; restart to pick up profile switches.
SANDBOX_FLAG=""
if [ -f .sandcastle/.sandbox-flag ]; then
  SANDBOX_VALUE=$(tr -d '[:space:]' < .sandcastle/.sandbox-flag)
  if [ -n "$SANDBOX_VALUE" ]; then
    SANDBOX_FLAG="--sandbox $SANDBOX_VALUE"
  fi
fi

while true; do
  "${RUNNER[@]}" "$@" $SANDBOX_FLAG
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
