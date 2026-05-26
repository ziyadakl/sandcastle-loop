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
