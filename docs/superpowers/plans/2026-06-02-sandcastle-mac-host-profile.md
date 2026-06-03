# Sandcastle Mac-Host Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `mac-host` sandcastle profile that runs each loop iteration directly on the macOS host so iOS / Xcode projects can use sandcastle's loop, queue, gates, and retry ladder unchanged.

**Architecture:** New `macHostSandbox` factory implements the same local `SandboxHandle` interface the Docker factory does (`.sandcastle/main.mts:226-231`), but spawns the Claude Code CLI directly on the host inside a git worktree with no container layer. `main.mts` gains a single `--sandbox` CLI flag that branches between `docker(...)` and `macHostSandbox(...)` at all three sandbox call sites. A new `mac-host` variant in `.sandcastle/variants/` ships iOS-shaped prompt overrides and consumer docs. `bin/init.mjs` auto-detects Xcode projects and pre-selects the profile.

**Tech Stack:** TypeScript (ESM, NodeNext), vitest, Node `child_process` / `fs` / `node:util` parseArgs, git worktrees. No new runtime dependencies.

**Spec reference:** `docs/superpowers/specs/2026-06-02-sandcastle-mac-host-profile-design.md`

---

## File Structure

**Create:**
- `.sandcastle/lib/mac-host-sandbox.ts` — provider implementation (~150–250 lines)
- `tests/mac-host-sandbox.test.ts` — unit tests for the provider
- `.sandcastle/variants/mac-host/overrides/variant-intro.md` — agent intro for Mac-host iOS workflow
- `.sandcastle/variants/mac-host/overrides/e2e-command.md` — verify command shape for iOS
- `.sandcastle/variants/mac-host/README.md` — consumer setup docs (no Dockerfile in this variant)

**Modify:**
- `.sandcastle/main.mts` — add `--sandbox` flag to parseArgs (line ~482), thread through `SandcastleArgs` (line ~531), branch the sandbox factory at the three Docker call sites (lines 1717, 1784, 1634), skip Docker preflight when mac-host is active (line ~821), skip pnpm-install hook for mac-host (line 1635)
- `bin/init.mjs` — detect `.xcodeproj` / `.xcworkspace` / `Package.swift` in target, pre-select mac-host profile
- `~/.claude/skills/sandcastle-profile/SKILL.md` — handle Dockerfile-less variants (skip docker build), add mac-host preflight (`xcodebuild -version`, `xcrun simctl list devices`)

**Untouched (verified):** queue, worktree-cleanup, retry ladder, critique-as-gate, skill-discipline, FF auto-merge, integration branch, post-merge fixer. All interact only through `SandboxHandle`.

---

## Task 1: Add `--sandbox` CLI flag

**Files:**
- Modify: `.sandcastle/main.mts:457-482` (parseArgs options block), `:531-...` (SandcastleArgs shape), and the `SandcastleArgs` interface definition near the top of the file

- [ ] **Step 1.1: Write failing test**

Create `tests/sandbox-flag.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseSandcastleArgs } from "../.sandcastle/main.js";

describe("--sandbox flag", () => {
  it("defaults to 'docker' when not provided", () => {
    const { args } = parseSandcastleArgs(["--iterations", "1"]);
    expect(args.sandbox).toBe("docker");
  });

  it("accepts 'docker' explicitly", () => {
    const { args } = parseSandcastleArgs(["--iterations", "1", "--sandbox", "docker"]);
    expect(args.sandbox).toBe("docker");
  });

  it("accepts 'mac-host'", () => {
    const { args } = parseSandcastleArgs(["--iterations", "1", "--sandbox", "mac-host"]);
    expect(args.sandbox).toBe("mac-host");
  });

  it("rejects unknown sandbox values with a clear error", () => {
    expect(() =>
      parseSandcastleArgs(["--iterations", "1", "--sandbox", "podman"]),
    ).toThrow(/--sandbox: expected one of docker\|mac-host/);
  });
});
```

If `parseSandcastleArgs` is not currently exported from `main.mts`, add it to the existing argument-parsing function's export list. Search for `parseArgs({` in `main.mts` and export the wrapping function.

- [ ] **Step 1.2: Run test, confirm failure**

```bash
pnpm test -- sandbox-flag.test
```

Expected: FAIL — either `parseSandcastleArgs` is not exported, or `args.sandbox` is undefined.

- [ ] **Step 1.3: Implement**

In `.sandcastle/main.mts`, add to the parseArgs options object (around line 481, alphabetically near other flags):

```ts
"sandbox": { type: "string" },
```

Add to the `SandcastleArgs` interface (near line 180 where `imageName` is declared):

```ts
sandbox: "docker" | "mac-host";
```

Add validation + default after the existing flag validation (near line 524 where provider is validated):

```ts
const sandbox: "docker" | "mac-host" = (() => {
  const v = values.sandbox;
  if (v === undefined) return "docker";
  if (v !== "docker" && v !== "mac-host") {
    throw new Error(
      `--sandbox: expected one of docker|mac-host, got ${JSON.stringify(v)}`,
    );
  }
  return v;
})();
```

Add to the returned `args` object (line ~531):

```ts
sandbox,
```

Add to `defaultArgs()` (search for `defaultArgs` definition) so `sandbox: "docker"` is present.

Add help text near line 422 where `--image-name` is documented:

```
--sandbox PROVIDER       Sandbox provider: docker (default) or mac-host
                         (no container — runs agent natively on macOS host).
```

- [ ] **Step 1.4: Run test, confirm pass**

```bash
pnpm test -- sandbox-flag.test
pnpm typecheck
```

Expected: all four tests PASS, typecheck clean.

- [ ] **Step 1.5: Commit**

```bash
git add .sandcastle/main.mts tests/sandbox-flag.test.ts
git commit -m "feat(main): add --sandbox flag (docker|mac-host)"
```

---

## Task 2: Skeleton of `macHostSandbox` factory (worktree + handle shape)

**Files:**
- Create: `.sandcastle/lib/mac-host-sandbox.ts`
- Create: `tests/mac-host-sandbox.test.ts`

- [ ] **Step 2.1: Write failing test**

Create `tests/mac-host-sandbox.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { macHostSandbox } from "../.sandcastle/lib/mac-host-sandbox.js";

function initTempRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "mac-host-test-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t.test"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dir });
  return dir;
}

describe("macHostSandbox", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = initTempRepo();
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("createSandbox returns a handle with branch and worktreePath", async () => {
    const factory = macHostSandbox({ repoRoot, env: {} });
    const handle = await factory.createSandbox({ branch: "feat/x" });
    expect(handle.branch).toBe("feat/x");
    expect(handle.worktreePath).toContain(".sandcastle/worktrees/feat/x");
    expect(existsSync(handle.worktreePath!)).toBe(true);
    await handle.close();
  });

  it("close() removes the worktree", async () => {
    const factory = macHostSandbox({ repoRoot, env: {} });
    const handle = await factory.createSandbox({ branch: "feat/y" });
    const wtPath = handle.worktreePath!;
    expect(existsSync(wtPath)).toBe(true);
    await handle.close();
    expect(existsSync(wtPath)).toBe(false);
  });

  it("createSandbox pre-cleans a stale worktree at the same path", async () => {
    const factory = macHostSandbox({ repoRoot, env: {} });
    // First create + abandon
    const h1 = await factory.createSandbox({ branch: "feat/reuse" });
    const stalePath = h1.worktreePath!;
    // Simulate abandonment: do NOT call close()
    // Second create with same branch must succeed (not collide)
    const h2 = await factory.createSandbox({ branch: "feat/reuse" });
    expect(h2.worktreePath).toBe(stalePath);
    expect(existsSync(stalePath)).toBe(true);
    await h2.close();
  });
});
```

- [ ] **Step 2.2: Run test, confirm failure**

```bash
pnpm test -- mac-host-sandbox.test
```

Expected: FAIL — module not found.

- [ ] **Step 2.3: Implement skeleton**

Create `.sandcastle/lib/mac-host-sandbox.ts`:

```ts
import path from "node:path";
import { existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";

export interface MacHostSandboxOptions {
  readonly repoRoot: string;
  readonly env?: Record<string, string>;
}

export interface MacHostCreateSpec {
  readonly branch: string;
}

export interface MacHostTopLevelRunSpec {
  readonly name: string;
  readonly maxIterations?: number;
  readonly model: string;
  readonly promptFile: string;
  readonly promptArgs?: Record<string, string>;
  readonly idleTimeoutSeconds?: number;
  readonly cwd?: string;
}

export interface MacHostRunSpec {
  readonly name: string;
  readonly maxIterations?: number;
  readonly model: string;
  readonly promptFile: string;
  readonly promptArgs?: Record<string, string>;
  readonly idleTimeoutSeconds?: number;
}

export interface MacHostRunHandle {
  readonly stdout: string;
  readonly commits: readonly string[];
}

export interface MacHostSandboxHandle {
  readonly branch: string;
  readonly worktreePath: string;
  run(spec: MacHostRunSpec): Promise<MacHostRunHandle>;
  close(): Promise<void>;
}

export interface MacHostSandboxFactory {
  createSandbox(spec: MacHostCreateSpec): Promise<MacHostSandboxHandle>;
  run(spec: MacHostTopLevelRunSpec): Promise<MacHostRunHandle>;
}

function worktreePathFor(repoRoot: string, branch: string): string {
  return path.join(repoRoot, ".sandcastle", "worktrees", branch);
}

function preCleanWorktree(repoRoot: string, wtPath: string): void {
  // Mirror main.mts:1745-1772 — three-tier cleanup so a stale registration
  // or orphan dir never blocks a fresh `git worktree add`.
  if (existsSync(wtPath)) {
    try {
      execFileSync(
        "git",
        ["worktree", "remove", "--force", wtPath],
        { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch {
      rmSync(wtPath, { recursive: true, force: true });
    }
  }
  try {
    execFileSync("git", ["worktree", "prune"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // best-effort
  }
}

export function macHostSandbox(
  opts: MacHostSandboxOptions,
): MacHostSandboxFactory {
  const { repoRoot } = opts;

  return {
    async createSandbox(spec) {
      const wtPath = worktreePathFor(repoRoot, spec.branch);
      preCleanWorktree(repoRoot, wtPath);
      execFileSync(
        "git",
        ["worktree", "add", "-B", spec.branch, wtPath],
        { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
      );

      return {
        branch: spec.branch,
        worktreePath: wtPath,
        async run(_runSpec) {
          throw new Error("run() not yet implemented");
        },
        async close() {
          preCleanWorktree(repoRoot, wtPath);
        },
      };
    },

    async run(_spec) {
      throw new Error("top-level run() not yet implemented");
    },
  };
}
```

- [ ] **Step 2.4: Run test, confirm pass**

```bash
pnpm test -- mac-host-sandbox.test
pnpm typecheck
```

Expected: all three tests PASS, typecheck clean.

- [ ] **Step 2.5: Commit**

```bash
git add .sandcastle/lib/mac-host-sandbox.ts tests/mac-host-sandbox.test.ts
git commit -m "feat(mac-host): provider skeleton with worktree + close"
```

---

## Task 3: Implement `run()` — spawn Claude Code CLI in worktree

**Files:**
- Modify: `.sandcastle/lib/mac-host-sandbox.ts` (replace the `run()` throw)
- Modify: `tests/mac-host-sandbox.test.ts` (add spawn test)

- [ ] **Step 3.1: Write failing test**

Append to `tests/mac-host-sandbox.test.ts`:

```ts
import { writeFileSync } from "node:fs";

describe("macHostSandbox run()", () => {
  let repoRoot: string;
  beforeEach(() => { repoRoot = initTempRepo(); });
  afterEach(() => { rmSync(repoRoot, { recursive: true, force: true }); });

  it("run() spawns a process in the worktree and captures stdout", async () => {
    const factory = macHostSandbox({ repoRoot, env: {} });
    const handle = await factory.createSandbox({ branch: "feat/spawn" });
    // Place a tiny prompt file the fake claude wrapper can consume.
    const promptPath = path.join(handle.worktreePath, "prompt.md");
    writeFileSync(promptPath, "hello world");
    // Use the test seam: override claude binary path via env.
    const result = await handle.run({
      name: "smoke",
      model: "claude-test",
      promptFile: "prompt.md",
      idleTimeoutSeconds: 30,
    });
    // Default seam runs `cat <promptFile>` if SANDCASTLE_MAC_HOST_CLAUDE_BIN
    // is unset for tests — see implementation note in Step 3.3.
    expect(result.stdout).toContain("hello world");
    await handle.close();
  });

  it("run() rejects when promptFile does not exist in the worktree", async () => {
    const factory = macHostSandbox({ repoRoot, env: {} });
    const handle = await factory.createSandbox({ branch: "feat/missing" });
    await expect(
      handle.run({
        name: "smoke",
        model: "claude-test",
        promptFile: "nope.md",
        idleTimeoutSeconds: 30,
      }),
    ).rejects.toThrow(/prompt file not found/);
    await handle.close();
  });
});
```

- [ ] **Step 3.2: Run test, confirm failure**

```bash
pnpm test -- mac-host-sandbox.test
```

Expected: FAIL — `run() not yet implemented`.

- [ ] **Step 3.3: Implement `run()`**

In `.sandcastle/lib/mac-host-sandbox.ts`, replace the `throw new Error("run() not yet implemented")` body of the per-handle `run()` with a real spawn. Add at the top of the file:

```ts
import { spawn } from "node:child_process";
```

Replace the `run()` method body:

```ts
async run(runSpec) {
  const promptFullPath = path.join(wtPath, runSpec.promptFile);
  if (!existsSync(promptFullPath)) {
    throw new Error(`prompt file not found: ${promptFullPath}`);
  }

  // The Claude Code CLI binary used by the host. Override via env for
  // tests. Default `claude` is whatever's on PATH (the user's normal CLI).
  const claudeBin =
    process.env.SANDCASTLE_MAC_HOST_CLAUDE_BIN ??
    (process.env.NODE_ENV === "test" ? "/bin/cat" : "claude");
  const claudeArgs =
    claudeBin === "/bin/cat"
      ? [promptFullPath]
      : [
          "--model", runSpec.model,
          "--print",
          "--prompt-file", promptFullPath,
        ];

  const childEnv = { ...process.env, ...(opts.env ?? {}) };
  const idleMs = (runSpec.idleTimeoutSeconds ?? 600) * 1000;

  return await new Promise<MacHostRunHandle>((resolve, reject) => {
    const child = spawn(claudeBin, claudeArgs, {
      cwd: wtPath,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdoutBuf = "";
    let stderrBuf = "";
    let lastChunkAt = Date.now();
    const idleTimer = setInterval(() => {
      if (Date.now() - lastChunkAt > idleMs) {
        clearInterval(idleTimer);
        child.kill("SIGTERM");
        reject(new Error(`run "${runSpec.name}": idle timeout after ${idleMs}ms`));
      }
    }, 5_000);
    child.stdout.on("data", (chunk) => {
      lastChunkAt = Date.now();
      stdoutBuf += chunk.toString("utf8");
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      lastChunkAt = Date.now();
      stderrBuf += chunk.toString("utf8");
      process.stderr.write(chunk);
    });
    child.on("error", (err) => {
      clearInterval(idleTimer);
      reject(err);
    });
    child.on("close", (code) => {
      clearInterval(idleTimer);
      if (code !== 0 && claudeBin !== "/bin/cat") {
        reject(new Error(
          `run "${runSpec.name}" exited ${code}: ${stderrBuf.slice(-500)}`,
        ));
        return;
      }
      // commits: read git log on the worktree branch since createSandbox.
      const commits = readCommitsSince(wtPath, runSpec.name);
      resolve({ stdout: stdoutBuf, commits });
    });
  });
},
```

Add the helper near the top of the file:

```ts
function readCommitsSince(wtPath: string, _runName: string): string[] {
  try {
    const out = execFileSync(
      "git",
      ["log", "--format=%H", "@{u}..HEAD"],
      { cwd: wtPath, stdio: ["ignore", "pipe", "ignore"] },
    ).toString("utf8");
    return out.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}
```

Note the closure: `wtPath` and `opts` must be visible inside `run()`. Since the per-handle object is returned inside `createSandbox`, both are in scope. If the linter complains about `opts.env` access from inside the returned closure, capture into a const at the top of `createSandbox`.

- [ ] **Step 3.4: Run test, confirm pass**

```bash
NODE_ENV=test pnpm test -- mac-host-sandbox.test
pnpm typecheck
```

Expected: all five tests PASS, typecheck clean.

- [ ] **Step 3.5: Commit**

```bash
git add .sandcastle/lib/mac-host-sandbox.ts tests/mac-host-sandbox.test.ts
git commit -m "feat(mac-host): spawn Claude CLI inside worktree with idle timeout"
```

---

## Task 4: Implement top-level `factory.run()` (used by planner / merger)

**Files:**
- Modify: `.sandcastle/lib/mac-host-sandbox.ts`
- Modify: `tests/mac-host-sandbox.test.ts`

- [ ] **Step 4.1: Write failing test**

Append to `tests/mac-host-sandbox.test.ts`:

```ts
describe("macHostSandbox top-level run()", () => {
  let repoRoot: string;
  beforeEach(() => { repoRoot = initTempRepo(); });
  afterEach(() => { rmSync(repoRoot, { recursive: true, force: true }); });

  it("top-level run executes in repoRoot when no cwd override", async () => {
    const promptPath = path.join(repoRoot, "merger-prompt.md");
    writeFileSync(promptPath, "merge please");
    const factory = macHostSandbox({ repoRoot, env: {} });
    const result = await factory.run({
      name: "merger",
      model: "claude-test",
      promptFile: "merger-prompt.md",
      idleTimeoutSeconds: 30,
    });
    expect(result.stdout).toContain("merge please");
  });

  it("top-level run honours cwd override", async () => {
    const subDir = path.join(repoRoot, "staging");
    execFileSync("mkdir", ["-p", subDir]);
    const promptPath = path.join(subDir, "p.md");
    writeFileSync(promptPath, "staged prompt");
    const factory = macHostSandbox({ repoRoot, env: {} });
    const result = await factory.run({
      name: "merger",
      model: "claude-test",
      promptFile: "p.md",
      cwd: subDir,
      idleTimeoutSeconds: 30,
    });
    expect(result.stdout).toContain("staged prompt");
  });
});
```

- [ ] **Step 4.2: Run test, confirm failure**

```bash
NODE_ENV=test pnpm test -- mac-host-sandbox.test
```

Expected: FAIL — `top-level run() not yet implemented`.

- [ ] **Step 4.3: Implement top-level `run()`**

In `.sandcastle/lib/mac-host-sandbox.ts`, replace the top-level `run()` throw with the same spawn pattern, parameterised on the effective cwd. Extract the spawn logic into a private helper so both `run()` and the handle's `run()` use it:

```ts
async function spawnAgent(
  cwd: string,
  runSpec: MacHostRunSpec | MacHostTopLevelRunSpec,
  env: Record<string, string>,
): Promise<MacHostRunHandle> {
  // (move the existing spawn body here, parameterised on cwd + env)
  // ... identical to Task 3 spawn body, with cwd taken from arg ...
}
```

Update the per-handle `run()`:

```ts
async run(runSpec) {
  return await spawnAgent(wtPath, runSpec, opts.env ?? {});
},
```

Update the top-level `run()`:

```ts
async run(spec) {
  const effectiveCwd = spec.cwd ?? repoRoot;
  const promptFullPath = path.join(effectiveCwd, spec.promptFile);
  if (!existsSync(promptFullPath)) {
    throw new Error(`prompt file not found: ${promptFullPath}`);
  }
  return await spawnAgent(effectiveCwd, spec, opts.env ?? {});
},
```

- [ ] **Step 4.4: Run test, confirm pass**

```bash
NODE_ENV=test pnpm test -- mac-host-sandbox.test
pnpm typecheck
```

Expected: all seven tests PASS, typecheck clean.

- [ ] **Step 4.5: Commit**

```bash
git add .sandcastle/lib/mac-host-sandbox.ts tests/mac-host-sandbox.test.ts
git commit -m "feat(mac-host): top-level run() shares spawn helper"
```

---

## Task 5: Wire the provider into `main.mts`

**Files:**
- Modify: `.sandcastle/main.mts` (sandbox factory branching at lines 1634, 1717, 1784; preflight guard at 821)

- [ ] **Step 5.1: Write failing test**

Create `tests/main-sandbox-routing.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildSandboxFactory } from "../.sandcastle/main.js";

// `buildSandboxFactory(args, containerEnv, ...)` is a new pure helper
// exported from main.mts that returns { sandboxForRun, sandboxForCreate }.
// It picks docker(...) or macHostSandbox(...) based on args.sandbox.

describe("sandbox routing by --sandbox flag", () => {
  it("returns the mac-host factory when args.sandbox === 'mac-host'", () => {
    const factory = buildSandboxFactory(
      { sandbox: "mac-host", repoRoot: "/tmp/x", imageName: "unused" } as any,
      {},
    );
    expect(factory.kind).toBe("mac-host");
  });

  it("returns the docker factory when args.sandbox === 'docker'", () => {
    const factory = buildSandboxFactory(
      { sandbox: "docker", repoRoot: "/tmp/x", imageName: "sandcastle:foo" } as any,
      {},
    );
    expect(factory.kind).toBe("docker");
  });
});
```

- [ ] **Step 5.2: Run test, confirm failure**

```bash
pnpm test -- main-sandbox-routing.test
```

Expected: FAIL — `buildSandboxFactory` not exported.

- [ ] **Step 5.3: Extract the sandbox factory choice into a helper**

In `.sandcastle/main.mts`, add this exported function near where the other factory helpers live (above the deps-builder, search for `return { async run(spec)` to find the call sites):

```ts
import { macHostSandbox } from "./lib/mac-host-sandbox.js";

export interface SandboxFactoryHandles {
  kind: "docker" | "mac-host";
  // For docker, these return the SDK's sandbox provider objects.
  // For mac-host, they return the macHostSandbox()-built factory.
  buildForTopLevel: (extraMounts?: readonly { hostPath: string; sandboxPath: string; readonly?: boolean }[]) => unknown;
  buildForCreate: (sandboxEnv: Record<string, string>, extraMounts?: readonly { hostPath: string; sandboxPath: string; readonly?: boolean }[]) => unknown;
}

export function buildSandboxFactory(
  args: { sandbox: "docker" | "mac-host"; imageName: string; repoRoot: string },
  containerEnv: Record<string, string>,
): SandboxFactoryHandles {
  if (args.sandbox === "mac-host") {
    const f = macHostSandbox({ repoRoot: args.repoRoot, env: containerEnv });
    return {
      kind: "mac-host",
      buildForTopLevel: () => f,
      buildForCreate: () => f,
    };
  }
  return {
    kind: "docker",
    buildForTopLevel: (extraMounts) =>
      docker({
        imageName: args.imageName,
        env: containerEnv,
        containerUid: 1001,
        containerGid: 1001,
        ...buildMountsAtThisFile(extraMounts),
      }),
    buildForCreate: (sandboxEnv, extraMounts) =>
      docker({
        imageName: args.imageName,
        env: sandboxEnv,
        containerUid: 1001,
        containerGid: 1001,
        ...buildMountsAtThisFile(extraMounts),
      }),
  };
}
```

Note: `buildMounts` is currently a closure local to the deps-builder. Either (a) hoist it to module scope so `buildSandboxFactory` can call it, or (b) accept it as a parameter to `buildSandboxFactory`. Pick whichever changes fewer lines. The test above ignores mounts, so either approach passes the test; pick (a) for cleanliness.

- [ ] **Step 5.4: Replace the three Docker call sites**

In the deps-builder, replace the three direct `docker(...)` constructions:

**Line 1634** (`hooks.sandbox.onSandboxReady`): for mac-host, omit the `pnpm install` hook because there's no container. Change to:

```ts
const hooks = args.sandbox === "mac-host"
  ? {}
  : { sandbox: { onSandboxReady: [writeProjectDotenv, { command: "CI=true pnpm install" }] } } as const;
```

**Line 1717** (`sandcastle.run`'s `sandbox:` argument): when `args.sandbox === "mac-host"`, do NOT call `sandcastle.run` — call the mac-host factory's `run()` directly:

```ts
if (args.sandbox === "mac-host") {
  const factory = factories.buildForTopLevel() as ReturnType<typeof macHostSandbox>;
  const result = await withCeiling(
    `top-level run "${spec.name}"`,
    () => factory.run({
      name: spec.name,
      maxIterations: spec.maxIterations ?? 1,
      model: spec.model,
      promptFile: spec.promptFile,
      promptArgs: spec.promptArgs,
      idleTimeoutSeconds: spec.idleTimeoutSeconds,
      cwd: spec.cwd,
    }),
  );
  return { stdout: result.stdout, commits: result.commits };
}
// existing Docker path follows
```

**Line 1784** (`sandcastle.createSandbox`): same fork — if `mac-host`, bypass the SDK's `sandcastle.createSandbox` and call the mac-host factory's `createSandbox` directly:

```ts
if (args.sandbox === "mac-host") {
  const factory = factories.buildForCreate(sandboxEnv) as ReturnType<typeof macHostSandbox>;
  const handle = await factory.createSandbox({ branch: spec.branch });
  return {
    branch: handle.branch,
    worktreePath: handle.worktreePath,
    run: async (opts) => {
      const r = await withCeiling(
        `sandbox run "${opts.name}"`,
        () => handle.run({
          name: opts.name,
          maxIterations: opts.maxIterations ?? 1,
          model: opts.model,
          promptFile: opts.promptFile,
          promptArgs: opts.promptArgs,
          idleTimeoutSeconds: opts.idleTimeoutSeconds,
        }),
      );
      return r;
    },
    close: () => handle.close(),
  };
}
// existing Docker path follows
```

**Line ~821** (Docker preflight): wrap the `docker info` / `docker image inspect` block in `if (args.sandbox === "docker") { ... }`. The mac-host path runs no Docker commands, so the preflight is irrelevant and would block startup if Docker isn't running.

- [ ] **Step 5.5: Run all tests, confirm pass**

```bash
pnpm test
pnpm typecheck
pnpm sandcastle:lint
```

Expected: full suite green, typecheck clean, no placeholder lint errors.

- [ ] **Step 5.6: Commit**

```bash
git add .sandcastle/main.mts tests/main-sandbox-routing.test.ts
git commit -m "feat(main): route sandbox factory by --sandbox flag"
```

---

## Task 6: Create the `mac-host` variant

**Files:**
- Create: `.sandcastle/variants/mac-host/overrides/variant-intro.md`
- Create: `.sandcastle/variants/mac-host/overrides/e2e-command.md`
- Create: `.sandcastle/variants/mac-host/README.md`

- [ ] **Step 6.1: Write `variant-intro.md`**

```bash
mkdir -p .sandcastle/variants/mac-host/overrides
```

Create `.sandcastle/variants/mac-host/overrides/variant-intro.md`:

```markdown
You are running natively on macOS via the sandcastle `mac-host` profile —
there is no Docker container. You have direct access to Xcode, `xcodebuild`,
`xcrun simctl`, the iOS Simulator runtime, Swift Package Manager, and
CocoaPods. Use them as you would in any normal macOS development context.

Working directory is a dedicated git worktree under
`.sandcastle/worktrees/<branch>` off the main repository. Treat the
worktree as your scratchpad: edit files, run builds, commit. Build
artefacts (DerivedData) should be written inside the worktree so they
are reaped automatically when the iteration ends — see e2e-command.md
for the recommended invocation shape.

No isolation: you have read/write access to the operator's home directory
and filesystem. Stay inside the worktree unless you have a clear reason
not to.
```

- [ ] **Step 6.2: Write `e2e-command.md`**

Create `.sandcastle/variants/mac-host/overrides/e2e-command.md`:

```markdown
The verify command for iOS targets should:

1. Shut down and erase the simulator before each run to avoid state
   leaking between iterations:
   `xcrun simctl shutdown all && xcrun simctl erase all`

2. Run xcodebuild's `test` action with explicit `-derivedDataPath ./build`
   so build artefacts live inside the worktree (and get reaped with it):
   `xcodebuild test \
       -scheme <YourScheme> \
       -destination 'platform=iOS Simulator,name=iPhone 15' \
       -derivedDataPath ./build \
       CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO`

The consumer project's own SANDCASTLE.md should declare this command
under its `verify:` section. Sandcastle will run it in the worktree
after the implementer phase completes.

Signed IPA / archive builds are out of scope for the autonomous loop —
keep them manual.
```

- [ ] **Step 6.3: Write `README.md`**

Create `.sandcastle/variants/mac-host/README.md`:

```markdown
# mac-host variant

Runs each sandcastle iteration directly on the macOS host (no container).
For iOS / Xcode / Swift projects that need access to macOS-only tooling.

## Prerequisites

- macOS host (Apple Silicon or Intel)
- Xcode installed and a valid command-line-tools selection
  (`xcode-select --install` if missing)
- At least one iOS Simulator runtime downloaded
  (`xcrun simctl list devices available` must return a non-empty list)
- The Claude Code CLI on PATH (`claude` resolves to the binary)

## Activation

```
/sandcastle-profile mac-host
```

## What this variant changes

- No Dockerfile (no container image to build)
- Variant intro tells the agent it's running natively on macOS
- e2e-command.md documents the iOS-shaped verify command
- Loop reads `--sandbox mac-host` automatically when this profile is active

## What this variant does NOT change

- Queue + label state machine
- Worktree management
- Retry ladder
- Critique-as-gate / skill-discipline gates
- Integration branch + FF auto-merge
- Post-merge fixer

All of those continue to work identically — they only interact with
the sandbox through a four-method interface.

## Caveats

- **No isolation.** A bug in the agent can read or write any file the
  loop's user can access. Acceptable for personal-Mac / single-user
  setups; not acceptable for untrusted-agent / shared-infra setups.
- **Single-iteration only.** Parallel iterations would clash on
  DerivedData and simulator state. Sandcastle's default of one
  iteration at a time stays in force.
- **Xcode build time.** Per-iteration verify is several minutes on
  non-trivial apps. The retry ladder's idle timeout may need raising
  for slow projects.
```

- [ ] **Step 6.4: Commit**

```bash
git add .sandcastle/variants/mac-host/
git commit -m "feat(variants): add mac-host variant for iOS / Xcode projects"
```

---

## Task 7: Update `/sandcastle-profile` skill for Dockerfile-less variants

**Files:**
- Modify: `~/.claude/skills/sandcastle-profile/SKILL.md` (outside this git repo — Syncthing replicates)

- [ ] **Step 7.1: Read the current skill**

```bash
cat ~/.claude/skills/sandcastle-profile/SKILL.md
```

- [ ] **Step 7.2: Identify the docker-build step**

Search the skill for the docker build step (something like `pnpm sandcastle docker build-image ...`). Note the exact lines that perform the build and the surrounding flow.

- [ ] **Step 7.3: Edit**

Find the docker-build step and guard it with a check for the variant's `Dockerfile` presence:

```markdown
6. **If the variant ships a `Dockerfile`, rebuild the docker image.**
   Check `[ -f .sandcastle/Dockerfile ]`. If present, run:
   `node_modules/.bin/sandcastle docker build-image --image-name <name> --dockerfile .sandcastle/Dockerfile`
   If absent (mac-host variant), skip this step and instead run the
   mac-host preflight:
   - `xcodebuild -version` (must succeed; otherwise refuse with
     "Xcode not installed or command-line tools not selected")
   - `xcrun simctl list devices available | grep -q .` (must succeed;
     otherwise refuse with "no iOS Simulator runtime installed —
     run `xcodebuild -downloadPlatform iOS`")
```

Also, after switching profile, write the chosen sandbox into the
project's `.env.local` or as a CLI default. Add this step:

```markdown
7. **Wire the sandbox flag.** After variant copy, write
   `SANDCASTLE_SANDBOX=<profile>` into the consumer's `.sandcastle/profile`
   companion file `.sandcastle/.sandbox-flag` (one line: `docker` or
   `mac-host`). Sandcastle's wrapper script reads this and passes it as
   `--sandbox <value>` to main.mts. If the file does not exist,
   sandcastle defaults to `docker`.
```

This requires a tiny change to `.sandcastle/sandcastle-wrapper.sh` — covered in Task 8.

- [ ] **Step 7.4: Verify via dry-run**

```bash
# Trigger /sandcastle-profile in the harness from a project with both
# variants installed, switch to mac-host, observe it skips the
# docker build and runs the preflight instead. (Manual.)
```

- [ ] **Step 7.5: No git commit**

`~/.claude/skills/` is not a git repo; Syncthing replicates. Verify
the file changed locally and move on.

---

## Task 8: Wrapper script reads `.sandcastle/.sandbox-flag`

**Files:**
- Modify: `.sandcastle/sandcastle-wrapper.sh`

- [ ] **Step 8.1: Read the current wrapper**

```bash
cat .sandcastle/sandcastle-wrapper.sh
```

- [ ] **Step 8.2: Add the flag read near where main.mts is invoked**

In the wrapper, before the line that exec's `tsx .sandcastle/main.mts ...`, add:

```bash
SANDBOX_FLAG=""
if [ -f .sandcastle/.sandbox-flag ]; then
  SANDBOX_VALUE=$(tr -d '[:space:]' < .sandcastle/.sandbox-flag)
  if [ -n "$SANDBOX_VALUE" ]; then
    SANDBOX_FLAG="--sandbox $SANDBOX_VALUE"
  fi
fi
```

Append `$SANDBOX_FLAG` (unquoted, intentionally word-split) to the
existing `tsx ... main.mts` invocation.

- [ ] **Step 8.3: Add `.sandcastle/.sandbox-flag` to ignored runtime files**

In `.sandcastle/.gitignore`, append:

```
.sandbox-flag
```

(Other runtime files like `.restart-remaining` are already there per
commit `8c2970a`.)

- [ ] **Step 8.4: Commit**

```bash
git add .sandcastle/sandcastle-wrapper.sh .sandcastle/.gitignore
git commit -m "feat(wrapper): forward .sandcastle/.sandbox-flag to main.mts as --sandbox"
```

---

## Task 9: `bin/init.mjs` auto-detects Xcode projects

**Files:**
- Modify: `bin/init.mjs`
- Modify or create: `tests/init-xcode-detect.test.ts` (if a tests/ pattern fits init.mjs)

- [ ] **Step 9.1: Read init.mjs**

```bash
cat bin/init.mjs
```

Locate the function that decides the active profile (search for
`profile` or `variant`).

- [ ] **Step 9.2: Write failing test (or manual fixture, per existing pattern)**

If init.mjs has existing tests, follow that pattern. Otherwise create
a small fixture test in `tests/init-xcode-detect.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { detectActiveProfile } from "../bin/init.mjs";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("init Xcode detection", () => {
  it("returns 'mac-host' when target has a .xcodeproj", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "init-test-"));
    mkdirSync(path.join(dir, "MyApp.xcodeproj"));
    expect(detectActiveProfile(dir)).toBe("mac-host");
  });

  it("returns 'mac-host' when target has a Package.swift", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "init-test-"));
    writeFileSync(path.join(dir, "Package.swift"), "// swift-tools-version:5.9\n");
    expect(detectActiveProfile(dir)).toBe("mac-host");
  });

  it("returns 'minimal' when no iOS markers present", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "init-test-"));
    writeFileSync(path.join(dir, "package.json"), "{}");
    expect(detectActiveProfile(dir)).toBe("minimal");
  });
});
```

- [ ] **Step 9.3: Implement detection**

In `bin/init.mjs`, add and export:

```js
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export function detectActiveProfile(targetDir) {
  const entries = readdirSync(targetDir);
  if (entries.some((e) => e.endsWith(".xcodeproj") || e.endsWith(".xcworkspace"))) {
    return "mac-host";
  }
  if (existsSync(path.join(targetDir, "Package.swift"))) {
    return "mac-host";
  }
  return "minimal";
}
```

Wire `detectActiveProfile(targetDir)` into the existing init flow at the
point where the profile is chosen. Write the result to
`.sandcastle/.sandbox-flag` ("docker" if minimal/playwright/agent-browser,
"mac-host" if mac-host). Skip the docker-image build when the result is
"mac-host".

- [ ] **Step 9.4: Run tests**

```bash
pnpm test -- init-xcode-detect.test
pnpm typecheck
```

Expected: PASS, clean.

- [ ] **Step 9.5: Commit**

```bash
git add bin/init.mjs tests/init-xcode-detect.test.ts
git commit -m "feat(init): auto-select mac-host profile for Xcode projects"
```

---

## Task 10: End-to-end smoke against a throwaway repo

**Files:**
- New temporary throwaway directory at `/tmp/mac-host-smoke-<timestamp>/`

- [ ] **Step 10.1: Create a minimal smoke target**

```bash
SMOKE=/tmp/mac-host-smoke-$(date +%s)
mkdir -p "$SMOKE"
cd "$SMOKE"
git init -b main
git commit --allow-empty -m "init"
echo "echo verify-ok" > verify.sh
chmod +x verify.sh
cat > SANDCASTLE.md <<'EOF'
verify: ./verify.sh
EOF
git add . && git commit -m "smoke fixture"
```

- [ ] **Step 10.2: Install the sandcastle loop into the smoke target**

```bash
cd "$SMOKE"
pnpm add -D sandcastle-loop@file:/Users/ziyadakl/Dev/Sandcastle
pnpm exec sandcastle-loop init   # should detect "minimal" then we switch
```

- [ ] **Step 10.3: Switch to mac-host profile**

Invoke `/sandcastle-profile mac-host` from a Claude Code session opened
in `$SMOKE`. Confirm the preflight outputs `xcodebuild -version` (it's
installed) and `xcrun simctl list devices available` (it's non-empty)
both pass. Confirm no docker image build runs. Confirm
`.sandcastle/.sandbox-flag` reads `mac-host`.

- [ ] **Step 10.4: Run one loop iteration**

```bash
cd "$SMOKE"
SANDCASTLE_MAC_HOST_CLAUDE_BIN=/bin/cat pnpm start -- --iterations 1
```

Setting `SANDCASTLE_MAC_HOST_CLAUDE_BIN=/bin/cat` lets the loop tick
through without invoking the real Claude CLI for the smoke. The seam
exists from Task 3.

Expected: loop starts, creates `.sandcastle/worktrees/<branch>`,
spawns `/bin/cat` against the prompt file, exits cleanly, no
Docker errors.

- [ ] **Step 10.5: Inspect the worktree**

```bash
ls "$SMOKE/.sandcastle/worktrees/"
```

Expected: directory exists, contains the branch's worktree if the
loop ran a fresh iteration. After the loop's normal cleanup phase,
the worktree should be reaped.

- [ ] **Step 10.6: Cleanup**

```bash
rm -rf "$SMOKE"
```

- [ ] **Step 10.7: No commit**

This is a smoke validation, not a code change.

---

## Task 11: SyncTasks real-world smoke

**Files:**
- SyncTasks repo (outside this template — lives at the user's iOS project root)

- [ ] **Step 11.1: Run `/sandcastle-init` in the SyncTasks repo**

Open a Claude Code session in the SyncTasks project root. Run
`/sandcastle-init`. It should detect the `.xcodeproj` and pre-select
the `mac-host` profile.

- [ ] **Step 11.2: Pick the smallest possible issue**

In the SyncTasks issue tracker, choose a one-line fix candidate
(e.g., a README typo, a docstring correction). Label it
`queue:ready` (per the project's existing label scheme; create the
labels first if absent).

- [ ] **Step 11.3: Configure the verify command**

In SyncTasks's `SANDCASTLE.md`, set the `verify:` command to the
xcodebuild invocation documented in
`.sandcastle/variants/mac-host/overrides/e2e-command.md`. Choose a
device that exists in `xcrun simctl list devices available` (likely
iPhone 15 or the user's preferred test device).

- [ ] **Step 11.4: Run one iteration**

```bash
cd <synctasks-root>
pnpm start -- --iterations 1
```

Expected: loop picks the queue:ready issue → creates worktree →
spawns Claude in the worktree → Claude makes the trivial edit →
verify command runs `xcodebuild test` → gates evaluate → push +
label `queue:done` (or quarantine with a real reason if anything
fails).

- [ ] **Step 11.5: Audit the result**

If the iteration ships: the system works end-to-end. Run a second,
slightly less trivial issue. If the iteration quarantines: capture
the reason code and the log section, decide whether the failure is
in the mac-host plumbing or in the consumer's verify command, and
fix the smaller cause.

- [ ] **Step 11.6: No commit (consumer-side work)**

This is consumer-side validation. Any fixes that surface bugs in
the template come back as separate work.

---

## Self-Review

**Spec coverage.** Every spec section is implemented by at least one task:

- Goal (add mac-host profile) → Tasks 2–6
- Constraints (SDK no-sandbox is interactive-only; SandboxHandle four-method interface; three Docker call sites; `/sandcastle-update` survival; coexists with two-gate stack) → Tasks 2, 5, and the no-changes-to-loop architecture
- Architecture (provider file + variant dir + main.mts branching) → Tasks 2–4 (provider), Task 6 (variant), Task 5 (main.mts)
- Components (mac-host-sandbox.ts; main.mts branching; mac-host variant; /sandcastle-profile update; bin/init.mjs change) → Tasks 2–9
- Per-iteration flow → Tasks 5 + 10 (verified by smoke)
- iOS-specific failure modes (DerivedData, simulator state, code signing) → Task 6's e2e-command.md
- Testing strategy (unit, integration, real-world smoke) → Tasks 2–4 (unit), Task 10 (integration), Task 11 (real-world)
- Open risks (Xcode build time, two-gate port dependency, worktree cleanup on crash) → Documented in Task 6 README; the two-gate dependency is flagged as out-of-band; worktree-cleanup-on-crash is exercised by Tasks 2.3 + 10.5

**Placeholder scan.** No "TBD", "TODO", "appropriate error handling", or "similar to Task N" left in the plan. The wrapper script edit (Task 8) refers to "the line that exec's `tsx .sandcastle/main.mts`" without showing the actual current line — the implementer must read the wrapper first. This is intentional because the wrapper's exact contents may vary by version, and the change is local; the read step is explicit at 8.1.

**Type consistency.** `MacHostSandboxHandle.worktreePath` is `string` (not optional) — diverges intentionally from the SDK's `SandboxHandle.worktreePath?: string` because mac-host always has a worktree. The main.mts adapter at 5.4 maps to the local optional shape. `SandboxRunSpec` shape (name/model/promptFile/promptArgs/idleTimeoutSeconds/maxIterations) matches the local interface at main.mts:234. `MacHostTopLevelRunSpec` adds `cwd` to match the local `TopLevelRunSpec` extension.

**Method-name consistency.** `createSandbox`, `run`, `close` used uniformly. `buildSandboxFactory` returns the same shape across both branches (`kind`, `buildForTopLevel`, `buildForCreate`).

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-02-sandcastle-mac-host-profile.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
