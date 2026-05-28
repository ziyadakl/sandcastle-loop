import { describe, it, expect } from "vitest";
import {
  assembleVariant,
  findMarkerNames,
} from "../.sandcastle/lib/variant-assembly.js";

describe("assembleVariant", () => {
  it("returns input unchanged when overrides map is empty", () => {
    const base =
      "intro\n<!-- variant:foo -->\ndefault body\n<!-- /variant:foo -->\noutro\n";
    expect(assembleVariant(base, new Map())).toBe(base);
  });

  it("substitutes the body of a single marker region", () => {
    const base = "<!-- variant:foo -->old<!-- /variant:foo -->";
    const out = assembleVariant(base, new Map([["foo", "new"]]));
    expect(out).toBe("<!-- variant:foo -->new<!-- /variant:foo -->");
  });

  it("substitutes multiple distinct markers independently", () => {
    const base =
      "<!-- variant:a -->A0<!-- /variant:a -->\n<!-- variant:b -->B0<!-- /variant:b -->";
    const out = assembleVariant(
      base,
      new Map([
        ["a", "A1"],
        ["b", "B1"],
      ]),
    );
    expect(out).toBe(
      "<!-- variant:a -->A1<!-- /variant:a -->\n<!-- variant:b -->B1<!-- /variant:b -->",
    );
  });

  it("substitutes every occurrence when the same marker name repeats", () => {
    const base =
      "<!-- variant:foo -->one<!-- /variant:foo -->\n" +
      "middle\n" +
      "<!-- variant:foo -->two<!-- /variant:foo -->\n" +
      "<!-- variant:foo -->three<!-- /variant:foo -->";
    const out = assembleVariant(base, new Map([["foo", "X"]]));
    expect(out).toBe(
      "<!-- variant:foo -->X<!-- /variant:foo -->\n" +
        "middle\n" +
        "<!-- variant:foo -->X<!-- /variant:foo -->\n" +
        "<!-- variant:foo -->X<!-- /variant:foo -->",
    );
  });

  it("leaves base unchanged when override key has no matching marker", () => {
    const base = "<!-- variant:foo -->keep<!-- /variant:foo -->";
    const out = assembleVariant(
      base,
      new Map([["nonexistent", "ignored"]]),
    );
    expect(out).toBe(base);
  });

  it("preserves a malformed marker (opener without closer) as literal text", () => {
    const base = "before\n<!-- variant:foo -->\nsome text\nno closer here\n";
    const out = assembleVariant(base, new Map([["foo", "REPLACED"]]));
    expect(out).toBe(base);
  });

  it("preserves multiline body around override and replaces only the body span", () => {
    const base =
      "head\n<!-- variant:foo -->\nline 1\nline 2\n<!-- /variant:foo -->\ntail\n";
    const out = assembleVariant(base, new Map([["foo", "NEW"]]));
    expect(out).toBe(
      "head\n<!-- variant:foo -->NEW<!-- /variant:foo -->\ntail\n",
    );
  });

  it("is idempotent: assembling twice equals assembling once", () => {
    const base =
      "<!-- variant:a -->A0<!-- /variant:a -->\n" +
      "<!-- variant:b -->B0<!-- /variant:b -->\n" +
      "<!-- variant:a -->A0 again<!-- /variant:a -->";
    const overrides = new Map([
      ["a", "AA"],
      ["b", "BB"],
    ]);
    const once = assembleVariant(base, overrides);
    const twice = assembleVariant(once, overrides);
    expect(twice).toBe(once);
  });

  it("ignores a region whose closer name doesn't match the opener", () => {
    const base = "<!-- variant:foo -->body<!-- /variant:bar -->";
    const out = assembleVariant(base, new Map([["foo", "X"]]));
    expect(out).toBe(base);
  });
});

describe("findMarkerNames", () => {
  it("returns empty set when no markers present", () => {
    expect(findMarkerNames("plain text")).toEqual(new Set());
  });

  it("collects every distinct marker name in the input", () => {
    const base =
      "<!-- variant:a -->x<!-- /variant:a -->\n" +
      "<!-- variant:b -->y<!-- /variant:b -->\n" +
      "<!-- variant:a -->z<!-- /variant:a -->";
    expect(findMarkerNames(base)).toEqual(new Set(["a", "b"]));
  });

  it("ignores malformed markers (no closer)", () => {
    expect(findMarkerNames("<!-- variant:foo -->no closer")).toEqual(new Set());
  });
});
