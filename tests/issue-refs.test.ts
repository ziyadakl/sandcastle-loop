/**
 * Canonical `#N` extractor shared by `parseBlockedBy` (main.mts) and
 * `parseSupersededBy` (gh.ts). Behaviour these two callers rely on:
 * validated positive ints, de-duplicated in first-seen order.
 */
import { describe, it, expect } from "vitest";

import { collectIssueRefs } from "../.sandcastle/lib/state/issue-refs.js";

describe("collectIssueRefs", () => {
  it("returns [] for empty text", () => {
    expect(collectIssueRefs("")).toEqual([]);
  });

  it("extracts every #N in first-seen order", () => {
    expect(collectIssueRefs("see #12, then #34")).toEqual([12, 34]);
  });

  it("de-dupes, keeping first-seen order", () => {
    expect(collectIssueRefs("#5 #8 #5 #3 #8")).toEqual([5, 8, 3]);
  });

  it("ignores #0 and non-#-prefixed numbers", () => {
    expect(collectIssueRefs("#0 and 42 and #7")).toEqual([7]);
  });

  it("returns [] when there are no refs", () => {
    expect(collectIssueRefs("no refs here")).toEqual([]);
  });
});
