import { describe, it, expect } from "vitest";
import {
  issueFromBranch,
  reuseOrFresh,
} from "../.sandcastle/lib/state/branch-checkpoint.js";

describe("issueFromBranch", () => {
  it("extracts the issue number from an agent/issue-<N> branch", () => {
    expect(issueFromBranch("agent/issue-42")).toBe(42);
  });

  it("returns null for a non-issue-shaped branch", () => {
    expect(issueFromBranch("sandcastle/nightly-20260716")).toBeNull();
    expect(issueFromBranch("main")).toBeNull();
    expect(issueFromBranch("agent/issue-")).toBeNull();
    expect(issueFromBranch("agent/issue-abc")).toBeNull();
  });
});

describe("reuseOrFresh", () => {
  const branch = "agent/issue-7";

  it("reuses only when sync is enabled AND a wip ref exists", () => {
    expect(reuseOrFresh({ syncEnabled: true, branch, wipExists: true })).toBe(
      "reuse",
    );
  });

  it("is fresh when sync is enabled but no wip ref exists", () => {
    expect(reuseOrFresh({ syncEnabled: true, branch, wipExists: false })).toBe(
      "fresh",
    );
  });

  it("is fresh when a wip ref exists but sync is disabled", () => {
    expect(reuseOrFresh({ syncEnabled: false, branch, wipExists: true })).toBe(
      "fresh",
    );
  });

  it("is fresh when sync is disabled and no wip ref exists", () => {
    expect(reuseOrFresh({ syncEnabled: false, branch, wipExists: false })).toBe(
      "fresh",
    );
  });

  it("is fresh for a non-issue-shaped branch even when sync on and wip claims to exist", () => {
    expect(
      reuseOrFresh({
        syncEnabled: true,
        branch: "sandcastle/nightly-20260716",
        wipExists: true,
      }),
    ).toBe("fresh");
  });
});
