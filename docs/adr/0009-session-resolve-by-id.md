# ADR 0009 — Sandcastle: resolve the skill-discipline session JSONL by id, retiring the hand-mirror

**Status:** Accepted
**Date:** 2026-06-05
**Supersedes:** ADR 0007's deferred item "Adopt the SDK's now-public path helpers in `resolveSessionFilePath`" and its Consequence "the hand-mirror in `skill-discipline.ts` stays, now guarded against drift".

## Context

ADR 0007 (2026-06-04) **deferred** adopting the SDK's public path helpers in
`resolveSessionFilePath`, keeping a hand-mirrored `encodeProjectPath` plus a
drift-guard test as a "live canary." The deferral rested on two judgments:
(1) a path regression would be a *loud* false-quarantine, not a silent ship, so
it was low-risk to wait; and (2) the drift-guard would catch any divergence
between our encoder and the SDK's. Revisit was gated on "an integration test
that exercises real session capture."

One day later the affinity-tracker consumer reported (sandcastle-feedback,
2026-06-05) that the gate was false-quarantining *every* typed issue on *every*
container run. Root cause: `resolveSessionFilePath` reconstructed the session
path from the **host** repoRoot cwd slug (e.g. `-home-deploy-dev-affinity-tracker`),
but Claude Code runs inside the sandbox at a different cwd and writes its session
JSONL under the **container** slug (e.g. `-home-agent-workspace`). The two slugs
can never match → file not found → `extractSkillInvocationsFromSession` returns
`[]` → `MissingRequiredSkillsError` → quarantine. The project functioned only by
carrying a local "must-keep" patch hardcoding the container cwd at both call sites.

This invalidates two of ADR 0007's premises:

- The deferral treated the loud false-quarantine as a *tolerable* wait-state. In
  practice it broke the gate outright for the entire class of container consumers
  — the primary deployment shape — masked only by an out-of-tree patch.
- The drift-guard was **not** a canary for this failure. It asserted our encoder
  equals the SDK's `claudeHostSessionPath`, but both encode the *host* cwd, so
  both agreed and both produced the wrong (host) slug for container runs. The
  guard was structurally blind to the host-vs-container cwd mismatch; it could
  only have caught an SDK *encoding* change, never a *cwd-domain* mismatch.

The "real session capture integration test" precondition is therefore moot: the
production failure is the evidence that precondition was meant to wait for, and
it points the opposite way — the hand-mirror is the bug, not the safeguard.

## Decision

Resolve the session JSONL by the iteration's **globally-unique `sessionId`**, not
by reconstructing a cwd-derived path. Delegate to the SDK's public
`findClaudeSessionOnHost(id, projectsDir?)` (0.7.0), which scans every
`~/.claude/projects/<slug>/` for `<id>.jsonl` and returns the first match. The
session id is the one key stable across the host/container boundary, so slug
naming becomes irrelevant and the host / container / mac-host profiles are all
handled by one path.

Consequently:

- `resolveSessionFilePath` becomes `async` (`Promise<string | undefined>`); both
  call sites (`.sandcastle/main.mts` implementer gate + post-merge fixer gate)
  `await` it. Invocation order is preserved (sequential awaits in the existing
  `for...of`).
- The hand-mirrored `encodeProjectPath` helper is **deleted** — there is no
  longer any encoding to mirror.
- The drift-guard test is **removed** — not because drift stopped mattering, but
  because there is nothing left to drift: path encoding now lives entirely inside
  the SDK helper we call, and the by-id resolution tests exercise that helper
  directly.
- We deliberately did **not** thread the SDK's internal `SANDBOX_REPO_DIR`
  constant (the consumer proposal's literal suggestion). It is not part of the
  SDK's public type surface and only encodes the *default* container cwd
  (`/home/agent/workspace`), which `podman.js` shows is overridable — so it would
  re-encode a brittle assumption rather than remove one.

ADR 0006's fail-loud contract is preserved: when no session file is found,
`extractSkillInvocationsFromSession` returns `[]` and the v3 hard-throw gate still
quarantines loudly — no silent abstention is introduced.

## Consequences

- The container false-quarantine is fixed for all consumers without a local
  patch; mac-host is covered by the same code path.
- ADR 0007's Consequence "the hand-mirror in `skill-discipline.ts` stays, now
  guarded against drift" no longer holds; both the mirror and the guard are
  retired (this ADR supersedes that line; ADR 0007 carries a forward pointer).
- Test coverage shifts from "our encoder matches the SDK's" (string equality) to
  "resolution finds the file regardless of slug" (container slug, mac-host slug,
  absent-id) against the real SDK helper — closer to the behavior that matters.
- Open follow-up, **separate repo**: `@ai-hero/sandcastle` should emit a loud
  warning when it skips session capture because `bindMountHandle` is undefined,
  instead of leaving `sessionFilePath` unset. Tracked as a separate report; not
  part of this template change.
- **Rollout caveat:** a consumer must not drop its local must-keep cwd patch
  until a single instrumented run (`--iterations 1 --issue N`) on a real
  container confirms the resolved path matches the in-container session and a
  typed issue is credited (not quarantined). The in-repo tests verify the
  resolver unit; the end-to-end container path is evidenced by the proposal's
  live probe and confirmed by that smoke run.
