/**
 * Pins the mac-host provider's PRODUCTION argv (`spawnAgent`'s "production"
 * branch in `./mac-host-sandbox.ts`) end to end through a real (fake-binary)
 * spawn — not a mocked one — so the loop-config fix (`sandboxAgentSettingsArgs()`
 * spliced onto that argv) is proven against what the child process actually
 * receives, the same discipline `main.mac-host-sandbox.test.ts` and
 * `lib/db/template-reconcile.test.ts` use for their own real-process/real-repo
 * seams.
 *
 * `SANDCASTLE_MAC_HOST_PRODUCTION_CLAUDE_BIN` is the ONE override that keeps
 * `mode === "production"` (any of `opts.claudeBin` / `opts.buildArgs` /
 * `SANDCASTLE_MAC_HOST_CLAUDE_BIN` flips it to a test seam mode instead), so
 * this file must delete the legacy env var explicitly.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { macHostSandbox } from "./mac-host-sandbox.js";
import { sandboxAgentSettings } from "./sandbox-agent-settings.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  }).toString("utf8");
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("mac-host production argv carries the sandbox agent settings (--settings)", () => {
  let repo: string;
  let binDir: string;
  const savedEnv = {
    SANDCASTLE_MAC_HOST_PRODUCTION_CLAUDE_BIN:
      process.env.SANDCASTLE_MAC_HOST_PRODUCTION_CLAUDE_BIN,
    SANDCASTLE_MAC_HOST_CLAUDE_BIN: process.env.SANDCASTLE_MAC_HOST_CLAUDE_BIN,
  };

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sc-mac-host-argv-repo-"));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
    // No `{{...}}` placeholders — applyPromptArgs must not throw on an empty
    // promptArgs map.
    writeFileSync(path.join(repo, "prompt.md"), "hello, a prompt with no placeholders\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "seed");

    binDir = mkdtempSync(path.join(tmpdir(), "sc-mac-host-argv-bin-"));
    const fakeBin = path.join(binDir, "fake-claude");
    // Echoes every argv element on its own line, then drains stdin so the
    // real spawn's stdin.end(promptText) never blocks.
    writeFileSync(fakeBin, `#!/bin/sh\nprintf '%s\\n' "$@"\ncat >/dev/null\n`);
    chmodSync(fakeBin, 0o755);

    process.env.SANDCASTLE_MAC_HOST_PRODUCTION_CLAUDE_BIN = fakeBin;
    delete process.env.SANDCASTLE_MAC_HOST_CLAUDE_BIN;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(repo, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  });

  it("appends --settings <json matching sandboxAgentSettings()> after the fixed production flags", async () => {
    const result = await macHostSandbox({ repoRoot: repo }).run({
      name: "argv-pin",
      model: "claude-test",
      promptFile: "prompt.md",
    });

    const lines = result.stdout.split("\n").filter((l) => l.length > 0);

    expect(lines).toContain("--print");
    expect(lines).toContain("--dangerously-skip-permissions");

    const sessionFlagIdx = lines.indexOf("--session-id");
    expect(sessionFlagIdx).toBeGreaterThanOrEqual(0);
    const sessionIdArg = lines[sessionFlagIdx + 1];
    expect(sessionIdArg).toMatch(UUID_RE);

    const modelFlagIdx = lines.indexOf("--model");
    expect(modelFlagIdx).toBeGreaterThanOrEqual(0);
    expect(lines[modelFlagIdx + 1]).toBe("claude-test");

    const settingsFlagIdx = lines.indexOf("--settings");
    expect(settingsFlagIdx).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(lines[settingsFlagIdx + 1])).toEqual(
      sandboxAgentSettings(),
    );

    // The forced production session id is the SAME id threaded back onto
    // the run result — the one lever the skill-discipline gate uses to
    // locate the session JSONL afterward.
    expect(result.iterations?.[0]?.sessionId).toBe(sessionIdArg);
  });
});
