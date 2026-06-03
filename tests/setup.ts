// Vitest global setup.
//
// Sets SANDCASTLE_MAC_HOST_CLAUDE_BIN=/bin/cat unless a test has already
// chosen its own binary. The mac-host sandbox helper used to fall back to
// /bin/cat implicitly when NODE_ENV === "test"; that branch was removed
// because it was a global-state seam at risk of leaking into production.
// Tests now opt in via the explicit env var (or directly via
// MacHostSandboxOptions.claudeBin / buildArgs).
process.env.SANDCASTLE_MAC_HOST_CLAUDE_BIN ??= "/bin/cat";
