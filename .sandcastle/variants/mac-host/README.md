# mac-host variant

Runs each sandcastle iteration directly on the macOS host (no container).
For iOS / Xcode / Swift projects that need access to macOS-only tooling.

## Prerequisites

- macOS host (Apple Silicon or Intel)
- Xcode installed and a valid command-line-tools selection
  (`xcode-select --install` if missing)
- At least one iOS Simulator runtime downloaded
  (`xcrun simctl list devices available` must return a non-empty list)
- The Claude Code CLI on PATH (`claude` resolves to the binary)

## Activation

```
/sandcastle-profile mac-host
```

## What this variant changes

- No Dockerfile (no container image to build)
- Variant intro tells the agent it's running natively on macOS
- e2e-command.md documents the iOS-shaped verify command
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
