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
const seedPath = resolve(here, "../.sandcastle/hosts.json");

describe("parseHostsConfig", () => {
  it("parses a bare array of valid entries", () => {
    const raw = JSON.stringify([
      { name: "local", transport: "local", maxConcurrent: 2 },
      { name: "hub", transport: "hub", maxConcurrent: 1 },
    ]);
    const cfg = parseHostsConfig(raw);
    expect(cfg).toEqual<HostConfig[]>([
      { name: "local", transport: "local", maxConcurrent: 2 },
      { name: "hub", transport: "hub", maxConcurrent: 1 },
    ]);
  });

  it("parses the { hosts: [...] } wrapper form to the same result", () => {
    const arr = [
      { name: "local", transport: "local", maxConcurrent: 2 },
      { name: "hub", transport: "hub", maxConcurrent: 1 },
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
      { name: "hub", transport: "hub", maxConcurrent: 1 },
      { name: "hub", transport: "hub2", maxConcurrent: 1 },
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
      { name: "hub", transport: "hub", maxConcurrent: 0 },
    ]);
    expect(() => parseHostsConfig(raw)).toThrow(/maxConcurrent/i);
  });

  it("throws when maxConcurrent is not an integer", () => {
    const raw = JSON.stringify([
      { name: "hub", transport: "hub", maxConcurrent: 1.5 },
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
      { name: "hub", transport: "hub", maxConcurrent: 1 },
      { name: "hub2", transport: "hub2", maxConcurrent: 3 },
    ]);
    expect(() => parseHostsConfig(raw)).not.toThrow();
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
      { name: "hub", transport: "hub", maxConcurrent: 1 },
    ]);
    const cfg = loadHostsConfig("/whatever", () => raw);
    expect(cfg).toEqual<HostConfig[]>([
      { name: "hub", transport: "hub", maxConcurrent: 1 },
    ]);
  });
});

describe("seeded .sandcastle/hosts.json", () => {
  it("round-trips to local (2) + hub (1)", () => {
    const raw = readFileSync(seedPath, "utf8");
    const cfg = parseHostsConfig(raw);
    const local = cfg.find((h) => h.transport === "local");
    const hub = cfg.find((h) => h.name === "hub");
    expect(local).toEqual({
      name: "local",
      transport: "local",
      maxConcurrent: 2,
    });
    expect(hub).toEqual({ name: "hub", transport: "hub", maxConcurrent: 1 });
  });
});
