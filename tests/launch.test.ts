import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import type { HostConfig } from "../.sandcastle/lib/hosts/registry.js";
import {
  runLaunch,
  buildLaunchCommand,
  buildRemoteCommand,
  isLaunchMode,
  type LaunchDeps,
  type LaunchSpec,
  type ExecResult,
} from "../.sandcastle/lib/hosts/launch.js";
import { parseSandcastleArgs } from "../.sandcastle/main.mjs";

const REPO_ROOT = path.resolve(__dirname, "..");
const RUNNER = path.join(REPO_ROOT, ".sandcastle/scripts/launch.mts");

const LOCAL: HostConfig = { name: "local", transport: "local", maxConcurrent: 2 };
const REMOTE: HostConfig = { name: "hub", transport: "hub", maxConcurrent: 1 };

const RUN_SPEC: LaunchSpec = {
  branch: "sandcastle/theme-20260716",
  mode: "claude",
  iterations: 10,
  action: "run",
};

/** Classify a gate argv into a stable key so the fake can answer per-stage. */
function classify(argv: string[]): string {
  const [a0, a1] = argv;
  if (a0 === "true") return "reachable";
  if (a0 === "bash") {
    const script = argv[2] ?? "";
    if (script.includes("pgrep")) return "pgrep";
    if (script.includes("sandcastle-wrapper.sh")) return "launch";
  }
  if (a0 === "git" && a1 === "status") return "status";
  if (a0 === "git" && a1 === "fetch") return "fetch";
  if (a0 === "git" && a1 === "rev-parse") return "rev-parse";
  if (a0 === "git" && a1 === "checkout") return "checkout";
  if (a0 === "git" && a1 === "merge") return "merge";
  if (a0 === "git" && a1 === "symbolic-ref") return "symbolic-ref";
  if (a0 === "gh" && a1 === "auth") return "gh-auth";
  if (a0 === "gh" && a1 === "issue") return "gh-issue";
  return "unknown";
}

interface FakeCall {
  host: string;
  argv: string[];
  key: string;
}

/** A fake exec: records every call and answers per-stage from `overrides`. */
function makeExec(overrides: Partial<Record<string, ExecResult>> = {}): {
  deps: LaunchDeps;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const defaults: Record<string, ExecResult> = {
    reachable: { ok: true, stdout: "ok", stderr: "" },
    pgrep: { ok: true, stdout: "", stderr: "" }, // no surviving pid -> not running
    status: { ok: true, stdout: "", stderr: "" }, // clean tree
    fetch: { ok: true, stdout: "", stderr: "" },
    "rev-parse": { ok: true, stdout: "abc123", stderr: "" }, // local run branch exists
    checkout: { ok: true, stdout: "", stderr: "" },
    merge: { ok: true, stdout: "Fast-forward", stderr: "" },
    "symbolic-ref": { ok: true, stdout: "sandcastle/theme-20260716", stderr: "" },
    "gh-auth": { ok: true, stdout: "Logged in", stderr: "" },
    "gh-issue": { ok: true, stdout: "#1 something", stderr: "" },
    launch: { ok: true, stdout: "", stderr: "" },
    unknown: { ok: true, stdout: "", stderr: "" },
  };
  const deps: LaunchDeps = {
    exec: async (host, argv) => {
      const key = classify(argv);
      calls.push({ host: host.name, argv, key });
      return overrides[key] ?? defaults[key];
    },
  };
  return { deps, calls };
}

const keys = (calls: FakeCall[]) => calls.map((c) => c.key);

describe("runLaunch safety gate", () => {
  it("returns unreachable and short-circuits when the host is not reachable", async () => {
    const { deps, calls } = makeExec({ reachable: { ok: false, stdout: "", stderr: "no route" } });
    const res = await runLaunch(LOCAL, RUN_SPEC, deps);
    expect(res.outcome).toBe("unreachable");
    // later gates never ran
    expect(keys(calls)).toEqual(["reachable"]);
  });

  it("returns already-running when the cwd-filtered pgrep finds a live loop", async () => {
    const { deps, calls } = makeExec({ pgrep: { ok: true, stdout: "12345\n", stderr: "" } });
    const res = await runLaunch(LOCAL, RUN_SPEC, deps);
    expect(res.outcome).toBe("already-running");
    expect(keys(calls)).toEqual(["reachable", "pgrep"]);
  });

  it("returns dirty-tree when git status --porcelain is non-empty, before touching the network", async () => {
    const { deps, calls } = makeExec({ status: { ok: true, stdout: " M src/foo.ts\n", stderr: "" } });
    const res = await runLaunch(LOCAL, RUN_SPEC, deps);
    expect(res.outcome).toBe("dirty-tree");
    expect(keys(calls)).toEqual(["reachable", "pgrep", "status"]);
    expect(keys(calls)).not.toContain("fetch");
  });

  it("returns diverged when the ff-only merge fails, and NEVER issues pull or reset", async () => {
    const { deps, calls } = makeExec({ merge: { ok: false, stdout: "", stderr: "Not possible to fast-forward" } });
    const res = await runLaunch(LOCAL, RUN_SPEC, deps);
    expect(res.outcome).toBe("diverged");
    // it DID try to fetch + ff-merge...
    expect(keys(calls)).toContain("fetch");
    expect(keys(calls)).toContain("merge");
    // ...but never forced anything
    const flat = calls.flatMap((c) => c.argv);
    expect(flat).not.toContain("pull");
    expect(flat).not.toContain("reset");
    // and never advanced to auth
    expect(keys(calls)).not.toContain("gh-auth");
  });

  it("returns preflight-error when HEAD is detached after the update (ADR 0016 attachment re-check)", async () => {
    const { deps } = makeExec({ "symbolic-ref": { ok: false, stdout: "", stderr: "not a symbolic ref" } });
    const res = await runLaunch(LOCAL, RUN_SPEC, deps);
    expect(res.outcome).toBe("preflight-error");
  });

  it("checks out the run branch when it EXISTS locally, ff-merges onto it, then launches", async () => {
    // host was sitting on `main`; the run branch exists locally.
    const { deps, calls } = makeExec();
    const res = await runLaunch(LOCAL, RUN_SPEC, deps);
    expect(res.outcome).toBe("launched");
    // it verified local existence, checked out the run branch, THEN ff-merged
    expect(keys(calls)).toEqual([
      "reachable",
      "pgrep",
      "status",
      "fetch",
      "rev-parse",
      "checkout",
      "merge",
      "symbolic-ref",
      "gh-auth",
      "gh-issue",
      "launch",
    ]);
    const checkout = calls.find((c) => c.key === "checkout")!;
    // a plain checkout of the existing branch — NOT a -b create, NOT a reset
    expect(checkout.argv).toEqual(["git", "checkout", "sandcastle/theme-20260716"]);
    const flat = calls.flatMap((c) => c.argv);
    expect(flat).not.toContain("reset");
    expect(flat).not.toContain("pull");
  });

  it("creates the run branch at the fetched tip when it is ABSENT locally, then launches", async () => {
    const { deps, calls } = makeExec({
      "rev-parse": { ok: false, stdout: "", stderr: "" }, // branch not present locally
    });
    const res = await runLaunch(LOCAL, RUN_SPEC, deps);
    expect(res.outcome).toBe("launched");
    // no ff-merge step — the branch is created directly at FETCH_HEAD
    expect(keys(calls)).toEqual([
      "reachable",
      "pgrep",
      "status",
      "fetch",
      "rev-parse",
      "checkout",
      "symbolic-ref",
      "gh-auth",
      "gh-issue",
      "launch",
    ]);
    const checkout = calls.find((c) => c.key === "checkout")!;
    expect(checkout.argv).toEqual([
      "git",
      "checkout",
      "-b",
      "sandcastle/theme-20260716",
      "FETCH_HEAD",
    ]);
    const flat = calls.flatMap((c) => c.argv);
    expect(flat).not.toContain("reset");
  });

  it("returns diverged when the local run branch cannot fast-forward, and never launches", async () => {
    const { deps, calls } = makeExec({
      merge: { ok: false, stdout: "", stderr: "Not possible to fast-forward" },
    });
    const res = await runLaunch(LOCAL, RUN_SPEC, deps);
    expect(res.outcome).toBe("diverged");
    expect(keys(calls)).not.toContain("launch");
    const flat = calls.flatMap((c) => c.argv);
    expect(flat).not.toContain("reset");
    expect(flat).not.toContain("pull");
  });

  it("returns preflight-error when HEAD ends up on the wrong branch after the update", async () => {
    const { deps } = makeExec({
      "symbolic-ref": { ok: true, stdout: "main", stderr: "" }, // still on main
    });
    const res = await runLaunch(LOCAL, RUN_SPEC, deps);
    expect(res.outcome).toBe("preflight-error");
    expect(res.detail).toContain("main");
    expect(res.detail).toContain("sandcastle/theme-20260716");
  });

  it("returns auth-failed when gh auth status fails, and does not launch", async () => {
    const { deps, calls } = makeExec({ "gh-auth": { ok: false, stdout: "", stderr: "not logged in" } });
    const res = await runLaunch(LOCAL, RUN_SPEC, deps);
    expect(res.outcome).toBe("auth-failed");
    expect(keys(calls)).not.toContain("launch");
  });
});

describe("runLaunch launch command", () => {
  it("launches on a local host: runs every gate in order then execs the wrapper detached WITHOUT setsid", async () => {
    const { deps, calls } = makeExec();
    const res = await runLaunch(LOCAL, RUN_SPEC, deps);
    expect(res.outcome).toBe("launched");
    expect(keys(calls)).toEqual([
      "reachable",
      "pgrep",
      "status",
      "fetch",
      "rev-parse",
      "checkout",
      "merge",
      "symbolic-ref",
      "gh-auth",
      "gh-issue",
      "launch",
    ]);
    const launch = calls.find((c) => c.key === "launch")!;
    const script = launch.argv[2];
    expect(script).toContain("bash .sandcastle/sandcastle-wrapper.sh");
    expect(script).toContain("--max-concurrent 2"); // registry value wins
    expect(script).toContain("nohup");
    expect(script).toContain("disown");
    expect(script).not.toContain("setsid"); // macOS has no setsid
  });

  it("local launch prefixes the node_modules PATH so a non-global tsx resolves", () => {
    // The local exec runs with cwd = repoRoot (scripts/launch.mts), so
    // $PWD/node_modules/.bin is where the vendored `tsx` lives. Without the
    // prefix a bare `tsx` dies "command not found" when it isn't installed
    // globally — the live-dogfood bug this guards.
    const cmd = buildLaunchCommand(LOCAL, RUN_SPEC);
    expect(cmd).toContain('PATH="$PWD/node_modules/.bin:$PATH"');
    // still the macOS detach form — no setsid
    expect(cmd).toContain("nohup");
    expect(cmd).toContain("disown");
    expect(cmd).not.toContain("setsid");
  });

  it("launches on a remote host: uses setsid + the node_modules PATH prefix and the host's concurrency", async () => {
    const { deps, calls } = makeExec();
    const res = await runLaunch(REMOTE, RUN_SPEC, deps);
    expect(res.outcome).toBe("launched");
    const launch = calls.find((c) => c.key === "launch")!;
    const script = launch.argv[2];
    expect(script).toContain("setsid");
    expect(script).toContain('PATH="$PWD/node_modules/.bin:$PATH"');
    expect(script).toContain("--max-concurrent 1"); // this host's cap, not local's
  });

  it("dry-run surfaces the exact launch command in detail and NEVER execs the wrapper", async () => {
    const { deps, calls } = makeExec();
    const res = await runLaunch(LOCAL, { ...RUN_SPEC, dryRun: true }, deps);
    expect(res.outcome).toBe("launched");
    expect(res.detail).toBe(buildLaunchCommand(LOCAL, { ...RUN_SPEC, dryRun: true }));
    expect(res.detail).toContain("sandcastle-wrapper.sh");
    expect(res.detail).toContain("--max-concurrent 2");
    // the gates all ran, but the wrapper was NOT exec'd
    expect(keys(calls)).not.toContain("launch");
  });

  it("includes --resume in the launch command for a resume action", async () => {
    const cmd = buildLaunchCommand(LOCAL, { ...RUN_SPEC, action: "resume" });
    expect(cmd).toContain("--resume");
  });
});

describe("buildLaunchCommand mode → main.mts flag translation", () => {
  // main.mts's parseSandcastleArgs is strict:true and has NO --mode option, so
  // the wrapper must emit the flags main.mts actually understands, not --mode.
  const cases: ReadonlyArray<[LaunchSpec["mode"], string]> = [
    ["claude", "--backend claude"],
    ["codex", "--backend codex"],
    ["kimi", "--provider kimi"],
    ["glm", "--provider glm"],
  ];

  for (const [mode, expected] of cases) {
    it(`emits ${JSON.stringify(expected)} for mode ${mode} and never a --mode flag`, () => {
      const cmd = buildLaunchCommand(LOCAL, { ...RUN_SPEC, mode });
      expect(cmd).toContain(expected);
      expect(cmd).not.toContain("--mode");
    });
  }
});

describe("launcher output ↔ main.mts parser contract", () => {
  // Integration guard the string-only unit tests can't give: drive the flags
  // the launcher actually emits through the REAL parseSandcastleArgs. A drift
  // between the launcher and main.mts's strict option set (e.g. the old --mode)
  // fails HERE even if every string assertion above still passes.

  /** Pull the wrapper argv out of a built launch command. */
  function wrapperFlags(cmd: string): string[] {
    const after = cmd.split("sandcastle-wrapper.sh ")[1];
    const flags = after.split(" > ")[0].trim();
    return flags.split(/\s+/);
  }

  const cases: ReadonlyArray<
    [LaunchSpec["mode"], "claude" | "codex", string | undefined]
  > = [
    ["claude", "claude", undefined],
    ["codex", "codex", undefined],
    ["kimi", "claude", "kimi"],
    ["glm", "claude", "glm"],
  ];

  for (const [mode, backend, provider] of cases) {
    it(`mode ${mode} parses into backend=${backend} provider=${provider} without throwing`, () => {
      const cmd = buildLaunchCommand(LOCAL, { ...RUN_SPEC, mode });
      const flags = wrapperFlags(cmd);
      // sanity: the launcher must NOT emit --mode (main.mts would reject it)
      expect(flags).not.toContain("--mode");
      let parsed!: ReturnType<typeof parseSandcastleArgs>;
      expect(() => {
        parsed = parseSandcastleArgs(flags);
      }).not.toThrow();
      expect(parsed.args.backend).toBe(backend);
      expect(parsed.args.provider).toBe(provider);
    });
  }
});

describe("buildRemoteCommand shell quoting", () => {
  it("cd's to the shell-quoted repoPath then joins the shell-quoted argv", () => {
    const cmd = buildRemoteCommand("/home/deploy/repo", ["git", "status", "--porcelain"]);
    expect(cmd).toBe("cd '/home/deploy/repo' && 'git' 'status' '--porcelain'");
  });

  it("quotes a repoPath containing spaces", () => {
    const cmd = buildRemoteCommand("/home/dev/my repo", ["true"]);
    expect(cmd).toBe("cd '/home/dev/my repo' && 'true'");
  });

  it("escapes embedded single quotes with the '\\'' idiom", () => {
    const cmd = buildRemoteCommand("/r", ["echo", "it's a test"]);
    // each ' becomes '\'' — closing the quote, an escaped literal ', reopening
    expect(cmd).toBe("cd '/r' && 'echo' 'it'\\''s a test'");
  });

  it("passes double quotes, $, && and newlines through literally inside single quotes", () => {
    const cmd = buildRemoteCommand("/r", ['echo "a" && b', "$PWD\nfoo"]);
    expect(cmd).toBe("cd '/r' && 'echo \"a\" && b' '$PWD\nfoo'");
  });

  it("round-trips a realistic multi-line bash -lc script element", () => {
    const script = "for pid in $(pgrep -f x); do\n  echo \"$pid\"\ndone";
    const cmd = buildRemoteCommand("/r", ["bash", "-lc", script]);
    expect(cmd).toBe(`cd '/r' && 'bash' '-lc' '${script}'`);
  });

  it("reconstructs the original argv when the string is parsed by a POSIX shell", () => {
    // Prove shq escaping is correct: feed the quoted-argv tail to `sh -c` with a
    // printf that emits one line per positional param, and assert we get the
    // original argv back verbatim (embedded quotes, $, spaces, newlines).
    const argv = ["bash", "-lc", 'echo PWD=$PWD; printf %s "a b"  c', "it's \"x\"", "a$b&&c"];
    const quoted = buildRemoteCommand("/tmp", argv).replace(/^cd '\/tmp' && /, "");
    const res = spawnSync(
      "sh",
      ["-c", `printf '%s\\n' ${quoted}`],
      { encoding: "utf8" },
    );
    expect(res.status).toBe(0);
    // printf emits each positional arg on its own line; the argv had no newline
    // elements here, so splitting on \n recovers the original argv exactly.
    expect(res.stdout.split("\n").slice(0, argv.length)).toEqual(argv);
  });
});

describe("LaunchMode", () => {
  it("accepts the four canonical modes and rejects anything else", () => {
    for (const m of ["claude", "codex", "kimi", "glm"]) {
      expect(isLaunchMode(m)).toBe(true);
    }
    expect(isLaunchMode("bogus")).toBe(false);
    expect(isLaunchMode("")).toBe(false);
    expect(isLaunchMode("anthropic")).toBe(false);
  });
});

describe("launch.mts runner --mode validation", () => {
  it("rejects an unknown --mode with a clear error and a non-zero exit", () => {
    const res = spawnSync("npx", ["tsx", RUNNER, "--branch", "x", "--mode", "bogus"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("--mode");
    expect(res.stderr).toContain("bogus");
  });
});

describe("buildLaunchCommand per-host concurrency", () => {
  it("passes maxConcurrent=1 for a cap-1 host and maxConcurrent=2 for a cap-2 host", () => {
    expect(buildLaunchCommand({ name: "a", transport: "local", maxConcurrent: 1 }, RUN_SPEC)).toContain(
      "--max-concurrent 1",
    );
    expect(buildLaunchCommand({ name: "b", transport: "x", maxConcurrent: 2 }, RUN_SPEC)).toContain(
      "--max-concurrent 2",
    );
  });
});
