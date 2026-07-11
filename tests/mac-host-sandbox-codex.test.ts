import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
  existsSync,
  readFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { macHostSandbox } from "../.sandcastle/lib/mac-host-sandbox.js";

function initTempRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "mac-host-codex-test-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t.test"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dir });
  return dir;
}

// Fake `codex` that exits 0 after writing a fixed final message to its `-o`
// file — enough for the AGENTS.md staging tests, which only care that the
// per-sandbox run path executed, not about the verdict text.
function writeFakeCodexFinal(dir: string): string {
  const fakeBin = path.join(dir, "fake-codex-final.sh");
  writeFileSync(
    fakeBin,
    [
      "#!/bin/sh",
      "out=''",
      "while [ $# -gt 0 ]; do",
      '  if [ "$1" = "-o" ]; then out="$2"; fi',
      "  shift",
      "done",
      'printf "FINAL" > "$out"',
      "exit 0",
    ].join("\n") + "\n",
  );
  chmodSync(fakeBin, 0o755);
  return fakeBin;
}

function excludeFileContents(worktreePath: string): string {
  const rel = execFileSync(
    "git",
    ["rev-parse", "--git-path", "info/exclude"],
    { cwd: worktreePath },
  )
    .toString("utf8")
    .trim();
  const exPath = path.resolve(worktreePath, rel);
  return existsSync(exPath) ? readFileSync(exPath, "utf8") : "";
}

describe("macHostSandbox codex backend", () => {
  let repoRoot: string;
  let prevBin: string | undefined;

  beforeEach(() => {
    repoRoot = initTempRepo();
    prevBin = process.env.SANDCASTLE_MAC_HOST_CODEX_BIN;
  });
  afterEach(() => {
    if (prevBin === undefined) delete process.env.SANDCASTLE_MAC_HOST_CODEX_BIN;
    else process.env.SANDCASTLE_MAC_HOST_CODEX_BIN = prevBin;
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("returns the -o last-message file as stdout, NOT the JSONL stream", async () => {
    // Fake codex: parse its own argv for `-o <file>`, write the final agent
    // message THERE, and print DIFFERENT JSONL to stdout. The run's stdout must
    // equal the file contents (parity with claude's final-message stdout), not
    // the JSONL events.
    const fakeBin = path.join(repoRoot, "fake-codex.sh");
    writeFileSync(
      fakeBin,
      [
        "#!/bin/sh",
        // echo a JSONL event to stdout (this must NOT be returned as stdout)
        'echo \'{"type":"event","text":"streaming-noise"}\'',
        // find the -o argument and write the real final message into it
        "out=''",
        "while [ $# -gt 0 ]; do",
        '  if [ "$1" = "-o" ]; then out="$2"; fi',
        "  shift",
        "done",
        'printf "FINAL_AGENT_VERDICT" > "$out"',
        "exit 0",
      ].join("\n") + "\n",
    );
    chmodSync(fakeBin, 0o755);
    process.env.SANDCASTLE_MAC_HOST_CODEX_BIN = fakeBin;

    const factory = macHostSandbox({ repoRoot, env: {} });
    const handle = await factory.createSandbox({ branch: "feat/codex" });
    writeFileSync(path.join(handle.worktreePath, "p.md"), "do the thing");
    const result = await handle.run({
      name: "codex-smoke",
      model: "gpt-5-codex",
      promptFile: "p.md",
      idleTimeoutSeconds: 30,
    });
    expect(result.stdout).toBe("FINAL_AGENT_VERDICT");
    expect(result.stdout).not.toContain("streaming-noise");
    await handle.close();
  });

  it("rejects when codex exits 0 but writes no last-message file", async () => {
    // Fake codex that exits 0 without writing the -o file → hard error, no
    // fallback to the JSONL stdout buffer.
    const fakeBin = path.join(repoRoot, "fake-codex-empty.sh");
    writeFileSync(fakeBin, "#!/bin/sh\necho noise\nexit 0\n");
    chmodSync(fakeBin, 0o755);
    process.env.SANDCASTLE_MAC_HOST_CODEX_BIN = fakeBin;

    const factory = macHostSandbox({ repoRoot, env: {} });
    const handle = await factory.createSandbox({ branch: "feat/codex-empty" });
    writeFileSync(path.join(handle.worktreePath, "p.md"), "x");
    await expect(
      handle.run({
        name: "codex-empty",
        model: "gpt-5-codex",
        promptFile: "p.md",
        idleTimeoutSeconds: 30,
      }),
    ).rejects.toThrow(/last-message file/);
    await handle.close();
  });

  it("passes the -m model and reads the prompt from stdin", async () => {
    // Fake codex echoes its model arg + stdin into the -o file so we can assert
    // the codex invocation shape (prompt on stdin, model via -m).
    const fakeBin = path.join(repoRoot, "fake-codex-echo.sh");
    writeFileSync(
      fakeBin,
      [
        "#!/bin/sh",
        "model=''",
        "out=''",
        "while [ $# -gt 0 ]; do",
        '  if [ "$1" = "-m" ]; then model="$2"; fi',
        '  if [ "$1" = "-o" ]; then out="$2"; fi',
        "  shift",
        "done",
        // capture ALL of stdin verbatim (the prompt may lack a trailing
        // newline, so a bare `read` would drop it), fold it into the -o
        // last-message file alongside the model arg.
        'stdin_all=$(cat)',
        'printf "model=%s stdin=%s" "$model" "$stdin_all" > "$out"',
        "exit 0",
      ].join("\n") + "\n",
    );
    chmodSync(fakeBin, 0o755);
    process.env.SANDCASTLE_MAC_HOST_CODEX_BIN = fakeBin;

    const factory = macHostSandbox({ repoRoot, env: {} });
    const handle = await factory.createSandbox({ branch: "feat/codex-echo" });
    writeFileSync(path.join(handle.worktreePath, "p.md"), "prompt-body");
    const result = await handle.run({
      name: "codex-echo",
      model: "gpt-5-codex",
      promptFile: "p.md",
      idleTimeoutSeconds: 30,
    });
    expect(result.stdout).toContain("model=gpt-5-codex");
    expect(result.stdout).toContain("stdin=prompt-body");
    await handle.close();
  });

  it("stages .sandcastle/AGENTS.md to the worktree root for codex runs, git-excluded", async () => {
    process.env.SANDCASTLE_MAC_HOST_CODEX_BIN = writeFakeCodexFinal(repoRoot);
    const factory = macHostSandbox({ repoRoot, env: {} });
    const handle = await factory.createSandbox({ branch: "feat/agents-stage" });
    mkdirSync(path.join(handle.worktreePath, ".sandcastle"), { recursive: true });
    writeFileSync(
      path.join(handle.worktreePath, ".sandcastle", "AGENTS.md"),
      "STANDING-INSTRUCTIONS",
    );
    writeFileSync(path.join(handle.worktreePath, "p.md"), "x");

    await handle.run({
      name: "stage",
      model: "gpt-5-codex",
      promptFile: "p.md",
      idleTimeoutSeconds: 30,
    });

    const staged = path.join(handle.worktreePath, "AGENTS.md");
    expect(existsSync(staged)).toBe(true);
    expect(readFileSync(staged, "utf8")).toBe("STANDING-INSTRUCTIONS");
    // git-excluded so the agent can't accidentally commit our copy
    expect(excludeFileContents(handle.worktreePath)).toMatch(/^AGENTS\.md$/m);
    await handle.close();
  });

  it("does NOT overwrite a project's own root AGENTS.md (no-clobber)", async () => {
    process.env.SANDCASTLE_MAC_HOST_CODEX_BIN = writeFakeCodexFinal(repoRoot);
    const factory = macHostSandbox({ repoRoot, env: {} });
    const handle = await factory.createSandbox({ branch: "feat/no-clobber" });
    mkdirSync(path.join(handle.worktreePath, ".sandcastle"), { recursive: true });
    writeFileSync(path.join(handle.worktreePath, ".sandcastle", "AGENTS.md"), "OURS");
    writeFileSync(path.join(handle.worktreePath, "AGENTS.md"), "THEIRS");
    writeFileSync(path.join(handle.worktreePath, "p.md"), "x");

    await handle.run({
      name: "no-clobber",
      model: "gpt-5-codex",
      promptFile: "p.md",
      idleTimeoutSeconds: 30,
    });

    expect(readFileSync(path.join(handle.worktreePath, "AGENTS.md"), "utf8")).toBe(
      "THEIRS",
    );
    await handle.close();
  });

  it("does NOT stage AGENTS.md for a non-codex (claude) run", async () => {
    // Fake claude (legacy-positional seam): exits 0, ignores everything.
    const fakeClaude = path.join(repoRoot, "fake-claude.sh");
    writeFileSync(fakeClaude, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeClaude, 0o755);

    const factory = macHostSandbox({ repoRoot, env: {}, claudeBin: fakeClaude });
    const handle = await factory.createSandbox({ branch: "feat/claude-nostage" });
    mkdirSync(path.join(handle.worktreePath, ".sandcastle"), { recursive: true });
    writeFileSync(path.join(handle.worktreePath, ".sandcastle", "AGENTS.md"), "OURS");
    writeFileSync(path.join(handle.worktreePath, "p.md"), "x");

    await handle.run({
      name: "claude-nostage",
      model: "claude-sonnet-4-6",
      promptFile: "p.md",
      idleTimeoutSeconds: 30,
    });

    expect(existsSync(path.join(handle.worktreePath, "AGENTS.md"))).toBe(false);
    await handle.close();
  });

  it("does NOT stage AGENTS.md on the top-level run path (real repo root)", async () => {
    process.env.SANDCASTLE_MAC_HOST_CODEX_BIN = writeFakeCodexFinal(repoRoot);
    mkdirSync(path.join(repoRoot, ".sandcastle"), { recursive: true });
    writeFileSync(path.join(repoRoot, ".sandcastle", "AGENTS.md"), "OURS");
    writeFileSync(path.join(repoRoot, "p.md"), "x");

    const factory = macHostSandbox({ repoRoot, env: {} });
    await factory.run({
      name: "top-level",
      model: "gpt-5-codex",
      promptFile: "p.md",
      idleTimeoutSeconds: 30,
    });

    // Top-level cwd is the operator's real repo root — must never be littered.
    expect(existsSync(path.join(repoRoot, "AGENTS.md"))).toBe(false);
  });

  it("fail-closed: a staging copy failure does not abort the run", async () => {
    process.env.SANDCASTLE_MAC_HOST_CODEX_BIN = writeFakeCodexFinal(repoRoot);
    const factory = macHostSandbox({ repoRoot, env: {} });
    const handle = await factory.createSandbox({ branch: "feat/fail-closed" });
    // Make the SOURCE a directory so copyFileSync throws (EISDIR). The run must
    // still succeed — AGENTS.md delivery is best-effort cosmetic (ADR 0010).
    mkdirSync(path.join(handle.worktreePath, ".sandcastle", "AGENTS.md"), {
      recursive: true,
    });
    writeFileSync(path.join(handle.worktreePath, "p.md"), "x");

    const result = await handle.run({
      name: "fail-closed",
      model: "gpt-5-codex",
      promptFile: "p.md",
      idleTimeoutSeconds: 30,
    });

    expect(result.stdout).toBe("FINAL"); // run completed despite the copy throw
    expect(existsSync(path.join(handle.worktreePath, "AGENTS.md"))).toBe(false);
    await handle.close();
  });

  // Regression for the mac-host skill-discipline gate false-quarantine
  // (sibling of the claude fix in 6b3720a/8e77259). The gate finds a codex
  // run's rollout via `iterations[].sessionId` (rollout-*-<id>.jsonl). Codex
  // has no `--session-id` to force, but `codex exec --json` emits its id as a
  // `{"type":"thread.started","thread_id":"<id>"}` first stream line. The
  // adapter must capture THAT and return it in `iterations`, or every typed
  // codex issue is quarantined despite the implementer invoking its skills.
  it("captures the codex thread_id from the --json stream into iterations[].sessionId", async () => {
    const THREAD_ID = "0199abcd-1234-7890-abcd-ef0123456789";
    const fakeBin = path.join(repoRoot, "fake-codex-thread.sh");
    writeFileSync(
      fakeBin,
      [
        "#!/bin/sh",
        // First stream line is codex's session announcement — the only place
        // the rollout id is exposed to a headless caller.
        `echo '{\"type\":\"thread.started\",\"thread_id\":\"${THREAD_ID}\"}'`,
        `echo '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"done\"}}'`,
        "out=''",
        "while [ $# -gt 0 ]; do",
        '  if [ "$1" = "-o" ]; then out="$2"; fi',
        "  shift",
        "done",
        'printf "COMPLIANT" > "$out"',
        "exit 0",
      ].join("\n") + "\n",
    );
    chmodSync(fakeBin, 0o755);
    process.env.SANDCASTLE_MAC_HOST_CODEX_BIN = fakeBin;

    const factory = macHostSandbox({ repoRoot, env: {} });
    const handle = await factory.createSandbox({ branch: "feat/codex-sid" });
    writeFileSync(path.join(handle.worktreePath, "p.md"), "do the thing");
    const result = await handle.run({
      name: "codex-sid",
      model: "gpt-5-codex",
      promptFile: "p.md",
      idleTimeoutSeconds: 30,
    });

    // Without this the skill-discipline gate gets an empty iterations array,
    // reads zero Skill() invocations, and false-quarantines the ticket.
    expect(result.iterations).toEqual([{ sessionId: THREAD_ID }]);
    await handle.close();
  });
});
