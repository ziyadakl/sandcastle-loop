import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  snapshotImportedFiles,
  detectImportedFileChange,
} from "../.sandcastle/lib/restart-detector.js";

describe("restart-detector", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rd-"));
    mkdirSync(join(root, ".sandcastle/lib/migrations"), { recursive: true });
    writeFileSync(join(root, ".sandcastle/main.mts"), "export {};\n");
    writeFileSync(join(root, ".sandcastle/models.ts"), "export {};\n");
    writeFileSync(join(root, ".sandcastle/providers.ts"), "export {};\n");
    writeFileSync(
      join(root, ".sandcastle/lib/migrations/drizzle-applier.ts"),
      "export const v = 1;\n",
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns null when nothing changed", () => {
    const snap = snapshotImportedFiles(root);
    expect(detectImportedFileChange(root, snap)).toBeNull();
  });

  it("detects a change to a tracked lib file", () => {
    const snap = snapshotImportedFiles(root);
    writeFileSync(
      join(root, ".sandcastle/lib/migrations/drizzle-applier.ts"),
      "export const v = 2;\n",
    );
    const changed = detectImportedFileChange(root, snap);
    expect(changed).toBe(".sandcastle/lib/migrations/drizzle-applier.ts");
  });

  it("detects a change to main.mts", () => {
    const snap = snapshotImportedFiles(root);
    writeFileSync(join(root, ".sandcastle/main.mts"), "export const x = 1;\n");
    expect(detectImportedFileChange(root, snap)).toBe(".sandcastle/main.mts");
  });

  it("ignores changes to prompt files", () => {
    writeFileSync(join(root, ".sandcastle/plan-prompt.md"), "v1\n");
    const snap = snapshotImportedFiles(root);
    writeFileSync(join(root, ".sandcastle/plan-prompt.md"), "v2\n");
    expect(detectImportedFileChange(root, snap)).toBeNull();
  });

  it("treats a deleted tracked file as a change", () => {
    const snap = snapshotImportedFiles(root);
    rmSync(join(root, ".sandcastle/lib/migrations/drizzle-applier.ts"));
    expect(detectImportedFileChange(root, snap)).toBe(
      ".sandcastle/lib/migrations/drizzle-applier.ts",
    );
  });
});
