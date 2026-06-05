# ADR 0010 — Sandcastle: register the context7 MCP in-container via a fail-closed boot hook

**Status:** Accepted
**Date:** 2026-06-05

## Context

The implementer benefits from live, version-correct library docs while coding;
context7 is an HTTP MCP that provides them. Affinity-tracker had been registering
it locally (consumer commit `d343f7c27`), but that registration lived *inside*
`main.mts` — the one file `/sandcastle-update` overwrites every run — so it was a
"must-keep" that had to be hand-re-applied on every update. Every other affinity
must-keep is a local-ahead file the surgical-update path preserves automatically;
this one alone kept getting clobbered. Upstreaming it removes that recurring
burden, and the capability helps any consumer, not just affinity.

The obvious alternative — let the host's MCP config flow into the sandbox — does
not work. The loop bind-mounts the `~/.claude` *directory* but **not** the sibling
`~/.claude.json` *file*, which is where user-scope MCP registrations live. So a
context7 registered on the host never reaches the container. And the key cannot be
baked at image-build time: build-time has no access to the project's secrets (the
same env-at-build limitation that ruled out a build-time Plaid marker), and
`~/.claude.json` is per-container anyway.

## Decision

Register context7 from inside the container, at sandbox boot, as an
`onSandboxReady` hook (`REGISTER_CONTEXT7_MCP_COMMAND` in `.sandcastle/main.mts`).
The command runs `claude mcp add --scope user --transport http context7` against
`https://mcp.context7.com/mcp`, reading the key from `$CONTEXT7_API_KEY`.

Load-bearing choices:

- **Key by forwarded env var, resolved in the boot shell.** The loop already
  forwards every root-`.env` key into the container as a docker env var
  (`readProjectEnv` → `containerEnv`), so `$CONTEXT7_API_KEY` is present at boot.
  Resolving it in the shell avoids any dependency on `${ENV}` expansion inside
  `~/.claude.json`. `--scope user` writes the container's own
  `/home/agent/.claude.json`; the host config is never touched.

- **Fail closed.** The command is guarded `if [ -n "$CONTEXT7_API_KEY" ]` and ends
  `>/dev/null 2>&1 || true`. A project without the key gets graceful absence — no
  context7, no error, no behavior change — so the hook cannot break an existing
  slice. This asymmetry (zero cost when unused) is what makes it template-worthy,
  unlike a baked binary that every consumer would carry whether they use it or not.

- **Per-boot, not build-time.** Required, not a preference: the key is unavailable
  at build and `~/.claude.json` is per-container. Ordered *before* `CI=true pnpm
  install` because it depends only on the baked-in `claude` CLI and the env var,
  not on the project's `node_modules`, so it registers as soon as the box is up.

- **Concrete, not generalized.** We ship context7 hard-coded, deliberately *not*
  a generic "register any MCP from a forwarded env key" mechanism. One MCP does
  not earn the abstraction; generalizing now would be speculative generality. The
  seam is recorded here so a future maintainer knows the intended path — see
  Consequences.

## Consequences

- The registration moves from an affinity must-keep into the template; it
  propagates to every consumer via `/sandcastle-update` and is a safe no-op for
  any consumer without `CONTEXT7_API_KEY`.

- **mac-host gets no context7.** The hook lives on the docker path
  (`dockerHooks.sandbox.onSandboxReady`); mac-host has no `onSandboxReady` concept.
  This is acceptable — mac-host runs `claude` from the host, where the operator's
  own `~/.claude.json` already carries their MCPs, so in-container registration is
  unnecessary there. If mac-host ever needs it, that is a new seam, not a
  regression here.

- **Silent failure is an accepted tradeoff.** `|| true` plus `>/dev/null 2>&1`
  means a broken registration (e.g. a future `claude mcp add` flag change, or a
  context7 endpoint change) is invisible in the orchestrator stream. This is
  intentional: a registration failure must not abort the boot chain. The mitigation
  is **not** to un-silence the command (that trades boot-safety and the
  affinity-proven, verbatim string for visibility) but a **verification path**: a
  consumer with a key should confirm a *real* context7 tool call returns data —
  `claude mcp list` only pings the endpoint without validating the key, which
  masked an earlier reverted approach's auth failure.

- **Generalization trigger.** When a second MCP needs the same treatment, replace
  the single `REGISTER_CONTEXT7_MCP_COMMAND` const with a small mechanism that
  emits one `claude mcp add` per (name, url, env-key) entry, each individually
  fail-closed. Until then the concrete version stays.

- Tests are source-level (`tests/main.test.ts`): four structural assertions on the
  command string (fail-closed guard, user-scope HTTP transport, endpoint, header,
  silenced/`|| true`) plus one assertion that the entry is actually wired into the
  `onSandboxReady` array. The `dockerHooks` literal is `as const` and only flows
  into `buildSandboxProvider` — it never reaches the returned `Deps` — so a
  behavioral assertion is not cleanly reachable without standing up the provider;
  the source-level wiring check is the pragmatic equivalent, matching the existing
  `prompt-contract.test.ts` source-assertion pattern.

- **Rollout:** the in-image proof (key set → real context7 tool call resolves a
  library id) was done on the affinity image per the originating proposal; it is
  not reproducible in this template repo (no key here). A consumer with a key
  should run that live check after picking the change up via `/sandcastle-update`.
