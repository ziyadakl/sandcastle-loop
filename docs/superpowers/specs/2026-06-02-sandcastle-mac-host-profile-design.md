# Sandcastle Mac-Host Profile — Design

## Problem

Sandcastle's autonomous loop runs each iteration inside a Linux Docker container, which is fine for Node/Python/web stacks but a hard blocker for iOS projects. Xcode, `xcodebuild`, the iOS Simulator, and Apple's code-signing toolchain are macOS-only — Apple does not ship a Linux build of Xcode, so no Linux container (regardless of host: OrbStack, Docker Desktop, Podman) can compile or test an iOS app.

The first concrete case is SyncTasks, a Swift/Xcode iPhone app. Without a host-native execution path, sandcastle's loop, queue, label state machine, retry ladder, critique-as-gate, and two-gate hardening — all the value the user gets from sandcastle — are unavailable for any iOS project.

## Goal

Add a new sandcastle profile, `mac-host`, that runs each loop iteration directly on the macOS host with no container. Consumers opt into it via `/sandcastle-profile mac-host`, and the existing loop machinery (`main.mts`, queue, gates, retry ladder, integration branch) runs unchanged on top of it. It covers two classes of macOS-native project that a Linux container can't build: (a) iOS / Xcode apps (SyncTasks today), and (b) macOS-GUI Swift Package Manager apps — AppKit or AppKit-backed SwiftUI built with `swift build` / `swift test`, no Xcode and no simulator (applock is the first such case). See the "Out of scope" note for why (b) is distinct from a Linux-buildable SwiftPM project.

## Non-goals

- Replacing the Docker profile for non-iOS consumers. The Docker default stays.
- Sandbox-grade isolation. Host-native execution by definition gives Claude access to the user's home directory and filesystem; this design accepts that for the single-user, single-Mac, supervised-overnight use case. Anyone wanting hard isolation should keep using Docker or move to CI-delegated verification.
- Archiving signed IPAs / TestFlight uploads. Out of scope; the loop only does build + test against the simulator.
- Concurrent iterations on the same Mac. Sandcastle's existing single-iteration default stays; parallelism is a future concern that introduces simulator / derived-data conflicts.

## Constraints

- The SDK's bundled `noSandbox` provider is `interactive()`-only and explicitly not accepted by `createSandbox()`, which is what the loop uses [VERIFIED — `node_modules/.pnpm/.../@ai-hero/sandcastle/dist/sandboxes/no-sandbox.d.ts:8`]. So we cannot just import and use it; we must write a `createSandbox`-compatible host provider ourselves.
- `SandboxHandle` is a four-method interface — `branch`, `worktreePath`, `run()`, `close()` [VERIFIED — `.sandcastle/main.mts:226-231`]. Anything implementing it integrates with the loop transparently.
- Three `docker(...)` call sites exist in `.sandcastle/main.mts` — two in the loop path (lines 1717, 1784) and one in the merger setup (line 1634) [VERIFIED — `grep -n "sandbox:.*docker\|sandbox: {"` against `.sandcastle/main.mts`]. The profile must route all three through the new provider when active.
- Must survive `/sandcastle-update`. The provider lives in the template repo, not the consumer's `.sandcastle/`, so updates flow through naturally.
- Must coexist with the existing two-gate critique + skill-discipline stack landed on the affinity-tracker server (commits `f37687aeb`, `e4b05a0b6`, `8e17f63ab`, `772032093`, `d5b4aafa9`). Once those changes port to master, the mac-host profile must not bypass either gate.

## Architecture

The whole change is contained in two places: a new provider file in the template, and a new variant in `.sandcastle/variants/`.

```
.sandcastle/
├── lib/
│   └── mac-host-sandbox.ts        # NEW — implements SandboxHandle on the host
├── main.mts                        # MODIFIED — branches sandbox factory by profile
└── variants/
    ├── agent-browser/              # unchanged
    ├── minimal/                    # unchanged
    ├── playwright/                 # unchanged
    └── mac-host/                   # NEW
        ├── overrides/              # iOS-specific prompt overrides
        │   ├── e2e-command.md      # describes xcodebuild verify command shape
        │   └── variant-intro.md    # tells the agent it's a Mac-host iOS workflow
        └── README.md               # consumer docs
```

Note the absence of a `Dockerfile` in the mac-host variant — that file's purpose is the container image, which this profile does not use. The `/sandcastle-profile` switch needs a small update to tolerate Dockerfile-less variants.

Everything else in sandcastle — queue, worktrees, retry ladder, critique-as-gate, skill-discipline, integration branch, FF auto-merge, post-merge fixer — is unchanged because it only interacts with the loop through `SandboxHandle`.

## Components

### `mac-host-sandbox.ts`

A factory that returns a `SandboxHandle`-compatible object. Per iteration:

1. **Worktree setup.** Creates a git worktree at `<repo>/.sandcastle/worktrees/<branch>` off the issue's base branch. This is the same path convention the Docker provider uses, so the loop's worktree-cleanup code at `main.mts:4048,4063` still finds and reaps abandoned trees.
2. **Spawn.** `run(spec)` spawns the Claude Code CLI as a host child process with `cwd` set to the worktree path. Inherits the user's PATH (so `xcodebuild`, `xcrun`, `swift` are reachable), filters env per the spec (no `dotenv-cli` indirection — env vars are merged directly).
3. **Streaming.** Forwards stdout/stderr to the loop's logger via the same `RunHandle` shape Docker emits. Includes the `sessionFilePath` derived from `sessionId` per the documented gotcha (memory: `reference_sandcastle_session_jsonl_gotcha.md`).
4. **Close.** Removes the worktree via `git worktree remove --force <path>`. The forced flag matches the Docker provider's cleanup behaviour for uncommitted-state cases.

Expected size: 150–250 lines. No external dependencies beyond Node's built-in `child_process`, `fs`, and the project's existing git wrapper.

### `main.mts` change

Single conditional at the three sandbox factory call sites:

```ts
const sandboxProvider = activeProfile === "mac-host"
  ? macHostSandbox({ env: containerEnv })
  : docker({ imageName: args.imageName, env: containerEnv, containerUid: 1000 });
```

`activeProfile` reads `.sandcastle/profile` (same source the `/sandcastle-profile` skill writes to). No other branching needed — the loop downstream of this point is profile-agnostic.

### `mac-host` variant

Mirrors the existing variants' structure minus the Dockerfile. `e2e-command.md` documents the expected shape of the consumer's verify command (`xcodebuild test -scheme <Name> -destination 'platform=iOS Simulator,name=<Device>' -derivedDataPath ./build`). `variant-intro.md` tells the agent it's working in an iOS context with native macOS tools. `README.md` documents the per-consumer setup steps (Xcode installed, command-line tools selected, simulator runtimes downloaded).

### `/sandcastle-profile` skill update

The profile-switch logic currently rebuilds the Docker image after a variant copy. For `mac-host` it should skip that step (no image to build) and instead verify host prerequisites: `xcodebuild -version` succeeds, `xcrun simctl list devices available` has at least one iOS Simulator available. Refuses with a clear error if either fails.

### `bin/init.mjs` change

When init detects a Swift / Xcode project (presence of `.xcodeproj`, `.xcworkspace`, or `Package.swift` at the consumer root), pre-select the `mac-host` profile and skip the Docker-image build step. Otherwise behave as today.

## Per-iteration data flow

1. Loop picks a `queue:ready` issue from GitHub.
2. `mac-host` provider creates `<repo>/.sandcastle/worktrees/<branch>` for the issue branch off `main`.
3. Claude Code CLI spawns as a host process in the worktree with the implementer prompt + `REQUIRED_SKILLS` list (per the two-gate v3.2 fix).
4. Claude edits files in the worktree, calls `xcodebuild`, `pod install`, `swift package resolve`, etc. on the host as needed.
5. After Claude finishes, the loop runs the verify command in the worktree — for iOS, `xcodebuild test` against a simulator.
6. Existing gates run: critique-as-gate reads the diff and rubric files (with the v3.1 `~/.claude/skills/` fallback), skill-discipline confirms required skills were invoked.
7. **Pass** → push branch, label `queue:done`, merge into integration branch (FF or critique-cleared).
8. **Fail** → existing retry ladder. Quarantine on persistent failure with the existing reason codes.

No step changes from today's Docker flow except the substrate where steps 2–4 physically run.

## iOS-specific failure modes & mitigations

- **Derived data collision.** `xcodebuild`'s default `DerivedData` location is global (`~/Library/Developer/Xcode/DerivedData`). Two iterations running back-to-back can poison each other's caches. Mitigation: the variant's `e2e-command.md` documents `-derivedDataPath ./build` per worktree so each iteration's build artefacts are contained inside its own worktree and reaped with it.
- **Simulator state.** Booted simulators, installed apps, and runtime state persist across runs. Mitigation: prepend the verify command with `xcrun simctl shutdown all && xcrun simctl erase all`. Documented in the variant's `e2e-command.md` as the recommended pattern.
- **Code signing.** Loop iterations are tests, not archives. Mitigation: variant docs recommend `CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO` on the verify command. Signed archive builds (for TestFlight) stay manual.
- **Concurrent iterations.** Sandcastle's default is single-iteration; the mac-host profile inherits that and does not attempt to support parallelism. Documented as a non-goal.
- **No isolation.** Accepted per Non-goals. Documented prominently in `README.md` — a bug in Claude can touch any file the running user can touch. Mitigation suggestion: run the loop as a dedicated macOS user account if the consumer wants harder containment.
- **PATH drift.** The provider inherits the user's PATH at loop-launch time. If `xcodebuild` is installed via a path-managed tool (e.g. `xcodes` switching active versions), the active version at loop start is what every iteration uses. Documented; not a code change.

## Testing strategy

1. **Unit tests for `mac-host-sandbox.ts`.** Stub `child_process.spawn`; assert the provider creates the right worktree, spawns with the right cwd / env, forwards streams correctly, and cleans up on `close()`. Run on Mac CI only (skip on Linux).
2. **Integration test against a fake repo.** Throwaway repo whose verify command is `echo "build ok"`. Run a single loop iteration end-to-end; assert worktree created, agent spawned, verify command run, gates evaluated, worktree cleaned.
3. **Real-world smoke on SyncTasks.** First trivial issue (README typo or comment fix) to confirm the full pipeline — worktree → spawn → `xcodebuild test` → gates → merge — ticks over against a real iOS target. Only after this passes do non-trivial features go through the loop.

## Open risks

- **Xcode build time.** A clean `xcodebuild test` can take several minutes on a non-trivial app. The loop's retry ladder is calibrated to faster verify cycles. If iterations consistently take >5 minutes, the user-attention model needs revisiting (e.g., shorter retry ladder, longer idle timeout). Empirical, decide after the SyncTasks smoke.
- **Two-gate port dependency.** The mac-host profile assumes the two-gate critique + skill-discipline stack ships in the master template eventually. Until that port lands (currently gated on the affinity-tracker server validation), mac-host on the current master ships without those gates and will have the same silent-abstention failure documented in `project_critique_as_gate_silent_abstention.md` if applied to backend `type:X` mappings. Mitigation: do not launch mac-host on consumers before the two-gate port lands, OR include a fail-loud guard in the mac-host variant's variant-intro.md as an interim.
- **Worktree cleanup on crash.** If the loop process is killed mid-iteration (Ctrl-C, OOM, OS crash), the worktree is left behind. The existing `/sandcastle-clean` skill handles this for the Docker profile; verify it works identically against host worktrees (no container to also clean up, so it should be a strict subset of work). Test as part of the smoke.

## Out of scope (carried over, future work)

- Signed IPA / TestFlight archive builds in the loop.
- Multiple concurrent iterations on one Mac.
- Swift CLI / SwiftPM **server** projects — command-line tools and server-side Swift with no macOS-only framework dependency. Those compile and test fine on Linux Swift, so the existing Docker profile handles them with no value-add from mac-host. This is distinct from macOS-GUI SwiftPM apps (AppKit / AppKit-backed SwiftUI), which are **in scope** for mac-host (see Goal): AppKit is macOS-only and has no Linux Swift build, so Docker genuinely can't compile them. The distinguishing test is not "does it use SwiftPM" but "does it depend on a macOS-only framework" — if yes, it needs mac-host regardless of build system.
- A Linux-host variant for users who want to skip Docker on Linux for other reasons.
