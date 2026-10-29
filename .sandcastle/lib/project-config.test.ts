/**
 * The project settings file (`.sandcastle/project.json`): defaults switch every
 * project-specific feature OFF, a bad file fails loudly at startup, and the
 * shipped example is itself valid and fills every key.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  GENERIC_WIDE_REACH_PATHS,
  PROJECT_CONFIG_RELATIVE_PATH,
  defaultProjectConfig,
  getProjectConfig,
  loadProjectConfig,
  parseProjectConfig,
  resetProjectConfig,
  setProjectConfig,
  wideReachPaths,
} from "./project-config.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sandcastle-project-config-"));
  mkdirSync(path.join(dir, ".sandcastle"), { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (text: string): void =>
  writeFileSync(path.join(dir, PROJECT_CONFIG_RELATIVE_PATH), text);

describe("defaults (no .sandcastle/project.json)", () => {
  it("a missing file is every default, and every project-specific feature is OFF", () => {
    const cfg = loadProjectConfig(dir);
    expect(cfg).toEqual({
      landCheck: null,
      testDatabase: null,
      migrations: null,
      checksRoot: "e2e/checks",
      browserCheckCommand: null,
      e2eScriptPackageJson: null,
      checkFreeze: { browserRoots: [], unitRoots: [], unitSeeds: [] },
      protectedPaths: [],
      wideReachPaths: [],
      ownerName: "the owner",
      commitIdentity: { name: "Claude", email: "noreply@anthropic.com" },
    });
  });

  it("an empty object is the same as no file", () => {
    write("{}");
    expect(loadProjectConfig(dir)).toEqual(defaultProjectConfig());
  });

  it("wide-reach defaults are the generic ones only: manifests and lockfiles, CI, the loop itself", () => {
    const all = wideReachPaths(defaultProjectConfig()).flatMap((r) => [...r.paths]);
    expect(all).toContain("package.json");
    expect(all).toContain("pnpm-lock.yaml");
    expect(all).toContain(".github/");
    expect(all).toContain(".sandcastle/");
    expect(all.some((p) => p.startsWith("packages/") || p.startsWith("tooling/"))).toBe(false);
  });

  it("a project's wideReachPaths are added on top of the generic ones", () => {
    const cfg = parseProjectConfig(
      JSON.stringify({ wideReachPaths: [{ paths: ["core/"], what: "changes the core" }] }),
    );
    expect(wideReachPaths(cfg)).toEqual([
      ...GENERIC_WIDE_REACH_PATHS,
      { paths: ["core/"], what: "changes the core" },
    ]);
  });
});

describe("validation", () => {
  it("rejects malformed JSON with a message naming the file", () => {
    write("{ nope");
    expect(() => loadProjectConfig(dir)).toThrow(/\.sandcastle\/project\.json is not valid JSON/);
  });

  it("rejects an unknown key (a typo must not silently turn a gate off)", () => {
    write(JSON.stringify({ landCheque: ["pnpm", "test"] }));
    expect(() => loadProjectConfig(dir)).toThrow(/project\.json is invalid[\s\S]*landCheque/);
  });

  it("rejects a landCheck that is a string instead of an argv list", () => {
    write(JSON.stringify({ landCheck: "pnpm verify" }));
    expect(() => loadProjectConfig(dir)).toThrow(/landCheck/);
  });

  it("rejects an empty landCheck argv", () => {
    write(JSON.stringify({ landCheck: [] }));
    expect(() => loadProjectConfig(dir)).toThrow(/landCheck/);
  });

  it("rejects a template database name that is not a plain identifier", () => {
    write(JSON.stringify({ testDatabase: { templateDb: "x'; drop database y; --" } }));
    expect(() => loadProjectConfig(dir)).toThrow(/testDatabase\.templateDb/);
  });

  it("accepts a test database with and without a setupCommand", () => {
    expect(parseProjectConfig(JSON.stringify({ testDatabase: { templateDb: "t" } })).testDatabase).toEqual({
      templateDb: "t",
    });
    expect(
      parseProjectConfig(JSON.stringify({ testDatabase: { templateDb: "t", setupCommand: ["make", "db"] } }))
        .testDatabase?.setupCommand,
    ).toEqual(["make", "db"]);
  });

  it("lists every problem, not just the first", () => {
    write(JSON.stringify({ landCheck: 3, checksRoot: "" }));
    let message = "";
    try {
      loadProjectConfig(dir);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/landCheck/);
    expect(message).toMatch(/checksRoot/);
  });
});

describe("the active config", () => {
  afterEach(() => resetProjectConfig());

  it("set / get / reset round-trip", () => {
    const cfg = { ...defaultProjectConfig(), ownerName: "Sam" };
    setProjectConfig(cfg);
    expect(getProjectConfig().ownerName).toBe("Sam");
    resetProjectConfig();
    expect(getProjectConfig().ownerName).toBe("the owner");
  });
});

describe("project.example.json", () => {
  const text = readFileSync(path.join(import.meta.dirname, "..", "project.example.json"), "utf8");

  it("is valid", () => {
    expect(() => parseProjectConfig(text, "project.example.json")).not.toThrow();
  });

  it("sets EVERY key (so the example never falls behind the schema)", () => {
    const keys = Object.keys(JSON.parse(text)).sort();
    expect(keys).toEqual(Object.keys(defaultProjectConfig()).sort());
  });
});
