---
name: sandcastle-run
description: Start the sandcastle autonomous coding loop — on one machine or across multiple machines / all my hosts / this Mac + the VPS as one combined run. Use when the user wants to kick off the overnight loop or invokes /sandcastle-run, whether on this machine only or fanned out to every healthy host. Detects package manager, refuses to run on protected branches, then plans the run and ASKS the launch questions before spending anything — which machines, concurrency, and mode — in one batched picker, skipping only what the user's flags already answered. All-machines plans once then launches the same branch/mode/iterations on each host from the registry with per-host concurrency, skipping any host with a reason.
---

# Sandcastle Run

Starts the orchestrator — either on **this machine only** or across **all machines** in the host registry as one combined run sharing a single GitHub queue.

## This machine, or all machines?

Work out which path you're on. Both paths share the planning stage, so if the answer is genuinely unknown you do NOT need it to start planning — you need it before you LAUNCH, which is exactly where the §7 picker asks it. Never let "I need to get moving" become a reason to guess it.

- **Single machine** — run the loop right here. Everything in this skill except the "All machines" fork applies. Choose this when the user named just this one machine.
- **All machines** — plan the run **once** locally, then fan the identical plan out to every healthy host (or one you pick) via the launch gate, so the machines act as a single combined loop over the same queue. Choose this when the user's phrasing implies more than one machine — "all my hosts", "across my machines", "this Mac + the VPS", "everywhere", "run-all", etc.

**Silence is NOT an answer — it is the absence of one.** A bare `/sandcastle-run` does not tell you which machines to use, so you do not know. Resolve it in this order:

1. The user's flags (`--host`, `--all`) or explicit phrasing named the target → that's the answer, don't ask.
2. `.sandcastle/hosts.json` lists exactly one host (or is missing) → single machine, don't ask.
3. Otherwise (registry has 2+ hosts and nothing named a target) → **you must ask.** Carry it as the **Machines** question in the §7 batched picker: `this machine only (default) / all healthy hosts / pick one host`. Do not infer it, and do not default to single machine — guessing here silently deletes the concurrency question too (§7a), so one wrong inference costs the user both.

The two paths **share the planning stage** (group issues, pick base, name+fork the run branch, size iterations, pick mode) — plan once regardless. They differ only at launch: single-machine launches locally via the wrapper (see *Run*); all-machines pushes the branch and fans out via the launch script (see *Launch across all machines*). When you're on the all-machines path, also run the **All-machines preconditions** below before launching.

## Producing work for the loop

The orchestrator's dispatch contract: an issue must carry **both** `ready-for-agent` AND a `type:X` label. The `type:X` half is what the skill-discipline gate keys on.

The user-facing pipeline that ends in eligible issues is (currently) `/grill-me` or `/grill-with-docs` → `/to-prd` → `/to-issues` → `/triage-plus-skills`. The first three "shape the work" and are owned by their upstream authors — don't assume their specific label outputs, they can change. Only the last step is non-substitutable: **`/triage-plus-skills` is the only skill that stamps `type:X`**, so it is required regardless of what the earlier steps produce. Bare `/triage` is not enough.

If `/sandcastle-run` is invoked with no eligible issues, point the user at this pipeline before starting the loop.

## Output discipline (READ FIRST — this governs everything below)

`/sandcastle-run` is a **run command, not a research report**. The user wants it to launch, not to watch you think. Obey this the whole way through:

- **Run every pre-flight check silently.** Do NOT narrate checks as you do them — no "Let me check…", no "Hold on…", no "Found it — line 143…", no play-by-play of shell commands. A passing check produces **zero** user-facing text.
- **Speak only when a check FAILS or BLOCKS**, or when you must ask the launch questions (§7 picker). A block gets one short plain-English line: what's wrong + the one command to fix it. Nothing else.
- **When you hit a surprise** (an unexpected process, a missing script, a contradiction) — investigate it silently and act. Do not report the investigation. The user does not need your reasoning; they need the outcome.
- **The ONLY narration the user sees on a clean run** is the launch questions (§7 — they are not optional, see there) and the final launch summary (§8) — a few short lines. Everything between "invoked" and "launched" is silent unless it blocks.

If you catch yourself typing a sentence that explains a check that passed, delete it.

## Pre-flight checks

1. **Initialized?** If `.sandcastle/main.mts` doesn't exist in cwd, tell the user to run `/sandcastle-init` first and stop.

2. **API keys reachable? — mode-dependent.** The orchestrator loads keys from a chain — first hit per-key wins:
   1. `process.env` (shell exports — always wins)
   2. `$SANDCASTLE_ENV_FILE` if set
   3. `<repoRoot>/.env` (project-local override)
   4. `$XDG_CONFIG_HOME/sandcastle/.env` or `~/.config/sandcastle/.env` (host-level default)

   **Which key (if any) is required depends on the chosen mode (§7b) — check only the one that applies:**
   - `claude` (default — no `--provider`/`--backend`): uses the local Claude subscription. **No API key needed — skip this check entirely.** (This is the common case; requiring a key here is a false alarm that blocks the default run.)
   - `codex` (`--backend codex`): uses Codex's own auth, not one of these keys. **Skip this check** (codex auth is validated on its own path).
   - `--provider kimi` → require `KIMI_API_KEY`.
   - `--provider glm` → require `GLM_API_KEY`.
   - `--provider anthropic` → require `ANTHROPIC_API_KEY`.

   When a key IS required, confirm it resolves from at least one source. Quick shell test (substitute the required var):
   ```
   ( source "$HOME/.config/sandcastle/.env" 2>/dev/null; \
     source "<repoRoot>/.env" 2>/dev/null; \
     test -n "$KIMI_API_KEY" )   # ← swap KIMI_API_KEY for the mode's required var
   ```
   If the required key doesn't resolve, tell the user to create `~/.config/sandcastle/.env` (recommended, set once for all projects) or `<repoRoot>/.env` (project-only), using `.sandcastle/.env.example` as a template, then stop. When creating `~/.config/sandcastle/.env`, `mkdir -p ~/.config/sandcastle && chmod 600 ~/.config/sandcastle/.env`.

   **Refresh `GH_TOKEN` if needed** (handles macOS Keychain storage + token rotation). On macOS `gh auth login` stores the token in the system Keychain, so the sandbox mount of `~/.config/gh/hosts.yml` doesn't carry a usable token and `gh issue list` inside the container returns 401. Before launching the loop:
   - Confirm `gh auth status` succeeds. If not, tell the user to `gh auth login` first and stop.
   - Check `~/.config/gh/hosts.yml` for an `oauth_token:` line. If present, the mount alone is sufficient — skip extraction.
   - Otherwise, run `gh auth token`. If it returns a token AND none of the env sources above resolve `GH_TOKEN`, append `GH_TOKEN=<token>` to `~/.config/sandcastle/.env` (creating the dir + `chmod 600` if new). Prefer the host-level location so every project benefits. (Don't clobber an explicit user value.)
   - If `GH_TOKEN` already resolves from any source, leave it alone; the user can edit manually if they rotated the token.
   - Both `.sandcastle/.gitignore` and any `.env` file under `<repoRoot>` should already be git-ignored — verify before writing.

3. **Branch check.** Two gates here:
   - **Current branch.** Get the current git branch. If it's `main` or `master`, refuse and tell the user to switch to a feature branch.
   - **`--branch` flag value.** Independent of current branch: if the user's flags include `--branch main` or `--branch master`, refuse. The orchestrator targets the value passed to `--branch`, not the current branch, so a feature-branch cwd does not make `--branch main` safe.

   **Common misreading.** If a recent commit appears on `main`, do not infer that `--branch main` was the mechanism. The pipeline puts merges on `main` via staging→main promotion or via PR, never via the orchestrator targeting `main` directly. Check the commit's actual provenance (PR number, branch lineage) before citing it as proof a flag worked.

4. **Sandbox runtime preflight.** First detect which runtime the active profile needs, then run the matching preflight.

   Read `.sandcastle/.sandbox-flag` (single bare line: `docker` or `mac-host`). If the file is missing, default to `docker` — that matches sandcastle's wrapper fallback. Also read `.sandcastle/profile` for the human-readable profile name (used in messages only). Store the value as `sandbox_runtime`.

   **When `sandbox_runtime == "docker"`** — the orchestrator's sandboxes need a Docker-compatible runtime. Check in this order:
   - `docker ps` — succeeds if Docker Desktop or OrbStack is running (OrbStack provides the `docker` CLI)
   - `podman ps` — succeeds if Podman machine is running
   - `colima status` — succeeds if Colima is running

   If none respond, tell the user "no container runtime is running" and recommend starting their installed one. If nothing is installed, point at `/sandcastle-init` which has the install recommendations (OrbStack first on Mac).

   **When `sandbox_runtime == "mac-host"`** — the loop runs host-native (no Docker needed). Run the same preflight `/sandcastle-profile` uses at step 8. **First classify the target** by inspecting the project root (cwd), then run the matching branch — do NOT run the iOS branch unconditionally (a macOS-GUI SwiftPM app builds with `swift` and needs no Xcode/simulator; refusing it on `xcodebuild` is a false positive):
   - If a `Package.swift` exists **and** there is **no** `.xcodeproj` or `.xcworkspace`, treat it as a **macOS-GUI SwiftPM target** → run the **SwiftPM preflight**.
   - Otherwise (an `.xcodeproj`/`.xcworkspace` is present, or no `Package.swift`), treat it as an **iOS / Xcode target** → run the **iOS preflight**.

   **iOS preflight:**
   - Run `xcodebuild -version`. If it fails (non-zero exit or command not found), **refuse** with: "Xcode not installed or command-line tools not selected" and stop.
   - Run `xcrun simctl list devices available | grep -q .`. If it fails (no output / non-zero exit), **refuse** with: "no iOS Simulator runtime installed — run `xcodebuild -downloadPlatform iOS`" and stop.
   - If both pass, continue.

   **SwiftPM preflight** (macOS-GUI SwiftPM app — no full Xcode / simulator required, since the mac-host executor only needs `git` + PATH + `swift`):
   - Run `swift --version`. If it fails (non-zero exit or command not found), **refuse** with: "the Swift command-line toolchain isn't available — run `xcode-select --install`" and stop.
   - Confirm `Package.swift` still exists at the project root. If it's gone, **refuse** with "no `Package.swift` found — this doesn't look like a SwiftPM project" and stop.
   - Do **not** run `xcodebuild` or `xcrun simctl` for this case. If it passes, continue.

4b. **Project's sandcastle image built? (Docker runtime only.)** Skip this step entirely when `sandbox_runtime == "mac-host"` — there is no docker image to build, the Dockerfile is inert under host-native sandboxing.

   The loop's iteration 1 fails immediately with `Image 'sandcastle:<name>' not found locally` if the named docker image doesn't exist. Common on fresh worktrees or after `docker prune`. Catch it here, auto-build to fix it.

   - Derive the expected image name. If the user passed `--image-name NAME` in their flags, use that. Otherwise the orchestrator default is `sandcastle:<basename of repo-root>` (e.g. `~/Dev/myproj` → `sandcastle:myproj`).
   - Check existence: `docker image inspect <image-name> > /dev/null 2>&1`. Exit 0 = exists; non-zero = missing.
   - **If the image exists**, continue.
   - **If missing**, build it before launching the loop:
     ```
     <pkg-mgr-bin>/sandcastle docker build-image --image-name <image-name> --dockerfile .sandcastle/Dockerfile
     ```
     Where `<pkg-mgr-bin>` is `node_modules/.bin` for npm/pnpm/yarn projects. Build takes ~30s and produces a ~750MB image. Stream output to the user so they see progress; don't background it (pre-flight must complete before launch).
   - If the build fails (Dockerfile syntax error, network issue), bubble the build's stderr verbatim and stop. Don't continue to launch — iteration 1 will just fail the same way.
   - On success, log "built `<image-name>` (Dockerfile=.sandcastle/Dockerfile)" and continue.

4c. **`.sandcastle/` prompt files committed to git? — `mac-host` ONLY. SKIP this entire step under docker.** This gate is **runtime-specific**, and applying it to docker is a false-positive that refuses working repos.

   - **Under `docker`** (`sandbox_runtime == "docker"`): **skip — do not run the check.** The orchestrator reads each prompt file from the **host launch root** (`process.cwd()`), not from inside the worktree — the SDK resolves `promptFile` against `process.cwd()` (verified: `@ai-hero/sandcastle` `index.d.ts` "`promptFile` is always resolved against `process.cwd()`"; `main.mts` preflight also checks them at `<repoRoot>/.sandcastle`). So a gitignored `.sandcastle/` runs perfectly — which is the **normal, template-default docker setup**. Requiring a commit here would refuse a healthy repo (this is the career-ops regression: a long-working docker repo that gitignores `.sandcastle/` by design).
   - **Under `mac-host`** (`sandbox_runtime == "mac-host"`): run the check below. The host-native executor reads the prompt from **inside the per-issue worktree** (`lib/mac-host-sandbox.ts` `spawnAgent(wtPath, …)` → `path.join(wtPath, promptFile)`), and worktrees cut from HEAD carry **only tracked files** — so here `.sandcastle/` genuinely must be committed or the implementer dies mid-run with `prompt file not found: .../worktrees/agent-issue-N/.sandcastle/implement-prompt.md`.

   mac-host check:
   ```
   git ls-files --error-unmatch .sandcastle/implement-prompt.md >/dev/null 2>&1; echo $?
   ```

   Exit `0` = tracked, continue. Non-zero = untracked (or `.sandcastle/` was never committed). **Refuse** with: "on the `mac-host` profile the loop reads prompts from inside each per-issue worktree, which carries only git-tracked files — and `.sandcastle/` isn't committed, so the implementer would fail with `prompt file not found`. Commit the tooling first: `git add .sandcastle/ && git commit -m \"chore: track sandcastle tooling\"` — your `.env` stays excluded via `.sandcastle/.gitignore` (verify with `git status --porcelain .sandcastle/.env` showing nothing staged). Then re-run." Do not auto-commit into the user's product repo — committing tooling into their repo is their call; surface it and stop.

5. **Canonical labels present?** The orchestrator writes `ready-for-agent`, `in-progress`, `done`, `needs-human`, `merged-to-staging`, and `quarantine` — and crashes the claim path (or post-merge path, for `merged-to-staging`) if any are missing. This is normally handled at `/sandcastle-init`, but they can drift (a user deletes one, a fresh re-init was skipped, an upstream template added a new required label that the user hasn't re-init'd to pick up, etc).

   ```
   gh label list --json name --limit 200
   ```

   Compute the missing subset against the canonical 6. If the set is empty, continue. If not, list them and stop with:

   "missing canonical labels: `<comma-list>`. Run `/sandcastle-init` to recreate them, or create manually with `gh label create <name>` — colors don't matter to the orchestrator, only the names."

   Don't auto-create here — pre-flight should fail fast and surface the drift, not silently mutate the remote during a run command. Init is the place for creates.

6. **Loop already running — FOR THIS PROJECT?** A bare `pgrep` on `.sandcastle/main.mts` is **project-blind**: every sandcastle loop on the machine has the identical command line (`tsx .sandcastle/main.mts …`), so it matches loops in *other* repos too. Reporting "a loop is already running" because a **different** project's loop is alive is a false positive that blocks a legitimate launch (and the mirror mistake — a monitor keyed to the same broad pattern — will latch onto the wrong project's PID and kill/wait on it). Scope the match to **this repo** by the process's working directory.

   Get candidate PIDs, then keep only those whose cwd is this repo root (`$PWD`):
   ```
   for pid in $(pgrep -f '\.sandcastle/main\.mts (--iterations|--issue|--max-concurrent|--repo-root|--branch)'); do
     cwd=$(lsof -a -d cwd -p "$pid" -Fn 2>/dev/null | sed -n 's/^n//p')
     [ "$cwd" = "$PWD" ] && echo "$pid"
   done
   ```
   (A loop launched with `--repo-root <other>` runs from a different cwd, so cwd-matching is the reliable discriminator; if the user passes `--repo-root` explicitly, compare against that path instead of `$PWD`.) If a PID survives the filter, THIS project's loop is already alive — tell the user and offer `/sandcastle-stop` first. If the only matches are other projects' loops, they are irrelevant — **continue silently** (per Output discipline; do not report other projects' loops as a blocker).

7. **One-shot label sanity check (only when `--issue N` is in the args).** The orchestrator's `claim()` flips `ready-for-agent` → `in-progress`; running on an issue that isn't currently `ready-for-agent` will silently no-op the flip or throw mid-stream. A previously-crashed run can leave an `in-progress` label orphaned on the issue, which looks identical from the agent's side until it tries to claim. Catch it here.

   If the user's flags include `--issue N` (parse N as a positive integer; reject otherwise with "invalid `--issue` value"), run:

   ```
   gh issue view <N> --json number,state,labels
   ```

   Then check the JSON:

   - **gh command failed?** Bubble the gh error verbatim and stop. Don't try to be clever — could be auth, network, or a typo'd issue number, and the user needs to see which.
   - **`state` != `OPEN`?** Stop with: "issue #N is `<state>` (closed/merged/etc.) — sandcastle only runs on open issues. Re-open it on GitHub if you want to retry."
   - **`labels` includes `in-progress`?** Stop with: "issue #N still has the `in-progress` label — likely orphaned from a prior crashed run. Remove the label on GitHub (or `gh issue edit <N> --remove-label in-progress`), confirm `ready-for-agent` is set, then re-run."
   - **`labels` does NOT include `ready-for-agent`?** Stop with: "issue #N isn't labeled `ready-for-agent` — sandcastle only claims issues with that label. Add it on GitHub (or `gh issue edit <N> --add-label ready-for-agent`) and re-run."
   - **All three checks pass?** Continue to package manager detection.

   If `--issue` is not in the args (planner mode), skip this step entirely — the planner has its own claimable-set logic.

8. **Planner-mode claimable-set sanity (only when `--issue N` is NOT in the args).** Mirror of step 7 for the planner path. Run:

   ```
   gh issue list --state open --label ready-for-agent --json number,title,body,labels --limit 100
   ```

   (`labels` is fetched so the planning stage below can partition by `type:`.) Checks against the result:

   - **Empty queue?** Stop with: "no open issues labeled `ready-for-agent` — planner has nothing to claim. Use `/triage-plus-skills` to stamp `type:X` and `ready-for-agent` on triaged issues first." Also treat the queue as effectively empty when `SANDCASTLE.md` exists at the repo root AND *every* ready issue is missing a `type:` label — the planner excludes all of them and the loop would exit on iteration 1. Same message.
   - **Under-provisioned?** If `count < iterations × max-concurrent`, warn with: "queue has N issues but the loop is configured for up to iterations × max-concurrent slices — loop may exit early when claimable runs out. Proceed?" Don't refuse — the user may want to launch anyway and let the loop exit cleanly when claimable runs out. **Suppress this warning when the planning stage (*Plan the run* §6) auto-sized iterations** — the over-provisioning is deliberate headroom for issues grilled in mid-run, not a misconfiguration.
   - **Dependency-blocked?** Case-insensitive substring match in title OR body for any of `blocked on #`, `depends on #`, `blocks #`, `blocked by #`, `waiting on #` — a broad operator heuristic. But the planner only ENFORCES the directive **`Blocked by: #N`** (colon required; `Blocked-by:` too), per `.sandcastle/plan-prompt.md` HARD RULE 2 / ADR 0013. The other phrasings — and a bare `blocked by` with no colon — are prose the planner IGNORES: if a match uses one of those, warn that ordering will NOT be honored and to rewrite it as `Blocked by: #N`. For a referenced blocker, the planner treats it as resolved ONLY when it is **closed** (absent from the open-issue list) — NOT merely labeled `done` / `merged-to-staging` while still open. Warn on any still-open blocker with the affected issue numbers — heuristic, not a contract. (Real example: a loop exited at iteration 4 because every remaining slice was blocked on a single unshipped issue.)
   - **Never advise "holding" a blocked issue by removing `ready-for-agent`.** A `Blocked by: #N` issue should stay `ready-for-agent` with the note in its body — the planner auto-excludes it while #N is open and auto-claims it once #N closes (ADR 0013). Unlabeling it to "hold" it defeats the auto-pickup: the planner can't see a label-less issue.

## All-machines preconditions (all-machines path ONLY — refuse loudly if unmet)

Run these only when you're on the all-machines fork. They're in addition to the pre-flight checks above (the branch check especially still applies).

1. **Host registry exists.** Read `.sandcastle/hosts.json`. Each entry is `{ name, transport: "local"|"<ssh-alias>", maxConcurrent, repoPath }`. **`repoPath` is REQUIRED for every remote host** (transport ≠ `"local"`) — the absolute path to the repo checkout on that machine; without it the registry parser refuses the whole file (a non-interactive `ssh <alias>` lands in `$HOME`, not the checkout). It is optional + ignored for the `local` host. If the file is missing, tell the user to create it (seed: `{ "hosts": [ { "name": "local", "transport": "local", "maxConcurrent": 2 }, { "name": "hub", "transport": "hub", "maxConcurrent": 1, "repoPath": "/home/deploy/dev/sandcastle-loop" } ] }`) and stop.
2. **Cross-host flags on, on EVERY host.** The combined run only coordinates if both `SANDCASTLE_CROSS_HOST_LEASE=1` and `SANDCASTLE_CROSS_HOST_SYNC=1` are set (in each host's `.env` / `~/.config/sandcastle/.env`). SYNC-without-LEASE makes the loop refuse to start. If you can't confirm both are set on a host, warn — without them the machines will double-work and won't hand off.
3. **Not on a protected branch** — already covered by pre-flight check 3; it applies here too.

## Plan the run (auto-scoping for bare invocations)

This is the friction-killer. A bare `/sandcastle-run` auto-discovers everything mechanical — surveys the queue, picks a base, names the branch, sizes iterations — so the user never hand-picks a base branch or invents a name. It then asks only the two operational choices the user wants control of (**concurrency** and **mode**), plus **epic-scope** when more than one epic is ready, each with a smart default pre-selected. Discovery is automatic; the handful of real preferences are a couple of taps.

**When this runs.** If the args contain `--issue`, skip this whole section (one-shot mode — go to package-manager detection and run on the current branch). Otherwise, treat any of `--branch` / `--label` / `--iterations` / `--max-concurrent` the user *did* pass as fixed, and auto-derive only the ones they left out. A bare `/sandcastle-run` auto-derives all four.

You already have the claimable set from step 8 (`gh issue list --state open --label ready-for-agent --json number,title,body,labels`). Reuse it — don't re-query.

1. **Filter to dispatchable, then group.** First decide whether skill discipline is on: does `SANDCASTLE.md` exist at the repo root (`test -f SANDCASTLE.md`)?
   - **If it exists**, the dispatch contract needs BOTH labels — an issue runs only if it carries `ready-for-agent` AND exactly one `type:` label. Partition the ready set (you have `labels` from step 8) into **dispatchable** (has a `type:`) and **typeless** (no `type:`). The planner excludes typeless issues and the host re-validates them out (`main.mts` skill-discipline gate, `plan-prompt.md` rule 3), so they will NOT run. Count, group, name, and size using **only the dispatchable set**. **Surface the typeless ones** among §7's inline warnings: "#X, #Y are `ready-for-agent` but missing a `type:` label — they won't be dispatched. Run `/triage-plus-skills` (the only skill that stamps `type:`) or add one by hand." If *every* ready issue is typeless, the dispatchable queue is empty — say so and don't launch.
   - **If `SANDCASTLE.md` is absent**, skill discipline is off and `type:` isn't required — every `ready-for-agent` issue is dispatchable.

   Then **group the dispatchable issues** into epics/themes (strongest signal first): an explicit parent reference in the body (`epic #N`, `parent #N`, `part of #N`), a shared milestone, a shared area label, or a common title prefix / feature noun. Short kebab slug + count per group. One cohesive feature = one group.

2. **Note runnability.** From step 8 you already know which ready issues are `Blocked by: #N` with #N still open — the planner auto-excludes those until #N closes. Carry it per group (e.g. "marketing ×7, 1 blocked by #468").

3. **Pick the base branch.** Skip if the user passed `--branch` (honor theirs; it already cleared the main/master refusal in step 3).
   - Base = the **current branch**, unless it is `main`/`master`.
   - If the current branch IS `main`/`master`, the base is ambiguous → find the integration line and confirm the base with the user before naming the branch:
     ```
     for b in $(git for-each-ref --format='%(refname:short)' refs/heads); do
       case "$b" in main|master) continue;; esac
       echo "$(git rev-list --count main.."$b" 2>/dev/null || echo 0) $b"
     done | sort -rn | head
     ```
     One non-protected branch clearly ahead → propose it. Zero or several plausible → ask the user which base.

4. **Name + create the run branch.** Always a fresh, dated, human-readable branch — this is the "name I can understand" the user asked for, and it keeps an unattended batch off the shared integration line.
   - `theme` = one group → its slug; two groups → `slugA+slugB`; three or more (or no clean grouping) → `queue`.
   - `name = sandcastle/<theme>-$(date +%Y%m%d)`.
   - **If that branch already exists** (`git rev-parse --verify --quiet refs/heads/<name>`), **reuse it** — continue the same batch. This is the relaunch path after a drain (§8). Do NOT suffix `-2`; reusing keeps re-launched work on one branch. Check it out in the launch worktree: `git checkout <name>`.
   - If it doesn't exist, **create it and check it out** in the launch worktree: `git checkout -b <name> <base>`.
   - Pass `--branch <name>` to the loop. **The launch worktree MUST be on `<name>`** — this is load-bearing, not cosmetic. The orchestrator cuts each per-issue worktree from the launch worktree's *current HEAD* (the SDK runs `git worktree add -b <issue> <path> HEAD`, not off `--branch`), and `fastForwardIntegration` advances `<name>` through whichever worktree has it checked out. If the launch worktree is parked on a stale branch, every merged issue re-bases off that stale HEAD and silently re-does the foundation — the layering bug. (Earlier versions of this step created the ref *without* checking out on the theory that the orchestrator bases worktrees on `--branch`; that theory is false — verified in the SDK's `WorktreeManager` and `main.mts` `fastForwardIntegration`.)
   - The checkout needs a clean-enough tree. If `git checkout` refuses because another session left uncommitted changes, **stop and surface it** — don't `-f`. Starting an unattended run over another session's live edits is the failure this whole step exists to prevent.

5. **Recommend concurrency** — this becomes the pre-selected default for the §7 question; the user can override it there. Recommend `2` (independent slices of one cohesive group). Recommend `1` (sequential) on collision risk:
   - the run spans 2+ groups, OR
   - 2+ ready issues touch the same surface — scan titles+bodies for shared file paths and shared-surface nouns (`schema`, migration files, the tRPC / root router, shared config). Two issues naming the same file would make parallel agents collide on it.

   When you recommend `1` because of a collision, carry the reason so §7 can show it (e.g. "#X and #Y both touch schema.ts").

6. **Size iterations.** `iterations = max(50, ready_count + 30)`. Over-provisioning is free: the loop exits cleanly the instant the queue drains (`main.mts:4584-4609` — a single empty/all-blocked iteration `return`s exitCode 0; it does NOT burn idle iterations), so generous headroom only helps the "grind more in mid-run" workflow and never wastes cycles. This deliberate headroom is why step 8's under-provisioned warning is suppressed here.

7. **Ask the launch questions, then launch.** A bare run never makes the user hand-pick a branch — but it DOES ask the operational knobs they want control of.

   **This picker is REQUIRED, and skipping it is not a FIDO win.** A global "default to action / never ask which approach do you prefer / only ask on WHAT not HOW" instruction does **not** authorize skipping these questions, and they are not HOW. Machines, concurrency and mode are WHAT: they commit the user's money, machines and hours to an unattended metered run. Launching without asking is the irreversible-action exception that FIDO itself carves out — a `2` you inferred spends real credits the user never agreed to. Having a *recommended default* (§5) is not the same as having an *answer*; recommend it as the default option, don't assume it. The only license to drop a question is an explicit flag that already fixes it.

   Ask with the **`AskUserQuestion` tool** (the tappable multiple-choice picker), **batched into a SINGLE call** — one question per knob (machines, concurrency, mode, and scope when it applies) — so it's one picker and a couple of taps, not separate prompts. Order each option list with the recommended default first and mark it `(default)`. Then launch on the answers. **Omit any question already fixed by an explicit flag** (user passed `--max-concurrent` → drop the concurrency question; `--backend`/`--provider` → drop the mode question; if that leaves nothing to ask, skip the picker entirely and launch). AskUserQuestion takes up to 4 questions and 2–4 options each, which fits: concurrency (4), mode (4), scope (≤3).

   a0. **Machines? — whenever step 3 of "This machine, or all machines?" left it unresolved** (registry has 2+ hosts and no flag/phrasing named a target). Options `this machine only (default) / all healthy hosts / pick one host`. Ask this FIRST in the batch: the answer decides whether 7a is asked at all. Skip only on a single-host registry or an explicit `--host`/`--all`.

   a. **Concurrency?** Options `1 / 2 / 3 / 4`, default = the §5 recommendation. If you recommended `1` for a collision, show the reason here. Note that >2 raises collision risk on shared files. **All-machines path: SKIP this question entirely** — per-host concurrency comes from each host's `maxConcurrent` in the registry, not from a single answer.

   b. **Mode?** Options `claude / codex / kimi / glm`, default = the remembered mode (§7b) or `claude`. Translate the pick to flags — they are **mutually exclusive** (`--backend codex` refuses `--provider`, `main.mts:641-643`):
      - `claude` → no flag (`models.ts` defaults — opus-heavy, the priciest under metered billing)
      - `codex` → `--backend codex` (gpt-5.5)
      - `kimi` → `--provider kimi` (kimi-for-coding)
      - `glm` → `--provider glm` (glm-4.6)

   c. **Scope? — only when 2+ epics are ready.** Options `both interleaved / <epic-A> only / <epic-B> only`, default `both`. If the user picks one epic, scope the run to it (claim only that epic's issues) and name the branch for that single epic.

   **Surface the warnings inline while asking** (don't make them separate gates) so the choice is informed: a base already resolved in §3, any `Blocked by:` open-issue ordering caveat, and any typeless `ready-for-agent` issues that won't run.

   After the answers: record the chosen mode (§7b), create/reuse the branch (§4), then **fork on the path**: single-machine → launch locally and report (§8); all-machines → go to *Launch across all machines* (push the branch, fan out via the launch script, report per-host) instead of §8.

7b. **Remember the mode** so "ask every time" stays one tap. Read `.sandcastle/.last-run-mode` (single line: `claude`|`codex`|`kimi`|`glm`) for the §7b default; if absent, default `claude`. After the user picks, write their choice back to that file. Ensure it's gitignored — add `.last-run-mode` to `.sandcastle/.gitignore` if not already covered. (Per-project, so different projects can keep different default modes.)

8. **After launch, always tell the user** (plain English):
   - the grouping, base, branch name, concurrency + one-word reason, iterations;
   - alive-check + log path + "run /sandcastle-status to watch" (see Run section);
   - the merge-back command for when they're happy: `git checkout <base> && git merge --ff-only <name>`;
   - the encompass-more reality: *"The planner re-checks `ready-for-agent` every cycle, so anything you grill in mid-run gets claimed automatically — as long as the bucket doesn't fully empty. If it drains to zero the loop exits cleanly by design; just re-run `/sandcastle-run` and it continues on the same branch. (A keep-alive 'drain-wait' mode is a planned follow-up.)"*

## Detect package manager

Same as `/sandcastle-init`:
- `pnpm-lock.yaml` → pnpm
- `yarn.lock` → yarn
- `package-lock.json` → npm

## Defaults

For a bare or partially-flagged invocation, `--branch`, `--iterations`, and `--max-concurrent` come from the planning stage above (*Plan the run*). The static fallbacks below apply only when planning is skipped — i.e. one-shot mode (`--issue N`) or a flag the user passed explicitly:
- `--iterations 50`
- `--max-concurrent 2`
- `--branch <current-branch>`

If the user passed flags (e.g. `/sandcastle-run --iterations 10`), pass them through verbatim; planning fills only the gaps.

## Flags reference

Pass these through verbatim when the user names them. Source of truth is `.sandcastle/main.mts` `--help`.

Required:
- `--iterations N` — outer cycles (≥ 1).

Mode:
- `--issue N` — one-shot: skip planner, work this issue only.
- `--dry-run` — skip claim/quarantine/markDone side effects.

Scope:
- `--repo-root PATH` — working dir (default: cwd).
- `--branch NAME` — base branch (default: current; refuses main/master regardless of current branch).
- `--label NAME` — label to claim (default: `ready-for-agent`).
- `--max-concurrent N` — parallel issues per cycle (default: 3).
- `--image-name NAME` — docker image (default: derived from repo root).
- `--log-file PATH` — tee output.

Models (defaults read from `.sandcastle/models.ts`):
- `--planner-model M`, `--implementer-model M`, `--reviewer-model M`,
  `--merger-model M`, `--post-merge-reviewer-model M`, `--recovery-model M`.

Provider:
- `--provider kimi|glm|anthropic` — overrides implementer for the run. Maps to that provider's default coding model (`kimi-for-coding`, `glm-4.6`, `claude-sonnet-4-6`). Reads `KIMI_API_KEY` / `GLM_API_KEY` from the env chain (see step 2 above; canonical location is `~/.config/sandcastle/.env`). Anthropic uses the local Claude subscription. Default: no override (uses `models.implementer.default`, currently `claude-sonnet-4-6`).

Resilience:
- `--recovery off` — disable the single recovery pass before quarantine. Default: on.
- `--no-retry` — disable per-issue retry ladder (HAS_BLOCKERS triggers one escalated implementer + reviewer pass before quarantine). Default: on.
- `--no-staging` — disable the integration-candidate staging branch and post-merge fix loop; merger writes directly to `--branch`. Default: staging on.
- `--consecutive-failure-limit N` — circuit-breaker threshold (default: 3).

Timeouts:
- `--implementer-timeout-sec N` (default: 1200), `--reviewer-timeout-sec N` (default: 600).

Exit codes: 0 = no claimable / clean finish; 1 = circuit breaker or fatal; 2 = iterations exhausted (still ran fine).

## Run

**The real launcher is the wrapper — `bash .sandcastle/sandcastle-wrapper.sh`.** `sandcastle-init` adds a `sandcastle` package.json script pointing at it (`bin/init.mjs`), so `pnpm sandcastle` / `npm run sandcastle` normally *is* the wrapper. Always launch through the wrapper, never `tsx .sandcastle/main.mts` directly — the wrapper adds two load-bearing things the direct call skips: **hot-reload restart** (exit 75, so a recovery agent's on-disk fix gets picked up) and **`--sandbox` forwarding** from `.sandcastle/.sandbox-flag`.

**Confirm the launcher exists before building the launch line** (silently — see Output discipline): does a `sandcastle` script exist? Check `node --print "require('./package.json').scripts?.sandcastle || ''"` (or just grep `package.json`).
- **Script present** → launch via the package manager (forms below).
- **Script missing** (repo init'd with an older template, or a manually-wired setup — this is the career-ops failure mode: `npm run sandcastle` exits "missing script" and there's nothing to improvise) → do NOT hunt or fall back to `tsx`. Launch the wrapper directly with `node_modules/.bin` on PATH so bare `tsx` inside it resolves:
  ```
  PATH="$PWD/node_modules/.bin:$PATH" bash .sandcastle/sandcastle-wrapper.sh <flags>
  ```
  and add the script so next time is clean: `npm pkg set scripts.sandcastle="bash .sandcastle/sandcastle-wrapper.sh"` (idempotent; works for pnpm/yarn too). Don't announce either of these — a missing script is a silently-handled snag, not a blocker.

Foreground (short test runs), when the script is present:
- pnpm: `pnpm sandcastle <flags>`
- npm: `npm run sandcastle -- <flags>`
- yarn: `yarn sandcastle <flags>`

**Do NOT insert `--` after `pnpm sandcastle` or `yarn sandcastle`** — only `npm run` needs the `--` separator to pass args through. pnpm rejects the stray `--` with an arg-parse error and the orchestrator never starts. The forms above are correct as written; copy them verbatim per package manager.

For background (overnight, default for runs with `--iterations >= 5`):
- **Use a per-project log path**, not a shared `/tmp/sandcastle.log` — a shared file is a cross-project confound (two projects' loops interleave into one log and you can't tell whose planner started). Use `/tmp/sandcastle-<repo-basename>.log` (basename of the repo root). Remember the exact path for the alive-check and the final summary.
- Wrap in `nohup <launch> > /tmp/sandcastle-<basename>.log 2>&1 < /dev/null & disown` — **do NOT prefix `setsid`**. `setsid` does not exist on macOS (the default host); the launch line then fails or, worse, the shell parses it in a way that spawns the loop twice. `nohup ... & disown` already detaches the process so it survives the shell exiting.
- **Capture the launched PID immediately** — `echo $!` right after the `nohup … &` (before `disown`, or grab `$!` into a var). The alive-check keys on THIS PID, never a bare `pgrep` (which is project-blind — see step 6; it will match other repos' loops and give a false "alive"/false "dead" reading). Wait 8 seconds, then confirm with `kill -0 <pid>` (exit 0 = alive) or `ps -p <pid>`.
- Tail the first 30 lines of the per-project log to confirm the planner started.
- Tell the user how to check status: "run /sandcastle-status to check on it". Any monitor you set up must key on this run's log path or captured PID — never `pgrep .sandcastle/main.mts`.

## Launch across all machines (all-machines path)

On the all-machines fork, you've already done the shared planning stage (theme, base, run branch, iterations, mode) and the **All-machines preconditions**. Do NOT launch locally via the wrapper; fan the one plan out through the launch gate instead:

1. **Push the run branch to origin** so every host can fetch it (the launch gate fast-forwards each host onto it). The remote host must be able to check out the run branch.
2. **Pick the targets.** Default = all hosts in the registry. If the user named one (`--host <name>`) or wants one, scope to it. Report which hosts you're targeting.
3. **Launch on each target** via the shared script — per-host concurrency comes from the registry automatically:
   ```
   tsx .sandcastle/scripts/launch.mts --action run --branch <run-branch> --mode <mode> --iterations <n> [--base <base>] [--host <name>]
   ```
   Run once with no `--host` to sweep all hosts, or with `--host <name>` for one. **Dry-run first** with `--dry-run` to show the user the exact command each host would run (especially the remote ssh + detach line) before committing.
4. **Report the per-host outcome** the script prints — one line each: `launched`, or `skipped (<reason>)` where reason is `unreachable / already-running / dirty-tree / diverged / auth-failed / preflight-error`. A skipped host is never forced; tell the user what to fix (e.g. a `diverged` host has local commits not on origin — resolve by hand). The local machine and healthy remotes that launched are now running the same queue. **Never forward credentials to a remote host; each uses its own auth.**

After an all-machines launch: watch the combined view with `/sandcastle-status` (its all-machines branch, or `pnpm sandcastle:watch`) — the viewer fuses all hosts' counts. Stop with `/sandcastle-stop --all` (add `--now` when you must leave immediately — it checkpoints in-flight work first). To bring a stopped machine back into an in-flight run without planning new work, use `/sandcastle-resume`.

## Talking to the user

See **Output discipline** at the top — it governs the whole run. In short: silent through every passing check; the only text on a clean run is the launch picker (if any) and a short final summary.

The final summary (§8) is a few short lines: branch, concurrency + iterations, what's running now, and how to watch it (`/sandcastle-status`). Do NOT recount the pre-flight checks you passed, the processes you inspected, the files you read, or contradictions you resolved along the way — the user asked for a run, not a trace of one. Never dump command output unless something failed. Plain English.
