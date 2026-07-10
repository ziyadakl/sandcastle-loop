# mac-host variant

Runs each sandcastle iteration directly on the macOS host (no container).
For macOS-native projects that need tooling a Linux container can't provide:
iOS / Xcode apps, and macOS-GUI Swift Package Manager apps (AppKit / SwiftUI)
that can't build on Linux Swift.

## Prerequisites

Always:

- macOS host (Apple Silicon or Intel)
- The Swift command-line tools on PATH (`swift --version` resolves;
  `xcode-select --install` if missing)
- The Claude Code CLI on PATH (`claude` resolves to the binary)

For an **iOS / Xcode** target (`.xcodeproj` / `.xcworkspace`) — additionally:

- Full Xcode installed and selected (`xcodebuild -version` succeeds)
- At least one iOS Simulator runtime downloaded
  (`xcrun simctl list devices available` must return a non-empty list)

For a **macOS-GUI SwiftPM** target (`Package.swift`, no `.xcodeproj`) — nothing
more: no full Xcode and no simulator are needed. The profile's preflight detects
which case you're in and only checks the tooling that case requires.

## Activation

```
/sandcastle-profile mac-host
```

## What this variant changes

- No Dockerfile (no container image to build)
- Variant intro tells the agent it's running natively on macOS
- e2e-command.md documents the verify command shape (iOS `xcodebuild test`
  or macOS-GUI SwiftPM `swift build && swift test`)
- Loop reads `--sandbox mac-host` automatically when this profile is active

## What this variant does NOT change

- Queue + label state machine
- Worktree management
- Retry ladder
- Critique-as-gate / skill-discipline gates
- Integration branch + FF auto-merge
- Post-merge fixer

All of those continue to work identically — they only interact with
the sandbox through a four-method interface.

## Caveats

- **No isolation.** A bug in the agent can read or write any file the
  loop's user can access. Acceptable for personal-Mac / single-user
  setups; not acceptable for untrusted-agent / shared-infra setups.
- **Single-iteration only.** Parallel iterations would clash on
  DerivedData and simulator state. Sandcastle's default of one
  iteration at a time stays in force.
- **Xcode build time.** Per-iteration verify is several minutes on
  non-trivial apps. The retry ladder's idle timeout may need raising
  for slow projects.
