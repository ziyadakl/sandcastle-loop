The mac-host profile covers two kinds of macOS-native project. Pick the
verify shape that matches yours and declare it in the consumer project's
own SANDCASTLE.md `verify:` section — sandcastle runs it in the worktree
after the implementer phase completes.

## iOS / Xcode target (`.xcodeproj` / `.xcworkspace`, builds against a simulator)

1. Shut down and erase the simulator before each run to avoid state
   leaking between iterations:
   `xcrun simctl shutdown all && xcrun simctl erase all`

2. Run xcodebuild's `test` action with explicit `-derivedDataPath ./build`
   so build artefacts live inside the worktree (and get reaped with it):
   `xcodebuild test \
       -scheme <YourScheme> \
       -destination 'platform=iOS Simulator,name=iPhone 15' \
       -derivedDataPath ./build \
       CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO`

## macOS-GUI SwiftPM target (`Package.swift`, no `.xcodeproj`, AppKit / SwiftUI)

A macOS AppKit or AppKit-backed SwiftUI app built with Swift Package
Manager needs no simulator and no Xcode — just the Swift toolchain from
the command-line tools. The verify shape is:

   `swift build && swift test`

There is no simulator to erase, and DerivedData lives in the worktree's
`.build/` automatically, so no `-derivedDataPath` juggling is needed.
This case exists specifically because it can NOT run in the Docker
profile: AppKit is macOS-only and has no Linux Swift build.

## Both cases

Signed IPA / archive builds are out of scope for the autonomous loop —
keep them manual.
