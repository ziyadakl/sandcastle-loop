import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const hasTool = (tool: string): boolean =>
  spawnSync("bash", ["-c", `command -v ${tool}`]).status === 0;

// ---------------------------------------------------------------------------
// sandcastle-wrapper.sh drives every launch. Stream 3 adds a watchdog
// stall-restart path ALONGSIDE the load-bearing exit-75 hot-reload path. These
// tests prove (1) the 75 path is preserved byte-for-byte in behaviour, and (2)
// the new .stall-restart marker relaunches the loop with the remaining
// iterations — the true self-heal. The real watchdog sidecar is disabled here
// (SANDCASTLE_WATCHDOG_DISABLE=1); the stub simulates what it writes.
// ---------------------------------------------------------------------------

const WRAPPER_SRC = path.join(import.meta.dirname, "sandcastle-wrapper.sh");

// The wrapper is Linux-only (flock, timeout); stock macOS has neither.
describe.skipIf(!hasTool("flock") || !hasTool("timeout"))("sandcastle-wrapper.sh", () => {
  let tmp: string;
  let wrapperPath: string;
  let stubPath: string;
  let countPath: string;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "scw-")));
    // The wrapper locks and installs relative to the git checkout it sits in.
    spawnSync("git", ["init", "-q", tmp]);
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

  function run(
    args: string[],
    envOverrides: Record<string, string | undefined> = {},
    cwd: string = tmp,
  ): ReturnType<typeof spawnSync> {
    return spawnSync("bash", [wrapperPath, ...args], {
      cwd,
      env: {
        ...process.env,
        SANDCASTLE_RUNNER: stubPath,
        SANDCASTLE_WATCHDOG_DISABLE: "1", // don't spawn the real sidecar in tests
        SANDCASTLE_INSTALL_CMD: "true", // the real install is opt-in per test
        ...envOverrides,
      },
      encoding: "utf8",
    });
  }

  // ---- regression: the exit-75 hot-reload path is untouched -----------------

  it("still loops on exit 75, sets SANDCASTLE_REMAINING_ITERATIONS, then exits 0", () => {
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
    const result = run(["--iterations", "10"]);
    expect(result.status).toBe(0);
    expect(readFileSync(countPath, "utf8").trim()).toBe("2");
    expect(readFileSync(path.join(tmp, ".env-on-second-call"), "utf8").trim()).toBe("5");
    expect(existsSync(path.join(tmp, ".sandcastle/.restart-remaining"))).toBe(false);
  });

  it("still refuses to loop blindly when the 75 marker file is missing", () => {
    writeStub(`#!/usr/bin/env bash
exit 75
`);
    const result = run(["--iterations", "1"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no marker file");
  });

  // ---- new: the watchdog stall-restart path ---------------------------------

  it("relaunches when a .stall-restart marker is present after a non-75 exit", () => {
    // First call simulates the watchdog: write the stall marker, then die with a
    // SIGKILL-style non-75 code (137). Second call must see the marker consumed
    // and SANDCASTLE_REMAINING_ITERATIONS carried across, then exit 0.
    writeStub(`#!/usr/bin/env bash
COUNT_FILE="${countPath}"
ENV_FILE="${tmp}/.env-on-second-call"
n=$(cat "$COUNT_FILE" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "$COUNT_FILE"
if [ "$n" -eq 1 ]; then
  echo "3" > "${tmp}/.sandcastle/.stall-restart"
  exit 137
fi
echo "\${SANDCASTLE_REMAINING_ITERATIONS:-<unset>}" > "$ENV_FILE"
exit 0
`);
    const result = run(["--iterations", "10"]);
    expect(result.status).toBe(0);
    expect(readFileSync(countPath, "utf8").trim()).toBe("2");
    expect(readFileSync(path.join(tmp, ".env-on-second-call"), "utf8").trim()).toBe("3");
    // Marker is consumed, never left behind.
    expect(existsSync(path.join(tmp, ".sandcastle/.stall-restart"))).toBe(false);
    expect(result.stdout).toContain("watchdog stall-restart with 3 iterations remaining");
  });

  it("propagates a non-75 exit code unchanged when NO stall marker exists", () => {
    writeStub(`#!/usr/bin/env bash
COUNT_FILE="${countPath}"
n=$(cat "$COUNT_FILE" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "$COUNT_FILE"
exit 42
`);
    const result = run(["--iterations", "1"]);
    expect(result.status).toBe(42);
    expect(readFileSync(countPath, "utf8").trim()).toBe("1");
  });

  it("does not loop on an invalid stall marker; propagates the original code", () => {
    writeStub(`#!/usr/bin/env bash
COUNT_FILE="${countPath}"
n=$(cat "$COUNT_FILE" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "$COUNT_FILE"
echo "garbage" > "${tmp}/.sandcastle/.stall-restart"
exit 9
`);
    const result = run(["--iterations", "1"]);
    expect(result.status).toBe(9);
    expect(readFileSync(countPath, "utf8").trim()).toBe("1");
    expect(result.stderr).toContain("stall marker contained invalid value");
  });

  // ---- package refresh before every start (#1370) ---------------------------

  describe("package refresh and single instance", () => {
    let logPath: string;
    let installStub: string;

    beforeEach(() => {
      logPath = path.join(tmp, "events.log");
      installStub = path.join(tmp, "fake-install.sh");
    });

    function writeInstall(body: string): void {
      writeFileSync(installStub, `#!/usr/bin/env bash\n${body}\n`, "utf8");
      chmodSync(installStub, 0o755);
    }
    const events = (): string[] =>
      existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter(Boolean) : [];
    const installEnv = (extra: Record<string, string | undefined> = {}) => ({
      SANDCASTLE_INSTALL_CMD: installStub,
      ...extra,
    });

    it("installs before the first start of the orchestrator", () => {
      writeInstall(`echo install >> "${logPath}"`);
      writeStub(`#!/usr/bin/env bash\necho runner >> "${logPath}"\n`);
      const result = run([], installEnv());
      expect(result.status).toBe(0);
      expect(events()).toEqual(["install", "runner"]);
    });

    it("installs before the stall watchdog spawns, and the watchdog before the runner", () => {
      const watchdog = path.join(tmp, "fake-watchdog.sh");
      writeFileSync(watchdog, `#!/usr/bin/env bash\necho watchdog >> "${logPath}"\nexec sleep 30\n`);
      chmodSync(watchdog, 0o755);
      writeInstall(`echo install >> "${logPath}"`);
      writeStub(`#!/usr/bin/env bash\nsleep 1\necho runner >> "${logPath}"\n`);
      const result = run(
        [],
        installEnv({ SANDCASTLE_WATCHDOG_DISABLE: undefined, SANDCASTLE_WATCHDOG_CMD: watchdog }),
      );
      expect(result.status).toBe(0);
      expect(events()).toEqual(["install", "watchdog", "runner"]);
    });

    it("installs again before an exit-75 self-restart", () => {
      writeInstall(`echo install >> "${logPath}"`);
      writeStub(`#!/usr/bin/env bash
echo runner >> "${logPath}"
if [ ! -f "${tmp}/seen" ]; then
  touch "${tmp}/seen"
  echo 5 > "${tmp}/.sandcastle/.restart-remaining"
  exit 75
fi
`);
      const result = run([], installEnv());
      expect(result.status).toBe(0);
      expect(events()).toEqual(["install", "runner", "install", "runner"]);
    });

    it("installs again before a stall-watchdog relaunch", () => {
      writeInstall(`echo install >> "${logPath}"`);
      writeStub(`#!/usr/bin/env bash
echo runner >> "${logPath}"
if [ ! -f "${tmp}/seen" ]; then
  touch "${tmp}/seen"
  echo 3 > "${tmp}/.sandcastle/.stall-restart"
  exit 137
fi
`);
      const result = run([], installEnv());
      expect(result.status).toBe(0);
      expect(events()).toEqual(["install", "runner", "install", "runner"]);
    });

    it("a failing install exits non-zero, never starts the runner, and says how to rerun it", () => {
      writeInstall(`echo "boom line" ; echo "more output" >&2; exit 3`);
      writeStub(`#!/usr/bin/env bash\necho runner >> "${logPath}"\n`);
      const result = run([], installEnv());
      expect(result.status).not.toBe(0);
      expect(events()).toEqual([]);
      expect(result.stderr).toContain(installStub);
      expect(result.stderr).toContain("exit status 3");
      expect(result.stderr).toContain(`cd "${tmp}" && ${installStub}`);
      expect(result.stderr).toContain("boom line");
      expect(result.stderr).toContain("more output");
    });

    it("shows only the last 20 lines of a failing install's output", () => {
      writeInstall(`for i in $(seq 1 30); do echo "line-$i"; done; exit 1`);
      writeStub(`#!/usr/bin/env bash\necho runner >> "${logPath}"\n`);
      const result = run([], installEnv());
      expect(result.stderr).toContain("line-30");
      expect(result.stderr).toContain("line-11");
      expect(result.stderr).not.toContain("line-10\n");
    });

    it("kills a hung install at the bound and treats it as a failure", () => {
      writeInstall(`sleep 60`);
      writeStub(`#!/usr/bin/env bash\necho runner >> "${logPath}"\n`);
      const started = Date.now();
      const result = run([], installEnv({ SANDCASTLE_INSTALL_TIMEOUT_SECS: "1" }));
      expect(Date.now() - started).toBeLessThan(20_000);
      expect(result.status).not.toBe(0);
      expect(events()).toEqual([]);
      expect(result.stderr).toContain("timed out after 1s");
    });

    it("runs the install from the repository root even when started from a subfolder", () => {
      mkdirSync(path.join(tmp, "sub"));
      writeInstall(`pwd > "${tmp}/install-cwd"`);
      writeStub(`#!/usr/bin/env bash\npwd > "${tmp}/runner-cwd"\n`);
      const result = run([], installEnv(), path.join(tmp, "sub"));
      expect(result.status).toBe(0);
      expect(readFileSync(path.join(tmp, "install-cwd"), "utf8").trim()).toBe(tmp);
      expect(readFileSync(path.join(tmp, "runner-cwd"), "utf8").trim()).toBe(path.join(tmp, "sub"));
    });

    it("logs 'packages current' when pnpm reports nothing to do, else 'packages installed'", () => {
      writeStub(`#!/usr/bin/env bash\ntrue\n`);
      writeInstall(`echo "Lockfile is up to date"; echo "Already up to date"`);
      const current = run([], installEnv());
      expect(current.stdout).toMatch(/\[sandcastle-wrapper\] packages current \(\d+s\)/);
      writeInstall(`echo "Packages: +3"`);
      const installed = run([], installEnv());
      expect(installed.stdout).toMatch(/\[sandcastle-wrapper\] packages installed \(\d+s\)/);
    });

    it("the default command is a frozen, offline-preferring, scriptless, non-interactive pnpm install", () => {
      const bin = path.join(tmp, "fakebin");
      mkdirSync(bin);
      const fakePnpm = path.join(bin, "pnpm");
      writeFileSync(
        fakePnpm,
        `#!/usr/bin/env bash\necho "$@" > "${tmp}/pnpm-argv"\necho "$CI" > "${tmp}/pnpm-ci"\n`,
      );
      chmodSync(fakePnpm, 0o755);
      writeStub(`#!/usr/bin/env bash\ntrue\n`);
      const result = run([], {
        SANDCASTLE_INSTALL_CMD: undefined,
        PATH: `${bin}:${process.env.PATH}`,
      });
      expect(result.status).toBe(0);
      const argv = readFileSync(path.join(tmp, "pnpm-argv"), "utf8").trim().split(" ");
      expect(argv[0]).toBe("install");
      expect(argv).toEqual(
        expect.arrayContaining(["--frozen-lockfile", "--ignore-scripts", "--prefer-offline"]),
      );
      expect(readFileSync(path.join(tmp, "pnpm-ci"), "utf8").trim()).toBe("true");
    });

    describe("marking the run unhealthy on a failed install", () => {
      let failLog: string;
      let failStub: string;
      beforeEach(() => {
        failLog = path.join(tmp, "fail-args");
        failStub = path.join(tmp, "fake-fail.sh");
        writeFileSync(failStub, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${failLog}"\nexit 5\n`);
        chmodSync(failStub, 0o755);
      });

      it("runs the fail command with the repo root and a reason, still exits non-zero, never starts the runner", () => {
        writeInstall(`exit 3`);
        writeStub(`#!/usr/bin/env bash\necho runner >> "${logPath}"\n`);
        const result = run([], installEnv({ SANDCASTLE_INSTALL_FAIL_CMD: failStub }));
        expect(result.status).not.toBe(0);
        expect(events()).toEqual([]);
        const args = readFileSync(failLog, "utf8").split("\n");
        expect(args.slice(0, 3)).toEqual(["--repo-root", tmp, "--reason"]);
        expect(args[3]).toContain("install failed");
        expect(args[3]).toContain("exit status 3");
        expect(result.stderr).toContain("exit status 3");
      });

      it("also runs it when the install times out", () => {
        writeInstall(`sleep 60`);
        writeStub(`#!/usr/bin/env bash\ntrue\n`);
        const result = run(
          [],
          installEnv({ SANDCASTLE_INSTALL_FAIL_CMD: failStub, SANDCASTLE_INSTALL_TIMEOUT_SECS: "1" }),
        );
        expect(result.status).not.toBe(0);
        expect(readFileSync(failLog, "utf8")).toContain("timed out after 1s");
      });

      it("never runs it when the install succeeds", () => {
        writeInstall(`true`);
        writeStub(`#!/usr/bin/env bash\ntrue\n`);
        const result = run([], installEnv({ SANDCASTLE_INSTALL_FAIL_CMD: failStub }));
        expect(result.status).toBe(0);
        expect(existsSync(failLog)).toBe(false);
      });
    });

    describe("exit 137 wording", () => {
      it("says 'killed (exit 137)' when the install died early, not 'timed out'", () => {
        writeInstall(`exit 137`);
        writeStub(`#!/usr/bin/env bash\ntrue\n`);
        const result = run([], installEnv());
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("killed (exit 137)");
        expect(result.stderr).not.toContain("timed out");
      });
    });

    describe("single instance", () => {
      let holder: ChildProcess | undefined;
      const lockPath = () => path.join(tmp, ".git", "sandcastle-wrapper.lock");

      afterEach(() => {
        holder?.kill("SIGKILL");
        holder = undefined;
      });

      it("a second wrapper on the same checkout refuses before running its install", async () => {
        holder = spawn("flock", ["-n", lockPath(), "sleep", "60"], { stdio: "ignore" });
        for (let i = 0; i < 100 && !existsSync(lockPath()); i++) {
          await new Promise((r) => setTimeout(r, 50));
        }
        await new Promise((r) => setTimeout(r, 200));
        writeInstall(`echo install >> "${logPath}"`);
        writeStub(`#!/usr/bin/env bash\necho runner >> "${logPath}"\n`);
        const result = run([], installEnv());
        expect(result.status).not.toBe(0);
        expect(events()).toEqual([]);
        expect(result.stderr).toContain(
          `[sandcastle-wrapper] another loop already holds ${lockPath()}; refusing to start`,
        );
      });

      it("keeps the lock file inside git's own folder, never in the working tree", () => {
        writeInstall(`true`);
        writeStub(`#!/usr/bin/env bash\ntrue\n`);
        run([], installEnv());
        const status = spawnSync(
          "git",
          ["-C", tmp, "status", "--porcelain", "--untracked-files=all"],
          { encoding: "utf8" },
        );
        expect(status.stdout).not.toContain("sandcastle-wrapper.lock");
        expect(existsSync(lockPath())).toBe(true);
      });

      it("a child the install leaves behind cannot keep the lock after the wrapper exits", () => {
        writeInstall(`sleep 60 >/dev/null 2>&1 &\necho $! > "${tmp}/orphan-pid"`);
        writeStub(`#!/usr/bin/env bash\ntrue\n`);
        const result = run([], installEnv());
        expect(result.status).toBe(0);
        const probe = spawnSync("flock", ["-n", lockPath(), "true"]);
        const pid = Number(readFileSync(path.join(tmp, "orphan-pid"), "utf8").trim());
        process.kill(pid, "SIGKILL");
        expect(probe.status).toBe(0);
      });

      it("an orchestrator the runner leaves behind cannot keep the lock", () => {
        writeStub(`#!/usr/bin/env bash\nsleep 60 >/dev/null 2>&1 &\necho $! > "${tmp}/orphan-pid"\n`);
        const result = run([], installEnv({ SANDCASTLE_INSTALL_CMD: "true" }));
        expect(result.status).toBe(0);
        const probe = spawnSync("flock", ["-n", lockPath(), "true"]);
        process.kill(Number(readFileSync(path.join(tmp, "orphan-pid"), "utf8").trim()), "SIGKILL");
        expect(probe.status).toBe(0);
      });

      it("a watchdog the wrapper leaves behind cannot keep the lock", () => {
        const watchdog = path.join(tmp, "fake-watchdog.sh");
        writeFileSync(
          watchdog,
          `#!/usr/bin/env bash\nexec >/dev/null 2>&1\necho $$ > "${tmp}/orphan-pid"\ntrap '' TERM\nwhile true; do sleep 1; done\n`,
        );
        chmodSync(watchdog, 0o755);
        writeStub(`#!/usr/bin/env bash\nsleep 1\n`);
        const result = run(
          [],
          installEnv({
            SANDCASTLE_INSTALL_CMD: "true",
            SANDCASTLE_WATCHDOG_DISABLE: undefined,
            SANDCASTLE_WATCHDOG_CMD: watchdog,
          }),
        );
        expect(result.status).toBe(0);
        const probe = spawnSync("flock", ["-n", lockPath(), "true"]);
        process.kill(Number(readFileSync(path.join(tmp, "orphan-pid"), "utf8").trim()), "SIGKILL");
        expect(probe.status).toBe(0);
      });
    });

    describe("missing tools", () => {
      for (const missing of ["flock", "timeout"]) {
        it(`refuses with one line naming ${missing} when it is not on PATH`, () => {
          const bin = path.join(tmp, "limitedbin");
          mkdirSync(bin);
          for (const tool of [
            "git", "flock", "timeout", "cat", "tr", "mktemp", "rm", "tail", "grep", "env", "sleep", "dirname",
          ]) {
            if (tool === missing) continue;
            const found = spawnSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
            if (found) symlinkSync(found, path.join(bin, tool));
          }
          writeStub(`#!/usr/bin/env bash\necho runner >> "${logPath}"\n`);
          const result = spawnSync("/bin/bash", [wrapperPath], {
            cwd: tmp,
            env: { PATH: bin, SANDCASTLE_RUNNER: stubPath, SANDCASTLE_WATCHDOG_DISABLE: "1" },
            encoding: "utf8",
          });
          expect(result.status).not.toBe(0);
          expect(events()).toEqual([]);
          expect(result.stderr).toContain(missing);
        });
      }
    });
  });
});
