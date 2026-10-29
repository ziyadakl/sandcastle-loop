/**
 * The person-written part of an issue body, read apart from the sections the
 * loop itself appends.
 */
import { describe, expect, it } from "vitest";

import { namesPathInOwnerText } from "./issue-body-sections.js";

describe("namesPathInOwnerText (spec #1334: was an older test named in the ticket?)", () => {
  const path = "packages/api/src/__checks__/issue-1058/relist.test.ts";

  it("reads a path the person wrote as named", () => {
    expect(namesPathInOwnerText(`This changes the rule ${path} pins.`, path)).toBe(true);
  });

  it("reads a path quoted only inside the loop's own section as NOT named", () => {
    const body =
      "Change the relist rule.\n\n" +
      "<!-- sandcastle:stop-report:start -->\n" +
      `The finished diff edited ${path}.\n` +
      "<!-- sandcastle:stop-report:end -->";
    expect(namesPathInOwnerText(body, path)).toBe(false);
  });

  it("reads a path inside a half-written loop section as NOT named", () => {
    const body = `Ticket text.\n<!-- sandcastle:retry-budget:start -->\n${path}`;
    expect(namesPathInOwnerText(body, path)).toBe(false);
  });

  it("reads no body as not named", () => {
    expect(namesPathInOwnerText(undefined, path)).toBe(false);
  });
});
