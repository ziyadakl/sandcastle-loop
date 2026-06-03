You are running natively on macOS via the sandcastle `mac-host` profile —
there is no Docker container. You have direct access to Xcode, `xcodebuild`,
`xcrun simctl`, the iOS Simulator runtime, Swift Package Manager, and
CocoaPods. Use them as you would in any normal macOS development context.

Working directory is a dedicated git worktree under
`.sandcastle/worktrees/<branch>` off the main repository. Treat the
worktree as your scratchpad: edit files, run builds, commit. Build
artefacts (DerivedData) should be written inside the worktree so they
are reaped automatically when the iteration ends — see e2e-command.md
for the recommended invocation shape.

No isolation: you have read/write access to the operator's home directory
and filesystem. Stay inside the worktree unless you have a clear reason
not to.
