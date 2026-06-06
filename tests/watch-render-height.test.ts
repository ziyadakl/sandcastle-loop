/**
 * Render-level regression guard for the flicker fix: the dashboard's TRUE
 * rendered height (margins included) must never exceed the terminal `rows`, or
 * Ink scroll-jitters. This catches `coreLines` drifting out of sync with the
 * actual render (e.g. a future header/row addition) — which the pure
 * `computeRecentCap` unit tests, validated against their own constants, cannot.
 */
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink";
import { Dashboard } from "../.sandcastle/watch/sandcastle-watch.js";
import type { SandcastleStatus } from "../.sandcastle/lib/status/schema.js";

const issues = Array.from({ length: 8 }, (_, i) => ({
  number: 100 + i,
  title: `done issue ${100 + i}`,
  branch: `agent/issue-${100 + i}`,
  phase: "merged" as const,
}));
const status: SandcastleStatus = {
  schemaVersion: 1,
  state: "running",
  run: { branch: "docs/x", repo: "affinity-tracker", startedAt: "2026-06-06T00:00:00.000Z", iterations: { current: 1, total: 50 }, maxConcurrent: 2 },
  totals: { merged: 8, needsHuman: 0, requeued: 0, running: 0 },
  issues,
  updatedAt: "2026-06-06T18:00:00.000Z",
  activity: "merging",
};

function fakeStdout() {
  let buf = "";
  const s: any = {
    columns: 100, rows: 0, isTTY: false,
    write: (c: string) => { buf = c; return true; },
    on() {}, off() {}, removeListener() {},
  };
  s.get = () => buf;
  return s;
}

async function trueHeight(rows: number): Promise<number> {
  const out = fakeStdout();
  const inst = render(
    React.createElement(Dashboard, { state: { status, banner: null }, rows }),
    { stdout: out, patchConsole: false },
  );
  await new Promise((r) => setTimeout(r, 20));
  inst.unmount();
  const frame = out.get().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\n+$/, "");
  return frame.split("\n").length;
}

describe("dashboard render height fits the terminal", () => {
  for (const rows of [40, 20, 14, 12, 10]) {
    it(`rows=${rows}: rendered height ≤ ${rows}`, async () => {
      expect(await trueHeight(rows)).toBeLessThanOrEqual(rows);
    });
  }
});
