# Follow-ups

Open items deferred from prior sessions. Address when convenient — neither blocks overnight runs, but #1 is silently expensive.

## 1. Verdict parser fails on Sonnet/Opus stream-json output

**Severity:** Medium. Pipeline still ships via the recovery flag, but recovery is firing on every issue instead of just the genuinely failing ones. That doubles the Opus invocation rate (recovery uses Opus by default), so cost-per-night roughly doubles.

**Observed:** `2026-05-08` smoke test on issue #82, see `git log agent/issue-82`. Implementer (Sonnet) wrote the test, committed `2a5e4f528`, and emitted a valid STORY_COMPLETE envelope to stdout. The verdict parser then threw:

```
ERROR: [issue=82] pipeline error: No assistant text could be extracted from the input.
Either the stream-json blob has no `assistant` envelopes or it's malformed.
```

The "offending text" the parser printed was a perfectly well-formed envelope — the JSON, the marker, and `<promise>COMPLETE</promise>` all present. So the issue isn't in the implementer's output; it's in how `parseVerdict` walks the stream-json blob.

**Where to look first:** `.sandcastle/lib/verdicts/parse.ts` — `parseVerdict` and `extractAssistantText`. The function expects Claude Code's stream-json shape with `type: "assistant"` envelopes. The CLI's output format may have changed (this is unverified — could be a newer CLI version or Sonnet/Opus emitting a different shape than what the parser was originally tuned for).

**Possible fixes:**
- Run a one-shot capture of Claude Code's actual stream-json output for the implementer prompt and diff against the parser's expectations.
- Make `extractAssistantText` more permissive: fall back to "treat the whole blob as assistant text" when no `assistant` envelopes are found, instead of throwing.
- Add a unit test using the actual offending text from issue #82 (~/Dev/Sandcastle/.git logs may still hold it; or re-run with `--issue` and capture).

**Why it matters:** Without this fix, every issue triggers recovery, which is supposed to be the rare rescue path. Recovery is correctly catching the failures, but it's masking a parser bug that's making the loop cost ~2x what it should.

## 2. Merge phase fails on corepack download prompt

**Severity:** Low. Per-issue pipeline still ships; only the post-issue merge step fails. The merge step combines all completed branches into the worktree's branch (e.g. `feat/agent-budgeting`); without it, you'd manually merge `agent/issue-82` into `feat/agent-budgeting` after the loop finishes.

**Observed:** Same `2026-05-08` smoke test:

```
ERROR: merge phase threw: Command failed (exit 1): pnpm install
! Corepack is about to download https://registry.npmjs.org/pnpm/-/pnpm-10.19.0.tgz
```

Affinity-tracker's `package.json` likely has a `packageManager: "pnpm@10.19.0"` field. Corepack needs to download that exact version into the container. By default it prompts for confirmation, which fails non-interactively.

**Possible fixes (in order of effort):**
- Set `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` as an env var in the Docker image (`.sandcastle/Dockerfile`).
- Pre-install pnpm 10.19.0 into the image during build (`RUN corepack prepare pnpm@10.19.0 --activate`).
- Pass the env var through `buildDefaultDeps` instead of baking into the image (more flexible per-project).

**Where to look:** `.sandcastle/Dockerfile` — corepack is enabled there but not pre-warmed.
