import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { detectPackageManager, registerPnpmPatch } from "../bin/init.mjs";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const KEY = '"@ai-hero/sandcastle@0.12.0": patches/@ai-hero__sandcastle@0.12.0.patch';

describe("init Docker-limits patch registration", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "init-patch-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates pnpm-workspace.yaml when there is none", () => {
    registerPnpmPatch(dir);
    expect(readFileSync(path.join(dir, "pnpm-workspace.yaml"), "utf8")).toBe(
      `patchedDependencies:\n  ${KEY}\n`,
    );
  });

  it("appends a block to an existing workspace file and is idempotent", () => {
    const file = path.join(dir, "pnpm-workspace.yaml");
    writeFileSync(file, "packages:\n  - apps/*");
    registerPnpmPatch(dir);
    registerPnpmPatch(dir);
    const text = readFileSync(file, "utf8");
    expect(text).toBe(`packages:\n  - apps/*\npatchedDependencies:\n  ${KEY}\n`);
  });

  it("adds to an existing patchedDependencies block", () => {
    const file = path.join(dir, "pnpm-workspace.yaml");
    writeFileSync(file, 'patchedDependencies:\n  "x@1.0.0": patches/x.patch\n');
    registerPnpmPatch(dir);
    expect(readFileSync(file, "utf8")).toBe(
      `patchedDependencies:\n  ${KEY}\n  "x@1.0.0": patches/x.patch\n`,
    );
  });

  it("detects the package manager from packageManager, then the lockfile", () => {
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@12.14.0" }));
    expect(detectPackageManager(dir)).toBe("pnpm");
    writeFileSync(path.join(dir, "package.json"), "{}");
    expect(detectPackageManager(dir)).toBe("npm");
    writeFileSync(path.join(dir, "yarn.lock"), "");
    expect(detectPackageManager(dir)).toBe("yarn");
  });
});
