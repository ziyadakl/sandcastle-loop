import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { detectActiveProfile } from "../bin/init.mjs";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("init Xcode detection", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "init-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns 'mac-host' when target has a .xcodeproj", () => {
    mkdirSync(path.join(dir, "MyApp.xcodeproj"));
    expect(detectActiveProfile(dir)).toBe("mac-host");
  });

  it("returns 'mac-host' when target has a .xcworkspace", () => {
    mkdirSync(path.join(dir, "MyApp.xcworkspace"));
    expect(detectActiveProfile(dir)).toBe("mac-host");
  });

  it("returns 'mac-host' when target has a Package.swift", () => {
    writeFileSync(path.join(dir, "Package.swift"), "// swift-tools-version:5.9\n");
    expect(detectActiveProfile(dir)).toBe("mac-host");
  });

  it("returns 'minimal' when no iOS markers present", () => {
    writeFileSync(path.join(dir, "package.json"), "{}");
    expect(detectActiveProfile(dir)).toBe("minimal");
  });
});
