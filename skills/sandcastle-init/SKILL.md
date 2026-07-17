---
name: sandcastle-init
description: Set up sandcastle-loop in the current project. Use when the user wants to install the autonomous coding loop in a new repo, or when they invoke /sandcastle-init. Detects package manager (npm/pnpm/yarn), runs the right install + init commands, auto-tunes the template based on whether the project needs a browser, recommends a container runtime, and tells the user how to configure the .env file.
---

# Sandcastle Init

Installs `github:ziyadakl/sandcastle-loop` as a devDependency and runs its init command in the current working directory.

## Architecture (read first — do NOT confuse these)

Two packages are involved, and they STACK. They do NOT compete or supersede each other:

- **`@ai-hero/sandcastle`** — the UPSTREAM library. Provides the sandbox runner, docker provider, agent shell, base templates (`blank`, `parallel-planner`, `parallel-planner-with-review`, etc.). Maintained externally on npm.
- **`github:ziyadakl/sandcastle-loop`** (what this skill installs) — the USER'S customized template layer built ON TOP of `@ai-hero/sandcastle`. Adds the GitHub label state machine, drizzle migration auto-applier, verdict parser, multi-issue planner, category-sweep reviewer, third-attempt retry gate, and a heavily customized `.sandcastle/main.mts` (~2700 lines). Maintained at `github:ziyadakl/sandcastle-loop`.

A project's `package.json` will normally have BOTH listed as devDependencies (`@ai-hero/sandcastle` as a transitive dep of `sandcastle-loop`). That is correct. Do NOT assume one is "old" or "superseded by" the other. Do NOT install `@ai-hero/sandcastle` directly via this skill — install `ziyadakl/sandcastle-loop` and the upstream library comes along as a transitive dep.

If you find a project with stale `.sandcastle/` files but no `sandcastle-loop` install, that means the previous installation was uninstalled or never completed — NOT that the project is "on a different stack." Re-init or `/sandcastle-update`, don't tear out and reinstall from `@ai-hero/sandcastle` baselines.

## Steps

1. **Verify the project.** Confirm `package.json` exists in cwd.

   **If `package.json` is missing, check for a macOS-native Swift project before giving up.** The orchestrator is Node-based and needs a host `package.json` to install into, but a macOS-native project (which can only run under the `mac-host` profile — Docker can't build it) legitimately has none. Look in cwd for `Package.swift`, `*.xcodeproj`, or `*.xcworkspace`, and confirm the host is macOS (`uname` = `Darwin`):

   - **None of those markers, or not macOS** → tell the user "this folder doesn't look like a Node project" and stop (unchanged behavior).

   - **A Swift/Xcode marker is present on macOS** → this is a `mac-host` candidate. Explain in plain English: "This is a macOS-native project with no `package.json`. Sandcastle's orchestrator itself runs on Node, so it needs a small tooling `package.json` here to install into — this does NOT make your project a Node project; your real build still runs natively via the `mac-host` profile (`swift build`/`xcodebuild`)." Then:
     - **Scaffold a minimal tooling-only `package.json`** at the repo root via the `Write` tool (never via shell redirection). Contents: `{"name": "<repo-basename>-sandcastle-tooling", "version": "0.0.0", "private": true}` — no `dependencies` yet (the install in step 5 adds `sandcastle-loop`). Use the repo's directory name for `<repo-basename>`, lowercased and sanitized to a valid npm name.
     - **Ask the user: commit or gitignore it?** This tooling `package.json` (plus the `node_modules/` and lockfile that installs create) is Node noise in a Swift repo. Two valid choices — let them pick: (a) **commit** it so `.sandcastle/` config is version-controlled with the repo (recommended if the repo is the single source of truth for the loop config); (b) **gitignore** `package.json`, `node_modules/`, and the lockfile so the Swift repo stays pristine (the loop config then lives only on this machine). If they gitignore, add those entries to `.gitignore` via `Read` + `Edit`/`Write` (never shell redirection).
     - **Record the intent:** this project is `mac-host`-bound. Carry that forward — step 3's package-manager detection will find no lockfile (default to pnpm, or ask), and steps 9–11 select `mac-host` directly instead of a Docker variant (see the carve-out there).
     - Continue to step 2.

2. **Check for prior init.** If `.sandcastle/` already exists:
   - Tell the user it's already initialized
   - Offer to (a) leave it alone, (b) update via `/sandcastle-update` instead, or (c) blow it away and re-init (last option requires explicit user OK)
   - Stop unless user picks (c)

3. **Detect the package manager.** Look at lockfiles in cwd:
   - `pnpm-lock.yaml` → pnpm
   - `yarn.lock` → yarn
   - `package-lock.json` → npm
   - None of the above → ask the user which to use. **Exception:** for a freshly-scaffolded `mac-host` project (step 1's Swift-project path), there's no lockfile yet because the `package.json` was just created — default to **pnpm** (lightest for a tooling-only host) without prompting, unless the user has stated a preference.

4. **Detect workspace mode (pnpm only).** If pnpm AND there's a `pnpm-workspace.yaml` in the project root, use the `-w` (workspace-root) flag for installs.

5. **Install the package.** Run the right command for the detected manager:
   - pnpm workspace: `pnpm add -Dw github:ziyadakl/sandcastle-loop`
   - pnpm standard: `pnpm add -D github:ziyadakl/sandcastle-loop`
   - npm: `npm install --save-dev github:ziyadakl/sandcastle-loop`
   - yarn: `yarn add --dev github:ziyadakl/sandcastle-loop`

6. **Run the init script.** Run the right command:
   - pnpm: `pnpm exec sandcastle-loop init`
   - npm: `npx sandcastle-loop init`
   - yarn: `yarn sandcastle-loop init`

7. **Pull in the new devDeps.** Run the manager's install command:
   - pnpm: `pnpm install`
   - npm: `npm install`
   - yarn: `yarn install`

7a. **pnpm-11 build-approval guard (pnpm only).** pnpm 11 makes `pnpm install` exit **non-zero** when a dependency has an unapproved build script, and `pnpm exec`'s deps-status precheck treats that as fatal — which bricks BOTH `pnpm exec …` and `pnpm sandcastle` (the loop won't start) even though nothing is actually broken. Sandcastle's tsx devDep pulls in **esbuild**, which trips this. Guard against it: after the install, verify `pnpm exec tsx --version` and check `$?` on its own line (a pipe can mask pnpm's exit code — do NOT trust a tailed/piped exit). If it exits non-zero with `ERR_PNPM_IGNORED_BUILDS`, run `pnpm approve-builds esbuild` (pnpm's native command; it writes `allowBuilds: { esbuild: true }` to `pnpm-workspace.yaml`), then re-verify `pnpm exec tsx --version` exits 0. If pnpm flags packages other than esbuild, approve those too. This is idempotent and a no-op on pnpm versions that don't gate build scripts.

   **`pnpm-workspace.yaml` MUST be committed, not gitignored** — even on the scaffolded-Swift path where package.json / node_modules / the lockfile are gitignored as Node noise. This file now carries the `allowBuilds` build-approval (pnpm 11's approval key lives ONLY here — the old `package.json` `pnpm.onlyBuiltDependencies` field was removed in pnpm 11). The loop runs its own `pnpm install` inside a per-iteration git worktree, which contains only **tracked** files (`copyToWorktree` copies only `node_modules`, not this file). If `pnpm-workspace.yaml` is gitignored, the approval never reaches that sandbox install and the loop re-hits `ERR_PNPM_IGNORED_BUILDS` every iteration. So: gitignore the rest of the Node noise if the user wants a clean Swift repo, but **commit `pnpm-workspace.yaml`** (it's tiny config, not noise). If you added it to `.gitignore` in step 1, remove that line.

8. **Auto-handle the `.env` file.** The orchestrator reads keys from a chain — first hit per-key wins:
   1. `process.env` (shell exports)
   2. `$SANDCASTLE_ENV_FILE` if set
   3. `<repoRoot>/.env` (project-local override)
   4. `~/.config/sandcastle/.env` (host-level default — set once, every project + worktree inherits it)

   **Strongly prefer the host-level file** for keys the user wants everywhere (`KIMI_API_KEY`, `GLM_API_KEY`, `ANTHROPIC_API_KEY`, `GH_TOKEN`). Use `<repoRoot>/.env` only for project-specific overrides (e.g. a different `DATABASE_URL`).

   Detect what auth the user already has and act accordingly. The user is assumed to be on a Claude subscription (Pro / Max / Team) and using Claude Code locally:

   - Check `~/.claude/.credentials.json` — if it exists, no `ANTHROPIC_API_KEY` is needed (the orchestrator's docker sandbox mounts the credentials and Claude Code inside the sandbox uses the user's subscription).
   - Run `gh auth status` — if it succeeds, the user is logged in. BUT on macOS `gh` defaults to the system Keychain (`--secure-storage`), which means the token does NOT live in `~/.config/gh/hosts.yml` — only a reference to it does. The sandbox mount of `~/.config/gh/` therefore can't supply the token, and `gh issue list` inside the container returns 401. Detect and patch:
     - Read `~/.config/gh/hosts.yml`. If it contains a line matching `oauth_token:` (any value), the file already carries a usable token — sandbox mount alone is enough. Skip the next step.
     - Otherwise (Keychain-stored token, the macOS default): run `gh auth token` to extract the token. If extraction succeeds, append `GH_TOKEN=<token>` to `~/.config/sandcastle/.env` (creating the dir first: `mkdir -p ~/.config/sandcastle`; set perms after write: `chmod 600 ~/.config/sandcastle/.env`). The orchestrator's docker provider passes `.env` through as container env vars and `gh` honours `GH_TOKEN` when `hosts.yml` lacks one.
     - Only write `GH_TOKEN=` if it doesn't already resolve from any source in the chain (don't clobber an explicit user value).
   - **Decide if `DATABASE_URL` matters via concrete detection.** Don't guess — check disk:
     - If `drizzle.config.ts` exists at repo root, OR any `**/migrations/*.sql` file exists, the project has drizzle migrations and `DATABASE_URL` is REQUIRED. The orchestrator runs migrations post-merge via `applyMigrationsBetween` and refuses to start if it's missing (pre-flight check). Tell the user in plain English: "this project has drizzle migrations — set `DATABASE_URL=postgres://...` in `<repoRoot>/.env` (project-specific, not a host-level secret) before running `/sandcastle-run`. Without it, the loop won't start."
     - If neither marker exists, stay silent. `DATABASE_URL` is not relevant; the migration applier is a no-op for non-drizzle projects.
   - **`KIMI_API_KEY` / `GLM_API_KEY` are optional.** The implementer default reverted to `claude-sonnet-4-6` (commit `a6e4a2f`). Only mention these keys if the user explicitly intends to run `--provider kimi` or `--provider glm` — e.g. they bring it up, or they're being rate-limited on Anthropic and want a fallback. Don't nag users who aren't asking. If asked: `.sandcastle/.env.example` documents the canonical location (`~/.config/sandcastle/.env`); the key itself has to come from kimi.com / glm provider, you can't fabricate it.
   - **Verify any `.env` you write is gitignored.** `<repoRoot>/.gitignore` should list `.env` (the shipped template's parent project usually does, but check). `~/.config/sandcastle/.env` lives outside the repo, so no gitignore concern.

8a. **Ensure canonical GitHub labels exist.** The orchestrator's state machine flips labels (`ready-for-agent` → `in-progress` → `done` / `needs-human` / `quarantine`) but does NOT auto-create them. On a fresh repo only `ready-for-agent` typically exists (the user creates it manually); the rest are easy to forget and cause silent claim failures (the bug: `gh issue edit --add-label in-progress --remove-label ready-for-agent` errors out, but the user is left with 4 issues that lost `ready-for-agent` after the circuit breaker trips).

   Run once to inventory:

   ```
   gh label list --json name --limit 200
   ```

   For each label in `[ready-for-agent, in-progress, done, needs-human, merged-to-staging, quarantine]` that's NOT in the inventory, create it with these defaults (the colors are convention; safe to override if the user has preferences):

   - `ready-for-agent` — `#5319E7` (purple) — "Story ready for autonomous agent pickup"
   - `in-progress` — `#FBCA04` (yellow) — "Issue claimed by sandcastle agent, work in progress"
   - `done` — `#0E8A16` (green) — "Issue shipped to base branch by sandcastle"
   - `needs-human` — `#D93F0B` (red) — "Sandcastle quarantined — needs human review"
   - `merged-to-staging` — `#1D76DB` (blue) — "Branch merged to integration; awaiting promotion to base"
   - `quarantine` — `#586069` (gray) — "Legacy synonym for needs-human; retained for back-compat"

   Per missing label: `gh label create <name> --color <hex> --description "<desc>"`.

   **On create failure:** the most likely cause is the user's GitHub token lacking `repo` write scope (read-only token still lets `gh issue list` work but blocks label creation). Detect this by inspecting the gh stderr for `HTTP 403` or `Resource not accessible`. Tell the user in plain English: "couldn't auto-create labels — your gh token doesn't have write access to this repo. Fix with `gh auth refresh -s repo` (re-auths and adds the scope), or create them manually in GitHub → Settings → Labels with the names listed above. Loop will fail to claim issues until they exist." Don't block init — the user can fix it and re-run; labels are independent of the `.sandcastle/` template.

   **Idempotent by construction.** Only missing labels get created; existing ones are left alone (their color/description are the user's choice).

8b. **Verify `gh repo set-default` is configured.** The orchestrator's planner and merger shell out to `gh issue list` / `gh issue edit` / `gh issue close` against the project's repo. If the project has multiple GitHub remotes (e.g., `origin` plus a personal fork) and `gh` has no default repo configured, those commands target the wrong repo (`gh` picks the first remote alphabetically) and silently send issue mutations to the unintended GitHub project.

   Run once to check: `gh repo set-default --view 2>&1`. If the output looks like a sensible `owner/repo` line, all good — confirm and move on.

   If the output contains "no default repository is set" / "no default repo set" / "more than one remote", or the command exits non-zero, surface the issue in plain English: "your project has multiple GitHub remotes and no default is set — sandcastle's `gh issue` operations may target the wrong repo. Fix with `gh repo set-default <owner>/<repo>` (run interactively from the project's root)." Don't block init; this is a warning, and the user can fix it after init or before the first `/sandcastle-run`.

   **Idempotent on re-runs.** A subsequent init re-checks; if the user has since set the default, no warning fires.

9. **Profile the project (UI vs non-UI).** Decide whether the project needs browser automation. Look at the project's `package.json` and file tree:

   **UI signals (any one is enough):**
   - `playwright`, `@playwright/test`, `puppeteer`, `cypress`, `webdriverio`, `selenium-webdriver` in dependencies or devDependencies
   - `next`, `react`, `vue`, `svelte`, `solid-js`, `@remix-run/`, `astro`, `nuxt` in dependencies
   - `.tsx`, `.jsx`, `.vue`, `.svelte` files anywhere under `src/`, `app/`, `pages/`, or `components/`

   **Non-UI signals (default if no UI signals):**
   - Project is mostly Python/scripts/CLI/data-pipeline with no UI dependencies

10. **Pick and apply the profile.** The template ships with four pre-built variants in `.sandcastle/variants/`:
    - `minimal` — no browser, verifies via project-native tests (pytest / npm test / cargo test / etc.)
    - `playwright` — Playwright pinned to `1.56.x` with memory caps (sidesteps the 1.57+ Chrome-for-Testing 20 GB regression). This is the default `.sandcastle/Dockerfile` shipped active.
    - `agent-browser` — Vercel agent-browser (Rust CLI, ARM64-native, more token-efficient than Playwright; bundles its own browser). Full prompt rewrite for the agent-browser CLI surface.
    - `mac-host` — host-native sandbox (no Dockerfile) for projects whose workload requires direct host access — e.g. Swift / Xcode / iOS-Simulator projects that can't run inside a container. **Explicit opt-in; never auto-selected at init.** Reachable only via `/sandcastle-profile mac-host` after init.

    **Detection logic:**
    - **`mac-host`-bound project (step 1's scaffolded Swift-project path) → select `mac-host` directly.** This is the one case where init auto-selects `mac-host`: the project has no `package.json` of its own and is macOS-native, so Docker literally can't build it — there is no Docker choice to make. Skip the UI/non-UI detection below and apply `mac-host` (the has_dockerfile=false path in the apply step handles it: no docker build, run the mac-host preflight instead).
    - Otherwise, pick among the three Docker-based variants:
      - Non-UI signals → recommend `minimal`
      - UI signals → recommend `playwright` by default (already active, no swap needed). Optionally offer the user agent-browser as a lighter alternative — describe the trade-off (lighter + cheaper per iteration; v0.27, less battle-tested) and let them choose.
      - `mac-host` is **never auto-recommended for a normal Node project**, even on macOS — Mac users on docker variants are well-served by OrbStack/Colima. Outside the scaffolded-Swift case above, the user opts into `mac-host` later only if their workload genuinely can't be containerised.

    **Apply the swap inline** (do NOT delegate to `/sandcastle-profile` — cross-skill invocation is harness-dependent and unreliable). Use the same logic the profile skill uses:

    a. **Validate the chosen name** against `^[a-z][a-z0-9-]{0,30}$`. If init is auto-picking from the detection logic above, the choices `minimal` / `playwright` / `agent-browser` are all safe — but still validate, in case the template adds new variants.

    a2. **Host Playwright peer-dep check (only relevant for `playwright` choice).** The orchestrator's docker sandbox copies the host's `node_modules/` into the container (`copyToWorktree: ["node_modules"]` in `main.mts`), so a host Playwright version that doesn't match the variant pin (`~1.56.0`) will collide and crash browser tests. If the chosen profile is `playwright`, read the host's `package.json` and check both `dependencies` and `devDependencies` for `playwright` and `@playwright/test`. If either is present and the version range does NOT start with `~1.56` or `1.56.`:
       - Tell the user the exact mismatch in plain English ("your `package.json` has `playwright@<host-version>`, but the playwright variant pins `~1.56.0` — they will collide inside the sandbox").
       - Recommend pinning the host package.json to `"playwright": "~1.56.0"` (and `"@playwright/test": "~1.56.0"` if present) before running the loop. Init can still proceed with the swap, but the user needs to know they will hit failures until they reconcile the versions or run `/sandcastle-profile minimal` / `agent-browser`.
       - This is a warning, not a hard stop, because init is a one-shot setup — surfacing it here is more useful than silently proceeding.

    b. **Check current state.** If `.sandcastle/profile` already contains `<chosen>`, skip the swap (template ships `playwright` active by default — if the choice is `playwright`, no copy is needed).

    c. **Pre-flight: list source files.** From the prompt set (`Dockerfile`, `implement-prompt.md`, `review-prompt.md`, `plan-prompt.md`, `merge-prompt.md`, `recovery-prompt.md`, `post-merge-review-prompt.md`), build the list of files actually present in `.sandcastle/variants/<chosen>/`. If empty, abort — the variant is malformed.

    d. **Atomic swap via `.sandcastle/.swap-tmp/`.** Copy each source file to the temp dir first; only after ALL copies succeed, `mv` each from temp to active. If any cp fails, rm -rf the temp dir and abort with no state change. Don't touch `.env`, `lib/`, `main.mts`, `package.json`, `tsconfig.json`, `.gitignore`, `worktrees/`, `logs/`.

    e. **Write `.sandcastle/profile` LAST** (after all mv's succeed). Then also write `.sandcastle/.sandbox-flag` — derive the value from whether `.sandcastle/variants/<chosen>/Dockerfile` exists (call this **has_dockerfile**): if true, write `docker`; if false (host-native variant such as `mac-host`), write the variant name (e.g. `mac-host`). Init's detection only picks Docker-based variants, so `has_dockerfile` is always true here and the flag is always `docker` at this stage — write it anyway so the wrapper has an explicit on-disk signal instead of falling back to default. Mirrors `/sandcastle-profile` step 10b.

    f. **Rebuild the docker image (Docker-based variants only).** When **has_dockerfile is true** (the `minimal` / `playwright` / `agent-browser` picks): sandcastle does NOT auto-rebuild on profile change. Run `pnpm exec sandcastle docker build-image` (or `npx` / `yarn` per detected manager). On failure, tell the user the exact command to retry. When **has_dockerfile is false** (the `mac-host` pick from the scaffolded-Swift carve-out above): skip the rebuild and instead run the `mac-host` preflight from `/sandcastle-profile` step 8 — that step classifies the target and runs the right check: for a macOS-GUI SwiftPM project (`Package.swift`, no `.xcodeproj`) just `swift --version` + `Package.swift` present; for an iOS/Xcode project `xcodebuild -version` + `xcrun simctl list devices available | grep -q .`. Refuse with the same messages if the applicable check fails.

    All four variants stay on disk in `variants/` — switching is reversible any time via `/sandcastle-profile <name>`.

11. **Recommend a container runtime if none is installed.** **Skip this entire step for a `mac-host`-bound project** (step 1's scaffolded-Swift path) — the host-native profile runs without any container, so a Docker/Podman/Colima runtime is irrelevant and recommending one would just confuse the user. For all Docker-based profiles: run `which docker || which podman || which colima`. On macOS, also check `/Applications/OrbStack.app` and `/Applications/Docker.app`.

    **If a runtime is already installed:** confirm and move on.

    **If nothing is installed:** branch on platform.

    **macOS** (`[[ "$(uname)" == "Darwin" ]]`) — recommend in this order, with the user picking:
    - **OrbStack** — lightest on Apple Silicon (~400 MB idle RAM, 1-2 second startup, free for personal use). Best default for solo devs. Closed source, paid for commercial use. Install: `brew install --cask orbstack`.
    - **Colima** — same memory footprint as OrbStack but slower startup, fully free + open source, terminal-only. Install: `brew install colima docker`.
    - **Podman** — rootless containers (better isolation for untrusted agent code), ~800 MB idle, free + open source. Install: `brew install podman`.
    - **Docker Desktop** — heaviest (2-4 GB idle, 20-30 second startup). Listed for completeness; recommend last. Install: `brew install --cask docker`.

    **Linux** (`[[ "$(uname)" == "Linux" ]]`) — recommend in this order:
    - **Docker** — most common, well-supported. Install: `sudo apt install docker.io` (Debian/Ubuntu) or your distro's equivalent. Add user to `docker` group.
    - **Podman** — rootless by default, more secure for agent sandboxes. Install: `sudo apt install podman` or distro equivalent.

    **Other platforms (Windows, etc.)** — point the user at the upstream install docs for Docker Desktop or Podman; don't try to recommend a package manager.

    Don't auto-install. Tell the user the install command for their pick and let them run it.

12. **Mention the skill-discipline feature (do NOT create the file).** Sandcastle supports a project-root `SANDCASTLE.md` rules file that defines which design / quality skills the autonomous loop must invoke for different kinds of work, keyed off `type:X` ticket labels. **Do not scaffold this file.** The orchestrator's gate is presence-based: the moment `SANDCASTLE.md` exists at the repo root, every dispatched ticket is required to carry a `type:X` label, and tickets without one get filtered out — looking like "no claimable issues." A stub created by init would silently break the day-one experience until the user goes back and labels every ticket. Tell the user about the feature instead, and let them create the file themselves when they're ready.

    a. **Do NOT call `Write` on `<repoRoot>/SANDCASTLE.md`. Do NOT touch the user's repo root at all in this step.** If the file already exists (the user made it on a previous setup), leave it alone — same as any other user file.

    b. **Tell the user, in conversation, in plain English:**

       > Sandcastle supports a `SANDCASTLE.md` rules file at your project root that defines which design skills the autonomous loop must invoke for different kinds of work. It's optional — without it, the loop runs without skill enforcement. Create it when you're ready to turn that on.

    c. **Show the user this sample format as a code block in the same message** so they can copy-paste later. Keep it stack-agnostic (no React / frontend assumptions):

       ```
       # SANDCASTLE.md

       > This file tells the autonomous coding loop which skills to invoke
       > for different kinds of work. Sandcastle reads it before dispatching
       > each ticket. Tickets must carry exactly one `type:X` label matching
       > a section below.
       >
       > Use the skill names exactly as they appear in `.claude/skills/` (or
       > wherever your skills live). The reviewer compares what the
       > implementer actually invoked against the `Required:` list and
       > rejects on missing skills.

       ### type:feature
       Building a new piece of functionality from scratch.
       Required:
       - <skill-name>
       - <skill-name>
       Opt in via `tool:` labels on the ticket:
       - tool:<label> → <skill-name>

       ### type:bugfix
       Fixing a defect in existing behavior. No new functionality.
       Required:
       - <skill-name>

       ### type:cleanup
       Removing dead code, refactoring, or dev-only data. No behavior change.
       Required: (none)
       ```

    d. **Add this footnote to the same message:**

       > Important — once you create `SANDCASTLE.md`, all tickets going to the loop must carry exactly one `type:X` label (and the file must be committed to your integration branch). If you're not ready for that, leave the file uncreated.

    e. **Remember to mention the OFF state in step 13** so the user knows skill discipline is not active yet.

12b. **Commit the `.sandcastle/` tooling (REQUIRED for the loop to run).** This is not optional polish — the loop cuts each per-issue worktree with `git worktree add` off HEAD, and a worktree contains **only tracked files**. If `.sandcastle/` (prompts, `main.mts`, `lib/`) is left untracked, every per-issue worktree is missing the prompt files and the implementer dies mid-run with `prompt file not found: .../worktrees/agent-issue-N/.sandcastle/implement-prompt.md`. So before you tell the user they're ready:

    - Confirm `.env` will not be committed: `.sandcastle/.gitignore` excludes it (verify) and `git status --porcelain .sandcastle/.env` shows nothing staged.
    - Stage and commit the tooling: `git add .sandcastle/ && git commit -m "chore: track sandcastle tooling"`. (On the scaffolded-Swift path where the user chose to gitignore the Node noise, `.sandcastle/`'s prompts/`main.mts`/`lib/` are still tracked — only `package.json`/`node_modules`/lockfile were ignored — so this commit still lands the files the worktree needs. `pnpm-workspace.yaml` is committed per step 7.)
    - Committing tooling into the user's product repo is a real change to their repo — do it as part of init (init's whole job is to make the loop runnable), but state plainly in step 13 that you committed `.sandcastle/` and that their `.env` was excluded.

13. **Tell the user the next steps in plain English:**
    - State what you auto-handled for `.env` (created empty / copied example)
    - State that you committed `.sandcastle/` (required so per-issue worktrees carry the prompt files) and that their `.env` was excluded from that commit
    - State what you tuned (Dockerfile stripped / Playwright pinned / nothing changed)
    - State what you did with labels ("all 5 already existed" / "created N missing" / "N couldn't be created — see scope-fix above")
    - Skill discipline is OFF (no `SANDCASTLE.md` at repo root). When you want to turn it on, create the file using the format I just showed you, then label your tickets.
    - List only the vars (if any) the user still needs to fill in manually
    - **Container runtime:** for a Docker-based profile, confirm a runtime is installed and running. For a `mac-host`-bound project, instead confirm the host preflight passed (Swift toolchain — and Xcode/simulator only if it's an iOS/Xcode target) and that no container runtime is needed. Also remind them their real build/test runs natively (`swift build && swift test` for a macOS-GUI SwiftPM app), declared in the project's `SANDCASTLE.md` `verify:` section.
    - Confirm at least one GitHub issue is labeled `ready-for-agent` AND carries a `type:X` label (skill-discipline gate keys on `type:X`). If none exist, point the user at the workflow that produces eligible issues: a "shape the work" pipeline (currently `/grill-me` or `/grill-with-docs` → `/to-prd` → `/to-issues`), then `/triage-plus-skills`. The final step is the non-substitutable one — only it stamps `type:X`. Bare `/triage` is not enough.
    - Suggest running `/sandcastle-run` to start the loop once eligible issues exist

## Verification

After every step, check the exit code and the relevant output. If anything fails, stop and report what failed in plain English. Don't continue past a broken step.

## Talking to the user

The user is non-technical. Don't dump command output unless something failed. Tell them what you did and what's next, plain English.
