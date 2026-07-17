---
name: sandcastle-update
description: Pull the latest sandcastle template into the current project. Use when the template repo on GitHub has new commits and the user wants to update their project's local copy, or when they invoke /sandcastle-update. Refuses if a loop is running. Warns before overwriting files the user may have customized. Always shows before/after SHAs and the upstream changelog so updates are never silent.
argument-hint: "[optional: symptom you're trying to fix, e.g. 'branch drift' — used to grep the changelog]"
---

# Sandcastle Update

Updates the project's `.sandcastle/` template files to match the latest GitHub release.

## Architecture (read first — do NOT confuse these)

Two packages are involved, and they STACK. They do NOT compete or supersede each other:

- **`@ai-hero/sandcastle`** — the UPSTREAM library. Provides the sandbox runner, docker provider, agent shell, base templates. Maintained externally on npm.
- **`github:ziyadakl/sandcastle-loop`** (what this skill updates) — the USER'S customized template layer built ON TOP of `@ai-hero/sandcastle`. The `.sandcastle/` directory in a project is the user's customized loop — NOT a stock template that should be replaced from `@ai-hero/sandcastle` baselines.

This skill pulls the latest commit from `github:ziyadakl/sandcastle-loop` and re-syncs the project's `.sandcastle/` files. It does NOT touch `@ai-hero/sandcastle` (that gets bumped via its own version range in `package.json`).

Note: file content is fetched directly from GitHub at the resolved SHA, NOT read from `node_modules/sandcastle-loop/.sandcastle/`, because npm/pnpm/yarn packaging of `github:` deps mangles dotfiles (`.gitignore` becomes `.npmignore`). The `node_modules` copy is used only to confirm the dep refresh landed and to read `package.json` for the devDeps injection step.

If you see a `.sandcastle/main.mts` with 2000+ lines of project-specific logic (label state machine, drizzle migration applier, verdict parser, etc.), that IS the customized loop. Do not "fix" it by replacing with a stock `@ai-hero/sandcastle` template — that would destroy the customizations.

## Files this skill will NEVER touch

This skill operates strictly inside `.sandcastle/`. The following project-root files are user-authored or project-owned and MUST be left exactly as-is, even if a future template diff appears to reference them:

- **`SANDCASTLE.md`** at the project root — user-authored skill-discipline rules. NOT inside `.sandcastle/`; it lives at the repo root by design so it survives template updates. Never read it as a source of truth for this skill's operations, never write it, never diff against it.
- **`.env`** at the project root — credentials. Already excluded from the in-`.sandcastle/` diff, but reinforced here: never overwrite, never report as changed.
- **Any path outside `.sandcastle/`** — package.json's `devDependencies` block and the `sandcastle:*` script entries (step 7 below) are the only exceptions, and even then ONLY those fields are mutated, never the rest of package.json. The `sandcastle:*` scripts (`sandcastle:watch`, `sandcastle:check-upstream`, etc.) all point at files INSIDE `.sandcastle/` (the relocated viewer lives at `.sandcastle/watch/`), so this adds a launcher entry without ever copying a file outside `.sandcastle/` — the filesystem path guard (step 6) is unchanged.

If a diff or copy step ever produces a target path that is not inside the project's `.sandcastle/` directory (or, for step 7, the `devDependencies` block or the `sandcastle:*` script entries of `package.json`), STOP. Tell the user which path tripped the guard and do not proceed.

## Pre-flight

1. **Loop running?** Check `pgrep -af '\.sandcastle/main\.mts (--iterations|--issue|--max-concurrent|--repo-root|--branch)'`. If it returns anything, you need to decide whether the loop's working directory overlaps the checkout being updated:
   - For each matched PID, read its working directory: `lsof -p <pid> -d cwd -Fn 2>/dev/null | sed -n 's/^n//p'` (macOS/Linux). Skip PIDs whose cwd cannot be read.
   - If ANY loop's cwd is inside the checkout being updated (the cwd this skill was invoked from), refuse — tell user to `/sandcastle-stop` first. Updating files the worker is actively re-reading mid-iteration corrupts the run.
   - If ALL matched loops have cwds in OTHER checkouts / worktrees (e.g. you're updating `~/dev/affinity-tracker` but the only running loop is in `~/dev/affinity-tracker/.claude/worktrees/affinity-track-budgeting`), proceed — git worktrees have separate filesystem paths, so updating one does not touch the other's `.sandcastle/` files. Print a one-line note to the user naming the other-worktree loop ("note: a loop is running in <path>, but it has its own `.sandcastle/` files so this update won't disturb it").
   - If no loops match the cwd check at all (pgrep matched but `lsof` failed for all of them), fall back to the conservative refuse — better safe than corrupting.

2. **Confirm initialized.** `.sandcastle/main.mts` must exist. If not, suggest `/sandcastle-init` and stop.

3. **Detect package manager.** Same as `/sandcastle-init`.

4. **Record current SHA.** Read the installed sandcastle-loop's commit SHA from the lockfile (`pnpm-lock.yaml`, `package-lock.json`, or `yarn.lock` — grep for `sandcastle-loop` and capture the `#<sha>` or `resolution: { commit: ... }` value). If `.sandcastle/.last-update` exists, also read its `sha` field. Store as `$OLD_SHA`. If neither source yields a SHA, set `$OLD_SHA=unknown` and note this to the user.

5. **Capture the active profile.** Read `.sandcastle/profile` into `$ACTIVE` BEFORE pulling any updates. If the file is missing, leave `$ACTIVE` empty. This is needed because the template ships with `playwright` active by default, and step 6 below would silently demote minimal/agent-browser users back to playwright unless we replay the swap afterward.

6. **Outer-tree working state — warn before touching anything.** This skill writes only inside `.sandcastle/`, but the user's main Claude session may follow up with cleanup commands (`git restore`, `git checkout -- .`) that DO touch the outer tree. If the outer tree has uncommitted edits to user-authored files, the user needs to see them BEFORE the update so they can stash/commit anything load-bearing.

   Run from the project root:

   ```
   git status --short
   ```

   Split the output into two buckets:

   - **In-`.sandcastle/`** — paths starting with `.sandcastle/`. These will be (or have been) overwritten by this update; that's expected and not a warning.
   - **Outside `.sandcastle/`** — everything else. These are the user's in-progress work.

   If the outside bucket is non-empty, list those paths to the user in plain English and require an explicit "ok, proceed" before continuing. Sample wording: "you have uncommitted changes outside `.sandcastle/` — listed below. The update itself won't touch them, but if you (or a follow-up cleanup step) run `git restore` or `git checkout -- .` against the outer tree, these edits will be lost. Stash or commit them first if they matter, then say 'go' to continue." Do not list the contents of the diff, just the file paths — the user knows what they wrote.

   If the outside bucket is empty, print one line ("outer tree clean — proceeding") and continue without a prompt.

## Steps

1. **Refresh the dep.** sandcastle-loop is a `github:` dependency, so a plain `update` / `upgrade` will NOT pull a new commit unless the lockfile happens to be stale — npm/pnpm/yarn cache resolved github tarballs aggressively. Always use the force-refetch path (the `add` / `install --save-dev` form) so the new commit lands:
   - pnpm workspace: `pnpm add -Dw github:ziyadakl/sandcastle-loop`
   - pnpm standard: `pnpm add -D github:ziyadakl/sandcastle-loop`
   - npm: `npm install --save-dev github:ziyadakl/sandcastle-loop`
   - yarn: `yarn add --dev github:ziyadakl/sandcastle-loop`

   After the install completes, sanity-check that the new copy actually landed: `ls node_modules/sandcastle-loop/.sandcastle/` and look for the file you expect (e.g. `variants/` if migrating from a pre-variants version). If the directory looks unchanged, tell the user the install didn't refresh the github dep and stop — they may need to clear the manager's cache (`pnpm store prune`, `npm cache clean --force`, or delete `node_modules/sandcastle-loop` and re-install) before re-running update. Note: this directory is checked only to confirm the dep refresh landed; the file content used for the actual copy comes from a direct GitHub fetch in step 3 below, because npm/pnpm/yarn packaging strips dotfiles like `.gitignore`.

2. **Capture new SHA + changelog.** After the refresh, read the new resolved SHA from the lockfile as `$NEW_SHA`. Then:
   - If `$OLD_SHA` and `$NEW_SHA` are the same, tell the user "you're already at `$NEW_SHA`, no upstream changes" — and skip to the no-op exit (after still running the post-update sanity check in step 9).
   - If they differ, fetch the changelog: try `gh api repos/ziyadakl/sandcastle-loop/compare/$OLD_SHA...$NEW_SHA --jq '.commits[] | "- " + (.sha[0:7]) + " " + (.commit.message | split("\n")[0])'` (falls back to `git log --oneline` if `gh` isn't available and a clone exists). Print the commit list to the user in plain English with a one-line summary per commit.
   - If the user passed an argument (a symptom they're trying to fix), grep the changelog for keywords from it and surface any matching commits explicitly: "your symptom mentions X; these upstream commits look related: ...".
   - If `gh` is unavailable and no clone exists, point the user at `https://github.com/ziyadakl/sandcastle-loop/compare/$OLD_SHA...$NEW_SHA` so they can read the changelog in the browser.

3. **Fetch and verify the source tree.** The npm/pnpm/yarn registry mangles dotfiles when packaging a `github:` dep (notably `.gitignore` is renamed to `.npmignore`), so `node_modules/sandcastle-loop/.sandcastle/` is NOT a faithful copy of the source repo. Pull a clean tarball directly from GitHub at `$NEW_SHA`:

   - `TMPDIR=$(mktemp -d)`; `TARBALL="$TMPDIR/src.tar.gz"`.
   - Primary fetch: `gh api repos/ziyadakl/sandcastle-loop/tarball/$NEW_SHA > "$TARBALL"` (gh follows the 302 to codeload and streams the binary tarball — do not pipe through any JSON tooling).
   - Fallback if `gh` is unavailable: `curl -fsSL "https://github.com/ziyadakl/sandcastle-loop/archive/$NEW_SHA.tar.gz" -o "$TARBALL"`.
   - Extract: `tar -xzf "$TARBALL" -C "$TMPDIR"`. GitHub tarballs unpack into a single top-level directory named `ziyadakl-sandcastle-loop-<short-sha>/`; locate it with `EXTRACTED=$(find "$TMPDIR" -maxdepth 1 -type d -name 'ziyadakl-sandcastle-loop-*' | head -1)`.
   - **Source-side path guard.** Assert `$EXTRACTED/.sandcastle` resolves to a path inside `$TMPDIR` (no symlinks escaping the extraction root). **Resolve BOTH sides before comparing** — this is not optional pedantry:

     ```
     REAL_TMP=$(realpath "$TMPDIR")
     REAL_SRC=$(realpath "$EXTRACTED/.sandcastle")
     case "$REAL_SRC" in "$REAL_TMP"/*) : ;; *) abort ;; esac
     ```

     Comparing `realpath`'d output against the raw `$TMPDIR` **fails on every Mac**: `mktemp -d` returns `/var/folders/...`, but `/var` is a symlink to `/private/var`, so `realpath` returns `/private/var/folders/...`. The two strings never share a prefix and the guard trips on a completely legitimate extraction. Verified on macOS 2026-07-17.

     If the resolved source really is outside, abort, `rm -rf "$TMPDIR"`, and tell the user the tarball failed the safety check.

     **If this guard fires, do NOT wave it through as "probably the Mac symlink thing."** Fix the comparison to resolve both sides, then re-run it. A guard that a human learns to override on sight is worse than no guard — the whole point is that the one time it's real, it still gets believed.
   - **Dotfile canary.** List dotfiles under `$EXTRACTED/.sandcastle/` (`find "$EXTRACTED/.sandcastle" -maxdepth 2 -name '.*' -type f`). The list MUST be non-empty AND MUST include `.gitignore`. If `.gitignore` is missing, the strip-bug is back (or the upstream commit really deleted it — extremely unlikely). Abort with: "fetched tarball is missing `.sandcastle/.gitignore`; refusing to proceed because copying from this source would silently delete files. Inspect `$EXTRACTED/.sandcastle/` and report this." Run `rm -rf "$TMPDIR"` before aborting.
   - If everything checks out, `$EXTRACTED/.sandcastle/` is now the source of truth for steps 4 and 6.
   - Cleanup discipline: `$TMPDIR` is removed in the final action of step 12, and on every abort path after this step succeeds.

4. **Diff the template.** Walk `$EXTRACTED/.sandcastle/` recursively. For each entry, classify as one of:
   - **NEW** — path doesn't exist in the project's `.sandcastle/` at all (e.g. `variants/` on a project that pre-dates the variants system). These will be created.
   - **CHANGED** — path exists on both sides but content differs.
   - **UNCHANGED** — content is byte-identical.

   Skip these entries entirely from both sides of the diff (never report, never copy, never delete): `.env`, `logs/`, anything matching `*.bak` or `*.bak-*`.

   **`hosts.json` — never copy, never overwrite, never delete.** Treat it exactly like `.env`.

   The template no longer ships it: it is gitignored upstream (`.sandcastle/.gitignore`) precisely so it cannot reach this diff, and `hosts.example.json` ships in its place. So in the normal case there is nothing here to skip — this rule is the backstop for the day someone re-tracks it.

   It must never be copied because it is **per-machine**: it holds the absolute path to each checkout ON each host, correct for one machine and wrong for every other. While it WAS tracked, this step copied the template repo's own `hub` entry (`repoPath: /home/deploy/dev/sandcastle-loop`) over each consumer's registry, silently pointing their remote commands at the wrong repo. That surfaces later as a baffling host failure, not as a bad update — which is why it gets a named rule rather than a line in the skip list.

   `hosts.example.json` IS safe to copy normally (NEW or CHANGED) — it is inert placeholder text by design.

   Build two lists: the NEW set and the CHANGED set. Don't show UNCHANGED.

5. **Warn the user.** Show both lists (NEW first, then CHANGED). Make clear that CHANGED entries will overwrite anything the user has customized. Get explicit OK before continuing. If both lists are empty, tell them everything is already up to date and exit.

6. **Copy the new files.** For each entry in NEW ∪ CHANGED:
   - **Paranoid path guard (run BEFORE every write).** Resolve the target path relative to the project root. It MUST be inside `.sandcastle/` — i.e., the resolved path starts with `<project-root>/.sandcastle/` and contains no `..` segments that escape that directory. **Resolve both sides (`realpath`) before comparing**, for the same reason as step 3's guard: comparing a resolved path against an unresolved root produces false trips the moment any component of the project path is a symlink. If the target genuinely resolves outside `.sandcastle/` (e.g. would write to `SANDCASTLE.md` at the project root, `.env`, or any other root-level file), ABORT the entire copy phase, do not write anything further, and tell the user: "safety check tripped — target path `<offending-path>` is outside `.sandcastle/`. Update halted. This indicates a regression in the diff logic; please report it." This is belt-and-suspenders against future template/diff changes accidentally pointing at root-level files.
   - If it's a regular file, copy it (creating parent dirs as needed).
   - If it's a directory, copy it recursively (e.g. `cp -R "$EXTRACTED/.sandcastle/variants" .sandcastle/variants`).
   - Skip `.env`, `logs/`, `*.bak`, `*.bak-*` (same as step 4).
   - Never write `hosts.json` (step 4's rule). It shouldn't reach here at all now that it's gitignored upstream; this is the belt-and-suspenders half, because the cost of getting it wrong is a silently mis-pointed host registry.

7. **Re-run init's package.json injection step.** The template may have new devDeps the project needs. Read `node_modules/sandcastle-loop/package.json`'s `devDependencies` for the wanted set; add anything missing to the project's `package.json` (alphabetically sorted). (Reading `package.json` from `node_modules` is fine — npm pack preserves `package.json` intact; the dotfile-mangling bug doesn't apply here.)

   **Also ensure the `sandcastle:*` launcher scripts exist.** The synced `.sandcastle/` payload now ships the `sandcastle-watch` viewer at `.sandcastle/watch/`, but the npm script that runs it lives in `package.json` (which is otherwise untouched). Ensure these entries are present in the project's `package.json` `scripts` block, adding any that are missing (do not overwrite a value the user customized to a different path):
   - `"sandcastle:watch": "tsx .sandcastle/watch/sandcastle-watch.tsx"`
   - `"sandcastle:check-upstream": "tsx .sandcastle/scripts/check-upstream.mts"`

   Both target files are inside `.sandcastle/` (already synced this run), so this only adds a launcher entry — it never copies a file outside `.sandcastle/`. This is why a project that updates gets the viewer's source + its `ink`/`react` devDeps (from the devDeps injection above) AND a working `pnpm sandcastle:watch`.

8. **Run install.** Pull the new deps with the right manager command.

8a. **pnpm-11 build-approval guard (pnpm only).** pnpm 11 makes `pnpm install` exit non-zero when a dependency has an unapproved build script (sandcastle's `tsx` pulls in **esbuild**), and `pnpm exec`'s deps-status precheck treats that as fatal — bricking `pnpm exec` (step 9's assembly runs `pnpm exec tsx`) and `pnpm sandcastle` (the loop won't start). Existing projects that were set up before this guard existed will hit it now. Verify `pnpm exec tsx --version` and check `$?` on its own line (don't trust a piped/tailed exit code). If it fails with `ERR_PNPM_IGNORED_BUILDS`, run `pnpm approve-builds esbuild` (approve any other flagged packages too), then re-verify exit 0. Ensure the resulting `pnpm-workspace.yaml` is **committed, not gitignored** — the loop's per-iteration `pnpm install` runs in a git worktree that only sees tracked files, so a gitignored approval re-triggers the bug in-sandbox. Idempotent; a no-op on pnpm versions that don't gate build scripts.

9. **Replay the active profile (or initialize one if migrating).**

   - **Case A — `$ACTIVE` is non-empty AND `.sandcastle/variants/$ACTIVE/` exists.** Replay the swap:
     - Compute **has_dockerfile**: does `.sandcastle/variants/$ACTIVE/Dockerfile` exist?
     - **When has_dockerfile is true** (Docker-based variant like `minimal` / `playwright` / `agent-browser`): `cp .sandcastle/variants/$ACTIVE/Dockerfile .sandcastle/Dockerfile` (Dockerfile is a full-file override per variant).
     - **When has_dockerfile is false** (host-native variant such as `mac-host`): skip the Dockerfile copy entirely. Any existing `.sandcastle/Dockerfile` left over from a prior Docker variant stays in place but is inert under host-native sandboxing — same convention as `/sandcastle-profile` step 9. Doing the unconditional `cp` here would fail outright on `mac-host` because the variant ships no Dockerfile.
     - Run the assembly script from the project root, using the package manager detected in step 3:
       - pnpm: `pnpm exec tsx .sandcastle/scripts/assemble-variant.mts $ACTIVE`
       - npm: `npx tsx .sandcastle/scripts/assemble-variant.mts $ACTIVE`
       - yarn: `yarn tsx .sandcastle/scripts/assemble-variant.mts $ACTIVE`
       - Plain `tsx ...` will fail — `tsx` is a devDependency, not a global install.
     - The script applies the variant's overrides to the freshly-pulled base prompts and atomically writes the assembled active prompts.
     - Write `$ACTIVE` back to `.sandcastle/profile`. Then write `.sandcastle/.sandbox-flag` — `docker` when **has_dockerfile** is true, the variant name (e.g. `mac-host`) when false. Mirrors `/sandcastle-profile` step 10b. This closes the silent-fallback bug where an update on a mac-host project would leave no flag and the wrapper would default back to docker.
     - Tell the user: "restored your active profile (`$ACTIVE`) — base prompts re-assembled with your variant's overrides; run `/sandcastle-profile $ACTIVE` only if you want to also rebuild the docker image."

   - **Case B — `$ACTIVE` is empty AND the project just received `.sandcastle/variants/` for the first time (pre-variants migration).** Step 4 will have copied the variants/ dir AND overwritten the active flat files with the package's defaults (which are playwright). To leave the project in a coherent state, write `playwright` to `.sandcastle/profile` so future `/sandcastle-profile` calls have a recorded baseline. Also write `docker` to `.sandcastle/.sandbox-flag` (playwright is a Docker-based variant, so the flag matches). Tell the user: "your project predated the profile system; you've been put on the `playwright` profile by default. Switch any time with `/sandcastle-profile minimal` or `/sandcastle-profile agent-browser` if you'd prefer a different stack, or `/sandcastle-profile mac-host` if your workload needs direct host access instead of Docker."

   - **Case C — `$ACTIVE` is non-empty BUT `.sandcastle/variants/$ACTIVE/` does NOT exist (variant was renamed/removed upstream).** Skip the replay, leave `.sandcastle/profile` containing `$ACTIVE` for transparency, and tell the user: "your recorded profile `$ACTIVE` is no longer in the template's variants. Active files now reflect the template default. Re-pick a profile via `/sandcastle-profile <name>`."

   - **Case D — `$ACTIVE` is empty AND `.sandcastle/variants/` still doesn't exist after step 4** (template doesn't ship variants — shouldn't happen with current versions but cover it). Skip silently.

10. **Post-update sanity check.** Run `node --check .sandcastle/main.mts` (or `tsc --noEmit` if the project has a tsconfig that includes `.sandcastle/`). If it fails, tell the user the update produced a syntactically broken file and recommend a rollback (`git restore .sandcastle/`). Do not declare success on faith.

11. **Post-update label preflight.** Template updates can add new required labels (e.g. `merged-to-staging` was added in the staging-mode upgrade — projects that init'd before that release won't have it, and the post-merge path crashes when it tries to apply a label the repo doesn't recognize). Re-run the canonical-label check from `/sandcastle-init`:

   ```
   gh label list --json name --limit 200
   ```

   Compute the missing subset against the canonical 6: `ready-for-agent`, `in-progress`, `done`, `needs-human`, `merged-to-staging`, `quarantine`. If the set is non-empty, offer to create them — this is the one exception to the "init creates labels, update doesn't mutate the remote" rule, because a template update is precisely the moment new labels appear. Tell the user: "the new template requires these labels that don't exist on your repo yet: `<comma-list>`. Want me to create them now? (Same defaults as `/sandcastle-init`.)" Wait for explicit OK before running `gh label create`. If the user declines, warn that the loop will fail on the path that needs the missing label and continue.

   If all 6 are present, print one line ("labels OK — all 6 canonical present") and continue.

12. **Write the last-update marker.** Overwrite `.sandcastle/.last-update` with:

   ```
   sha: <NEW_SHA>
   previous_sha: <OLD_SHA>
   updated_at: <ISO timestamp>
   hostname: <hostname>
   ```

   This is the source of truth for future `/sandcastle-update` and `/sandcastle-feedback` calls to answer "what changed since I last updated?"

   Then unconditionally `rm -rf "$TMPDIR"` to clean up the fetched source tree. Also run this cleanup on every abort path triggered after step 3's fetch succeeded (sanity-check failure, label-preflight abort, copy-phase path-guard abort, etc.) — the temp dir should never outlive the run.

## Output to user

Required output structure (every field must be present — missing field = visible gap):

- **Before/after SHA:** `OLD_SHA → NEW_SHA` (or `unchanged`).
- **Changelog summary:** plain-English summary of the upstream commits since OLD_SHA, or "no upstream changes."
- **Files changed locally:** NEW count + CHANGED count, with short list of names.
- **Sanity check result:** pass / fail, with the command run.
- **Label preflight result:** "all 6 canonical present" / "created N missing labels: `<list>`" / "user declined to create missing: `<list>`".
- **Last-update marker:** confirm written, with path.
- **Scope confirmation (always print on success, both no-op and changed cases):**
  - "Pulled template changes into `.sandcastle/`."
  - "Your `SANDCASTLE.md` at project root was untouched (skill discipline rules are project-owned)."
  - If `.sandcastle/hosts.json` existed, always say it was preserved and NOT overwritten, and print the `repoPath` you observed for each remote host so the user can eyeball that it still points at their checkout. This file is the one place an update can silently break multi-host runs, and a wrong `repoPath` surfaces later as a confusing host failure rather than a bad update — so it gets named explicitly, every run, not just when something changed.
  - If any `sandcastle:*` script was added to `package.json`, name it (e.g. "Added the `sandcastle:watch` script so the relocated viewer is runnable."). If none were added, say nothing.

If nothing changed, still print the SHA, the sanity check result, and "no-op." Never just say "already up to date" with no evidence.
