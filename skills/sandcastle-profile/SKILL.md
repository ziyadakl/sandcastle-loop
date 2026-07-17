---
name: sandcastle-profile
description: Show or switch the active sandcastle profile (browser stack variant). Use when the user wants to see which profile is active, switch between minimal / playwright / agent-browser / mac-host, or invokes /sandcastle-profile. Reads `.sandcastle/profile`, lists `.sandcastle/variants/`, copies a variant's files over the active set atomically, rebuilds the docker image (Docker-based variants) or runs the mac-host preflight (host-native variants), and refuses while a loop is running.
---

# Sandcastle Profile

Manages the active browser-stack profile for sandcastle-loop. A profile is a bundle of files (Dockerfile + prompts) that lives under `.sandcastle/variants/<name>/`. The active copy lives flat in `.sandcastle/`. The text file `.sandcastle/profile` records which variant is currently active.

Profiles supported by the template:

- **minimal** — no browser; agent verifies via the project's own tests (pytest, vitest, etc.)
- **playwright** — Playwright with version pins for the Chrome-for-Testing regression (default for UI projects)
- **agent-browser** — Vercel agent-browser (lighter, ARM64-native, fewer tokens per browser action)
- **mac-host** — host-native macOS sandbox (no Docker). Covers iOS / Xcode projects (requires Xcode + an iOS Simulator runtime) **and** macOS-GUI SwiftPM apps (AppKit / SwiftUI with `Package.swift` and no `.xcodeproj`; needs only the `swift` command-line toolchain — no full Xcode, no simulator). The preflight auto-detects which case applies.

## Two modes of invocation

### Mode A — `/sandcastle-profile` with no argument

Show state. Don't change anything.

1. **Verify cwd.** `.sandcastle/` must exist. If not, tell the user "this project isn't initialized — try `/sandcastle-init`" and stop.
2. **Read the active profile.** `cat .sandcastle/profile` if it exists. If the file is missing, say "no profile recorded — the project may have been initialized before profiles existed" and continue.
3. **List available variants.** `ls .sandcastle/variants/` (each subdirectory is one variant). If the directory is missing or empty, tell the user the template has no variants installed and suggest `/sandcastle-update`.
4. **Report in plain English.** Active profile + the names of available variants + a one-line hint that they can switch with `/sandcastle-profile <name>`.

### Mode B — `/sandcastle-profile <name>`

Switch to the named variant.

1. **Validate the name.** The `<name>` argument MUST match the regex `^[a-z][a-z0-9-]{0,30}$` (lowercase letter first; lowercase letters, digits, hyphens after; max 31 chars). If it doesn't match, stop immediately with "invalid profile name" — do not touch the filesystem. This blocks path traversal (`..`, `/`, etc.) and other injection.

2. **Verify cwd.** `.sandcastle/` must exist. If not, point them at `/sandcastle-init` and stop.

3. **Verify the variant exists.** `.sandcastle/variants/<name>/` must be a directory. If not, list what *is* available under `.sandcastle/variants/` and stop.

4. **Refuse if a loop is running.** Run `pgrep -af '\.sandcastle/main\.mts (--iterations|--issue|--max-concurrent|--repo-root|--branch)'`. If it returns anything, tell the user to `/sandcastle-stop` first and stop. Switching profiles mid-run would corrupt the in-flight container build.

5. **Idempotency check.** If `.sandcastle/profile` already contains `<name>` exactly, report "already on `<name>`, nothing to do" and stop. Don't re-copy files — that would clobber any user edits to the active set.

6. **Host package.json sanity check (Playwright peer-dep skew).** The orchestrator's docker sandbox copies the host's `node_modules` into the container (`copyToWorktree: ["node_modules"]` in `main.mts`). Two Playwright versions in scope at once → mysterious browser failures. Before swapping, read the host's `package.json` (in cwd, NOT inside `.sandcastle/`):

   - **Switching to `playwright`:** the variant Dockerfile pins `playwright@~1.56.0` (sidesteps the 1.57+ Chrome-for-Testing 20 GB regression). Check `dependencies` and `devDependencies` for `playwright` and `@playwright/test`. If either is present and the version range does NOT start with `~1.56` or `1.56.` (e.g. host has `^1.58.1`), STOP and warn the user in plain English:
     - Tell them the exact mismatch: "Your `package.json` has `playwright@<host-version>`. The `playwright` variant pins `~1.56.0` in the sandbox image to avoid a memory regression in 1.57+. The orchestrator copies your `node_modules/` into the container, so two versions will collide and browser tests will fail mysteriously."
     - Tell them exactly what to change: pin their host `package.json` to `"playwright": "~1.56.0"` (and `"@playwright/test": "~1.56.0"` if present), then re-run install (`pnpm install` / `npm install` / `yarn install`), then re-run `/sandcastle-profile playwright`.
     - Offer an explicit override: "if you understand the risk and want to proceed anyway, re-run with `/sandcastle-profile playwright --force`." Only proceed if `--force` is in the argument string.

   - **Switching to `minimal`:** the variant Dockerfile has no Playwright at all. If host `package.json` has `playwright` or `@playwright/test`, warn (informational, not blocking): "your project still has Playwright in deps but the `minimal` profile's image won't have it baked in — Playwright tests will fail to launch a browser inside the sandbox. The agent's verification will use the project's native tests instead, so this is usually fine, but if you do still want to run `playwright test` from inside the sandbox, switch to the `playwright` profile." Continue the swap.

   - **Switching to `agent-browser`:** same situation — variant has no Playwright, and the prompts call `agent-browser` CLI commands instead of `npx playwright test`. If host has Playwright, warn (informational, not blocking): "your `package.json` still has Playwright but this profile's prompts no longer use it — the agent will drive the bundled `agent-browser` CLI instead. Playwright in deps is harmless, just unused inside the sandbox." Continue the swap.

   The `--force` override only applies to the `playwright` switch (the only blocking branch). For the other two profiles the warning is informational and the swap continues unconditionally.

7. **Pre-flight: inspect variant capabilities.** A well-formed variant directory contains:
   - `Dockerfile` (optional — present for Docker-based sandbox variants; absent for host-native variants such as `mac-host`)
   - `overrides/` (optional, may be empty) — per-marker override files, one `.md` per marker name

   Note whether `.sandcastle/variants/<name>/Dockerfile` exists — call this **has_dockerfile**. Keep this flag; it controls steps 8, 9, and 11.

   If **both** the Dockerfile and the `overrides/` directory are absent, abort — the variant directory appears empty and is likely malformed. The `overrides/` directory may otherwise be absent or empty for a valid Dockerfile variant; the assembly tool handles both cases (empty overrides = base defaults inherited everywhere, which is the playwright case).

   The prompt files (`implement-prompt.md`, `review-prompt.md`, etc.) live in base `.sandcastle/` and are assembled per-variant. Variants no longer ship full-file forks of base prompts.

8. **Mac-host preflight (before touching any project files).** Run this step only when **has_dockerfile is false**. If **has_dockerfile is true**, skip to step 9.

   First **classify the target** by inspecting the project root (cwd):
   - If a `Package.swift` exists **and** there is **no** `.xcodeproj` or `.xcworkspace`, treat it as a **macOS-GUI SwiftPM target** and run the **SwiftPM preflight** below.
   - Otherwise (an `.xcodeproj`/`.xcworkspace` is present, or no `Package.swift`), treat it as an **iOS / Xcode target** and run the **iOS preflight** below.

   **iOS preflight:**
   - Run `xcodebuild -version`. If it fails (non-zero exit or command not found), **refuse** with: "Xcode not installed or command-line tools not selected" and stop. Do not modify any project files.
   - Run `xcrun simctl list devices available | grep -q .`. If it fails (no output / non-zero exit), **refuse** with: "no iOS Simulator runtime installed — run `xcodebuild -downloadPlatform iOS`" and stop. Do not modify any project files.
   - If both pass, continue to step 9.

   **SwiftPM preflight** (macOS-GUI SwiftPM app — no full Xcode / simulator required, since the mac-host executor only needs `git` + PATH + `swift`):
   - Run `swift --version`. If it fails (non-zero exit or command not found), **refuse** with: "the Swift command-line toolchain isn't available — run `xcode-select --install`" and stop. Do not modify any project files.
   - Confirm `Package.swift` still exists at the project root (it did during classification; re-assert to be safe). If it's gone, **refuse** with "no `Package.swift` found — this doesn't look like a SwiftPM project" and stop.
   - Do **not** run `xcodebuild` or `xcrun simctl` for this case — a macOS-GUI SwiftPM app builds and tests with `swift build` / `swift test` and needs neither. Continue to step 9.

9. **Atomic swap: Dockerfile via temp dir (if present), prompts via assembly script.** No partial-state failures allowed.

   For the Dockerfile (**only when has_dockerfile is true**):
   - Create `.sandcastle/.swap-tmp/` (rm -rf first if it exists from a prior aborted run).
   - `cp .sandcastle/variants/<name>/Dockerfile .sandcastle/.swap-tmp/Dockerfile`. If copy fails, abort: rm -rf `.sandcastle/.swap-tmp/`, do NOT touch active files, do NOT update `.sandcastle/profile`.
   - `mv .sandcastle/.swap-tmp/Dockerfile .sandcastle/Dockerfile` (atomic on same filesystem).
   - rm -rf `.sandcastle/.swap-tmp/`.

   When **has_dockerfile is false** (host-native variant such as `mac-host`): skip the Dockerfile copy sub-block entirely. The old `.sandcastle/Dockerfile` from any prior Docker-based profile is left in place — it is inert because the sandbox-flag (step 10) routes the runtime away from docker. Do not delete it, as removal adds another failure mode to the atomic swap with no benefit.

   For the prompts:
   - Detect the package manager (same as step 11: `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `package-lock.json` → npm). Then run from the project root:
     - pnpm: `pnpm exec tsx .sandcastle/scripts/assemble-variant.mts <name>`
     - npm: `npx tsx .sandcastle/scripts/assemble-variant.mts <name>`
     - yarn: `yarn tsx .sandcastle/scripts/assemble-variant.mts <name>`
   - **Do not run plain `tsx ...`** — `tsx` is a devDependency, not a global install; the bare invocation fails with "command not found" in most shells.
   - The script reads each base `.sandcastle/*.md`, applies the variant's overrides, and atomically writes each assembled prompt via its own tempfile + rename. If the script exits non-zero, abort: leave `.sandcastle/profile` untouched and report stderr to the user.
   - The assembly script emits a one-line summary like `assembled prompts for variant <name>: N base files processed, M overrides applied, K warnings`. Surface the warning count to the user if K > 0 — warnings indicate orphan markers or unmatched override keys in the variant's overrides/ directory.

   **Do not touch** the following — they're not profile-specific and may contain user customizations or generated state:
   - `.sandcastle/.env`
   - `.sandcastle/lib/`
   - `.sandcastle/main.mts`
   - `.sandcastle/package.json`
   - `.sandcastle/tsconfig.json`
   - `.sandcastle/.gitignore`
   - `.sandcastle/worktrees/`
   - `.sandcastle/logs/`

10. **Record the new profile and write the sandbox flag.** Two writes, in order:

   a. Write `<name>` to `.sandcastle/profile` (overwrite, no trailing junk). This is the final commit point of the swap — if step 9 succeeded, this should always succeed too.

   b. Derive the sandbox-flag value: if **has_dockerfile is true**, value is `docker`; otherwise value is `mac-host` (or the variant name if a future non-Dockerfile variant ships with a different name). Write this bare value as a single line to `.sandcastle/.sandbox-flag` (overwrite). Example: for a Dockerfile-based variant, the file contains `docker`; for `mac-host`, it contains `mac-host`. Sandcastle's wrapper script reads this file and passes it as `--sandbox <value>` to `main.mts`. If the file does not exist, sandcastle defaults to `docker`.

11. **Rebuild (Docker-based variants only).**

   **When has_dockerfile is true (Docker-based variant such as `minimal`, `playwright`, `agent-browser`):**
   The cached image is stale after a Dockerfile swap; sandcastle does NOT auto-rebuild. Detect the package manager (same logic as `/sandcastle-init`: `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `package-lock.json` → npm). Then run:
   - pnpm: `pnpm exec sandcastle docker build-image`
   - npm: `npx sandcastle docker build-image`
   - yarn: `yarn sandcastle docker build-image`

   If the package manager can't be detected, skip auto-execute and tell the user the exact command to run instead.

   **When has_dockerfile is false (host-native variant such as `mac-host`):**
   No-op. The mac-host preflight already ran at step 8; no docker build is needed.

12. **Report to the user in plain English:**
    - Which profile they're now on (e.g. "switched from `playwright` to `minimal`")
    - The list of files that were replaced (just filenames, not full paths)
    - **For Docker-based variants — rebuild status.** Either "docker image rebuilt for the new profile" (if step 11 ran successfully) or "run `<pm> exec sandcastle docker build-image` to rebuild — sandcastle does not auto-rebuild on profile change" (if skipped or failed).
    - **For `mac-host` variant — preflight status** (preflight ran at step 8, before any files were touched). Report the case that matched: for an iOS / Xcode target, "host environment verified: Xcode and iOS Simulator runtime detected"; for a macOS-GUI SwiftPM target, "host environment verified: Swift command-line toolchain detected (no Xcode/simulator needed for this SwiftPM app)".
    - If they switched to `minimal`, mention the agent will verify via the project's native tests instead of a browser test.
    - If they switched to `agent-browser`, mention the prompts now expect agent-browser commands instead of `npx playwright test`.

## Verification

After each `cp` and `mv`, check the exit code. On any failure: clean up `.sandcastle/.swap-tmp/`, leave active files untouched, leave `.sandcastle/profile` untouched, report which file failed in plain English. A half-applied profile is worse than no switch at all — atomicity is non-negotiable.

## Confidence tags

Per the user's CLAUDE.md, tag non-trivial claims:

- `[VERIFIED: ...]` for things you actually checked (e.g. `[VERIFIED: pgrep returned no matches]`, `[VERIFIED: .sandcastle/profile now contains "minimal"]`, `[VERIFIED: docker build-image exit 0]`)
- `[UNVERIFIED: ...]` when you couldn't check (e.g. `[UNVERIFIED: rebuild skipped — user needs to run the build command manually]`)
- `[ASSUMED: ...]` for memory-based claims (avoid these here — everything in this skill is checkable)

## Talking to the user

The user is non-technical. Don't dump `cp` output or directory listings unless something failed. Tell them what changed and what's next, plain English.
