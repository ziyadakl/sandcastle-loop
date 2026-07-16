import { describe, it, expect } from "vitest";
import {
  formatHostResult,
  formatHostResults,
  isLaunched,
  type HostResult,
} from "../.sandcastle/lib/hosts/result.js";

describe("formatHostResult", () => {
  it("formats launched as launched", () => {
    expect(formatHostResult({ host: "hub", outcome: "launched" })).toBe(
      "hub: launched",
    );
  });

  it("formats unreachable as skipped", () => {
    expect(formatHostResult({ host: "hub", outcome: "unreachable" })).toBe(
      "hub: skipped (unreachable)",
    );
  });

  it("formats already-running as skipped", () => {
    expect(formatHostResult({ host: "hub", outcome: "already-running" })).toBe(
      "hub: skipped (already-running)",
    );
  });

  it("formats dirty-tree as skipped", () => {
    expect(formatHostResult({ host: "hub", outcome: "dirty-tree" })).toBe(
      "hub: skipped (dirty-tree)",
    );
  });

  it("formats diverged as skipped", () => {
    expect(formatHostResult({ host: "hub", outcome: "diverged" })).toBe(
      "hub: skipped (diverged)",
    );
  });

  it("formats auth-failed as skipped", () => {
    expect(formatHostResult({ host: "hub", outcome: "auth-failed" })).toBe(
      "hub: skipped (auth-failed)",
    );
  });

  it("formats preflight-error as skipped", () => {
    expect(formatHostResult({ host: "hub", outcome: "preflight-error" })).toBe(
      "hub: skipped (preflight-error)",
    );
  });

  it("appends detail when present", () => {
    expect(
      formatHostResult({
        host: "hub",
        outcome: "diverged",
        detail: "local commits not on origin",
      }),
    ).toBe("hub: skipped (diverged) — local commits not on origin");
  });

  it("appends detail on a launched result too", () => {
    expect(
      formatHostResult({
        host: "hub",
        outcome: "launched",
        detail: "branch feat/x",
      }),
    ).toBe("hub: launched — branch feat/x");
  });

  it("omits the detail separator when detail is absent or empty", () => {
    expect(
      formatHostResult({ host: "hub", outcome: "dirty-tree", detail: "" }),
    ).toBe("hub: skipped (dirty-tree)");
  });
});

describe("isLaunched", () => {
  it("is true only for launched", () => {
    expect(isLaunched({ host: "a", outcome: "launched" })).toBe(true);
    expect(isLaunched({ host: "a", outcome: "unreachable" })).toBe(false);
    expect(isLaunched({ host: "a", outcome: "dirty-tree" })).toBe(false);
  });
});

describe("formatHostResults", () => {
  it("joins lines and appends a launched/skipped summary", () => {
    const rs: HostResult[] = [
      { host: "hub", outcome: "launched" },
      { host: "edge1", outcome: "dirty-tree" },
      { host: "edge2", outcome: "diverged", detail: "local commits not on origin" },
    ];
    expect(formatHostResults(rs)).toBe(
      [
        "hub: launched",
        "edge1: skipped (dirty-tree)",
        "edge2: skipped (diverged) — local commits not on origin",
        "1 launched, 2 skipped",
      ].join("\n"),
    );
  });

  it("counts all launched", () => {
    const rs: HostResult[] = [
      { host: "a", outcome: "launched" },
      { host: "b", outcome: "launched" },
    ];
    expect(formatHostResults(rs)).toBe(
      ["a: launched", "b: launched", "2 launched, 0 skipped"].join("\n"),
    );
  });

  it("handles an empty list", () => {
    expect(formatHostResults([])).toBe("0 launched, 0 skipped");
  });
});
