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
