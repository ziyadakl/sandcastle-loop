# ADR 0011 — Sandcastle: forward a long-lived OAuth token into the container for macOS subscription auth

**Status:** Accepted
**Date:** 2026-06-10

## Context

The default `anthropic` provider authenticates the in-container `claude` against
the operator's Pro/Max **subscription**, not an API key (`providers.ts`:
`subscription: true` returns `{}` — no key injected, "let claude find its own
auth"). The mechanism is the loop bind-mounting the host `~/.claude` *directory*
into the container: on Linux the subscription OAuth token lives in
`~/.claude/.credentials.json`, a file inside that directory, so it rides in and
the container's `claude` is logged in.

This silently broke on macOS hosts. Recent Claude Code builds migrated the
subscription token from `~/.claude/.credentials.json` into the **macOS login
Keychain** (verified on a host running CLI 2.1.163: no credential file present,
token found under Keychain service `"Claude Code-credentials"`). The Keychain
cannot be bind-mounted into a Linux container, so the mounted `~/.claude` dir
carries no credential and **every agent fails at the first `claude` call** —
`Not logged in · Please run /login`. The planner is the first to hit it, so the
loop dies before claiming any issue.

The same code keeps working on the Linux VPS, where the token is still a
mountable file — confirming this is a host-OS credential-storage difference, not
a loop regression. A consumer's local run on 2026-05-21 succeeded; the first
failure was 2026-06-10, bracketing the CLI's file→Keychain migration.

Two non-starters were ruled out:

- **Re-materializing `~/.claude/.credentials.json` from the Keychain.** Fragile:
  the Keychain token rotates/expires and `claude` may re-migrate, so a copied
  file goes stale and the loop fails mid-run. Also re-introduces a plaintext
  on-disk credential — the exact thing the Keychain move removed.
- **Switching the consumer to the `mac-host` profile.** Works (the host `claude`
  reads the Keychain directly), but trades away container isolation for every
  iteration, and the `mac-host` variant is authored for iOS/Xcode projects —
  wrong prompts for a non-iOS consumer. Profile choice should not be forced by an
  auth gap.

## Decision

Forward a long-lived subscription token into the container as the
`CLAUDE_CODE_OAUTH_TOKEN` env var, injected through `containerEnv` in
`.sandcastle/main.mts`. The operator generates the token once with
`claude setup-token` (a ~1-year token tied to the Pro/Max subscription) and
exports it — e.g. via a gitignored `.sandcastle/.oauth.env` the launch sources.

Load-bearing choices:

- **`containerEnv`, not `envForModel` / per-call agent env.** `containerEnv`
  seeds the sandbox env for *both* `topLevelRun` (planner, merger) and
  `createSandbox` (implementer, reviewer) via `buildSandboxProvider`. The
  per-call `claudeCode(model, { env })` channel does **not** survive into
  `handle.run` — the SDK's `createSandbox.js` hardcodes `agentProviderEnv: {}`
  (see the `RunHandle` note in `main.mts`). Injecting at `containerEnv` is the
  only single point that reliably reaches every agent, and the planner — which
  fails first — has no per-call env source at all (its `deps.run` call passes no
  `env`).

- **No-op when unset.** Gated `oauthToken && oauthToken.trim() !== ""`. A host
  that doesn't set it (the Linux VPS, where the file-mount still works; any CI
  using an API key) gets identical behavior to before — zero cost when unused.
  This asymmetry is what makes it template-worthy, matching the ADR 0010 bar.

- **A subscription token, not an API key.** `setup-token` issues a long-lived
  *subscription* OAuth token; it bills against the plan quota, not pay-per-token
  API. It also doesn't rotate on the short cycle the Keychain access token does,
  so it won't go stale mid-loop. (Note: `ANTHROPIC_API_KEY`, if also set, would
  win over the OAuth token and bill per-token — keep it unset for the
  subscription path.)

## Consequences

- The fix propagates to every consumer via `/sandcastle-update` and is a safe
  no-op for any host without `CLAUDE_CODE_OAUTH_TOKEN`. A consumer's
  `.sandcastle/main.mts` is gitignored (managed file), so this is the only
  durable home for the change — local edits there are overwritten on next update.

- **mac-host is unaffected and needs no token.** It runs `claude` on the host,
  which reads the Keychain directly. The env var is harmless if present.

- **`.sandcastle/.oauth.env` is now gitignored** in the template so consumers
  can't accidentally commit a token. The launch must source it (or otherwise
  export the var) so it reaches the orchestrator's `process.env`.

- **Billing caveat (June 15 2026 change).** Anthropic is moving Agent-SDK /
  headless / `claude -p` usage off the flat subscription limit onto a separate
  metered credit pool ($20 Pro / $100 Max 5x / $200 Max 20x at API rates, no
  rollover). The sandcastle loop is a programmatic Agent-SDK driver, so after
  June 15 a subscription-authenticated run draws from that credit pool, not the
  interactive subscription quota — regardless of this token mechanism or the
  docker/mac-host choice. This ADR makes auth *work*; it does not change that
  economics.

- **Verification.** Proven end-to-end on a real consumer (career-ops, docker /
  minimal profile, macOS host) on 2026-06-10: with the token exported, a
  `--dry-run` smoke run got the **planner** past login (produced a plan and
  claimed an issue under dry-run) *and* the **implementer** authenticated and
  began real work ("Agent started" → step-by-step file edits), with no
  `Not logged in`. The run was killed before any push. The template repo has no
  token, so the live check is reproducible only on a consumer after pickup via
  `/sandcastle-update`.
