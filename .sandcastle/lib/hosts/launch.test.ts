/**
 * Coverage for `runLaunch`, the per-host launch safety gate, plus the
 * command-building helpers it calls once every gate passes.
 *
 * `launch.ts`'s own header claims "tests drive the gate DECISIONS with a
 * fake exec" and `scripts/launch.mts`'s header claims the gate "is tested
 * there with a fake exec" — until this file, neither was true. The only
 * coverage that existed was for the screen-check switch's forwarding (since
 * removed, spec #1334); the six-step gate itself (reachable, not-running, clean tree,
 * fast-forward update, auth, launch) had zero tests, so a regression there
 * would not fail loudly — it would silently double-launch a machine, launch
 * on a stale checkout, or skip every machine while reporting nothing ran.
 *
 * `deps.exec` is the ONLY collaborator `runLaunch` touches — no real
 * ssh/git process ever runs here. `makeFakeExec` below matches on argv shape
 * (the same contract `LaunchDeps.exec` documents), not on internal
 * implementation details like the exact pgrep script text.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  agentCommitIdentity,
  agentIdentityArgs,
} from "../git/identity.js";
import type { HostConfig } from "./registry.js";
import type { ExecResult, LaunchDeps, LaunchSpec } from "./launch.js";
import {
  ALREADY_RUNNING_MARKER,
  buildLaunchCommand,
  buildRemoteCommand,
  GRAFT_SENTINEL_PATH,
  OWN_SERVICE_UNIT_SH,
  runLaunch,
  SANDCASTLE_MINUS_TELEMETRY,
  SELF_HEAL_COMMIT_SUBJECT,
} from "./launch.js";

const LOCAL: HostConfig = {
  name: "mac",
  transport: "local",
  maxConcurrent: 2,
} as HostConfig;

const REMOTE: HostConfig = {
  name: "vps",
  transport: "my-server",
  repoPath: "/home/you/dev/my-project",
  maxConcurrent: 1,
} as HostConfig;

function spec(over: Partial<LaunchSpec> = {}): LaunchSpec {
  return {
    branch: "sandcastle/run-1",
    mode: "claude",
    iterations: 10,
    action: "run",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// buildLaunchCommand / buildRemoteCommand — actual output shape.
// ---------------------------------------------------------------------------

describe("the graft sentinel names a file this tree really carries (spec #1334)", () => {
  // The sentinel was `lib/judge/ruling.ts` until the judge was deleted. A
  // sentinel naming a file that no longer exists makes every host's self-heal
  // refuse forever, with nothing failing — so pin that it exists here.
  it("exists on disk, relative to the repository root", () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    expect(existsSync(path.join(repoRoot, GRAFT_SENTINEL_PATH))).toBe(true);
  });
});

describe("buildLaunchCommand — actual output shape", () => {
  // Both transports share the systemd arm; only the fallback arm differs.
  const wrapper = (concurrency: number) =>
    `bash .sandcastle/sandcastle-wrapper.sh --branch sandcastle/run-1 --backend claude ` +
    `--iterations 10 --max-concurrent ${concurrency}`;
  const shape = (concurrency: number, log: string, fallback: string) =>
    [
      `if systemctl --user show-environment >/dev/null 2>&1 && ` +
        `[ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" = yes ]; then`,
      `  u="sandcastle-$(printf %s "\${PWD##*/}" | tr -c 'A-Za-z0-9_.-' _)"`,
      `  if systemctl --user is-active --quiet "$u"; then echo "sandcastle-launch: already-running: $u" >&2; exit 1; fi`,
      `  systemd-run --user --collect --unit="$u" --working-directory="$PWD" ` +
        `-E PATH="$PWD/node_modules/.bin:$PATH" -E HOME="$HOME" ` +
        `$(compgen -e | sed -n 's/^SANDCASTLE_.*/-E &/p') ` +
        `bash -c 'exec ${wrapper(concurrency)} > ${log} 2>&1 </dev/null'`,
      "else",
      `  PATH="$PWD/node_modules/.bin:$PATH" ${fallback}`,
      "fi",
    ].join("\n");

  it("builds the exact LOCAL form — own systemd service, else nohup + disown", () => {
    expect(buildLaunchCommand(LOCAL, spec())).toBe(
      shape(2, "/tmp/sandcastle-mac.log",
        `nohup ${wrapper(2)} > /tmp/sandcastle-mac.log 2>&1 </dev/null & disown`),
    );
  });

  it("builds the exact REMOTE form — own systemd service, else setsid nohup", () => {
    expect(buildLaunchCommand(REMOTE, spec())).toBe(
      shape(1, "/tmp/sandcastle-vps.log",
        `setsid nohup ${wrapper(1)} > /tmp/sandcastle-vps.log 2>&1 </dev/null &`),
    );
  });

  // The exact-text tests above only compare against hand-written text, so a
  // slip that a shell rejects (a `;` after a trailing `&`) would pass them.
  // `bash -n` parses without running anything.
  it("parses as bash in every form, including wrapped for ssh", () => {
    const parses = (cmd: string) =>
      spawnSync("bash", ["-n", "-c", cmd], { encoding: "utf8" });
    for (const cmd of [
      buildLaunchCommand(LOCAL, spec({ label: "phase-1" })),
      buildLaunchCommand(REMOTE, spec()),
    ]) {
      expect(parses(cmd).stderr).toBe("");
      expect(parses(cmd).status).toBe(0);
    }
    const sshWrapped = buildRemoteCommand(REMOTE.repoPath!, [
      "bash",
      "-lc",
      buildLaunchCommand(REMOTE, spec()),
    ]);
    expect(parses(sshWrapped).status).toBe(0);
  });

  it("names the unit after the checkout folder, with characters systemd rejects made safe", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "launch-unit-"));
    const odd = path.join(dir, "My Project·2");
    mkdirSync(odd);
    const out = spawnSync("bash", ["-c", `echo "${OWN_SERVICE_UNIT_SH}"`], {
      cwd: odd,
      encoding: "utf8",
    });
    rmSync(dir, { recursive: true, force: true });
    expect(out.stdout.trim()).toBe("sandcastle-My_Project__2");
  });

  it("translates every LaunchMode to the exact main.mts flag(s)", () => {
    expect(buildLaunchCommand(LOCAL, spec({ mode: "claude" }))).toContain(
      "--backend claude --iterations",
    );
    expect(buildLaunchCommand(LOCAL, spec({ mode: "codex" }))).toContain(
      "--backend codex --iterations",
    );
    expect(buildLaunchCommand(LOCAL, spec({ mode: "budget" }))).toContain(
      "--backend claude --budget --iterations",
    );
    expect(buildLaunchCommand(LOCAL, spec({ mode: "kimi" }))).toContain(
      "--provider kimi --iterations",
    );
    expect(buildLaunchCommand(LOCAL, spec({ mode: "glm" }))).toContain(
      "--provider glm --iterations",
    );
  });

  // This pair used to assert the OPPOSITE — that a resume action appends
  // `--resume`. That is the bug, not the contract: main.mts's
  // `parseSandcastleArgs` is `parseArgs({ strict:true })` with no `resume`
  // option, so the flag killed the loop with "Unknown option '--resume'" the
  // moment it started. The tests were written from the code rather than from
  // the requirement, so they locked the crash in and kept it green.
  it("never emits --resume — main.mts has no such flag and would die on it", () => {
    const cmd = buildLaunchCommand(LOCAL, spec({ action: "resume" }));
    expect(cmd).not.toContain("--resume");
  });

  it("builds a resume identically to a run — the branch already carries the work", () => {
    expect(buildLaunchCommand(LOCAL, spec({ action: "resume" }))).toBe(
      buildLaunchCommand(LOCAL, spec({ action: "run" })),
    );
  });

  it("never emits --base — main.mts has no such flag and would die on it", () => {
    const cmd = buildLaunchCommand(LOCAL, spec({ base: "main" }));
    expect(cmd).not.toContain("--base");
  });

  it("forwards --label to the wrapper when the spec carries one (phased batches)", () => {
    const cmd = buildLaunchCommand(LOCAL, spec({ label: "phase-1" }));
    expect(cmd).toContain("--label phase-1");
  });

  it("omits --label when unset, so main.mts's own ready-for-agent default wins", () => {
    const cmd = buildLaunchCommand(LOCAL, spec());
    expect(cmd).not.toContain("--label");
  });

  it("keeps --label last, after --max-concurrent, on a resume too", () => {
    const cmd = buildLaunchCommand(
      LOCAL,
      spec({ label: "phase-2", action: "resume" }),
    );
    expect(cmd).toContain("--max-concurrent 2 --label phase-2 >");
  });

});

describe("buildRemoteCommand — actual output shape", () => {
  it("builds the exact cd + shell-quoted-argv form", () => {
    expect(
      buildRemoteCommand("/home/you/dev/my-project", [
        "git",
        "status",
        "--porcelain",
      ]),
    ).toBe(`cd '/home/you/dev/my-project' && 'git' 'status' '--porcelain'`);
  });

  it("escapes an embedded single quote in an argv element", () => {
    expect(buildRemoteCommand("/repo", ["echo", "it's"])).toBe(
      `cd '/repo' && 'echo' 'it'\\''s'`,
    );
  });

  it("escapes a single quote in the repo path itself", () => {
    expect(buildRemoteCommand("/o'brien/repo", ["true"])).toBe(
      `cd '/o'\\''brien/repo' && 'true'`,
    );
  });

  it("survives the remote shell round-trip intact for a launch command", () => {
    // ssh space-joins its args and the remote shell re-parses them, so the
    // whole command is shell-quoted by `buildRemoteCommand`.
    const cmd = buildLaunchCommand(REMOTE, spec());
    const remote = buildRemoteCommand(REMOTE.repoPath!, ["bash", "-lc", cmd]);
    expect(remote).toContain("--branch sandcastle/run-1");
    expect(remote.startsWith(`cd '${REMOTE.repoPath}' && `)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runLaunch — the six-step safety gate, driven end-to-end through a fake exec
// ---------------------------------------------------------------------------

function okResult(stdout = "", stderr = ""): ExecResult {
  return { ok: true, stdout, stderr, exitCode: 0 };
}

// A non-zero exit. `exitCode` defaults to 1 — the code most gates carry (and,
// for `git diff --quiet`, "differs") — but is overridable so a test can supply
// a real git ERROR (>= 2). Every gate other than step 4.5 branches on `ok`, so
// the exact value is immaterial to them.
function failResult(stderr = "boom", exitCode = 1): ExecResult {
  return { ok: false, stdout: "", stderr, exitCode };
}

interface StepResponses {
  reachable?: ExecResult;
  pgrep?: ExecResult;
  status?: ExecResult;
  fetch?: ExecResult;
  revParse?: ExecResult;
  checkout?: ExecResult;
  merge?: ExecResult;
  symbolicRef?: ExecResult;
  // step 4.5 self-heal — distinct from the branch fetch/checkout above
  fetchMain?: ExecResult;
  // `git diff --quiet origin/main -- .sandcastle <exclude-telemetry>` — does
  // the checkout differ from main? (exitCode 0 = same, 1 = differs, >= 2 =
  // git error)
  sandcastleDiff?: ExecResult;
  // `git log --format=%s origin/main..HEAD -- .sandcastle <exclude-telemetry>`
  // — the touched-probe. Its stdout is the subjects of the BRANCH's own
  // commits that changed the machinery; empty (the default) = untouched.
  touchedLog?: ExecResult;
  // `git cat-file -e origin/main:<graft sentinel>` — is main's .sandcastle
  // re-grafted? (default ok = yes)
  sentinel?: ExecResult;
  // `git rm -r --quiet --ignore-unmatch .sandcastle <exclude-telemetry>` — the
  // tree-replacement step
  syncRm?: ExecResult;
  syncCheckout?: ExecResult;
  syncCommit?: ExecResult;
  // `git push origin <branch>` — publishing the heal commit
  push?: ExecResult;
  // `git checkout HEAD -- .sandcastle` / `git restore --staged .sandcastle` —
  // the compensating restore after a failed sync
  restoreCheckout?: ExecResult;
  restoreStaged?: ExecResult;
  ghAuth?: ExecResult;
  ghIssue?: ExecResult;
  launchExec?: ExecResult;
}

/**
 * A fake `LaunchDeps.exec` that routes on argv SHAPE (the documented
 * `LaunchDeps.exec` contract), not on the gate's private script text, and
 * records every call so a test can assert both WHICH commands ran and in
 * what ORDER. Defaults are all-green so a single override reproduces exactly
 * one refusal without hand-wiring the other five steps every time.
 */
function makeFakeExec(
  branch: string,
  responses: StepResponses = {},
): { exec: LaunchDeps["exec"]; calls: { host: string; argv: string[] }[] } {
  const calls: { host: string; argv: string[] }[] = [];
  const exec: LaunchDeps["exec"] = async (host, argv) => {
    calls.push({ host: host.name, argv: [...argv] });
    const [cmd, a1, a2] = argv;
    if (cmd === "true") return responses.reachable ?? okResult();
    if (cmd === "bash" && a1 === "-lc" && typeof a2 === "string" && a2.includes("pgrep")) {
      return responses.pgrep ?? okResult();
    }
    if (cmd === "bash" && a1 === "-lc") {
      // the final detached-launch invocation
      return responses.launchExec ?? okResult();
    }
    if (cmd === "git" && a1 === "status") return responses.status ?? okResult();
    // step 4.5 fetch of origin/main — distinct from the branch fetch (argv[3])
    if (cmd === "git" && a1 === "fetch" && argv[3] === "main") {
      return responses.fetchMain ?? okResult();
    }
    if (cmd === "git" && a1 === "fetch") return responses.fetch ?? okResult();
    // step 4.5 staleness probe vs origin/main: `git diff --quiet origin/main
    // -- .sandcastle <exclude-telemetry>` — the only diff the gate issues.
    if (cmd === "git" && a1 === "diff") {
      return responses.sandcastleDiff ?? okResult();
    }
    // step 4.5 touched-probe: subjects of branch commits that changed the
    // machinery. Default = empty stdout = the branch left it untouched.
    if (cmd === "git" && a1 === "log") {
      return responses.touchedLog ?? okResult();
    }
    // step 4.5 graft-sentinel probe on origin/main's tree. Default ok = grafted.
    if (cmd === "git" && a1 === "cat-file") {
      return responses.sentinel ?? okResult();
    }
    if (cmd === "git" && a1 === "rev-parse") {
      return responses.revParse ?? okResult();
    }
    // step 4.5 tree-replacement: `git rm -r --quiet --ignore-unmatch …`
    if (cmd === "git" && a1 === "rm") {
      return responses.syncRm ?? okResult();
    }
    // step 4.5 sync checkout carries `origin/main` + the `.sandcastle`
    // pathspec; the compensating restore checks `.sandcastle` out of HEAD.
    // Both are distinct from the branch checkout, which never carries a
    // pathspec.
    if (cmd === "git" && a1 === "checkout" && argv.includes(".sandcastle")) {
      return argv.includes("HEAD")
        ? (responses.restoreCheckout ?? okResult())
        : (responses.syncCheckout ?? okResult());
    }
    if (cmd === "git" && a1 === "checkout") return responses.checkout ?? okResult();
    // step 4.5 compensating-restore unstage
    if (cmd === "git" && a1 === "restore") {
      return responses.restoreStaged ?? okResult();
    }
    // step 4.5 publish of the heal commit
    if (cmd === "git" && a1 === "push") {
      return responses.push ?? okResult();
    }
    if (cmd === "git" && a1 === "merge") return responses.merge ?? okResult();
    if (cmd === "git" && a1 === "symbolic-ref") {
      return responses.symbolicRef ?? okResult(branch);
    }
    // step 4.5 identity-spliced commit: argv[1] is `-c`, so match on "commit"
    if (cmd === "git" && argv.includes("commit")) {
      return responses.syncCommit ?? okResult();
    }
    if (cmd === "gh" && a1 === "auth") return responses.ghAuth ?? okResult();
    if (cmd === "gh" && a1 === "issue") return responses.ghIssue ?? okResult();
    throw new Error(`makeFakeExec: unexpected argv ${JSON.stringify(argv)}`);
  };
  return { exec, calls };
}

describe("runLaunch — refusals, each driven through the injected transport", () => {
  it("already-running: the loop's own unit is active at launch time, so the launch reports it as such", async () => {
    const stderr = `${ALREADY_RUNNING_MARKER}: sandcastle-my-project`;
    const { exec } = makeFakeExec("sandcastle/run-1", {
      launchExec: failResult(stderr),
    });
    const result = await runLaunch(REMOTE, spec(), { exec });
    expect(result).toEqual({ host: "vps", outcome: "already-running", detail: stderr });
  });

  it("preflight-error: any other launch failure keeps its own message", async () => {
    const { exec } = makeFakeExec("sandcastle/run-1", {
      launchExec: failResult("Failed to connect to bus"),
    });
    const result = await runLaunch(REMOTE, spec(), { exec });
    expect(result.outcome).toBe("preflight-error");
    expect(result.detail).toBe("Failed to connect to bus");
  });

  it("unreachable: step 1 fails, and nothing else is ever run", async () => {
    const { exec, calls } = makeFakeExec("sandcastle/run-1", {
      reachable: failResult("ssh: connection refused"),
    });
    const result = await runLaunch(REMOTE, spec(), { exec });
    expect(result).toEqual({
      host: "vps",
      outcome: "unreachable",
      detail: "ssh: connection refused",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].argv).toEqual(["true"]);
  });

  it("already-running: a live pid short-circuits before the tree is even checked", async () => {
    const { exec, calls } = makeFakeExec("sandcastle/run-1", {
      pgrep: okResult("4321\n"),
    });
    const result = await runLaunch(REMOTE, spec(), { exec });
    expect(result).toEqual({
      host: "vps",
      outcome: "already-running",
      detail: "pid 4321",
    });
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.argv[0])).toEqual(["true", "bash"]);
  });

  it("dirty-tree: uncommitted changes stop the gate before any fetch", async () => {
    const { exec, calls } = makeFakeExec("sandcastle/run-1", {
      status: okResult(" M .sandcastle/main.mts\n"),
    });
    const result = await runLaunch(REMOTE, spec(), { exec });
    expect(result).toEqual({ host: "vps", outcome: "dirty-tree" });
    expect(calls).toHaveLength(3);
    expect(calls.at(-1)!.argv).toEqual(["git", "status", "--porcelain"]);
  });

  it("diverged (non-fast-forward): a clean local branch can't ff-merge origin's tip", async () => {
    const { exec, calls } = makeFakeExec("sandcastle/run-1", {
      revParse: okResult("refs/heads/sandcastle/run-1"), // local branch exists
      merge: failResult("fatal: Not possible to fast-forward, aborting."),
    });
    const result = await runLaunch(REMOTE, spec(), { exec });
    expect(result).toEqual({
      host: "vps",
      outcome: "diverged",
      detail: "fatal: Not possible to fast-forward, aborting.",
    });
    // fetch, rev-parse, checkout <branch>, merge --ff-only — auth is never reached
    expect(calls.map((c) => c.argv[0])).toEqual([
      "true",
      "bash",
      "git",
      "git",
      "git",
      "git",
      "git",
    ]);
    expect(calls.at(-1)!.argv).toEqual(["git", "merge", "--ff-only", "FETCH_HEAD"]);
  });

  it("diverged: a fetch failure is also reported as diverged, never as unreachable", async () => {
    const { exec } = makeFakeExec("sandcastle/run-1", {
      fetch: failResult("fatal: couldn't find remote ref sandcastle/run-1"),
    });
    const result = await runLaunch(REMOTE, spec(), { exec });
    expect(result).toEqual({
      host: "vps",
      outcome: "diverged",
      detail: "fatal: couldn't find remote ref sandcastle/run-1",
    });
  });

  it("unauthenticated: gh auth status failing stops before the issue-list probe", async () => {
    const { exec, calls } = makeFakeExec("sandcastle/run-1", {
      revParse: okResult("refs/heads/sandcastle/run-1"),
      ghAuth: failResult("You are not logged into any GitHub hosts."),
    });
    const result = await runLaunch(REMOTE, spec(), { exec });
    expect(result).toEqual({
      host: "vps",
      outcome: "auth-failed",
      detail: "You are not logged into any GitHub hosts.",
    });
    expect(calls.at(-1)!.argv).toEqual(["gh", "auth", "status"]);
  });

  it("unauthenticated: gh auth status can pass while gh issue list still fails", async () => {
    const { exec } = makeFakeExec("sandcastle/run-1", {
      revParse: okResult("refs/heads/sandcastle/run-1"),
      ghIssue: failResult("HTTP 401: Bad credentials"),
    });
    const result = await runLaunch(REMOTE, spec(), { exec });
    expect(result).toEqual({
      host: "vps",
      outcome: "auth-failed",
      detail: "HTTP 401: Bad credentials",
    });
  });

  it("never forwards a token — auth always runs as the host's own `gh` identity", async () => {
    // No credential of any kind appears in any argv the gate issues.
    const { exec, calls } = makeFakeExec("sandcastle/run-1", {
      revParse: okResult("refs/heads/sandcastle/run-1"),
    });
    await runLaunch(REMOTE, spec(), { exec });
    for (const call of calls) {
      for (const arg of call.argv) {
        expect(String(arg)).not.toMatch(/token|ghp_|gho_/i);
      }
    }
  });

  it("preflight-error: HEAD detached after the update is refused, not silently launched", async () => {
    const { exec } = makeFakeExec("sandcastle/run-1", {
      revParse: okResult("refs/heads/sandcastle/run-1"),
      symbolicRef: failResult("fatal: ref HEAD is not a symbolic ref"),
    });
    const result = await runLaunch(REMOTE, spec(), { exec });
    expect(result).toEqual({
      host: "vps",
      outcome: "preflight-error",
      detail: "HEAD is detached after update",
    });
  });

  it("preflight-error: HEAD attached to the WRONG branch after the update is refused", async () => {
    const { exec } = makeFakeExec("sandcastle/run-1", {
      revParse: okResult("refs/heads/sandcastle/run-1"),
      symbolicRef: okResult("main"),
    });
    const result = await runLaunch(REMOTE, spec(), { exec });
    expect(result).toEqual({
      host: "vps",
      outcome: "preflight-error",
      detail: "HEAD is main after update, expected sandcastle/run-1",
    });
  });

  it("preflight-error: an unexpected thrown error degrades instead of crashing the sweep", async () => {
    const exec: LaunchDeps["exec"] = async () => {
      throw new Error("ECONNRESET");
    };
    const result = await runLaunch(REMOTE, spec(), { exec });
    expect(result).toEqual({
      host: "vps",
      outcome: "preflight-error",
      detail: "ECONNRESET",
    });
  });
});

describe("runLaunch — the success path", () => {
  it("a healthy machine with an existing local branch checks it out, ff-merges, and launches", async () => {
    const { exec, calls } = makeFakeExec("sandcastle/run-1", {
      revParse: okResult("refs/heads/sandcastle/run-1"),
    });
    const result = await runLaunch(REMOTE, spec(), { exec });

    expect(result.host).toBe("vps");
    expect(result.outcome).toBe("launched");
    expect(result.detail).toBe(buildLaunchCommand(REMOTE, spec()));

    // Every step ran, in order, ending with the exact detached launch argv.
    // The six git calls are: status, fetch <branch>, rev-parse, checkout,
    // merge, symbolic-ref; then step 4.5 adds fetch origin main + diff (the
    // `.sandcastle/` is CURRENT here, so no sync checkout/commit).
    expect(calls.map((c) => c.argv[0])).toEqual([
      "true",
      "bash",
      "git",
      "git",
      "git",
      "git",
      "git",
      "git",
      "git",
      "git",
      "gh",
      "gh",
      "bash",
    ]);
    const last = calls.at(-1)!;
    expect(last.argv).toEqual(["bash", "-lc", buildLaunchCommand(REMOTE, spec())]);
  });

  it("a healthy machine with NO local branch creates it at the fetched tip instead of resetting", async () => {
    const { exec, calls } = makeFakeExec("sandcastle/run-1", {
      revParse: failResult(""), // refs/heads/<branch> doesn't exist locally
    });
    const result = await runLaunch(REMOTE, spec(), { exec });

    expect(result.outcome).toBe("launched");
    const checkoutCall = calls.find(
      (c) => c.argv[0] === "git" && c.argv[1] === "checkout",
    )!;
    expect(checkoutCall.argv).toEqual([
      "git",
      "checkout",
      "-b",
      "sandcastle/run-1",
      "FETCH_HEAD",
    ]);
    // No merge step on the create path — nothing to ff-merge onto yet.
    expect(calls.some((c) => c.argv[1] === "merge")).toBe(false);
  });

  it("dryRun returns the launch command WITHOUT ever exec'ing it", async () => {
    const { exec, calls } = makeFakeExec("sandcastle/run-1", {
      revParse: okResult("refs/heads/sandcastle/run-1"),
    });
    const result = await runLaunch(REMOTE, spec({ dryRun: true }), { exec });

    expect(result).toEqual({
      host: "vps",
      outcome: "launched",
      detail: buildLaunchCommand(REMOTE, spec({ dryRun: true })),
    });
    // gh issue list is the last real check; no trailing `bash -lc <launch cmd>`.
    expect(calls.at(-1)!.argv).toEqual(["gh", "issue", "list", "-L", "1"]);
    expect(calls.filter((c) => c.argv[0] === "bash" && c.argv[1] === "-lc")).toHaveLength(1);
  });

  it("preflight-error: the detached launch exec itself failing is refused, not reported as launched", async () => {
    const { exec } = makeFakeExec("sandcastle/run-1", {
      revParse: okResult("refs/heads/sandcastle/run-1"),
      launchExec: failResult("nohup: failed to run command: No such file or directory"),
    });
    const result = await runLaunch(REMOTE, spec(), { exec });
    expect(result).toEqual({
      host: "vps",
      outcome: "preflight-error",
      detail: "nohup: failed to run command: No such file or directory",
    });
  });

  it("a healthy LOCAL machine launches with the local detach form (nohup + disown, no ssh)", async () => {
    const { exec, calls } = makeFakeExec("sandcastle/run-1", {
      revParse: okResult("refs/heads/sandcastle/run-1"),
    });
    const result = await runLaunch(LOCAL, spec(), { exec });

    expect(result.outcome).toBe("launched");
    expect(result.detail).toBe(buildLaunchCommand(LOCAL, spec()));
    expect(calls.every((c) => c.host === "mac")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runLaunch — step 4.5, the self-healing stale-machinery guard. The ff-only
// update (step 4) fast-forwards the run branch to ITS OWN origin tip, not to
// origin/main, so a RESUMED branch can carry stale `.sandcastle/` code. This
// step detects that against origin/main and, if stale, syncs ONLY `.sandcastle`
// and proceeds — a self-healing repair, not a refuse-and-halt gate.
// ---------------------------------------------------------------------------

/** Every `git checkout` argv the gate issued, for pathspec-scope assertions. */
function checkoutCalls(
  calls: { host: string; argv: string[] }[],
): string[][] {
  return calls
    .filter((c) => c.argv[0] === "git" && c.argv[1] === "checkout")
    .map((c) => c.argv);
}

describe("runLaunch — step 4.5 self-heal of stale loop machinery", () => {
  it("CURRENT: an up-to-date .sandcastle/ neither checks out nor commits — launch just proceeds", async () => {
    const { exec, calls } = makeFakeExec("sandcastle/run-1", {
      revParse: okResult("refs/heads/sandcastle/run-1"),
      sandcastleDiff: okResult(), // exit 0 = identical to origin/main
    });
    const result = await runLaunch(REMOTE, spec(), { exec });

    expect(result.outcome).toBe("launched");
    // The guard ran its detection — fetch origin main + the diff probe.
    expect(
      calls.some((c) => c.argv.join(" ") === "git fetch origin main"),
    ).toBe(true);
    expect(
      calls.some(
        (c) =>
          c.argv.join(" ") ===
          `git diff --quiet origin/main -- ${SANDCASTLE_MINUS_TELEMETRY.join(" ")}`,
      ),
    ).toBe(true);
    // …but it did NOT sync: no `.sandcastle` checkout, no commit.
    expect(checkoutCalls(calls).some((a) => a.includes(".sandcastle"))).toBe(
      false,
    );
    expect(calls.some((c) => c.argv.includes("commit"))).toBe(false);
  });

  it("STALE: a differing .sandcastle/ is synced from origin/main and committed, THEN launch proceeds", async () => {
    const { exec, calls } = makeFakeExec("sandcastle/run-1", {
      revParse: okResult("refs/heads/sandcastle/run-1"),
      sandcastleDiff: failResult(""), // exit 1 = differs from origin/main
    });
    const result = await runLaunch(REMOTE, spec(), { exec });

    // It self-heals and STILL launches — this is a repair, not a halt.
    expect(result.outcome).toBe("launched");
    expect(result.detail).toBe(buildLaunchCommand(REMOTE, spec()));

    // The sync checked out ONLY the `.sandcastle`-minus-telemetry pathspec
    // from origin/main.
    const sync = checkoutCalls(calls).find((a) => a.includes("origin/main"));
    expect(sync).toEqual([
      "git",
      "checkout",
      "origin/main",
      "--",
      ...SANDCASTLE_MINUS_TELEMETRY,
    ]);

    // …then committed it under the AGENT identity (never the owner's) with the
    // EXACT subject the touched-probe later exempts.
    const commit = calls.find((c) => c.argv.includes("commit"));
    expect(commit).toBeDefined();
    expect(commit!.argv.slice(0, 5)).toEqual(["git", ...agentIdentityArgs()]);
    expect(commit!.argv).toContain(`user.name=${agentCommitIdentity().name}`);
    expect(commit!.argv).toContain(`user.email=${agentCommitIdentity().email}`);
    expect(commit!.argv.at(-1)).toBe(SELF_HEAL_COMMIT_SUBJECT);
    // …and the launch really happened after the sync.
    expect(calls.at(-1)!.argv).toEqual([
      "bash",
      "-lc",
      buildLaunchCommand(REMOTE, spec()),
    ]);
  });

  it("TELEMETRY-ONLY TOUCH: the loop's own bookkeeping commits do NOT disarm the heal", async () => {
    // The loop commits `.sandcastle/telemetry/issues.jsonl` on the run branch
    // after EVERY processed issue, so a resumed branch essentially always has
    // `.sandcastle` commits of its own. Both step-4.5 probes are scoped to
    // `.sandcastle`-minus-telemetry, so those commits are invisible to the
    // touched-probe (the fake's empty `git log` stdout models exactly that) and
    // the heal RUNS instead of being skipped on every real resume.
    const { exec, calls } = makeFakeExec("sandcastle/run-1", {
      revParse: okResult("refs/heads/sandcastle/run-1"),
      sandcastleDiff: failResult(""), // machinery (minus telemetry) is stale
      touchedLog: okResult(""), // telemetry commits are outside the pathspec
    });
    const result = await runLaunch(REMOTE, spec(), { exec });

    expect(result.outcome).toBe("launched");
    // The heal really ran…
    expect(calls.some((c) => c.argv.includes("commit"))).toBe(true);
    // …and EVERY probe and sync command carried the telemetry exclusion, so the
    // branch's own telemetry data is never read as a touch nor reverted.
    const exclude = ":(exclude).sandcastle/telemetry";
    const scoped = calls.filter((c) =>
      ["diff", "log", "rm"].includes(c.argv[1]),
    );
    expect(scoped.length).toBeGreaterThanOrEqual(3);
    for (const c of scoped) expect(c.argv).toContain(exclude);
    const sync = checkoutCalls(calls).find((a) => a.includes("origin/main"))!;
    expect(sync).toContain(exclude);
  });

  it("PRIOR-HEAL-ONLY TOUCH: a previous self-heal commit does not disarm the guard on the next resume", async () => {
    // After one heal, the branch forever carries a commit touching
    // `.sandcastle`-minus-telemetry — the heal's own. If that counted as a
    // branch touch, the guard would disarm permanently after its first repair.
    // The touched-probe exempts the heal's exact commit subject.
    const { exec, calls } = makeFakeExec("sandcastle/run-1", {
      revParse: okResult("refs/heads/sandcastle/run-1"),
      sandcastleDiff: failResult(""),
      touchedLog: okResult(`${SELF_HEAL_COMMIT_SUBJECT}\n${SELF_HEAL_COMMIT_SUBJECT}\n`),
    });
    const result = await runLaunch(REMOTE, spec(), { exec });

    expect(result.outcome).toBe("launched");
    // The heal RAN again: rm, sync checkout, commit, push.
    expect(calls.some((c) => c.argv[1] === "rm")).toBe(true);
    expect(calls.some((c) => c.argv.includes("commit"))).toBe(true);
    expect(
      calls.some(
        (c) => c.argv.join(" ") === "git push origin sandcastle/run-1",
      ),
    ).toBe(true);
  });

  it("PUSH: the heal commit is pushed AFTER the commit, so peers fast-forward onto the healed tip", async () => {
    // Unpushed, every host of a multi-host resume mints its own heal commit on
    // the shared branch and the first run-end push splits it (peers then skip
    // as `diverged`).
    const { exec, calls } = makeFakeExec("sandcastle/run-1", {
      revParse: okResult("refs/heads/sandcastle/run-1"),
      sandcastleDiff: failResult(""),
    });
    const result = await runLaunch(REMOTE, spec(), { exec });

    expect(result.outcome).toBe("launched");
    const commitIdx = calls.findIndex((c) => c.argv.includes("commit"));
    const pushIdx = calls.findIndex(
      (c) => c.argv[0] === "git" && c.argv[1] === "push",
    );
    expect(commitIdx).toBeGreaterThanOrEqual(0);
    expect(pushIdx).toBeGreaterThan(commitIdx);
    expect(calls[pushIdx].argv).toEqual([
      "git",
      "push",
      "origin",
      "sandcastle/run-1",
    ]);
  });

  it("PUSH REJECTED, ff succeeds: the gate adopts the tip and still launches", async () => {
    // A transient rejection where fetch + ff-only recovers must not halt the
    // launch — the run-end push carries the commit later.
    const { exec, calls } = makeFakeExec("sandcastle/run-1", {
      revParse: okResult("refs/heads/sandcastle/run-1"),
      sandcastleDiff: failResult(""),
      push: failResult("! [rejected] (fetch first)"),
      // fetch + merge --ff-only default to ok
    });
    const result = await runLaunch(REMOTE, spec(), { exec });
    expect(result.outcome).toBe("launched");
    // The recovery really was fetch + ff-only, after the push.
    const pushIdx = calls.findIndex((c) => c.argv[1] === "push");
    const refetchIdx = calls.findIndex(
      (c, i) => i > pushIdx && c.argv[1] === "fetch",
    );
    const ffIdx = calls.findIndex((c, i) => i > pushIdx && c.argv[1] === "merge");
    expect(refetchIdx).toBeGreaterThan(pushIdx);
    expect(ffIdx).toBeGreaterThan(refetchIdx);
    expect(calls[ffIdx].argv).toEqual(["git", "merge", "--ff-only", "FETCH_HEAD"]);
  });

  it("PUSH REJECTED, ff also fails: preflight-error — never launch a split branch", async () => {
    // A peer healed first and our own heal commit diverged from its tip. The
    // no-local-branch path is used so the only `git merge` call is the
    // post-rejection ff attempt.
    const { exec, calls } = makeFakeExec("sandcastle/run-1", {
      revParse: failResult(""), // no local branch → checkout -b, no step-4 merge
      sandcastleDiff: failResult(""),
      push: failResult("! [rejected] sandcastle/run-1 -> sandcastle/run-1 (non-fast-forward)"),
      merge: failResult("fatal: Not possible to fast-forward, aborting."),
    });
    const result = await runLaunch(REMOTE, spec(), { exec });
    expect(result.outcome).toBe("preflight-error");
    expect(result.detail).toContain("[rejected]");
    // The detached launch never ran.
    expect(
      calls.some(
        (c) =>
          c.argv[0] === "bash" &&
          c.argv[1] === "-lc" &&
          !String(c.argv[2]).includes("pgrep"),
      ),
    ).toBe(false);
  });

  it("DRY-RUN: a stale .sandcastle is REPORTED, never mutated — no rm/checkout/commit/push", async () => {
    const { exec, calls } = makeFakeExec("sandcastle/run-1", {
      revParse: okResult("refs/heads/sandcastle/run-1"),
      sandcastleDiff: failResult(""), // stale → a real run would heal
    });
    const result = await runLaunch(REMOTE, spec({ dryRun: true }), { exec });

    expect(result.outcome).toBe("launched");
    expect(result.detail).toContain(
      "would self-heal .sandcastle from origin/main",
    );
    expect(result.detail).toContain(
      buildLaunchCommand(REMOTE, spec({ dryRun: true })),
    );
    // Read-only probes may run; nothing mutated.
    expect(calls.some((c) => c.argv[1] === "rm")).toBe(false);
    expect(checkoutCalls(calls).some((a) => a.includes(".sandcastle"))).toBe(
      false,
    );
    expect(calls.some((c) => c.argv.includes("commit"))).toBe(false);
    expect(calls.some((c) => c.argv[1] === "push")).toBe(false);
  });

  it("UN-RE-GRAFTED MAIN: a missing graft sentinel on origin/main refuses the downgrade and launches on the branch's machinery", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { exec, calls } = makeFakeExec("sandcastle/run-1", {
        revParse: okResult("refs/heads/sandcastle/run-1"),
        sandcastleDiff: failResult(""),
        sentinel: failResult("", 1), // sentinel absent from origin/main's tree
      });
      const result = await runLaunch(REMOTE, spec(), { exec });

      expect(result.outcome).toBe("launched");
      // The probe really targeted origin/main's tree at the sentinel path…
      expect(
        calls.some(
          (c) =>
            c.argv[1] === "cat-file" &&
            c.argv.includes(`origin/main:${GRAFT_SENTINEL_PATH}`),
        ),
      ).toBe(true);
      // …no sync happened…
      expect(calls.some((c) => c.argv[1] === "rm")).toBe(false);
      expect(calls.some((c) => c.argv.includes("commit"))).toBe(false);
      // …and it warned loudly, naming the refusal.
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("un-re-grafted"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("GRAFTED MAIN: the sentinel present lets the heal proceed (the probe is consulted, then the sync runs)", async () => {
    const { exec, calls } = makeFakeExec("sandcastle/run-1", {
      revParse: okResult("refs/heads/sandcastle/run-1"),
      sandcastleDiff: failResult(""),
      // sentinel defaults to ok → present
    });
    const result = await runLaunch(REMOTE, spec(), { exec });
    expect(result.outcome).toBe("launched");
    const sentinelIdx = calls.findIndex((c) => c.argv[1] === "cat-file");
    const rmIdx = calls.findIndex((c) => c.argv[1] === "rm");
    expect(sentinelIdx).toBeGreaterThanOrEqual(0);
    expect(rmIdx).toBeGreaterThan(sentinelIdx);
  });

  it("sync FAILS (checkout errors): compensating restore runs, then preflight-error — never runs stale, never left rm'd", async () => {
    const { exec, calls } = makeFakeExec("sandcastle/run-1", {
      revParse: okResult("refs/heads/sandcastle/run-1"),
      sandcastleDiff: failResult(""),
      syncCheckout: failResult("error: pathspec 'origin/main' did not match"),
    });
    const result = await runLaunch(REMOTE, spec(), { exec });

    expect(result.outcome).toBe("preflight-error");
    expect(result.detail).toContain(
      "error: pathspec 'origin/main' did not match",
    );
    // A failure AFTER the `git rm` must not strand the host with the machinery
    // deleted (the next launch would die at the dirty-tree gate): the gate
    // issues the compensating restore, and the detail reports its success.
    expect(
      calls.some(
        (c) => c.argv.join(" ") === "git checkout HEAD -- .sandcastle",
      ),
    ).toBe(true);
    expect(
      calls.some(
        (c) => c.argv.join(" ") === "git restore --staged .sandcastle",
      ),
    ).toBe(true);
    expect(result.detail).toContain("working tree restored to HEAD");
    // No commit, and crucially no detached launch exec.
    expect(calls.some((c) => c.argv.includes("commit"))).toBe(false);
    expect(
      calls.some((c) => c.argv[0] === "bash" && c.argv[1] === "-lc" && !String(c.argv[2]).includes("pgrep")),
    ).toBe(false);
  });

  it("sync FAILS (checkout errors) and the restore ALSO fails: the detail says so", async () => {
    const { exec } = makeFakeExec("sandcastle/run-1", {
      revParse: okResult("refs/heads/sandcastle/run-1"),
      sandcastleDiff: failResult(""),
      syncCheckout: failResult("error: unable to write file"),
      restoreCheckout: failResult("fatal: disk full"),
    });
    const result = await runLaunch(REMOTE, spec(), { exec });
    expect(result.outcome).toBe("preflight-error");
    expect(result.detail).toContain("RESTORE FAILED");
  });

  it("sync FAILS (commit errors): compensating restore runs, then preflight-error — never runs stale", async () => {
    const { exec, calls } = makeFakeExec("sandcastle/run-1", {
      revParse: okResult("refs/heads/sandcastle/run-1"),
      sandcastleDiff: failResult(""),
      syncCommit: failResult("nothing to commit, working tree clean"),
    });
    const result = await runLaunch(REMOTE, spec(), { exec });

    expect(result.outcome).toBe("preflight-error");
    expect(result.detail).toContain("nothing to commit, working tree clean");
    expect(result.detail).toContain("working tree restored to HEAD");
    // The compensating restore ran here too — the rm had already happened.
    expect(
      calls.some(
        (c) => c.argv.join(" ") === "git checkout HEAD -- .sandcastle",
      ),
    ).toBe(true);
    // The detached launch never ran.
    expect(
      calls.some((c) => c.argv[0] === "bash" && c.argv[1] === "-lc" && !String(c.argv[2]).includes("pgrep")),
    ).toBe(false);
  });

  it("fetch of origin/main FAILS: preflight-error — cannot verify machinery is current", async () => {
    const { exec } = makeFakeExec("sandcastle/run-1", {
      revParse: okResult("refs/heads/sandcastle/run-1"),
      fetchMain: failResult("fatal: couldn't find remote ref main"),
    });
    const result = await runLaunch(REMOTE, spec(), { exec });
    expect(result).toEqual({
      host: "vps",
      outcome: "preflight-error",
      detail: "fatal: couldn't find remote ref main",
    });
  });

  it("SCOPE: the sync never merges origin/main wholesale into the run branch", async () => {
    // The stale-base landmine: a bare `git merge origin/main` (or a checkout
    // without the `.sandcastle` pathspec) would drag main's product changes
    // onto the in-flight run branch. The only origin/main touch is the scoped
    // `.sandcastle` checkout.
    const { exec, calls } = makeFakeExec("sandcastle/run-1", {
      revParse: okResult("refs/heads/sandcastle/run-1"),
      sandcastleDiff: failResult(""),
    });
    await runLaunch(REMOTE, spec(), { exec });

    // No `git merge` ever touches origin/main.
    expect(
      calls.some(
        (c) =>
          c.argv[0] === "git" &&
          c.argv[1] === "merge" &&
          c.argv.includes("origin/main"),
      ),
    ).toBe(false);
    // Every checkout that touches origin/main is pathspec-scoped to `.sandcastle`.
    for (const argv of checkoutCalls(calls)) {
      if (argv.includes("origin/main")) {
        expect(argv).toContain("--");
        expect(argv).toContain(".sandcastle");
      }
    }
  });

  it("DELETION: the sync `git rm`s the tree BEFORE checking main back in, so a file deleted on main is not orphaned", async () => {
    // `git checkout origin/main -- .sandcastle` only adds/updates paths that
    // EXIST in main; it never removes a `.sandcastle` file main deleted/renamed.
    // The fix makes the sync a TRUE tree replacement: `git rm -r
    // --ignore-unmatch .sandcastle` first, THEN the checkout. Without the rm, a
    // deletion-only diff stages nothing → the commit fails "nothing to commit" →
    // every host on the shared run branch false-halts.
    const { exec, calls } = makeFakeExec("sandcastle/run-1", {
      revParse: okResult("refs/heads/sandcastle/run-1"),
      sandcastleDiff: failResult(""), // differs from origin/main
      // touchedLog defaults to empty stdout → pure staleness → heal runs
    });
    const result = await runLaunch(REMOTE, spec(), { exec });

    // It self-heals and STILL launches.
    expect(result.outcome).toBe("launched");

    // The `git rm` argv is exactly the tracked-only, deletion-tolerant,
    // telemetry-sparing form…
    const rmIdx = calls.findIndex(
      (c) => c.argv[0] === "git" && c.argv[1] === "rm",
    );
    expect(rmIdx).toBeGreaterThanOrEqual(0);
    expect(calls[rmIdx].argv).toEqual([
      "git",
      "rm",
      "-r",
      "--quiet",
      "--ignore-unmatch",
      ...SANDCASTLE_MINUS_TELEMETRY,
    ]);
    // …and it PRECEDES the `.sandcastle` checkout of origin/main.
    const syncCheckoutIdx = calls.findIndex(
      (c) =>
        c.argv[0] === "git" &&
        c.argv[1] === "checkout" &&
        c.argv.includes("origin/main") &&
        c.argv.includes(".sandcastle"),
    );
    expect(syncCheckoutIdx).toBeGreaterThan(rmIdx);
    // The commit still runs after the replacement, so the deletion is recorded.
    expect(calls.some((c) => c.argv.includes("commit"))).toBe(true);
  });

  it("AHEAD-OF-MAIN: when the BRANCH itself changed .sandcastle, no revert — no checkout, no commit, launch proceeds", async () => {
    // The branch legitimately carries its own `.sandcastle` work (a machinery
    // fix landed on the branch, or dogfooding). Reverting it to main would be
    // silent loss of committed work. The direction guard (the touched-probe's
    // `git log` of branch-authored machinery commits) must SKIP the heal and
    // launch on the branch's own machinery, warning loudly. A genuine machinery
    // commit is one whose subject is NOT the heal's own.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { exec, calls } = makeFakeExec("sandcastle/run-1", {
        revParse: okResult("refs/heads/sandcastle/run-1"),
        sandcastleDiff: failResult(""), // differs from origin/main
        // A genuine machinery commit — alongside a prior heal commit, which
        // alone would NOT count. The genuine one wins: skip.
        touchedLog: okResult(
          `fix(sandcastle): branch-authored machinery fix\n${SELF_HEAL_COMMIT_SUBJECT}\n`,
        ),
      });
      const result = await runLaunch(REMOTE, spec(), { exec });

      // Launches on the branch's own machinery — not a halt.
      expect(result.outcome).toBe("launched");
      expect(result.detail).toBe(buildLaunchCommand(REMOTE, spec()));

      // Crucially: NO auto-revert. No `.sandcastle` checkout of origin/main, no
      // `git rm`, no self-heal commit, no push.
      expect(
        checkoutCalls(calls).some((a) => a.includes(".sandcastle")),
      ).toBe(false);
      expect(calls.some((c) => c.argv[0] === "git" && c.argv[1] === "rm")).toBe(
        false,
      );
      expect(calls.some((c) => c.argv.includes("commit"))).toBe(false);
      expect(calls.some((c) => c.argv[1] === "push")).toBe(false);

      // …but it DID consult the direction guard (the touched-probe `git log`,
      // telemetry excluded).
      const log = calls.find(
        (c) => c.argv[0] === "git" && c.argv[1] === "log",
      )!;
      expect(log.argv).toEqual([
        "git",
        "log",
        "--format=%s",
        "origin/main..HEAD",
        "--",
        ...SANDCASTLE_MINUS_TELEMETRY,
      ]);
      // …and said so loudly.
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("auto-heal SKIPPED"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("GIT-ERROR: a `git diff --quiet` that ERRORS (exit >= 2) is preflight-error, not a needless sync", async () => {
    // exit 0 = same, 1 = differs, >= 2 = a git error (bad object, corrupt
    // index). Reading `ok` alone conflated "differs" with "error" and synced
    // needlessly; reading the exit code refuses the error instead.
    const { exec, calls } = makeFakeExec("sandcastle/run-1", {
      revParse: okResult("refs/heads/sandcastle/run-1"),
      sandcastleDiff: failResult("fatal: bad object origin/main", 128),
    });
    const result = await runLaunch(REMOTE, spec(), { exec });

    expect(result.outcome).toBe("preflight-error");
    expect(result.detail).toBe("fatal: bad object origin/main");
    // It did NOT sync: no touched-probe `git log`, no `git rm`, no `.sandcastle`
    // checkout, no commit, and no detached launch.
    expect(
      calls.some((c) => c.argv[0] === "git" && c.argv[1] === "log"),
    ).toBe(false);
    expect(calls.some((c) => c.argv[0] === "git" && c.argv[1] === "rm")).toBe(
      false,
    );
    expect(checkoutCalls(calls).some((a) => a.includes(".sandcastle"))).toBe(
      false,
    );
    expect(calls.some((c) => c.argv.includes("commit"))).toBe(false);
    expect(
      calls.some(
        (c) =>
          c.argv[0] === "bash" &&
          c.argv[1] === "-lc" &&
          !String(c.argv[2]).includes("pgrep"),
      ),
    ).toBe(false);
  });
});
