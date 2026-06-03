# Mac-host review follow-ups — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Address the four real findings from the `/thermo-review` of `feat/mac-host-profile` that remain after the `promptArgs` substitution fix landed: (1) top-level mac-host `run()` silently drops commits, (2) the mac-host helper has a circular import from `main.mts`, (3) the helper's `NODE_ENV === "test"` seam is global-state, and (4) the `buildSandboxFactory` shape forces `unknown`-typed casts and `if (sandbox === "mac-host")` branches throughout `buildDefaultDeps`.

**Architecture:** Each task is a self-contained change with its own commit. Task 4 is a real boundary refactor that collapses ~80 lines of branching in `main.mts` into a uniform `SandboxProvider` interface that both docker and mac-host implement. Tasks 1–3 are small and ship-able even if Task 4 is deferred.

**Tech Stack:** TypeScript (NodeNext), Node 20, vitest 2.x, `@ai-hero/sandcastle@0.5.10` SDK.

---

## Branch state assumption

Plan is written against `feat/mac-host-profile` HEAD `<HEAD>` (will be the HEAD after the `promptArgs` substitution commit). Baseline test count is **481/481 passing** post-substitution-fix. `git status` should be clean except the three pre-branch carryovers (`.claude/`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`). If state drifts, STOP and re-verify before continuing.

## Non-goals

- **Tier 2 standalone fix for the dead `hooks` ternary.** **Resolved by being a side-effect of Task 4**, not by a separate task. The ternary at `main.mts:1735-1741` becomes structurally unreachable after Task 4: docker config (including `hooks`) moves into `makeDockerProvider`'s construction bag and only exists when `args.sandbox === "docker"`. The author's "future-proofing for mac-host hooks" comment (`main.mts:1731-1734`) loses force because each provider owns its own config in the new shape — when mac-host gains hook support, it'll be a `MacHostProviderConfig` field, not a shared `hooks` variable. Side-effect scan confirms `hooks` is referenced only at the declaration (line 1735) and the docker-only consumer (line 1918); no tests reference it. Task 4 Step 4.4 must explicitly delete the ternary, replace it with the unconditional docker hooks object inside the `dockerConfig` bag, and remove the now-stale comment block.
- **Spec scope-creep findings (AbortSignal plumbing, `bin/init.d.mts`, `tsconfig.json` change).** Reviewer wrote "reasonable but technically out of plan scope." No action.
- **Spec (a) #2 help-text ordering.** Reviewer wrote "Minor; not a true gap." No action.
- **Spec (c) #3 `activeProfile` source-of-truth divergence.** Behavior matches because the skill writes both files. Document as a known wiring choice if pressed; no code change.
- **Built-in `SOURCE_BRANCH`/`TARGET_BRANCH` injection and shell-block preprocessing.** Already in `FOLLOW_UPS.md` §3.

---

## Task 1: Fix top-level mac-host `run()` silently dropping commits

**Severity:** correctness regression vs. Docker. The merger (top-level `factory.run()` consumer) reads `result.commits` to know what to merge. On mac-host this is always `[]`.

**Files:**
- Modify: `.sandcastle/lib/mac-host-sandbox.ts:248-251` (the top-level `async run(spec)` method)
- Test: `tests/mac-host-sandbox.test.ts` (add a case under the existing `describe("macHostSandbox", ...)` block)

**Approach:** before spawning, capture `HEAD` of `effectiveCwd` and pass as `forkSha`. Mirrors what `createSandbox` already does at line 230-234. `readCommitsSince` works on any working dir + commit pair, so no further changes needed.

- [ ] **Step 1.1: Write the failing test**

  In `tests/mac-host-sandbox.test.ts`, inside `describe("macHostSandbox", ...)`, add (place it after the existing top-level run test that asserts `result.stdout`):

  ```ts
  it("top-level run() returns commits made inside cwd since the run started", async () => {
    const subDir = path.join(repoRoot, "sub");
    mkdirSync(subDir);
    // initial commit so HEAD resolves
    writeFileSync(path.join(subDir, "seed.txt"), "seed\n");
    execFileSync("git", ["init", "-b", "main"], { cwd: subDir });
    execFileSync("git", ["config", "user.email", "t@t.test"], { cwd: subDir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: subDir });
    execFileSync("git", ["add", "."], { cwd: subDir });
    execFileSync("git", ["commit", "-m", "seed"], { cwd: subDir });

    // Use a test-seam binary that makes one commit in cwd and exits 0.
    const fakeBin = path.join(repoRoot, "fake-claude.sh");
    writeFileSync(
      fakeBin,
      `#!/bin/sh\ncd "$(dirname "$0")/sub"\necho touched > new.txt\ngit add new.txt\ngit commit -m "agent commit" >/dev/null 2>&1\nexit 0\n`,
    );
    chmodSync(fakeBin, 0o755);
    writeFileSync(path.join(subDir, "p.md"), "prompt body\n");

    const prevBin = process.env.SANDCASTLE_MAC_HOST_CLAUDE_BIN;
    process.env.SANDCASTLE_MAC_HOST_CLAUDE_BIN = fakeBin;
    try {
      const factory = macHostSandbox({ repoRoot, env: {} });
      const result = await factory.run({
        name: "merger",
        model: "claude-test",
        promptFile: "p.md",
        cwd: subDir,
        idleTimeoutSeconds: 30,
      });
      expect(result.commits.length).toBe(1);
      expect(result.commits[0].sha).toMatch(/^[a-f0-9]{40}$/);
    } finally {
      if (prevBin === undefined) delete process.env.SANDCASTLE_MAC_HOST_CLAUDE_BIN;
      else process.env.SANDCASTLE_MAC_HOST_CLAUDE_BIN = prevBin;
    }
  });
  ```

  Note: the existing tests in the file demonstrate the `SANDCASTLE_MAC_HOST_CLAUDE_BIN` test seam pattern (test seam currently uses `/bin/cat <promptFullPath>` by default — replacing the bin via env var is the supported override). Importing `chmodSync` and `mkdirSync` is already in scope at the top of the file.

- [ ] **Step 1.2: Run the test to verify it fails**

  ```bash
  pnpm vitest run tests/mac-host-sandbox.test.ts -t "top-level run\\(\\) returns commits"
  ```

  Expected: FAIL with `expect(received).toBe(1)` — received is `0`.

- [ ] **Step 1.3: Implement the minimal fix**

  In `.sandcastle/lib/mac-host-sandbox.ts`, change the top-level `run()` method:

  ```ts
  async run(spec): Promise<MacHostRunHandle> {
    const effectiveCwd = spec.cwd ?? repoRoot;
    const forkSha = execFileSync(
      "git",
      ["rev-parse", "HEAD"],
      { cwd: effectiveCwd, stdio: ["ignore", "pipe", "ignore"] },
    ).toString("utf8").trim();
    return await spawnAgent(effectiveCwd, spec, opts.env ?? {}, forkSha);
  },
  ```

  Rationale: this mirrors `createSandbox` at lines 230-234. If `effectiveCwd` isn't a git repo `rev-parse` will throw, which is the right behavior — top-level runs always target a git checkout in this codebase.

- [ ] **Step 1.4: Run the test to verify it passes**

  ```bash
  pnpm vitest run tests/mac-host-sandbox.test.ts -t "top-level run\\(\\) returns commits"
  ```

  Expected: PASS.

- [ ] **Step 1.5: Run the full suite**

  ```bash
  pnpm vitest run
  ```

  Expected: 482/482 passing (481 baseline + 1 new).

- [ ] **Step 1.6: Commit**

  ```bash
  git add .sandcastle/lib/mac-host-sandbox.ts tests/mac-host-sandbox.test.ts
  git commit -m "fix(mac-host): top-level run() returns commits made since fork

  The top-level run() method was passing forkSha=null to spawnAgent,
  short-circuiting readCommitsSince and returning commits: [] regardless
  of what the agent committed. The merger (a top-level-run consumer)
  uses result.commits to know what to merge, so its work was silently
  dropped on mac-host. Mirror createSandbox by capturing HEAD before
  spawn and passing it as forkSha."
  ```

---

## Task 2: Break the circular import between mac-host-sandbox and main.mts

**Severity:** testability regression. `mac-host-sandbox.ts` imports `worktreePathFor` from `../main.mjs` (4324-line orchestrator). Any unit test of the helper drags the orchestrator into the module graph.

**Files:**
- Create: `.sandcastle/lib/worktree-path.ts` (new, ~10 lines)
- Modify: `.sandcastle/lib/mac-host-sandbox.ts:4` (replace the import)
- Modify: `.sandcastle/main.mts` (the existing `worktreePathFor` export — convert to re-export from the new module so existing consumers still see it)

**Approach:** lift `worktreePathFor` from `main.mts` into `lib/worktree-path.ts`. `main.mts` re-exports it so external `main.mjs` consumers continue working. `mac-host-sandbox.ts` imports directly from the lib module — no more cycle.

- [ ] **Step 2.1: Find the current `worktreePathFor` definition**

  ```bash
  grep -nE "export function worktreePathFor|export const worktreePathFor" /Users/ziyadakl/Dev/Sandcastle/.sandcastle/main.mts
  ```

  Expected: one match. Record the file:line. The function transforms a branch name like `agent/issue-42` to a relative worktree path like `.sandcastle/worktrees/agent-issue-42`.

- [ ] **Step 2.2: Write the failing test**

  Add to `tests/mac-host-sandbox.test.ts` (top of file, alongside `applyPromptArgs` tests):

  ```ts
  import { worktreePathFor } from "../.sandcastle/lib/worktree-path.js";

  describe("worktreePathFor (extracted helper)", () => {
    it("transforms branch names by replacing / with -", () => {
      expect(worktreePathFor("agent/issue-42")).toBe(".sandcastle/worktrees/agent-issue-42");
    });
    it("handles branch names without /", () => {
      expect(worktreePathFor("main")).toBe(".sandcastle/worktrees/main");
    });
  });
  ```

  Note: the exact transform (slash-replacement, prefix path) must match what `main.mts` currently does. Read the existing implementation in Step 2.1 and copy the assertions to match — do not invent new behavior.

- [ ] **Step 2.3: Run the test to verify it fails**

  ```bash
  pnpm vitest run tests/mac-host-sandbox.test.ts -t "worktreePathFor"
  ```

  Expected: FAIL with "Cannot find module ../.sandcastle/lib/worktree-path.js".

- [ ] **Step 2.4: Create the new module**

  Create `.sandcastle/lib/worktree-path.ts` with the body of `worktreePathFor` lifted verbatim from `main.mts` (read it in Step 2.1, paste it here). Export as `export function worktreePathFor(...)`.

- [ ] **Step 2.5: Update `main.mts` to re-export**

  Change the existing `export function worktreePathFor(...)` in `main.mts` to:

  ```ts
  export { worktreePathFor } from "./lib/worktree-path.js";
  ```

  Note: keep the named export so callers like `mac-host-sandbox.ts:4` (will be updated in next step) and any external consumer that imports from `main.mjs` continue working.

- [ ] **Step 2.6: Update `mac-host-sandbox.ts` to import from the new module**

  Change line 4 from:

  ```ts
  import { worktreePathFor as canonicalWorktreePathFor } from "../main.mjs";
  ```

  to:

  ```ts
  import { worktreePathFor as canonicalWorktreePathFor } from "./worktree-path.js";
  ```

- [ ] **Step 2.7: Run the test to verify it passes**

  ```bash
  pnpm vitest run tests/mac-host-sandbox.test.ts -t "worktreePathFor"
  ```

  Expected: PASS.

- [ ] **Step 2.8: Run the full suite**

  ```bash
  pnpm vitest run && pnpm tsc --noEmit
  ```

  Expected: 484/484 passing (482 prior + 2 new) and tsc clean.

- [ ] **Step 2.9: Commit**

  ```bash
  git add .sandcastle/lib/worktree-path.ts .sandcastle/lib/mac-host-sandbox.ts .sandcastle/main.mts tests/mac-host-sandbox.test.ts
  git commit -m "refactor(mac-host): break circular import via lib/worktree-path

  mac-host-sandbox.ts was importing worktreePathFor from ../main.mjs,
  which in turn imports macHostSandbox — a cycle that dragged the
  4324-line orchestrator into the unit-test module graph. Lift
  worktreePathFor into lib/worktree-path.ts; main.mts re-exports it
  for external consumers."
  ```

---

## Task 3: Replace `NODE_ENV === "test"` test seam with explicit options

**Severity:** testability — global-state seam that couples unit tests to runner env and could silently change production behavior if `NODE_ENV` ever leaks.

**Files:**
- Modify: `.sandcastle/lib/mac-host-sandbox.ts` — `MacHostSandboxOptions` adds `claudeBin?` and `buildArgs?` fields; `spawnAgent` reads from `opts` instead of `process.env.NODE_ENV`
- Modify: `tests/mac-host-sandbox.test.ts` — existing tests that rely on `NODE_ENV === "test"` switch to explicit `claudeBin` injection

**Approach:** the current code at `mac-host-sandbox.ts:113-130` switches between `/bin/cat <promptFile>` (test) and `claude --print --model X --dangerously-skip-permissions` (prod) based on `NODE_ENV` and `SANDCASTLE_MAC_HOST_CLAUDE_BIN`. Replace with explicit `MacHostSandboxOptions.claudeBin` + `buildArgs` injection. Vitest already sets `NODE_ENV=test`, but we'll stop relying on it.

- [ ] **Step 3.1: Read the current seam**

  Read `.sandcastle/lib/mac-host-sandbox.ts:113-156` to confirm the current logic and the exact production args list.

- [ ] **Step 3.2: Write a test for explicit `claudeBin` injection**

  Add to `tests/mac-host-sandbox.test.ts` inside `describe("macHostSandbox", ...)`:

  ```ts
  it("uses opts.claudeBin and opts.buildArgs when provided, ignoring NODE_ENV", async () => {
    const fakeBin = path.join(repoRoot, "fake-claude.sh");
    writeFileSync(fakeBin, `#!/bin/sh\nread input\necho "ARGS:$@ STDIN:$input"\nexit 0\n`);
    chmodSync(fakeBin, 0o755);
    writeFileSync(path.join(repoRoot, "p.md"), "prompt body\n");

    const factory = macHostSandbox({
      repoRoot,
      env: {},
      claudeBin: fakeBin,
      buildArgs: (spec) => ["--marker", spec.name],
    });
    const result = await factory.run({
      name: "test-run",
      model: "claude-sonnet-4-5",
      promptFile: "p.md",
      idleTimeoutSeconds: 30,
    });
    expect(result.stdout).toContain("ARGS:--marker test-run");
    expect(result.stdout).toContain("STDIN:prompt body");
  });
  ```

- [ ] **Step 3.3: Run the test to verify it fails**

  ```bash
  pnpm vitest run tests/mac-host-sandbox.test.ts -t "uses opts.claudeBin"
  ```

  Expected: FAIL — either type error on the new options or runtime behavior diverges.

- [ ] **Step 3.4: Add the options to the type**

  In `mac-host-sandbox.ts`, modify `MacHostSandboxOptions`:

  ```ts
  export interface MacHostSandboxOptions {
    readonly repoRoot: string;
    readonly env?: Record<string, string>;
    readonly claudeBin?: string;
    readonly buildArgs?: (spec: MacHostRunSpec | MacHostTopLevelRunSpec) => readonly string[];
  }
  ```

- [ ] **Step 3.5: Replace the NODE_ENV branch in `spawnAgent`**

  Replace lines 111-156 of `mac-host-sandbox.ts` (the `claudeBin` resolution, `isTestSeam` derivation, `claudeArgs` selection, and the stdin/no-stdin fork) with:

  ```ts
  const claudeBin =
    options.claudeBin ??
    process.env.SANDCASTLE_MAC_HOST_CLAUDE_BIN ??
    "claude";
  const claudeArgs = options.buildArgs
    ? [...options.buildArgs(runSpec)]
    : [
        "--print",
        "--model", runSpec.model,
        "--dangerously-skip-permissions",
      ];
  // pipePrompt: true when production-style args (the default); test seams that
  // take the prompt as a positional or don't want stdin pass buildArgs and
  // either include the prompt themselves or read from stdin (fakeBin pattern).
  // The default `claude` invocation reads prompt from stdin.
  ```

  Then thread `options` into `spawnAgent` — it currently takes `(cwd, runSpec, env, forkSha)`. Add `options: MacHostSandboxOptions` as a fifth arg, passed by both `createSandbox.run` and the top-level `run` call sites.

  Update the stdin handling at lines 150-156:

  ```ts
  // Always pipe the prompt via stdin. Test seams that don't want stdin can
  // close their own input — we only end() what we have. The default `claude`
  // invocation reads prompt from stdin.
  child.stdin.end(promptText);
  ```

  Note: removing the `isTestSeam` fork means existing tests using `/bin/cat <promptFile>` (the old default) need to either (a) explicitly pass `claudeBin: "/bin/cat"` and `buildArgs: () => [promptPath]`, or (b) use the new fake-shell-script pattern that reads stdin. Audit existing tests in Step 3.6.

- [ ] **Step 3.6: Audit existing tests for `NODE_ENV` dependency**

  ```bash
  grep -nE "NODE_ENV|/bin/cat|SANDCASTLE_MAC_HOST_CLAUDE_BIN" tests/mac-host-sandbox.test.ts
  ```

  For each match, update the test to either pass explicit `claudeBin`/`buildArgs` or use a shell-script fake binary as in Step 3.2. Do not silently change behavior — each test should still cover its original contract (the run returns stdout, abort signal kills, idle timeout fires, etc.).

  If a test previously relied on `/bin/cat <promptPath>` rendering the *unsubstituted* prompt to stdout, the new pattern needs a shell-script that echoes its stdin to stdout.

- [ ] **Step 3.7: Run the full suite**

  ```bash
  pnpm vitest run && pnpm tsc --noEmit
  ```

  Expected: 485/485 passing (484 prior + 1 new) and tsc clean. If existing tests fail because they relied on `NODE_ENV`, fix them per Step 3.6.

- [ ] **Step 3.8: Commit**

  ```bash
  git add .sandcastle/lib/mac-host-sandbox.ts tests/mac-host-sandbox.test.ts
  git commit -m "refactor(mac-host): explicit claudeBin/buildArgs options replace NODE_ENV seam

  spawnAgent was switching between /bin/cat <file> (test) and the real
  claude CLI (prod) by reading process.env.NODE_ENV — a global-state
  seam that coupled unit tests to the runner env and would silently
  change prod behavior if NODE_ENV ever leaked. Replace with explicit
  MacHostSandboxOptions.claudeBin and buildArgs injection. Existing
  tests now pass an explicit fake binary instead of relying on the
  global default."
  ```

---

## Task 4: Provider-shape refactor — uniform `SandboxProvider` interface

**Severity:** structural debt + four overlapping Quality findings (1a, 1b, 2b, 3a). Closes them all in one commit.

**Files:**
- Create: `.sandcastle/lib/sandbox-provider.ts` (new, ~150 lines) — defines the `SandboxProvider` / `RunSpec` / `RunResult` / `SandboxHandle` interfaces, the `makeDockerProvider(...)` adapter, and re-exports the existing `macHostSandbox` adapted to the interface
- Modify: `.sandcastle/main.mts` — replace `SandboxFactoryHandles` / `buildSandboxFactory` with the new `SandboxProvider`; collapse both `if (args.sandbox === "mac-host")` branches in `Deps.run` and `Deps.createSandbox`; remove `as ReturnType<typeof docker>` / `as ReturnType<typeof macHostSandbox>` casts
- Modify: `.sandcastle/lib/mac-host-sandbox.ts` — adapt `macHostSandbox(...)` to expose the `SandboxProvider` shape (rename `run` → `topLevelRun` if needed, or leave both with the same external shape)
- Modify: `tests/main-sandbox-routing.test.ts` — update routing test to assert the new shape (returns a `SandboxProvider`, not a `SandboxFactoryHandles`)
- Modify: `tests/mac-host-sandbox.test.ts` — adapt tests that exercise the old `MacHostSandboxFactory` directly to the new shape

**Architectural decision (pre-recorded so implementation doesn't drift):**

The new `SandboxProvider` interface carries only the fields **both providers need**. Docker-specific concerns (mounts, hooks, completionSignal, copyToWorktree, timeouts, claudeCode-agent wrapping) are **baked into the docker adapter at construction time** in `makeDockerProvider(...)`. The per-call spec stays narrow.

The exception is `mounts`: declared on the existing `RunSpec` / `CreateSandboxSpec` at `main.mts:253,266` but `grep` confirms no caller populates it. Keep it as an optional docker-only field on the new `RunSpec` / `CreateSandboxSpec` (mac-host adapter ignores) to preserve the existing API surface — do not delete it on this branch.

```ts
// Target interface (will live in .sandcastle/lib/sandbox-provider.ts)

export interface ProviderRunSpec {
  readonly name: string;
  readonly maxIterations?: number;
  readonly model: string;
  readonly promptFile: string;
  readonly promptArgs?: Record<string, string>;
  readonly idleTimeoutSeconds?: number;
  readonly cwd?: string;
  readonly mounts?: readonly { hostPath: string; sandboxPath: string; readonly?: boolean }[];
  readonly signal?: AbortSignal;
}

export interface ProviderRunResult {
  readonly stdout: string;
  readonly commits: readonly { sha: string }[];
  readonly iterations?: readonly { sessionFilePath?: string; sessionId?: string }[];
}

export interface ProviderCreateSpec {
  readonly branch: string;
  readonly sandboxEnv: Record<string, string>;
  readonly mounts?: readonly { hostPath: string; sandboxPath: string; readonly?: boolean }[];
}

export interface ProviderSandboxHandle {
  readonly branch: string;
  readonly worktreePath: string;
  run(opts: ProviderRunSpec): Promise<ProviderRunResult>;
  close(): Promise<void>;
}

export interface SandboxProvider {
  topLevelRun(spec: ProviderRunSpec): Promise<ProviderRunResult>;
  createSandbox(spec: ProviderCreateSpec): Promise<ProviderSandboxHandle>;
}
```

**Bonus fix:** `ProviderCreateSpec.sandboxEnv` is now per-call. The mac-host adapter passes it into `macHostSandbox({ ..., env: spec.sandboxEnv })` at call time — closes the FOLLOW_UPS.md §3 documented gap for per-handle env injection. **Update `FOLLOW_UPS.md` to remove that bullet** in Step 4.9.

- [ ] **Step 4.1: Write the failing routing test**

  Replace the body of `tests/main-sandbox-routing.test.ts:11-30` (the existing routing test) with:

  ```ts
  import { describe, it, expect } from "vitest";
  import { buildSandboxProvider } from "../.sandcastle/main.mjs";

  describe("buildSandboxProvider", () => {
    it("returns a SandboxProvider with topLevelRun and createSandbox when args.sandbox === 'docker'", () => {
      const provider = buildSandboxProvider(
        { sandbox: "docker", repoRoot: "/tmp/x", imageName: "sandcastle:foo" } as any,
        {},
      );
      expect(typeof provider.topLevelRun).toBe("function");
      expect(typeof provider.createSandbox).toBe("function");
    });
    it("returns a SandboxProvider with topLevelRun and createSandbox when args.sandbox === 'mac-host'", () => {
      const provider = buildSandboxProvider(
        { sandbox: "mac-host", repoRoot: "/tmp/x", imageName: "sandcastle:foo" } as any,
        {},
      );
      expect(typeof provider.topLevelRun).toBe("function");
      expect(typeof provider.createSandbox).toBe("function");
    });
  });
  ```

- [ ] **Step 4.2: Run the test to verify it fails**

  ```bash
  pnpm vitest run tests/main-sandbox-routing.test.ts
  ```

  Expected: FAIL with "buildSandboxProvider is not exported" or "is not a function".

- [ ] **Step 4.3: Create `.sandcastle/lib/sandbox-provider.ts`**

  Implement the interfaces defined above plus:

  ```ts
  // makeDockerProvider — wraps the SDK's docker(...) into a SandboxProvider.
  // All docker-specific concerns (mounts, hooks, completionSignal, etc.)
  // are baked in at construction time so the per-call spec stays narrow.

  export function makeDockerProvider(
    args: { imageName: string; repoRoot: string },
    containerEnv: Record<string, string>,
    config: {
      hooks: unknown;  // type from sandcastle SDK; fill in concretely
      copyToWorktree: readonly string[];
      completionSignal: readonly string[];
      copyToWorktreeMs: number;
    },
  ): SandboxProvider {
    const sandbox = (sandboxEnv: Record<string, string>, extraMounts?: readonly {hostPath: string; sandboxPath: string; readonly?: boolean}[]) =>
      docker({
        imageName: args.imageName,
        env: sandboxEnv,
        containerUid: 1001,
        containerGid: 1001,
        mounts: extraMounts && extraMounts.length > 0
          ? [...AUTH_MOUNTS, ...extraMounts]
          : [...AUTH_MOUNTS],
      });
    return {
      async topLevelRun(spec) {
        const result = await sandcastle.run({
          sandbox: sandbox(containerEnv, spec.mounts),
          cwd: spec.cwd ?? args.repoRoot,
          name: spec.name,
          maxIterations: spec.maxIterations ?? 1,
          agent: sandcastle.claudeCode(spec.model, { env: envForModel(spec.model) }),
          promptFile: spec.promptFile,
          promptArgs: spec.promptArgs,
          idleTimeoutSeconds: spec.idleTimeoutSeconds,
          completionSignal: config.completionSignal,
          signal: spec.signal,
        });
        return { stdout: result.stdout, commits: result.commits };
      },
      async createSandbox(spec) {
        const handle = await sandcastle.createSandbox({
          branch: spec.branch,
          sandbox: sandbox(spec.sandboxEnv, spec.mounts),
          cwd: args.repoRoot,
          hooks: config.hooks,
          copyToWorktree: config.copyToWorktree,
          timeouts: { copyToWorktreeMs: config.copyToWorktreeMs },
        });
        return {
          branch: handle.branch,
          worktreePath: handle.worktreePath,
          async run(opts) {
            const r = await handle.run({
              name: opts.name,
              maxIterations: opts.maxIterations ?? 1,
              agent: sandcastle.claudeCode(opts.model, { env: envForModel(opts.model) }),
              promptFile: opts.promptFile,
              promptArgs: opts.promptArgs,
              idleTimeoutSeconds: opts.idleTimeoutSeconds,
              completionSignal: config.completionSignal,
              signal: opts.signal,
            });
            return {
              stdout: r.stdout,
              commits: r.commits,
              iterations: r.iterations?.map((it: any) => ({
                sessionFilePath: it.sessionFilePath,
                sessionId: it.sessionId,
              })),
            };
          },
          close: () => handle.close(),
        };
      },
    };
  }
  ```

  Note: this implementation reads `sandcastle`, `docker`, `envForModel`, `AUTH_MOUNTS` from somewhere. The imports must come from the SDK (`@ai-hero/sandcastle`) and the existing helpers in `main.mts`. Move `AUTH_MOUNTS` and `buildMounts` from `main.mts:1637-1646` into this file (or import from main.mts). `envForModel` stays in main.mts and is imported here.

  Plus `makeMacHostProvider` — a thin adapter:

  ```ts
  export function makeMacHostProvider(
    args: { repoRoot: string },
    containerEnv: Record<string, string>,
  ): SandboxProvider {
    return {
      async topLevelRun(spec) {
        const factory = macHostSandbox({ repoRoot: args.repoRoot, env: containerEnv });
        return await factory.run(spec);
      },
      async createSandbox(spec) {
        const factory = macHostSandbox({ repoRoot: args.repoRoot, env: spec.sandboxEnv });
        const handle = await factory.createSandbox({ branch: spec.branch });
        return {
          branch: handle.branch,
          worktreePath: handle.worktreePath,
          run: (opts) => handle.run(opts),
          close: () => handle.close(),
        };
      },
    };
  }
  ```

- [ ] **Step 4.4: Wire `buildSandboxProvider` in `main.mts`**

  Replace `buildSandboxFactory(...)` at `main.mts:1652-1688` and the `SandboxFactoryHandles` interface with:

  ```ts
  export function buildSandboxProvider(
    args: { sandbox: "docker" | "mac-host"; imageName: string; repoRoot: string },
    containerEnv: Record<string, string>,
    dockerConfig?: { hooks: unknown; copyToWorktree: readonly string[]; completionSignal: readonly string[]; copyToWorktreeMs: number },
  ): SandboxProvider {
    if (args.sandbox === "mac-host") {
      return makeMacHostProvider({ repoRoot: args.repoRoot }, containerEnv);
    }
    if (!dockerConfig) {
      throw new Error("docker provider requires dockerConfig");
    }
    return makeDockerProvider({ imageName: args.imageName, repoRoot: args.repoRoot }, containerEnv, dockerConfig);
  }
  ```

  Update `buildDefaultDeps` (currently spans `main.mts:1699` onward) to:

  1. Call `buildSandboxProvider` once with both `containerEnv` and the `dockerConfig` bag (built from the existing `hooks` / `copyToWorktree` / `completionSignal` / `600_000` locals).
  2. Replace the `Deps.run` body at `main.mts:1801-1834` with a single `return provider.topLevelRun({ ...spec, signal: undefined })` wrapped in `withCeiling`. (`withCeiling` injects the signal — must pass it through.)
  3. Replace the `Deps.createSandbox` body at `main.mts:1885-1958` with a `provider.createSandbox({ branch: spec.branch, sandboxEnv, mounts: spec.mounts })` call plus the existing pre-clean tier-3 logic. The pre-clean logic stays in main.mts because it predates the provider boundary and operates at the orchestrator's worktree path.
  4. Delete `factories.buildForTopLevel(...) as ReturnType<typeof docker>` / `as ReturnType<typeof macHostSandbox>` casts — they no longer compile or are needed.

- [ ] **Step 4.5: Run the routing test**

  ```bash
  pnpm vitest run tests/main-sandbox-routing.test.ts
  ```

  Expected: PASS.

- [ ] **Step 4.6: Run `tsc` to catch any remaining `unknown` / cast issues**

  ```bash
  pnpm tsc --noEmit
  ```

  Expected: clean. If anything fails, fix in place — each error points at a leftover cast or shape mismatch from the old `SandboxFactoryHandles`.

- [ ] **Step 4.7: Run the full suite**

  ```bash
  pnpm vitest run
  ```

  Expected: same count as Task 3 end (485) — the refactor preserves behavior, no new tests beyond routing.

- [ ] **Step 4.8: Manual Docker smoke (REQUIRED — user-confirmed Docker daemon available)**

  The test suite has no Docker integration tests (verified via grep). The refactor changes the docker call sites, so this smoke is the only behavioral check that nothing regressed on the Docker path. **User confirmed Docker is available locally; this step is mandatory, not optional.**

  In a throwaway repo configured for sandcastle Docker:

  ```bash
  cd /tmp && mkdir -p sc-smoke-docker && cd sc-smoke-docker
  # Set up minimal sandcastle config: .sandcastle/profile=minimal,
  # a trivial implement-prompt.md, a labeled queue-ready issue.
  # Reuse the same shape Task 10 of the mac-host plan used; only
  # the --sandbox flag differs.
  /Users/ziyadakl/Dev/Sandcastle/.sandcastle/sandcastle-wrapper.sh --sandbox docker --iterations 1
  ```

  Acceptance criteria:
  1. Loop starts the docker container without TypeError / undefined / cast-failure errors.
  2. `sandcastle.run` (top-level) or `sandcastle.createSandbox` (per-issue) is reached and accepts the provider's spec shape.
  3. One iteration runs to a recognizable terminal state (ship commit, HALT, or domain-level error like "no queue:ready issues").
  4. The pnpm install hook fires inside the container (the unconditional docker `hooks` from Step 4.4).

  Capture the wrapper's stderr output and report back before committing Task 4. If any acceptance criterion fails because of the refactor (vs. environment issues like docker pull rate-limit, missing image, etc.), STOP and re-examine the docker adapter — do not paper over with a workaround.

- [ ] **Step 4.9: Update `FOLLOW_UPS.md` §3**

  Remove the "per-handle `handle.run(opts)` env injection on the mac-host path" line because the new `ProviderCreateSpec.sandboxEnv` field closes it. The shell-block preprocessing and built-in `SOURCE_BRANCH` / `TARGET_BRANCH` lines stay.

- [ ] **Step 4.10: Commit**

  ```bash
  git add .sandcastle/lib/sandbox-provider.ts .sandcastle/lib/mac-host-sandbox.ts .sandcastle/main.mts tests/main-sandbox-routing.test.ts tests/mac-host-sandbox.test.ts FOLLOW_UPS.md
  git commit -m "refactor(sandbox): uniform SandboxProvider interface for docker and mac-host

  Collapse buildSandboxFactory's dual buildForTopLevel/buildForCreate
  shape and the if (args.sandbox === 'mac-host') branches in
  buildDefaultDeps into a single SandboxProvider interface that both
  providers implement. Docker-specific config (hooks, mounts,
  completionSignal, copyToWorktree, timeouts) is baked into the docker
  adapter at construction; per-call spec stays narrow.

  Closes Quality findings 1a, 1b, 2b, 3a from the /thermo-review of
  feat/mac-host-profile. Removes 'as ReturnType<typeof docker>' /
  'as ReturnType<typeof macHostSandbox>' casts.

  Bonus: per-handle sandboxEnv now flows through ProviderCreateSpec,
  closing FOLLOW_UPS.md §3 documented gap for mac-host per-call env.

  Docker path verified by routing test + manual smoke (or accept
  post-merge consumer verification — note in PR)."
  ```

---

## Self-review

**Spec coverage:**

- Tier 1 (commits drop) → Task 1 ✓
- Tier 2 (hooks ternary) → Non-goal (author-defended; surface to user) ✓
- Tier 3 (provider refactor, Quality 1a + 1b + 2b + 3a) → Task 4 ✓
- Tier 4 (testability: circular import + NODE_ENV seam, Quality 2a) → Tasks 2 + 3 ✓
- Quality 3b (dead hooks ternary) → Same as Tier 2; non-goal ✓
- Spec scope-creep → Non-goal ✓
- Spec help-text ordering → Non-goal ✓
- Spec activeProfile divergence → Non-goal ✓
- FOLLOW_UPS.md §3 per-handle env → Closed as Task 4 bonus ✓

**Placeholder scan:** the only `unknown` in the plan is `hooks: unknown` in `makeDockerProvider` — that's the SDK's actual type which the orchestrator currently treats as opaque. Acceptable; a follow-up could thread the SDK's `Hooks` type through. No TODOs, no "implement appropriate error handling", no missing test bodies.

**Type consistency:** `ProviderRunSpec` is used identically in Task 4 across spec and code. `SandboxProvider` named identically. `buildSandboxProvider` (new name) replaces `buildSandboxFactory` (old name) — every reference is in Task 4. `worktreePathFor` is the same name across Task 2's source and re-export.

---

## Execution-time commit/PR strategy (advisor-informed)

- Task 1 and Task 2 are tightly scoped and low-risk; safe to ship in their own commits even if Task 4 stalls or is rolled back.
- Task 3 changes a test-injection contract; medium risk because every existing test that used the old `NODE_ENV` seam needs migration in the same commit.
- Task 4 deserves its own commit so a revert is a single click if Docker breaks. Do not squash with Task 3 — they have orthogonal blast radius.
- Branch stays local. Do not push or PR without explicit user go-ahead (global rule, branch-level rule).

## Resolved decisions (user-confirmed 2026-06-03)

- **Tier 2 / Quality 3b (dead hooks ternary):** delegated to assistant judgment. Resolved as side-effect of Task 4 (Step 4.4 deletes the ternary + stale comment when docker config moves into `makeDockerProvider`'s construction bag). No standalone Task 5.
- **Docker smoke availability:** docker daemon available locally; Step 4.8 is mandatory, results must be reported before Task 4 commit.
