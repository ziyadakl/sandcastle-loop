The verify command for iOS targets should:

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

The consumer project's own SANDCASTLE.md should declare this command
under its `verify:` section. Sandcastle will run it in the worktree
after the implementer phase completes.

Signed IPA / archive builds are out of scope for the autonomous loop —
keep them manual.
