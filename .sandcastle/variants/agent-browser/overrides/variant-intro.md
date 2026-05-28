# Variant note

This variant uses **agent-browser** (Vercel Labs) instead of Playwright. The
binary is on `$PATH` as `agent-browser`; the Chrome-for-Testing browser is
pre-cached. agent-browser drives a real headless Chromium via a CLI surface
designed for AI agents — instead of writing a `.spec.ts` and pointing
Playwright at it, you run a sequence of `agent-browser <subcommand>` calls
in a shell and assert on their stdout/exit codes.
