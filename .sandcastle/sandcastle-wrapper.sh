#!/usr/bin/env bash
# sandcastle-wrapper.sh — loop on exit code 75 so the orchestrator can
# self-restart when one of its own statically-imported files changes on
# disk (typically: a recovery agent committed a fix and we need to pick
# it up). See docs/superpowers/plans/2026-05-26-orchestrator-hot-reload.md.
#
# Order of a start, every time (spec #1370):
#   1. lock      One loop per checkout: an exclusive flock on
#                <git-dir>/sandcastle-wrapper.lock, held on fd 9 for the
#                wrapper's whole life. A second wrapper refuses before it
#                touches the packages. The lock lives inside git's own folder
#                so the working tree never gains an untracked file.
#   2. install   Bring node_modules in line with the lockfile and patches
#                (frozen, offline-preferring, no package scripts), from the
#                repo root, bounded by a timeout. Runs before EVERY start:
#                first start, exit-75 self-restart and stall relaunch. A
#                failed or hung install stops the wrapper; no retry.
#   3. watchdog  The stall sidecar, only once the install is done.
#   4. orchestrator
#
# A failed or timed-out install also runs a best-effort "mark the run unhealthy"
# command (tsx .sandcastle/scripts/mark-run-unhealthy.mts --repo-root <root>
# --reason <text>) so the web status page stops showing a dead run as Live.
# Its own failure is ignored; the wrapper still exits 1.
#
# Lock lifetime trade-off: the orchestrator does NOT inherit the lock (fd 9 is
# closed for it), so an orphaned orchestrator can never block the next start.
# The cost: if only the wrapper is killed while the orchestrator lives, a new
# wrapper can install under it before the orchestrator's own one-loop lock
# refuses. Always stop the loop with /sandcastle-stop, which kills the wrapper
# too.
#
# Linux-only: stock macOS has neither flock nor timeout.
#
# Overrides (tests): SANDCASTLE_INSTALL_CMD, SANDCASTLE_INSTALL_TIMEOUT_SECS,
# SANDCASTLE_INSTALL_FAIL_CMD (the command prefix; --repo-root and --reason are
# always appended).

set -uo pipefail

for tool in flock timeout git; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "[sandcastle-wrapper] required tool '$tool' is not on PATH; refusing to start" >&2
    exit 1
  fi
done

GIT_DIR_ABS=$(git rev-parse --absolute-git-dir 2>/dev/null) || {
  echo "[sandcastle-wrapper] not inside a git checkout; refusing to start" >&2
  exit 1
}
REPO_ROOT=$(git rev-parse --show-toplevel)
LOCK_FILE="$GIT_DIR_ABS/sandcastle-wrapper.lock"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[sandcastle-wrapper] another loop already holds $LOCK_FILE; refusing to start" >&2
  exit 1
fi
# fd 9 is closed (9>&-) for every child below so an orphan can never hold it.

INSTALL_TIMEOUT_SECS="${SANDCASTLE_INSTALL_TIMEOUT_SECS:-600}"
if [ -n "${SANDCASTLE_INSTALL_CMD:-}" ]; then
  read -r -a INSTALL_CMD <<< "$SANDCASTLE_INSTALL_CMD"
else
  INSTALL_CMD=(env CI=true pnpm install --frozen-lockfile --prefer-offline --ignore-scripts)
fi

if [ -n "${SANDCASTLE_INSTALL_FAIL_CMD:-}" ]; then
  read -r -a INSTALL_FAIL_CMD <<< "$SANDCASTLE_INSTALL_FAIL_CMD"
else
  INSTALL_FAIL_CMD=(tsx .sandcastle/scripts/mark-run-unhealthy.mts)
fi

# Refresh node_modules; on failure print one explanatory line plus the tail of
# the output and exit the wrapper without starting anything.
run_install() {
  local out start rc secs why
  out=$(mktemp) || { echo "[sandcastle-wrapper] mktemp failed; refusing to start" >&2; exit 1; }
  start=$SECONDS
  (cd "$REPO_ROOT" && timeout -k 30 "$INSTALL_TIMEOUT_SECS" "${INSTALL_CMD[@]}") >"$out" 2>&1 9>&-
  rc=$?
  secs=$((SECONDS - start))
  if [ "$rc" -eq 0 ]; then
    if grep -q "Already up to date" "$out"; then
      echo "[sandcastle-wrapper] packages current (${secs}s)"
    else
      echo "[sandcastle-wrapper] packages installed (${secs}s)"
    fi
    rm -f "$out"
    return 0
  fi
  if [ "$rc" -eq 124 ] || { [ "$rc" -eq 137 ] && [ "$secs" -ge "$INSTALL_TIMEOUT_SECS" ]; }; then
    why="timed out after ${INSTALL_TIMEOUT_SECS}s"
  elif [ "$rc" -eq 137 ]; then
    why="killed (exit 137)"
  else
    why="exit status $rc"
  fi
  echo "[sandcastle-wrapper] install failed (${why}): ${INSTALL_CMD[*]} ; rerun: cd \"$REPO_ROOT\" && ${INSTALL_CMD[*]}" >&2
  tail -n 20 "$out" >&2
  rm -f "$out"
  (cd "$REPO_ROOT" && timeout -k 10 60 "${INSTALL_FAIL_CMD[@]}" --repo-root "$REPO_ROOT" \
    --reason "install failed (${why}): ${INSTALL_CMD[*]}") >&2 9>&- || true
  exit 1
}

RESTART_EXIT_CODE=75
# NOTE: MARKER_FILE is resolved against the wrapper's CWD. If the user
# passes --repo-root /some/other/path to the orchestrator, the orchestrator
# writes the marker under that path while the wrapper looks here — the
# wrapper will exit 1 with "no marker file" instead of restarting. The
# loud failure is acceptable for the rarely-used --repo-root flag; if this
# bites in practice, parse --repo-root from "$@" here too.
MARKER_FILE=".sandcastle/.restart-remaining"

# Stall watchdog (Stream 3). A sidecar (.sandcastle/scripts/stall-watchdog.mts)
# runs alongside main.mts and, when the loop wedges past its stall limit with no
# genuine progress (status.json.lastProgressAt goes stale while state=running),
# kills the sandbox + loop and writes STALL_MARKER_FILE so we relaunch. This is
# the self-heal for a hang no per-step timeout caught (2026-08-31 6.5h freeze).
# It is SEPARATE from the exit-75 hot-reload marker so that path stays untouched.
STALL_MARKER_FILE=".sandcastle/.stall-restart"

# Watchdog runner is overridable/disable-able for tests, same idea as
# SANDCASTLE_RUNNER. Set SANDCASTLE_WATCHDOG_DISABLE=1 to skip spawning it.
if [ -n "${SANDCASTLE_WATCHDOG_CMD:-}" ]; then
  read -r -a WATCHDOG_CMD <<< "$SANDCASTLE_WATCHDOG_CMD"
else
  WATCHDOG_CMD=(tsx .sandcastle/scripts/stall-watchdog.mts)
fi

# PID of the watchdog spawned for the CURRENT main.mts run. Killed the instant
# main.mts returns (below) and, as a backstop, on any wrapper exit (trap) so the
# sidecar never lingers past the loop it was watching.
WATCHDOG_PID=""
kill_watchdog() {
  if [ -n "$WATCHDOG_PID" ]; then
    kill "$WATCHDOG_PID" 2>/dev/null || true
    WATCHDOG_PID=""
  fi
}
trap kill_watchdog EXIT

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
  # Packages first, before the watchdog or the orchestrator exist.
  run_install

  # Spawn a fresh watchdog for THIS run (unless disabled), then kill it the
  # moment main.mts returns — every run gets its own sidecar, and there is
  # never a lingering one after a restart.
  if [ -z "${SANDCASTLE_WATCHDOG_DISABLE:-}" ]; then
    "${WATCHDOG_CMD[@]}" 9>&- &
    WATCHDOG_PID=$!
  fi

  "${RUNNER[@]}" "$@" $SANDBOX_FLAG 9>&-
  code=$?

  # Capture the runner's exit code FIRST (above), then stop the watchdog.
  kill_watchdog

  if [ "$code" -ne "$RESTART_EXIT_CODE" ]; then
    # Watchdog stall-restart: the sidecar killed a wedged loop and left this
    # marker asking us to relaunch (true self-heal, not just a death). Same
    # remaining-iterations contract as the exit-75 path below, but a SEPARATE
    # marker so that path is preserved byte-for-byte.
    if [ -f "$STALL_MARKER_FILE" ]; then
      stall_remaining=$(cat "$STALL_MARKER_FILE")
      rm -f "$STALL_MARKER_FILE"
      if [[ "$stall_remaining" =~ ^[0-9]+$ ]] && [ "$stall_remaining" -ge 1 ]; then
        echo "[sandcastle-wrapper] watchdog stall-restart with $stall_remaining iterations remaining"
        export SANDCASTLE_REMAINING_ITERATIONS="$stall_remaining"
        continue
      fi
      echo "[sandcastle-wrapper] stall marker contained invalid value: $stall_remaining" >&2
    fi
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
