/**
 * Tests for the pure height-fit math behind the `sandcastle-watch` viewer.
 *
 * The load-bearing property: total rendered lines must never exceed the terminal
 * height, or Ink scroll-jitters. The "recent" strip is the elastic zone, so
 * `computeRecentCap` shrinks it (down to 0) to make everything fit — while still
 * showing the full set when there's room. Verified in BOTH directions per the
 * plan: a tall terminal must NOT spuriously hide rows; a short one must shrink.
 */
import { describe, it, expect } from "vitest";
import { computeRecentCap, RECENT_CAP } from "../.sandcastle/watch/layout.js";

describe("computeRecentCap", () => {
  it("tall terminal shows all wanted rows (no spurious hiding)", () => {
    expect(computeRecentCap({ rows: 100, coreLines: 10, recentTotal: 4 })).toBe(4);
  });

  it("caps at RECENT_CAP even with a huge history on a tall terminal", () => {
    expect(computeRecentCap({ rows: 100, coreLines: 10, recentTotal: 20 })).toBe(
      RECENT_CAP,
    );
  });

  it("headless render (rows = Infinity) preserves pre-fix behaviour", () => {
    expect(
      computeRecentCap({ rows: Number.POSITIVE_INFINITY, coreLines: 10, recentTotal: 3 }),
    ).toBe(3);
    expect(
      computeRecentCap({ rows: Number.POSITIVE_INFINITY, coreLines: 10, recentTotal: 20 }),
    ).toBe(RECENT_CAP);
  });

  it("short terminal shrinks the strip, reserving a line for the '+N more' hint", () => {
    // rows 16 − core 10 − chrome 3 = budget 3; can't show all 5 → 3 − 1 = 2.
    expect(computeRecentCap({ rows: 16, coreLines: 10, recentTotal: 5 })).toBe(2);
  });

  it("returns 0 when not even one recent row fits", () => {
    expect(computeRecentCap({ rows: 10, coreLines: 10, recentTotal: 5 })).toBe(0);
  });

  it("returns 0 when there is nothing recent to show", () => {
    expect(computeRecentCap({ rows: 100, coreLines: 5, recentTotal: 0 })).toBe(0);
  });

  it("exact-fit boundary: all rows fit when budget equals the count (no hint needed)", () => {
    // rows 16 − core 10 − chrome 3 = 3; recentTotal 3 ≤ cap ⇒ no "+N more".
    expect(computeRecentCap({ rows: 16, coreLines: 10, recentTotal: 3 })).toBe(3);
    // One line shorter → can't fit all 3, reserve hint line → 2 − 1 = 1.
    expect(computeRecentCap({ rows: 15, coreLines: 10, recentTotal: 3 })).toBe(1);
  });

  it("overflow-reserve boundary: showing the full cap needs room for '+N more'", () => {
    // recentTotal 10 > cap 6 ⇒ a hint line is always needed. Budget 7 fits 6+1.
    expect(computeRecentCap({ rows: 20, coreLines: 10, recentTotal: 10 })).toBe(6);
    // Budget 6 can't fit 6+1 → 6 − 1 = 5 (shown) + "+5 more".
    expect(computeRecentCap({ rows: 19, coreLines: 10, recentTotal: 10 })).toBe(5);
  });
});
