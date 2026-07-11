# ADR 0018 — Sandcastle: test-cert gate (reviewer runs the suite, host checks the cert)

**Status:** Accepted
**Date:** 2026-07-11

## Context

The same `/sandcastle-feedback` audit behind ADR 0017 flagged a second hole: a reviewer
approved code that shipped a **failing test** (issue #125). No gate ever ran the tests —
the only test signal was self-reported by the implementer and never verified. A cert-only
check (host greps a token) would not have caught it, because #125's implementer falsely
self-reported passing tests.

The obvious fix — have the host execute the suite — was prototyped and **rejected** (see
ADR 0017's "Related / deferred" note and the exploration that followed):

- There is **no in-sandbox exec API**: `SandboxHandle.run()`/`.interactive()` are
  agent-only, with no method to run a plain command and read `{exitCode, stdout, stderr}`
  (`main.mts:263-268`, SDK `index.d.ts:733-746`).
- **Host-side execution is wrong for docker** — the profile #125 happened on. The docker
  worktree's `node_modules` is installed *inside the linux container* (`CI=true pnpm
  install`, `main.mts:2432`); running those linux-native modules on the macOS host is
  broken, and `pnpm run` against a copied store trips
  `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`. Tests only run correctly *inside* the
  sandbox, which has no exec surface.

## Decision

Mirror the existing **lint-cert gate** (ADR-less, `classifyLintCert` + `checkLintCert` +
the implement/review prompt contract) for tests. The suite RUN happens in-sandbox where it
actually works — but by the **reviewer**, a separate adversarial model, not just the
implementer — and the host keeps a deterministic cert-presence backstop.

1. **Implementer** (`implement-prompt.md`): run the `test` script green, then certify
   `SANDCASTLE-TEST: pass` (or `n/a` when there's no `test` script) in the commit body
   with a quoted passing summary — exactly the lint-cert pattern.

2. **Reviewer** (`review-prompt.md`, new "Test suite" CATEGORY SWEEP category): must
   **actually run the suite** and reject a red or uncertified one as a HARD finding. This
   is the step that was missing when #125 slipped — a cert alone is trusted; a re-run is
   ground truth. Narrow escape hatch: a suite genuinely too slow to finish in one pass
   degrades to re-running only the diff-touched tests + reasoning about the cert — never a
   blanket skip of a fast suite.

3. **Recovery** (`recovery-prompt.md`): mirrors the cert so recovered commits don't
   false-quarantine on the new gate (the exhaustive-sibling rule).

4. **Host gate** (`main.mts`, `checkTestCert` in `shipAfterMigrations`): a 1:1 mirror of
   `checkLintCert` — `TEST_CERT_TOKEN`, `commitMessageHasTestCert`, `hasTestScript`, pure
   `classifyTestCert` (shares `hasCodeDiff`, so lint/test dormancy can't drift). Reads the
   commit body by SHA (git-object-based, so `repoRoot` is correct — no working-tree
   execution, which is what broke the abandoned approach). `missing` on a code-bearing
   diff → quarantine, placed after the lint gate and before the migration gates so an
   uncertified diff never touches the dev DB.

## Consequences

- Catches the #125 failure mode on **both** profiles: the reviewer runs the suite in the
  sandbox that already has a working environment, so a red test surfaces as `HAS_BLOCKERS`
  instead of shipping.
- **Cost:** every review pass on a test-enabled project now re-runs the suite (a real
  latency/compute regression, the price of ground truth over a trusted cert).
- **Slow-suite risk (mitigated, not eliminated):** the reviewer is a cheap one-shot Haiku
  model. A pathologically slow suite could exhaust its pass and emit no verdict → ADR
  0017's no-verdict retry+defer absorbs it, but only for `MAX_DEFERRALS` cycles before real
  quarantine. The prompt escape hatch (degrade to changed-tests-only on a genuinely slow
  suite) is the primary guard; the ADR 0017 defer is the secondary net. Fast unit suites
  (the common case, and #125's) stream output, reset the idle timer, and finish well inside
  the 600s reviewer timeout.
- **Persistent-dev-DB caveat:** a schema-changing issue on a project whose test suite reads
  a *shared persistent* dev DB (rather than an ephemeral/pushed test DB) can fail the
  reviewer's run environmentally — migrations apply only after ALL_CLEAR, so the reviewer's
  suite runs pre-migration. The common Drizzle pattern (ephemeral/pushed test DB) is
  unaffected, and the implementer hits the same wall first. Documented, not fixed.

## Alternatives considered

- **Host executes the suite** (in `sandbox.worktreePath`). Rejected: wrong `node_modules`
  platform for docker + the pnpm-symlink abort; can't cover the profile #125 happened on.
- **Add a real `exec()` to both sandbox providers.** Rejected for now: the docker path is
  SDK-backed with no exec surface, so it would need docker-exec-into-container plumbing —
  large, fragile, uncertain. If the SDK later exposes exec, a machine-verified exit-code
  backstop can be layered on top of this cert gate without redoing it.
- **Cert-only (host greps a token, nobody re-runs).** Rejected: this is exactly what
  failed on #125 (a false self-report). The reviewer re-run is the whole point.
