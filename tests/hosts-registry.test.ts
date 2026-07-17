import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  parseHostsConfig,
  loadHostsConfig,
  type HostConfig,
} from "../.sandcastle/lib/hosts/registry.js";

const here = dirname(fileURLToPath(import.meta.url));
// hosts.example.json, NOT hosts.json: the real registry is per-machine and
// untracked, so it does not exist in a fresh clone and cannot be a fixture.
// The example is what ships, so the example is what must stay parseable.
const examplePath = resolve(here, "../.sandcastle/hosts.example.json");

describe("parseHostsConfig", () => {
  it("parses a bare array of valid entries", () => {
    const raw = JSON.stringify([
      { name: "local", transport: "local", maxConcurrent: 2 },
      { name: "hub", transport: "hub", maxConcurrent: 1, repoPath: "/srv/repo" },
    ]);
    const cfg = parseHostsConfig(raw);
    expect(cfg).toEqual<HostConfig[]>([
      { name: "local", transport: "local", maxConcurrent: 2 },
      { name: "hub", transport: "hub", maxConcurrent: 1, repoPath: "/srv/repo" },
    ]);
  });

  it("parses the { hosts: [...] } wrapper form to the same result", () => {
    const arr = [
      { name: "local", transport: "local", maxConcurrent: 2 },
      { name: "hub", transport: "hub", maxConcurrent: 1, repoPath: "/srv/repo" },
    ];
    const fromArray = parseHostsConfig(JSON.stringify(arr));
    const fromWrapper = parseHostsConfig(JSON.stringify({ hosts: arr }));
    expect(fromWrapper).toEqual(fromArray);
  });

  it("throws naming invalid JSON on unparseable input", () => {
    expect(() => parseHostsConfig("{not json")).toThrow(/JSON/i);
  });

  it("throws on an empty list", () => {
    expect(() => parseHostsConfig("[]")).toThrow(/empty/i);
    expect(() => parseHostsConfig(JSON.stringify({ hosts: [] }))).toThrow(
      /empty/i,
    );
  });

  it("throws naming the blank name", () => {
    const raw = JSON.stringify([
      { name: "  ", transport: "local", maxConcurrent: 1 },
    ]);
    expect(() => parseHostsConfig(raw)).toThrow(/name/i);
  });

  it("throws naming a duplicate name", () => {
    const raw = JSON.stringify([
      { name: "hub", transport: "hub", maxConcurrent: 1, repoPath: "/srv/a" },
      { name: "hub", transport: "hub2", maxConcurrent: 1, repoPath: "/srv/b" },
    ]);
    expect(() => parseHostsConfig(raw)).toThrow(/duplicate/i);
  });

  it("throws naming a blank transport", () => {
    const raw = JSON.stringify([
      { name: "hub", transport: "  ", maxConcurrent: 1 },
    ]);
    expect(() => parseHostsConfig(raw)).toThrow(/transport/i);
  });

  it("throws when maxConcurrent is 0", () => {
    const raw = JSON.stringify([
      { name: "hub", transport: "hub", maxConcurrent: 0, repoPath: "/srv/a" },
    ]);
    expect(() => parseHostsConfig(raw)).toThrow(/maxConcurrent/i);
  });

  it("throws when maxConcurrent is not an integer", () => {
    const raw = JSON.stringify([
      { name: "hub", transport: "hub", maxConcurrent: 1.5, repoPath: "/srv/a" },
    ]);
    expect(() => parseHostsConfig(raw)).toThrow(/maxConcurrent/i);
  });

  it("throws when more than one host is transport 'local'", () => {
    const raw = JSON.stringify([
      { name: "a", transport: "local", maxConcurrent: 1 },
      { name: "b", transport: "local", maxConcurrent: 1 },
    ]);
    expect(() => parseHostsConfig(raw)).toThrow(/local/i);
  });

  it("allows zero local hosts (all remote)", () => {
    const raw = JSON.stringify([
      { name: "hub", transport: "hub", maxConcurrent: 1, repoPath: "/srv/a" },
      { name: "hub2", transport: "hub2", maxConcurrent: 3, repoPath: "/srv/b" },
    ]);
    expect(() => parseHostsConfig(raw)).not.toThrow();
  });

  it("requires repoPath for a remote host and names it in the error", () => {
    const raw = JSON.stringify([
      { name: "hub", transport: "hub", maxConcurrent: 1 },
    ]);
    expect(() => parseHostsConfig(raw)).toThrow(/hub.*repoPath/i);
  });

  it("rejects a blank repoPath on a remote host", () => {
    const raw = JSON.stringify([
      { name: "hub", transport: "hub", maxConcurrent: 1, repoPath: "  " },
    ]);
    expect(() => parseHostsConfig(raw)).toThrow(/repoPath/i);
  });

  it("carries repoPath through for a remote host", () => {
    const raw = JSON.stringify([
      { name: "hub", transport: "hub", maxConcurrent: 1, repoPath: "/home/deploy/repo" },
    ]);
    expect(parseHostsConfig(raw)).toEqual<HostConfig[]>([
      { name: "hub", transport: "hub", maxConcurrent: 1, repoPath: "/home/deploy/repo" },
    ]);
  });

  it("does NOT require repoPath for a local host (ignored)", () => {
    const raw = JSON.stringify([
      { name: "local", transport: "local", maxConcurrent: 2 },
    ]);
    expect(() => parseHostsConfig(raw)).not.toThrow();
  });

  it("rejects a non-string repoPath", () => {
    const raw = JSON.stringify([
      { name: "hub", transport: "hub", maxConcurrent: 1, repoPath: 42 },
    ]);
    expect(() => parseHostsConfig(raw)).toThrow(/repoPath/i);
  });
});

describe("loadHostsConfig", () => {
  it("returns the local default when readFile throws (missing file)", () => {
    const cfg = loadHostsConfig("/nope/hosts.json", () => {
      throw new Error("ENOENT");
    });
    expect(cfg).toEqual<HostConfig[]>([
      { name: "local", transport: "local", maxConcurrent: 2 },
    ]);
  });

  it("parses the injected file contents when readFile succeeds", () => {
    const raw = JSON.stringify([
      { name: "hub", transport: "hub", maxConcurrent: 1, repoPath: "/srv/repo" },
    ]);
    const cfg = loadHostsConfig("/whatever", () => raw);
    expect(cfg).toEqual<HostConfig[]>([
      { name: "hub", transport: "hub", maxConcurrent: 1, repoPath: "/srv/repo" },
    ]);
  });
});

describe("shipped .sandcastle/hosts.example.json", () => {
  it("parses, and offers a local host as the starting point", () => {
    const cfg = parseHostsConfig(readFileSync(examplePath, "utf8"));
    expect(cfg.find((h) => h.transport === "local")).toEqual({
      name: "local",
      transport: "local",
      maxConcurrent: 2,
    });
  });

  // The regression guard for the bug this file was split to fix. The example
  // ships to every consumer; a REAL path in it is the exact defect that made
  // /sandcastle-update overwrite each project's registry with this repo's own
  // `hub` checkout. Placeholders keep it inert until a human edits it.
  it("contains only placeholder remote paths — never a real machine's", () => {
    const cfg = parseHostsConfig(readFileSync(examplePath, "utf8"));
    const remotes = cfg.filter((h) => h.transport !== "local");
    expect(remotes.length).toBeGreaterThan(0);
    for (const r of remotes) {
      expect(r.repoPath).toMatch(/REPLACE-ME/);
      expect(r.transport).toMatch(/REPLACE-ME/);
    }
  });
});
