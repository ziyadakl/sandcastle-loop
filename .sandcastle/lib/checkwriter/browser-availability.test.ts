import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BROWSERLESS_PROFILES,
  profileHasBrowser,
  readActiveProfile,
} from "./browser-availability.js";

describe("profileHasBrowser — the pure decision (issue #933)", () => {
  it("is false for every browserless profile named", () => {
    for (const profile of BROWSERLESS_PROFILES) {
      expect(profileHasBrowser(profile)).toBe(false);
    }
  });

  it("is true for the two variants that ship a browser stack", () => {
    expect(profileHasBrowser("playwright")).toBe(true);
    expect(profileHasBrowser("agent-browser")).toBe(true);
  });

  it("defaults to true (unchanged behaviour) for an unknown or missing profile", () => {
    expect(profileHasBrowser(undefined)).toBe(true);
    expect(profileHasBrowser("some-future-variant")).toBe(true);
  });
});

describe("readActiveProfile — reads .sandcastle/profile from the issue's own worktree", () => {
  let worktree: string;

  beforeEach(() => {
    worktree = mkdtempSync(path.join(tmpdir(), "sandcastle-browser-availability-"));
  });

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true });
  });

  it("reads the trimmed profile name when the file exists", () => {
    mkdirSync(path.join(worktree, ".sandcastle"), { recursive: true });
    writeFileSync(path.join(worktree, ".sandcastle", "profile"), "minimal\n");
    expect(readActiveProfile(worktree)).toBe("minimal");
  });

  it("returns undefined when the file is missing", () => {
    expect(readActiveProfile(worktree)).toBeUndefined();
  });

  it("returns undefined when the file is empty or whitespace-only", () => {
    mkdirSync(path.join(worktree, ".sandcastle"), { recursive: true });
    writeFileSync(path.join(worktree, ".sandcastle", "profile"), "   \n");
    expect(readActiveProfile(worktree)).toBeUndefined();
  });
});

describe("end to end — both setups (issue #933 acceptance)", () => {
  let worktree: string;

  beforeEach(() => {
    worktree = mkdtempSync(path.join(tmpdir(), "sandcastle-browser-availability-e2e-"));
    mkdirSync(path.join(worktree, ".sandcastle"), { recursive: true });
  });

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true });
  });

  it("minimal profile -> no browser available", () => {
    writeFileSync(path.join(worktree, ".sandcastle", "profile"), "minimal");
    expect(profileHasBrowser(readActiveProfile(worktree))).toBe(false);
  });

  it("playwright profile -> browser available, current behaviour unchanged", () => {
    writeFileSync(path.join(worktree, ".sandcastle", "profile"), "playwright");
    expect(profileHasBrowser(readActiveProfile(worktree))).toBe(true);
  });
});
