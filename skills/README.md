# Sandcastle skills

The `/sandcastle-*` skills, version-controlled. These files are the live ones —
`~/.claude/skills/sandcastle-*` are symlinks into this directory, so editing a
`SKILL.md` here changes the skill immediately, with no copy step.

## Why they live here

They used to live only in `~/.claude/skills/`, which is not a git repo. That
meant every fix was local to one machine: the Mac and the VPS drifted, and a bug
fixed in one place stayed broken in the other. It caused a real problem three
separate times, most recently when `/sandcastle-update` overwrote a project's
`hosts.json` and the fix existed on only one machine.

Keeping them in this repo makes a fix travel the same way code does: commit,
push, `git pull` on the other machine.

## Install (every machine that runs sandcastle, VPS included)

```sh
git clone https://github.com/ziyadakl/sandcastle-loop ~/Dev/Sandcastle   # once
bash ~/Dev/Sandcastle/skills/install.sh
```

The script symlinks each `sandcastle-*` skill into `~/.claude/skills/`. It is
idempotent, and it moves any existing copy into a timestamped backup rather than
deleting it. Afterwards, `git pull` in this repo is all it takes to update the
skills on that machine.

## Why symlinks into `~/.claude/skills` rather than this repo's `.claude/skills`

These skills are invoked from *consumer* projects — `/sandcastle-update` runs
inside affinity-tracker, not here. A project-level skill would only be visible in
this repo, which is the one place it is least needed. User-level is the only
scope that makes them available everywhere, and symlinking to a checkout is what
keeps them version-controlled at the same time.

This mirrors the existing `~/.agents/mattpocock-skills` arrangement on this
machine, which already runs ~21 skills this way.

## Gotcha

`~/.claude/skills/` is NOT version-controlled. If you edit a skill through that
path on a machine where `install.sh` has not been run, you are editing a private
copy that no other machine will ever see — the exact failure this layout exists
to end. Check that `~/.claude/skills/sandcastle-run` is a symlink before
trusting an edit to propagate:

```sh
ls -l ~/.claude/skills/sandcastle-run    # should print '-> .../Sandcastle/skills/sandcastle-run'
```
