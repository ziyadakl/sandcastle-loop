import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..");
const SCRIPT_SRC = path.join(
  REPO_ROOT,
  ".sandcastle/scripts/assemble-variant.mts",
);

function runCli(
  cwd: string,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("npx", ["tsx", SCRIPT_SRC, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("assemble-variant CLI", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "asmv-"));
    mkdirSync(path.join(tmp, ".sandcastle"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeBase(name: string, content: string): string {
    const abs = path.join(tmp, ".sandcastle", name);
    writeFileSync(abs, content, "utf8");
    return abs;
  }

  function writeOverride(
    variant: string,
    markerName: string,
    content: string,
  ): void {
    const dir = path.join(
      tmp,
      ".sandcastle",
      "variants",
      variant,
      "overrides",
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${markerName}.md`), content, "utf8");
  }

  it("substitutes marker body end-to-end and preserves marker comments", () => {
    const basePath = writeBase(
      "foo.md",
      "intro\n<!-- variant:greeting -->\nhello\n<!-- /variant:greeting -->\noutro\n",
    );
    writeOverride("playwright", "greeting", "howdy\n");

    const result = runCli(tmp, ["playwright"]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);

    const assembled = readFileSync(basePath, "utf8");
    expect(assembled).toBe(
      "intro\n<!-- variant:greeting -->howdy<!-- /variant:greeting -->\noutro\n",
    );
  });

  it("warns and exits 0 when an override file matches no marker", () => {
    writeBase(
      "foo.md",
      "<!-- variant:greeting -->hi<!-- /variant:greeting -->\n",
    );
    writeOverride("playwright", "greeting", "howdy");
    writeOverride("playwright", "unused", "ignored content");

    const result = runCli(tmp, ["playwright"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      "override file overrides/unused.md has no matching <!-- variant:unused --> marker in any base prompt — ignoring",
    );
  });

  it("fails when the variant directory does not exist", () => {
    writeBase("foo.md", "no markers here\n");

    const result = runCli(tmp, ["doesnotexist"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "variant directory not found: .sandcastle/variants/doesnotexist/",
    );
  });

  it("fails with usage info when no argument is given", () => {
    const result = runCli(tmp, []);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("usage:");
    expect(result.stderr).toContain("<variant-name>");
  });

  it("strips a single trailing newline from override content before substitution", () => {
    const basePath = writeBase(
      "foo.md",
      "prefix <!-- variant:foo -->BODY<!-- /variant:foo --> suffix\n",
    );
    // Note: writing exactly "NEW\n" — the script must strip the trailing \n.
    writeOverride("playwright", "foo", "NEW\n");

    const result = runCli(tmp, ["playwright"]);
    expect(result.status).toBe(0);

    const assembled = readFileSync(basePath, "utf8");
    expect(assembled).toBe(
      "prefix <!-- variant:foo -->NEW<!-- /variant:foo --> suffix\n",
    );
  });

  it("warns about orphan opener and continues processing", () => {
    writeBase(
      "foo.md",
      "<!-- variant:foo -->no closer\n<!-- variant:foo -->valid<!-- /variant:foo -->\n",
    );
    // Ensure variants/playwright dir exists even with no overrides.
    mkdirSync(
      path.join(tmp, ".sandcastle", "variants", "playwright", "overrides"),
      { recursive: true },
    );

    const result = runCli(tmp, ["playwright"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      "has unmatched <!-- variant:foo --> opener",
    );
    expect(result.stderr).toContain(
      "no corresponding <!-- /variant:foo --> closer",
    );
    expect(result.stderr).toContain(
      "assembled output may swallow downstream content",
    );
  });

  it("does NOT warn about orphan opener when markers are properly paired", () => {
    writeBase(
      "foo.md",
      "<!-- variant:foo -->body<!-- /variant:foo -->\n",
    );
    mkdirSync(
      path.join(tmp, ".sandcastle", "variants", "playwright", "overrides"),
      { recursive: true },
    );

    const result = runCli(tmp, ["playwright"]);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("unmatched");
    expect(result.stderr).not.toContain("orphan");
  });
});
