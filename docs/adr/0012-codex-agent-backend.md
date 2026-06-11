# ADR 0012 — Add OpenAI Codex as a second agent backend (with a Codex-native discipline gate)

**Status:** Accepted — Phase 0 spike **GO** (2026-06-10)
**Date:** 2026-06-10

## Context

ADR 0011's billing caveat is now the driver. From June 15 2026 Anthropic moves
Agent-SDK / headless / `claude -p` usage off the flat subscription onto a
separate metered credit pool at API rates. The sandcastle loop is a programmatic
Agent-SDK driver, so after June 15 every subscription-authenticated Claude run
draws from that pool — making the operator's overnight loop no longer
cost-viable on Claude. The operator wants the loop driven by **OpenAI Codex
itself**, on their **ChatGPT subscription**, at full parity with the Claude path.

The migration surface is far smaller than "rewrite the loop," because three
layers are already backend-agnostic — verified directly, not assumed:

- **The SDK already speaks Codex.** `@ai-hero/sandcastle` v0.7.0 exports
  `codex(model, opts)` parallel to `claudeCode(...)`, plus `findCodexSessionOnHost`
  / `transferCodexSession`. No fork needed. [VERIFIED: `dist/index.d.ts:179,52,58`]
- **Viewer + status feed are decoupled.** They read the custom `.sandcastle/status.json`
  (zod schema, no Claude parsing) and survive a backend swap untouched. [VERIFIED]
- **The verdict layer is provider-agnostic.** The SDK normalizes both Claude
  `stream-json` and Codex `codex exec --json` into the same final-text
  `RunResult.stdout`; `parseVerdict` already runs in `alreadyAssistantText` mode.
  The verdict is a *prompt contract*, not a Claude artifact. [VERIFIED: `main.mts:2691`]

The Claude coupling that remains is localized: `sandbox-provider.ts` (the two
`claudeCode()` call sites), `mac-host-sandbox.ts` (spawns the `claude` binary),
`models.ts`, `providers.ts` (codex was deliberately excluded with a comment),
the `Dockerfile` (installs `claude`), and `skill-discipline.ts` (parses Claude
session JSONL for `Skill` tool_use blocks via `findClaudeSessionOnHost`).

Two alternatives were weighed and rejected:

- **Hard-swap to Codex-only.** Simpler final code, but throws away the working
  Claude/Kimi/GLM backends, kills the ability to build the port *using* the
  still-free pre-June-15 Claude window, and regresses any consumer still on
  Claude. Rejected for a backend-agnostic addition.
- **Disable skill-discipline under Codex.** Skills are a Claude Code construct;
  under Codex there are zero `Skill` invocations to count, so the existing gate
  and the `{{REQUIRED_SKILLS}}` prompt scaffolding (ADR 0006 v3.2) measure
  nothing. The cheap path is to disable the gate for Codex and lean on
  critique-as-gate + the lint gate (both provider-agnostic). Rejected by the
  operator in favor of a real Codex-native gate, which is feasible because Codex
  has its own SKILL.md skill system and an AGENTS.md instruction layer.

## Decision

Add Codex as a **backend-agnostic** agent backend alongside the existing
providers, not a replacement.

1. **Backend dispatch.** Introduce an explicit *agent backend* axis (which
   agent binary/SDK factory drives a run: `claudeCode` vs `codex`), distinct
   from the existing *provider* axis (which Anthropic-compatible endpoint/auth:
   anthropic/kimi/glm). Route both `sandbox-provider.ts` call sites through one
   `agentForModel()` helper that returns `sandcastle.codex(...)` or
   `sandcastle.claudeCode(...)` by backend.

2. **Subscription auth, forwarded as a refreshable file.** Use `codex login`
   (ChatGPT subscription); the token lives at `~/.codex/auth.json`. Forward it
   into the container by **adding `~/.codex` to `AUTH_MOUNTS` read-write** — NOT
   the static-env-var approach of ADR 0011. The contrast is load-bearing: ADR
   0011 forwarded a long-lived *env token* because Claude hid its credential in
   the macOS Keychain (unmountable); Codex keeps a plain *file* the CLI may
   **rewrite on token refresh mid-run**, so a read-only mount would die at the
   first refresh. `AUTH_MOUNTS` mounts read-write by default, so the existing
   mechanism fits. API-key auth is the fallback only — it is metered at API
   rates and would defeat the cost purpose. [SPIKE CONFIRMED: `~/.codex/auth.json`
   has `auth_mode:"chatgpt"` (subscription), `OPENAI_API_KEY` empty (no per-token
   billing), and a `refresh_token` + `last_refresh` — so the CLI *does* rewrite
   the file on refresh, making the read-write mount mandatory. In-container
   read+refresh is re-confirmed in the docker container-auth probe.]
   **Decision (locked): a shared read-write bind-mount of `~/.codex`, NOT
   per-sandbox copy-in.** The discriminator is the loop's concurrency: it runs
   up to `maxConcurrent` (default 3) sandboxes at once (`main.mts` semaphore,
   `Promise.allSettled` over the plan), all sharing the one auth file. Under
   OAuth refresh-token rotation, copy-in is the WORSE model — each sandbox holds
   its own copy, so the first to rotate invalidates every sibling AND the host
   (a permanent desync needing a manual `codex login`); the shared mount instead
   converges everyone on one always-current file. Its only residual risk is a
   transient race if two sandboxes refresh in the same instant, and that
   self-heals at the file level on the next read. So bind-mount **dominates**
   copy-in whether or not the token rotates — which makes rotation
   documentation-only, not a decision gate (see Verification). Container uid 1001
   can write the mount (verified). The earlier "copy-in wins on isolation" framing
   is withdrawn: it assumed independent single-sandbox runs; under shared-file
   concurrency, isolation is exactly what breaks copy-in.

3. **Codex-native discipline gate.** The required design-principle skills already
   live at `~/.claude/skills/<name>/SKILL.md` and are bind-mounted into every
   container via `AUTH_MOUNTS` — so they are reachable in-container with **no
   separate install** (the earlier "port the skills to a Codex skills dir" plan
   was an over-specification; WS-C used `~/.codex/skills/` only to *test the
   detector*, which keys on the `skills/<name>/SKILL.md` path **anywhere**, not on
   a fixed prefix). Codex has no `Skill` tool, so AGENTS.md (its instruction
   layer, read before any work) tells the agent that the **shell-read** of a
   required skill's `SKILL.md` IS its invocation — that read both loads the rubric
   and trips the gate. Verify invocation by parsing the Codex session **rollout
   JSONL** (`findCodexSessionOnHost` → `rollout-*-<id>.jsonl`) — the observation
   mechanism that mirrors the Claude gate. A prompt-emitted attestation marker, parsed from the verdict stdout,
   serves as the provider-agnostic cross-check/fallback. [SPIKE CONFIRMED: the
   Codex rollout JSONL uses its own schema — `session_meta` / `event_msg` /
   `response_item`, each with a `payload.type` discriminator. The agent's final
   text is a `response_item` with `payload.type:"message"`, `role:"assistant"`,
   `content[].type:"output_text"` (also surfaced as `event_msg.task_complete.last_agent_message`).
   Tool/skill invocations appear as `response_item`s with a function/tool
   `payload.type` (not the Claude `tool_use` block) — the WS-C parser keys on
   that. One real skill-invocation sample is captured in WS-C against an actual
   Codex SKILL.md run.]

## Consequences

- **Spike result: GO.** Codex (codex-cli 0.139.0, subscription auth) ran
  `codex exec` headless and emitted the marker + a JSON verdict envelope that
  **round-trips through the loop's real `parseVerdict(ImplementerOutputSchema)`**
  (`PARSE OK`). One concrete prompt-tuning item surfaced: `extractMarker` reads
  the terminal marker off the *last* non-empty line, so for the marker-only
  flows (reviewer / critique / recovery) the Codex prompts must place the marker
  last. Harmless for the implementer *success* path, which the loop already
  guards with a try/catch and relies on `parseVerdict` (`main.mts:2709`). This
  is a WS-D detail, not a blocker — so the provider/gate/test workstreams fan
  out in parallel as planned.

- **Cost is subscription-metered by plan caps, not unlimited.** ChatGPT Plus has
  tighter limits; Pro has real headroom. A heavy overnight loop can exhaust Plus.
  And OpenAI explicitly steers automation toward API keys and is actively
  reworking headless-subscription auth (open issue openai/codex#3820) — so the
  subscription-headless path could tighten the way Anthropic's just did. This
  ADR makes Codex *work*; it does not guarantee the economics stay favorable.

- **Parity holds on the decoupled layers.** Viewer, status feed, and verdict
  parsing need no change. As already noted for Kimi/GLM, the status feed's
  cost field stays best-effort — SDK `usage` may be absent for Codex too.

- **No-op for non-Codex hosts.** Like ADR 0010/0011, the `~/.codex` mount and
  codex backend are inert unless a run selects the Codex backend, so
  Claude/Kimi/GLM consumers are unaffected and inherit the change safely via
  `/sandcastle-update`.

- **Verification.**
  - [DONE — Phase 0 spike, 2026-06-10] Subscription auth (`auth_mode:"chatgpt"`,
    no API key); `codex exec` headless exit 0; output round-trips through the
    real `parseVerdict` (`PARSE OK`); rollout JSONL schema captured
    (`response_item`/`event_msg`/`session_meta`); `token_count` present so Codex
    usage is parseable (a parity bonus over Kimi/GLM).
  - [DONE — container-auth, 2026-06-10] Image built with `codex-cli 0.139.0`
    baked in (exit 0). With `~/.codex` bind-mounted (Option A), Codex
    **authenticates inside the container** (`codex exec` exit 0, replied `READY`,
    no "not logged in"), and the **container user (uid 1001) can write the
    mounted file** (`WRITE_OK`) — so on macOS Docker Desktop the uid mismatch
    does NOT block a refresh write. Staged check #2 resolved ✓.
  - [RESOLVED — auth mechanism, 2026-06-10] Production mechanism locked: a
    **shared read-write bind-mount** of `~/.codex` (not per-sandbox copy-in). The
    decision is settled by analysis, not by observing a refresh — the loop runs up
    to `maxConcurrent` (default 3) sandboxes concurrently sharing the one auth
    file (`main.mts:733`, `:4496` semaphore + `Promise.allSettled`), and that
    concurrency is the real discriminator. Under refresh-token rotation, copy-in
    is the WORSE model: each sandbox's copy holds the same `refresh_token`, so the
    first to rotate invalidates every sibling AND the host (permanent desync). The
    shared mount converges everyone on one always-current file; its only residual
    risk is a transient same-instant refresh race that self-heals at the file
    level on the next read. So bind-mount **dominates** copy-in whether or not the
    token rotates — rotation no longer gates the decision. Whether the
    `refresh_token` actually rotates is now informational only; if observed during
    the live full-loop run (it crosses an access-token expiry), record it here as
    an audit note, but it changes nothing. Container uid 1001 can write the mount
    (container-auth probe above). Code/comment: `sandbox-provider.ts` `AUTH_MOUNTS`.
  - [DONE — integration build, 2026-06-10] Full backend built across WS-A…F:
    `providers.ts` backend axis, `sandbox-provider.ts` `agentForModel` dispatch +
    `~/.codex` mount, `Dockerfile` codex install, `models.ts` `codexModels`,
    `main.mts` `--backend codex` flag, mac-host codex spawn path, the
    Codex-native skill-discipline gate (`codex-session.ts` parses `function_call`
    shell-reads of `skills/<name>/SKILL.md` — Codex has no Skill tool; wired into
    `main.mts`'s two skill-extraction call sites), the marker-ordering prompt fix,
    and `AGENTS.md` (delivered to the codex agent's cwd at sandbox boot via a
    codex-only, no-clobber, git-excluded hook — it won't overwrite a consumer's
    own root `AGENTS.md`, and the agent can't commit our copy). Delivered on
    BOTH paths: docker via the `onSandboxReady` hook, and mac-host via
    `stageCodexAgentsMdIntoWorktree` in the per-sandbox `run()` (worktree path
    only — never the top-level run, whose cwd is the operator's real repo root).
    Also fixed a latent gap: the post-merge fixer model now
    routes through the run backend (was hardcoded to `models.postMergeFixer`).
    **Verified: `tsc --noEmit` exit 0; full `vitest run` = 650 passed / 28 files,
    0 failures** (incl. 9 codex-backend, 28 mac-host, 46 skill-discipline).
  - [PENDING build] Docker full-loop e2e: one issue end-to-end on `--sandbox
    docker --backend codex` against a target repo → parseable verdict + clean
    merge; the native gate passes a disciplined run and quarantines an
    undisciplined one. (Needs a target repo — deferred per the operator.)
  - [RESOLVED — stdout, 2026-06-10] The "0 lines to stdout" was an artifact of
    my probe (the `-o` flag diverts the message, and an unclosed stdin makes
    `codex exec` hang on "Reading additional input from stdin"). Run SDK-style
    (`codex exec --json`, no `-o`, stdin closed) it emits the agent text in
    `item.completed`/`agent_message` events, and the SDK's `parseCodexStreamLine`
    (dist:2924) matches that exact schema → builds `RunResult.stdout` from it →
    `parseVerdict` gets real text. So the loop *does* drive Codex to a readable
    verdict; chain verified part-by-part. [The SDK pipes the prompt via stdin and
    closes it, so it does not hit the hang.] Full docker e2e still the ultimate
    confirmation (deferred with the target-repo run).
  - [FIXED — escalation routing, advisor #2] The retry ladder + post-merge fixer
    read `models.X` directly at ~4 sites, so `--backend codex` would have
    escalated a failed attempt onto a Claude model. Now threaded via
    `args.backend` + `roleModelsFor()`. Consequence: Codex has an empty
    escalation ladder, so a codex run does NOT model-escalate on failure (it
    quarantines) — intended for now; a Codex escalation tier is a follow-up.
    Locked by a test asserting `codexModels[*].escalations === []`.
  - [FIXED — advisor #4] The AGENTS.md hook wrote `.git/info/exclude` by literal
    path, which fails in a worktree (`.git` is a file there). Now resolved via
    `git rev-parse --git-path info/exclude`.
  - [RESOLVED — skills delivery, 2026-06-10] No in-container skills install is
    needed. The gate's detector keys on a `skills/<name>/SKILL.md` path **anywhere**
    in a shell command (`codex-session.ts` `SKILL_MD_PATH`, prefix-agnostic), and
    the required skills already exist at `~/.claude/skills/<name>/SKILL.md`, which
    is bind-mounted into every container via `AUTH_MOUNTS` (and is the host's real
    home on the mac-host path). So the skills are already reachable; the only gap
    was that the shared implement-prompt STEP 0 is written in Claude `Skill()`
    terms, which Codex (no `Skill` tool) cannot execute. Fixed in AGENTS.md (the
    Codex-only instruction layer): a "Skill discipline" section tells the agent
    that the **shell-read** of a required skill's `SKILL.md` — repo-local
    `.claude/skills/<name>/SKILL.md` first, else `~/.claude/skills/<name>/SKILL.md`
    — IS the invocation, mandatory per-attempt for every name in the required list;
    that read both loads the rubric and trips the gate's detector. The earlier
    "install into `~/.codex/skills/`" framing was an over-read of WS-C, which used
    that path only to exercise the detector. Behaviour end-to-end (does Codex
    reliably read each required skill before coding?) is confirmable only in the
    live full-loop run against a `SANDCASTLE.md` consumer; the wiring is correct.
