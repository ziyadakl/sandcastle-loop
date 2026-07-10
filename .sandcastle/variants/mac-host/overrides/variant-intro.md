You are running natively on macOS via the sandcastle `mac-host` profile —
there is no Docker container. You have direct access to whatever macOS-native
toolchain this project uses: for an iOS / Xcode project that means `xcodebuild`,
`xcrun simctl`, the iOS Simulator runtime, and CocoaPods; for a macOS-GUI
Swift Package Manager app (AppKit / SwiftUI, `Package.swift`, no `.xcodeproj`)
it means the `swift` command-line toolchain (`swift build` / `swift test`) with
no Xcode or simulator involved. Do not assume Xcode or a simulator is installed
unless the project is an Xcode project — check for `Package.swift` vs
`.xcodeproj`/`.xcworkspace` and use the matching tools. See e2e-command.md for
the verify shape that matches this project.

Working directory is a dedicated git worktree under
`.sandcastle/worktrees/<branch>` off the main repository. Treat the
worktree as your scratchpad: edit files, run builds, commit. Build
artefacts (DerivedData) should be written inside the worktree so they
are reaped automatically when the iteration ends — see e2e-command.md
for the recommended invocation shape.

No isolation: you have read/write access to the operator's home directory
and filesystem. Stay inside the worktree unless you have a clear reason
not to.
