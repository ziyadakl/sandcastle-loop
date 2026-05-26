# Orchestrator Hot-Reload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a recovery agent commits a fix to one of the orchestrator's own helper files mid-run, the next iteration must execute the fixed code, not the stale in-memory copy.

**Architecture:** The long-lived orchestrator process detects whether any file it statically imports has changed on disk since startup. When a change is detected, the orchestrator finishes the current iteration, writes the remaining iteration count to a marker file, and exits with code `75`. A small shell wrapper around `tsx .sandcastle/main.mts` loops on exit code 75, re-running with the remaining-iterations count carried through via an env var. Everything else (lock file, issue labels, worktrees) is already on disk or GitHub and is re-read by the new process.

**Tech Stack:** TypeScript (Node ≥22, ESM), vitest, bash, `tsx`. Existing `Deps` injection seam in `.sandcastle/main.mts:266` is the test-injection point for the orchestrator-level test.

**Reference evidence:**
- Static-import sites: `.sandcastle/main.mts:48-52` (migrations), `:38-45` (state), `:46-47` (verdicts), `:53-58` (models/diagnose/skill-discipline), `:59-64` (providers)
- Iteration loop: `.sandcastle/main.mts:3238` (`for (let it = 1; it <= args.iterations; it++)`)
- `iterationsRun` counter: `.sandcastle/main.mts:3122,3241`
- `RunMainResult.exitCode` union: `.sandcastle/main.mts:340`
- Main entrypoint that calls `process.exit(result.exitCode)`: `.sandcastle/main.mts:4003-4005`
- Default-deps factory: `.sandcastle/main.mts:1471` (`buildDefaultDeps`)
- CLI parser: `.sandcastle/main.mts:438-540` (`parseSandcastleArgs`)
- Init script that wires `package.json` script: `bin/init.mjs:69`

---

## File Structure

**Create:**
- `.sandcastle/lib/restart-detector.ts` — pure module with `snapshotImportedFiles()` and `detectImportedFileChange()`. Hashes the contents of files the orchestrator statically imports. No git, no fs side effects beyond reading.
- `.sandcastle/sandcastle-wrapper.sh` — bash loop that runs `tsx .sandcastle/main.mts "$@"` and re-runs on exit code 75 with `SANDCASTLE_REMAINING_ITERATIONS` set from the marker file.
- `tests/restart-detector.test.ts` — unit tests for the detector module.
- `tests/wrapper.test.ts` — vitest test that spawns the wrapper as a subprocess and uses `SANDCASTLE_RUNNER` to point at a fake bash stub.

**Modify:**
- `.sandcastle/main.mts` — at the top of `runMain`, snapshot imported files; at the top of each iteration, check for a change and exit 75 if detected; extend `RunMainResult.exitCode` union to include `75`; honor `SANDCASTLE_REMAINING_ITERATIONS` env var in `parseSandcastleArgs` to override `--iterations`; add optional `iterationStartHook` field to `Deps` interface.
- `bin/init.mjs:69` — write `"sandcastle": "bash .sandcastle/sandcastle-wrapper.sh"` instead of `"tsx .sandcastle/main.mts"`. Copy `sandcastle-wrapper.sh` into the consumer's `.sandcastle/` via existing `copyDir`.
- `tests/main.test.ts` — extend the existing `buildDeps` helper to accept `iterationStartHook`, then add an orchestrator-level test that triggers a simulated `.sandcastle/lib/migrations/drizzle-applier.ts` content change on iteration 2's hook and asserts the result is `{ exitCode: 75, iterationsRun: 1 }` plus the marker file was written.

**Real test-helper names (verified by reading `tests/main.test.ts`):** the existing helpers are `buildDeps` (returns `{ state, deps, enqueue }`) and `baseArgs` (returns a `SandcastleArgs` with overrides applied). Use those exact names in any new test.

**Untouched:**
- `.sandcastle/lib/migrations/**` (the contents of the applier are not the problem; the static-import-cache is)
- Recovery agent prompts and SDK invocation paths

---

## Task 1: Restart detector (pure module + unit tests)

**Files:**
- Create: `.sandcastle/lib/restart-detector.ts`
- Test: `tests/restart-detector.test.ts`

The detector hashes the contents of every file the orchestrator statically imports. Two functions: `snapshotImportedFiles(repoRoot)` returns a `Map<string, string>` of `relativePath → sha256`; `detectImportedFileChange(repoRoot, snapshot)` re-hashes and returns the first changed path or `null`.

**Tracked paths** (relative to repo root, glob-expanded at snapshot time):
- `.sandcastle/main.mts`
- `.sandcastle/models.ts`
- `.sandcastle/providers.ts`
- `.sandcastle/lib/**/*.ts`

Prompt files (`.sandcastle/*.md`) are NOT tracked — they're read from disk on every use, so the cached-import bug doesn't affect them.

- [ ] **Step 1: Write the failing test**

Create `tests/restart-detector.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  snapshotImportedFiles,
  detectImportedFileChange,
} from "../.sandcastle/lib/restart-detector.js";

describe("restart-detector", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rd-"));
    mkdirSync(join(root, ".sandcastle/lib/migrations"), { recursive: true });
    writeFileSync(join(root, ".sandcastle/main.mts"), "export {};\n");
    writeFileSync(join(root, ".sandcastle/models.ts"), "export {};\n");
    writeFileSync(join(root, ".sandcastle/providers.ts"), "export {};\n");
    writeFileSync(
      join(root, ".sandcastle/lib/migrations/drizzle-applier.ts"),
      "export const v = 1;\n",
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns null when nothing changed", () => {
    const snap = snapshotImportedFiles(root);
    expect(detectImportedFileChange(root, snap)).toBeNull();
  });

  it("detects a change to a tracked lib file", () => {
    const snap = snapshotImportedFiles(root);
    writeFileSync(
      join(root, ".sandcastle/lib/migrations/drizzle-applier.ts"),
      "export const v = 2;\n",
    );
    const changed = detectImportedFileChange(root, snap);
    expect(changed).toBe(".sandcastle/lib/migrations/drizzle-applier.ts");
  });

  it("detects a change to main.mts", () => {
    const snap = snapshotImportedFiles(root);
    writeFileSync(join(root, ".sandcastle/main.mts"), "export const x = 1;\n");
    expect(detectImportedFileChange(root, snap)).toBe(".sandcastle/main.mts");
  });

  it("ignores changes to prompt files", () => {
    writeFileSync(join(root, ".sandcastle/plan-prompt.md"), "v1\n");
    const snap = snapshotImportedFiles(root);
    writeFileSync(join(root, ".sandcastle/plan-prompt.md"), "v2\n");
    expect(detectImportedFileChange(root, snap)).toBeNull();
  });

  it("treats a deleted tracked file as a change", () => {
    const snap = snapshotImportedFiles(root);
    rmSync(join(root, ".sandcastle/lib/migrations/drizzle-applier.ts"));
    expect(detectImportedFileChange(root, snap)).toBe(
      ".sandcastle/lib/migrations/drizzle-applier.ts",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/restart-detector.test.ts`
Expected: FAIL with `Cannot find module '../.sandcastle/lib/restart-detector.js'`

- [ ] **Step 3: Implement the module**

Create `.sandcastle/lib/restart-detector.ts`:

```typescript
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const TRACKED_TOP_LEVEL = [
  ".sandcastle/main.mts",
  ".sandcastle/models.ts",
  ".sandcastle/providers.ts",
];

const TRACKED_DIR = ".sandcastle/lib";

function walkTs(absDir: string, out: string[]): void {
  if (!existsSync(absDir)) return;
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const abs = join(absDir, entry.name);
    if (entry.isDirectory()) {
      walkTs(abs, out);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(abs);
    }
  }
}

function trackedAbsPaths(repoRoot: string): string[] {
  const out: string[] = [];
  for (const rel of TRACKED_TOP_LEVEL) {
    out.push(join(repoRoot, rel));
  }
  walkTs(join(repoRoot, TRACKED_DIR), out);
  return out;
}

function hashOrEmpty(abs: string): string {
  try {
    const buf = readFileSync(abs);
    return createHash("sha256").update(buf).digest("hex");
  } catch {
    return ""; // file missing — record as empty so deletion shows up as change
  }
}

export function snapshotImportedFiles(repoRoot: string): Map<string, string> {
  const snap = new Map<string, string>();
  for (const abs of trackedAbsPaths(repoRoot)) {
    snap.set(relative(repoRoot, abs), hashOrEmpty(abs));
  }
  return snap;
}

export function detectImportedFileChange(
  repoRoot: string,
  snapshot: Map<string, string>,
): string | null {
  // Check every previously-snapshotted file for a hash change or deletion.
  for (const [rel, prevHash] of snapshot) {
    const nowHash = hashOrEmpty(join(repoRoot, rel));
    if (nowHash !== prevHash) return rel;
  }
  // Also catch newly-added tracked files (e.g. a new lib/ module).
  const currentRel = new Set(
    trackedAbsPaths(repoRoot).map((abs) => relative(repoRoot, abs)),
  );
  for (const rel of currentRel) {
    if (!snapshot.has(rel)) return rel;
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/restart-detector.test.ts`
Expected: 5/5 pass.

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add .sandcastle/lib/restart-detector.ts tests/restart-detector.test.ts
git commit -m "$(cat <<'EOF'
feat: add restart-detector for orchestrator hot-reload

Hashes the orchestrator's statically-imported files at snapshot time
and detects content changes (including deletions and new tracked files).
Pure module — no git, no process state.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Wire detector into runMain + extend exit code + env-var override

**Files:**
- Modify: `.sandcastle/main.mts:340` (extend `RunMainResult.exitCode` union)
- Modify: `.sandcastle/main.mts:438-540` (env-var override in `parseSandcastleArgs`)
- Modify: `.sandcastle/main.mts:3115-3245` (snapshot at runMain start, check at iteration top, write marker + return 75)
- Add new import: `.sandcastle/main.mts:48-52` block (add restart-detector import)
- Test: `tests/main.test.ts` (orchestrator-level test)

The orchestrator-level test uses the existing `Deps` injection seam. The test injects a `Deps` bag plus an `iterationHook` (new dep, see below) that the orchestrator calls right before its detector check at iteration 2 — the hook writes to `.sandcastle/lib/restart-detector.ts` to simulate a recovery commit. The test then asserts the runMain returns `{ exitCode: 75, iterationsRun: 1 }` and that `.sandcastle/.restart-remaining` contains `9` (because launched with `--iterations 10`).

Add a single new optional dep `iterationStartHook?: (it: number) => void | Promise<void>` to the `Deps` interface for this purpose — production wiring is `undefined`, test wiring writes the file. This is the minimum-surface seam.

- [ ] **Step 1: Verify the existing test helpers**

Run: `grep -n "^function buildDeps\|^function baseArgs\|^function plannerStdout\|interface DepsBuilder" tests/main.test.ts`
Expected: `buildDeps`, `baseArgs`, `plannerStdout`, and `DepsBuilder` are all defined in the current file. Confirm the signatures match what's used in Step 2 below before writing the test.

- [ ] **Step 2: Extend `buildDeps` to accept `iterationStartHook`**

In `tests/main.test.ts`, find `function buildDeps(opts: {` (around line 123). Add `iterationStartHook?: (it: number) => void | Promise<void>;` to the `opts` parameter type. Then in the `const deps: Deps = { ... }` object literal (around line 161), add at the end (right before the closing `}`):

```typescript
iterationStartHook: opts.iterationStartHook,
```

This keeps the existing test surface unchanged (all current `buildDeps()` calls work because the new field is optional) while exposing the hook for our new tests.

- [ ] **Step 3: Write the failing tests in `tests/main.test.ts`**

Add a new `describe` block at the end of `tests/main.test.ts` (just before the final closing brace if there is one — confirm where the file ends):

```typescript
describe("runMain — restart on .sandcastle/** change", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "scrr-"));
    // Lay down the tracked files the detector will snapshot at runMain start.
    mkdirSync(path.join(tmpRoot, ".sandcastle/lib/migrations"), { recursive: true });
    writeFileSync(path.join(tmpRoot, ".sandcastle/main.mts"), "// stub\n");
    writeFileSync(path.join(tmpRoot, ".sandcastle/models.ts"), "// stub\n");
    writeFileSync(path.join(tmpRoot, ".sandcastle/providers.ts"), "// stub\n");
    writeFileSync(
      path.join(tmpRoot, ".sandcastle/lib/migrations/drizzle-applier.ts"),
      "// v1\n",
    );
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("exits 75 with remaining-iterations file after a tracked file changes between iterations", async () => {
    const args = baseArgs({ iterations: 10, repoRoot: tmpRoot });
    const builder = buildDeps({
      iterationStartHook: (it: number) => {
        if (it === 2) {
          writeFileSync(
            path.join(tmpRoot, ".sandcastle/lib/migrations/drizzle-applier.ts"),
            "// v2 — recovery fix\n",
          );
        }
      },
    });
    // Iteration 1 planner returns an empty plan (nothing to ship), so the
    // loop falls through to iteration 2 cleanly. We only need ONE planner
    // outcome enqueued because iteration 2 trips the detector BEFORE its
    // planner runs.
    builder.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(args, builder.deps);

    expect(result.exitCode).toBe(75);
    expect(result.iterationsRun).toBe(1);
    const markerPath = path.join(tmpRoot, ".sandcastle/.restart-remaining");
    expect(existsSync(markerPath)).toBe(true);
    expect(readFileSync(markerPath, "utf8").trim()).toBe("9");
  });

  it("does NOT exit 75 when no tracked file changes", async () => {
    const args = baseArgs({ iterations: 2, repoRoot: tmpRoot });
    const builder = buildDeps({});
    builder.enqueue("planner", { stdout: plannerStdout([]) });
    builder.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(args, builder.deps);

    expect(result.exitCode).toBe(0);
    expect(
      existsSync(path.join(tmpRoot, ".sandcastle/.restart-remaining")),
    ).toBe(false);
  });

  it("honors SANDCASTLE_REMAINING_ITERATIONS env var as override for --iterations", () => {
    const prev = process.env.SANDCASTLE_REMAINING_ITERATIONS;
    process.env.SANDCASTLE_REMAINING_ITERATIONS = "7";
    try {
      const { args } = parseSandcastleArgs(["--iterations", "100"]);
      expect(args.iterations).toBe(7);
    } finally {
      if (prev === undefined) delete process.env.SANDCASTLE_REMAINING_ITERATIONS;
      else process.env.SANDCASTLE_REMAINING_ITERATIONS = prev;
    }
  });
});
```

Note: this assumes `parseSandcastleArgs` returns `{ args, showHelp }` — verify against the existing function signature at `.sandcastle/main.mts:440-475` before writing.

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm vitest run tests/main.test.ts -t "restart on .sandcastle"`
Expected: FAIL (the orchestrator doesn't have the detector wired yet; env-var override doesn't exist).

- [ ] **Step 5: Add the restart-detector import and the import for marker writing**

In `.sandcastle/main.mts`, add to the import block at lines 48-52:

```typescript
import {
  applyMigrationsBetween,
  listMigrationsOnDisk,
  validateJournalRegistration,
} from "./lib/migrations/index.js";
import {
  snapshotImportedFiles,
  detectImportedFileChange,
} from "./lib/restart-detector.js";
```

And add to the existing `node:fs` import group (find the existing `from "node:fs"` import and add `writeFileSync` if not already there).

- [ ] **Step 6: Extend `RunMainResult.exitCode` and the `Deps` interface**

At `.sandcastle/main.mts:340`, change:
```typescript
exitCode: 0 | 1 | 2;
```
to:
```typescript
exitCode: 0 | 1 | 2 | 75;
```

In the `Deps` interface (around line 266), add the optional hook field at the end:
```typescript
/**
 * Optional iteration-start hook. Production wires this to `undefined`.
 * Tests use it to inject mid-run filesystem mutations so the restart-
 * detector path can be exercised without a real recovery agent.
 */
iterationStartHook?: (it: number) => void | Promise<void>;
```

- [ ] **Step 7: Add env-var override to `parseSandcastleArgs`**

In `parseSandcastleArgs` (around line 477), AFTER:
```typescript
const iterations = parsePositiveInt(values.iterations, "--iterations");
if (iterations === null) {
  throw new Error("--iterations is required and must be an integer ≥ 1");
}
```

Insert:
```typescript
// Env var override: when the sandcastle-wrapper.sh re-launches us after a
// hot-reload restart, it sets SANDCASTLE_REMAINING_ITERATIONS so the
// --iterations cap is honored across the restart boundary.
const envRemaining = process.env.SANDCASTLE_REMAINING_ITERATIONS;
const effectiveIterations =
  envRemaining !== undefined && envRemaining !== ""
    ? parsePositiveInt(envRemaining, "SANDCASTLE_REMAINING_ITERATIONS") ??
      iterations
    : iterations;
```

Then in the `args` object construction below, change `iterations,` to `iterations: effectiveIterations,`.

- [ ] **Step 8: Snapshot at runMain start, check at iteration top, write marker + return 75**

At the top of `runMain` (find `let iterationsRun = 0;` at line 3122), AFTER that line, add:

```typescript
const importedFilesSnapshot = snapshotImportedFiles(args.repoRoot);
```

At the top of the iteration loop body (find `iterationsRun = it;` at line 3241), AFTER that line, add:

```typescript
// Run the test-injected hook if present (production: undefined). This MUST
// fire BEFORE the detector check so tests can simulate a recovery commit.
if (deps.iterationStartHook !== undefined) {
  await deps.iterationStartHook(it);
}

// Hot-reload detector: if any statically-imported file changed on disk
// since startup, exit cleanly with code 75 so the wrapper can relaunch.
// Skip this check on iteration 1 (nothing could have changed yet — we
// just snapshotted) so a single-shot run still ships.
if (it > 1) {
  const changed = detectImportedFileChange(args.repoRoot, importedFilesSnapshot);
  if (changed !== null) {
    deps.log(
      `[sandcastle] tracked file changed on disk: ${changed}. ` +
        `Exiting with code 75 so the wrapper can restart with fresh imports.`,
    );
    const remaining = args.iterations - (iterationsRun - 1);
    writeFileSync(
      join(args.repoRoot, ".sandcastle/.restart-remaining"),
      String(remaining),
      "utf8",
    );
    return {
      exitCode: 75,
      iterationsRun: iterationsRun - 1,
      shippedIssues,
      quarantinedIssues,
    };
  }
}
```

Note: the `iterationsRun - 1` accounting reflects "we incremented `iterationsRun = it` at the top of the iteration but then bailed before doing the work; the previous iteration is the last one we actually completed." The remaining count is then `args.iterations - (iterationsRun - 1)` = `args.iterations - previously-completed-iterations`.

Also import `join` from `node:path` at the top of `main.mts` if not already imported.

**Lock-release note:** the runMain function acquires a `proper-lockfile` instance lock at line 3172 and releases it in its `finally` block (search for `releaseLoopLock` to confirm). The early `return { exitCode: 75, ... }` exits the `try` block, so the `finally` runs and the lock is released before the wrapper relaunches. No new lock-handling code is needed. If lock contention surfaces in practice (it shouldn't), add a 200ms sleep before relaunch in the wrapper script — do NOT add speculatively.

- [ ] **Step 9: Wire production `iterationStartHook: undefined` (no-op)**

In `buildDefaultDeps` (line 1471), the returned object doesn't need to set `iterationStartHook` — leaving the optional field unset is correct. No edit needed here unless the strict-mode check complains; if so, add `iterationStartHook: undefined,` to the returned object.

- [ ] **Step 10: Run the orchestrator-level test**

Run: `pnpm vitest run tests/main.test.ts -t "restart on .sandcastle"`
Expected: 3/3 pass.

- [ ] **Step 11: Run the full test suite + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: 392/392 pass (384 prior + 5 from Task 1 restart-detector + 3 new), typecheck clean.

- [ ] **Step 12: Commit**

```bash
git add .sandcastle/main.mts tests/main.test.ts
git commit -m "$(cat <<'EOF'
feat: orchestrator exits 75 when its own files change on disk

Snapshots hashes of statically-imported files at runMain start; at each
iteration boundary (skipping it=1), re-hashes and exits with code 75 if
any tracked file changed. Writes remaining iteration count to a marker
file so the wrapper script can re-launch with the right cap.

Honors SANDCASTLE_REMAINING_ITERATIONS env var as an override for
--iterations so the cap survives the restart.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Wrapper shell script + vitest test

**Files:**
- Create: `.sandcastle/sandcastle-wrapper.sh`
- Test: `tests/wrapper.test.ts` (vitest — runs under `pnpm test` with everything else)

The wrapper accepts a `SANDCASTLE_RUNNER` env var as an escape hatch for the runner command (defaults to `tsx .sandcastle/main.mts`). The vitest test sets this env var to a fake bash stub so the wrapper can be exercised without `tsx` or the real orchestrator.

- [ ] **Step 1: Write the failing vitest test**

Create `tests/wrapper.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  chmodSync,
  existsSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..");
const WRAPPER_SRC = path.join(REPO_ROOT, ".sandcastle/sandcastle-wrapper.sh");

describe("sandcastle-wrapper.sh", () => {
  let tmp: string;
  let stubPath: string;
  let wrapperPath: string;
  let countPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "scw-"));
    mkdirSync(path.join(tmp, ".sandcastle"), { recursive: true });
    wrapperPath = path.join(tmp, ".sandcastle/sandcastle-wrapper.sh");
    copyFileSync(WRAPPER_SRC, wrapperPath);
    chmodSync(wrapperPath, 0o755);
    countPath = path.join(tmp, ".invocation-count");
    stubPath = path.join(tmp, "fake-runner.sh");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeStub(body: string): void {
    writeFileSync(stubPath, body, "utf8");
    chmodSync(stubPath, 0o755);
  }

  it("loops on exit code 75, sets SANDCASTLE_REMAINING_ITERATIONS, then exits 0", () => {
    // Stub: increments invocation count; first call writes marker + exits 75,
    // second call records the env var it saw and exits 0.
    writeStub(`#!/usr/bin/env bash
COUNT_FILE="${countPath}"
ENV_FILE="${tmp}/.env-on-second-call"
n=$(cat "$COUNT_FILE" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "$COUNT_FILE"
if [ "$n" -eq 1 ]; then
  echo "5" > "${tmp}/.sandcastle/.restart-remaining"
  exit 75
fi
echo "\${SANDCASTLE_REMAINING_ITERATIONS:-<unset>}" > "$ENV_FILE"
exit 0
`);
    const result = spawnSync("bash", [wrapperPath, "--iterations", "10"], {
      cwd: tmp,
      env: { ...process.env, SANDCASTLE_RUNNER: stubPath },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(readFileSync(countPath, "utf8").trim()).toBe("2");
    expect(
      readFileSync(path.join(tmp, ".env-on-second-call"), "utf8").trim(),
    ).toBe("5");
    expect(
      existsSync(path.join(tmp, ".sandcastle/.restart-remaining")),
    ).toBe(false);
  });

  it("propagates non-75 exit codes without looping", () => {
    writeStub(`#!/usr/bin/env bash
COUNT_FILE="${countPath}"
n=$(cat "$COUNT_FILE" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "$COUNT_FILE"
exit 42
`);
    const result = spawnSync("bash", [wrapperPath, "--iterations", "1"], {
      cwd: tmp,
      env: { ...process.env, SANDCASTLE_RUNNER: stubPath },
      encoding: "utf8",
    });
    expect(result.status).toBe(42);
    expect(readFileSync(countPath, "utf8").trim()).toBe("1");
  });

  it("refuses to loop blindly when marker file is missing", () => {
    writeStub(`#!/usr/bin/env bash
exit 75
`);
    const result = spawnSync("bash", [wrapperPath, "--iterations", "1"], {
      cwd: tmp,
      env: { ...process.env, SANDCASTLE_RUNNER: stubPath },
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no marker file");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/wrapper.test.ts`
Expected: FAIL with `ENOENT` on `.sandcastle/sandcastle-wrapper.sh`.

- [ ] **Step 3: Create the wrapper script**

Create `.sandcastle/sandcastle-wrapper.sh`:

```bash
#!/usr/bin/env bash
# sandcastle-wrapper.sh — loop on exit code 75 so the orchestrator can
# self-restart when one of its own statically-imported files changes on
# disk (typically: a recovery agent committed a fix and we need to pick
# it up). See docs/superpowers/plans/2026-05-26-orchestrator-hot-reload.md.

set -uo pipefail

RESTART_EXIT_CODE=75
MARKER_FILE=".sandcastle/.restart-remaining"

# Runner is overridable via env var (used by tests). Default is the
# production invocation. Parsed as an array so a multi-word runner like
# `tsx .sandcastle/main.mts` splits correctly.
if [ -n "${SANDCASTLE_RUNNER:-}" ]; then
  read -r -a RUNNER <<< "$SANDCASTLE_RUNNER"
else
  RUNNER=(tsx .sandcastle/main.mts)
fi

while true; do
  "${RUNNER[@]}" "$@"
  code=$?
  if [ "$code" -ne "$RESTART_EXIT_CODE" ]; then
    exit "$code"
  fi
  if [ ! -f "$MARKER_FILE" ]; then
    echo "[sandcastle-wrapper] orchestrator exited 75 but no marker file at $MARKER_FILE; refusing to loop blindly" >&2
    exit 1
  fi
  remaining=$(cat "$MARKER_FILE")
  rm -f "$MARKER_FILE"
  if ! [[ "$remaining" =~ ^[0-9]+$ ]] || [ "$remaining" -lt 1 ]; then
    echo "[sandcastle-wrapper] marker file contained invalid value: $remaining" >&2
    exit 1
  fi
  echo "[sandcastle-wrapper] restarting with $remaining iterations remaining"
  export SANDCASTLE_REMAINING_ITERATIONS="$remaining"
done
```

Make it executable: `chmod +x .sandcastle/sandcastle-wrapper.sh`.

- [ ] **Step 4: Run the vitest test to verify it passes**

Run: `pnpm vitest run tests/wrapper.test.ts`
Expected: 3/3 pass.

- [ ] **Step 5: Run shellcheck on the wrapper (optional)**

Run: `shellcheck .sandcastle/sandcastle-wrapper.sh`
Expected: no warnings. If shellcheck is not installed, skip — the vitest test is the authoritative check.

- [ ] **Step 6: Run the full test suite**

Run: `pnpm test`
Expected: 395/395 pass (392 after Task 2 + 3 new from this task), all under one runner.

- [ ] **Step 7: Commit**

```bash
git add .sandcastle/sandcastle-wrapper.sh tests/wrapper.test.ts
git commit -m "$(cat <<'EOF'
feat: sandcastle-wrapper.sh loops on exit 75 for hot-reload restart

The orchestrator now exits with code 75 when one of its own statically-
imported files changes on disk. The wrapper detects code 75, reads the
remaining-iterations count from .sandcastle/.restart-remaining, exports
it as SANDCASTLE_REMAINING_ITERATIONS, and re-runs the runner with the
same argv. Any other exit code propagates as-is.

Runner command is overridable via the SANDCASTLE_RUNNER env var (used
by the vitest test in tests/wrapper.test.ts; defaults to
`tsx .sandcastle/main.mts`).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Update bin/init.mjs to install the wrapper

**Files:**
- Modify: `bin/init.mjs:69`

Today, `bin/init.mjs` runs `copyDir(TEMPLATE_ROOT, resolve(TARGET_ROOT, ".sandcastle"))` (line 105), so `sandcastle-wrapper.sh` already gets copied into consumers automatically as soon as we drop it under `.sandcastle/`. The only change needed is the package.json script alias.

- [ ] **Step 1: Read `bin/init.mjs:60-80` to confirm context**

Run: `sed -n '60,80p' bin/init.mjs`
Expected: see the line `projPkg.scripts.sandcastle = "tsx .sandcastle/main.mts";`.

- [ ] **Step 2: Edit the line**

In `bin/init.mjs:69`, change:

```javascript
projPkg.scripts.sandcastle = "tsx .sandcastle/main.mts";
```

to:

```javascript
projPkg.scripts.sandcastle = "bash .sandcastle/sandcastle-wrapper.sh";
```

- [ ] **Step 3: Update this template's own `package.json` `start` script for consistency**

In `/Users/ziyadakl/Dev/Sandcastle/package.json:14`, change:

```json
"start": "tsx .sandcastle/main.mts"
```

to:

```json
"start": "bash .sandcastle/sandcastle-wrapper.sh"
```

- [ ] **Step 4: Run all tests + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: 395/395 pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add bin/init.mjs package.json
git commit -m "$(cat <<'EOF'
feat: init.mjs installs sandcastle-wrapper.sh as the launcher

New consumer projects now get the loop-on-75 wrapper instead of a bare
tsx call. This template's own `npm start` also switches over.

Existing downstream projects pick this up via /sandcastle-update.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Update sandcastle-run skill doc (template-level guidance)

**Files:**
- Modify: `~/.claude/skills/sandcastle-run/SKILL.md` (NOT in this repo — it's Syncthing-propagated; surface the diff so the user can apply it manually or via a paste prompt)

This task does NOT commit to the repo. It produces a diff for the user to apply to their global skill file. Skip if the user opts out.

- [ ] **Step 1: Show the user the doc edit**

Output a unified diff against `~/.claude/skills/sandcastle-run/SKILL.md` adding a short note in the troubleshooting section:

> When a recovery agent commits a fix to one of sandcastle's own files mid-run, the orchestrator now exits cleanly with code 75 and a wrapper script re-launches it. You'll see `[sandcastle] tracked file changed on disk` followed by `[sandcastle-wrapper] restarting with N iterations remaining` in the logs. This is normal — not an error.

Ask the user whether they want to paste this into their global skill file or skip.

- [ ] **Step 2: If user approves: paste-ready prompt**

Provide the user a copy-paste prompt they can run on the Mac AND on the VPS (Syncthing keeps them in sync but the VPS may need an explicit push if propagation lags).

- [ ] **Step 3: No commit (this is a skill edit, not a repo edit)**

---

## Self-Review Checklist

After writing each task, the executing agent should verify:

1. **Spec coverage:** Detector exists (Task 1) ✓ · Orchestrator wires it (Task 2) ✓ · Iteration carry-through (Task 2 env var + Task 3 marker file) ✓ · Wrapper loops on 75 (Task 3) ✓ · Init script installs wrapper (Task 4) ✓ · No circuit breaker (intentionally omitted per design discussion).
2. **Placeholder scan:** Tasks 1-4 contain full code blocks. Task 5 is documentation-only and explicitly contingent on user opt-in.
3. **Type consistency:** `RunMainResult.exitCode` extended to `0 | 1 | 2 | 75`; the early-return in the detector path matches the existing union pattern (same `iterationsRun`, `shippedIssues`, `quarantinedIssues` fields). `iterationStartHook` is declared on `Deps` and called via `deps.iterationStartHook?.(it)` (optional chaining keeps prod no-op).
4. **Spec requirements not in any task:** none.

---

## Notes on Out-of-Scope

- **Circuit breaker on restart count:** intentionally not in v1. Recovery's existing `needs-human` quarantine handles the runaway case. Add only if pathological behavior is observed in practice.
- **Watching for changes mid-iteration:** not done. The check fires at iteration boundaries only. Mid-iteration changes wait for the next boundary. Acceptable because the in-flight iteration is using the version it was already running with — no new bugs introduced.
- **Touching prompt files:** not tracked. Prompts are read from disk on every use, not statically imported. The bug doesn't affect them.
- **Recovery agent prompt changes:** out of scope. The recovery agent already commits; the change here is purely about how the orchestrator notices.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-26-orchestrator-hot-reload.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
