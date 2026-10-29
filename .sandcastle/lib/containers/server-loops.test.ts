/**
 * Spec #1368: which pids from `pgrep` belong to some OTHER loop.
 */
import { describe, expect, it } from "vitest";

import { otherLoopPids } from "./server-loops.js";

describe("otherLoopPids", () => {
  it("drops our own pid and our ancestors (the wrapper and tsx launcher), keeps a loop in another checkout", () => {
    expect(otherLoopPids("100\n200\n300\n", new Set([100, 200]))).toEqual([300]);
  });
  it("is empty when only our own process tree matches", () => {
    expect(otherLoopPids("100\n200\n", new Set([100, 200]))).toEqual([]);
    expect(otherLoopPids("", new Set([1]))).toEqual([]);
  });
});
