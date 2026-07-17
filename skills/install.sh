#!/usr/bin/env bash
#
# Link this repo's sandcastle-* skills into ~/.claude/skills/ so Claude Code
# picks them up in EVERY project.
#
# Why symlinks into ~/.claude/skills rather than shipping the files into each
# project's .claude/skills: these skills are run FROM consumer projects
# (/sandcastle-update is invoked inside affinity-tracker, not here), so they
# must be user-level to be discoverable everywhere. Symlinking to a git
# checkout is what makes them version-controlled AND global at once — the same
# arrangement the mattpocock-skills clone already uses on this machine.
#
# Run on every machine that runs sandcastle (including the VPS):
#   git clone https://github.com/ziyadakl/sandcastle-loop ~/Dev/Sandcastle   # once
#   bash ~/Dev/Sandcastle/skills/install.sh
#
# Thereafter a `git pull` in this repo updates the skills on that machine —
# that is the whole point: a fix authored on one machine reaches the others.
#
# Idempotent: re-running is a no-op if the links are already correct.

set -euo pipefail

REPO_SKILLS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$DEST/.sandcastle-skills-backup-$STAMP"

mkdir -p "$DEST"

linked=0; skipped=0; backed_up=0

for src in "$REPO_SKILLS"/sandcastle-*/; do
  [ -d "$src" ] || continue
  name="$(basename "$src")"
  target="$DEST/$name"

  # Already pointing at this checkout — nothing to do.
  if [ -L "$target" ] && [ "$(readlink "$target")" = "${src%/}" ]; then
    echo "ok        $name (already linked)"
    skipped=$((skipped + 1))
    continue
  fi

  # A real directory (or a link elsewhere) is the user's current copy. NEVER
  # delete it outright — move it into a timestamped backup so a bad link is
  # always one `mv` away from being undone.
  if [ -e "$target" ] || [ -L "$target" ]; then
    mkdir -p "$BACKUP"
    mv "$target" "$BACKUP/$name"
    echo "backed up $name -> $BACKUP/$name"
    backed_up=$((backed_up + 1))
  fi

  ln -s "${src%/}" "$target"
  echo "linked    $name -> ${src%/}"
  linked=$((linked + 1))
done

echo "---"
echo "linked $linked, already-ok $skipped, backed up $backed_up"
[ "$backed_up" -gt 0 ] && echo "previous copies kept at: $BACKUP"
echo "skills now track: $REPO_SKILLS"
exit 0
