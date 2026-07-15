/**
 * Tests for the history-backed "recent" strip in the sandcastle-watch viewer.
 *
 * The completed strip should:
 *   1. Render from `status.history` (cross-iteration, newest-first) when non-empty.
 *   2. Fall back to `status.issues` terminal-phase filter when history is empty.
 *   3. Respect RECENT_CAP and show "+N more" when the cap is exceeded.
 *   4. Handle duplicate issue numbers in history without crashing (composite key).
 */
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink";
import { Dashboard } from "../.sandcastle/watch/sandcastle-watch.js";
import {
  STATUS_SCHEMA_VERSION,
  type SandcastleStatus,
} from "../.sandcastle/lib/status/schema.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function fakeStdout() {
  let buf = "";
  const s: any = {
    columns: 100,
    rows: 0,
    isTTY: false,
    write: (c: string) => {
      buf = c;
      return true;
    },
    on() {},
    off() {},
    removeListener() {},
  };
  s.get = () => buf;
  return s;
}

async function renderFrame(status: SandcastleStatus, rows: number): Promise<string> {
  const out = fakeStdout();
  const inst = render(
    React.createElement(Dashboard, { state: { status, banner: null }, rows }),
    { stdout: out, patchConsole: false },
  );
  await new Promise((r) => setTimeout(r, 20));
  inst.unmount();
  return out.get().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

/** Shared run/totals fields so each test only needs to override issues/history. */
const BASE_RUN: SandcastleStatus["run"] = {
  branch: "docs/test",
  repo: "test-repo",
  startedAt: "2026-06-18T00:00:00.000Z",
  iterations: { current: 1, total: 50 },
  maxConcurrent: 2,
};

const BASE_TOTALS: SandcastleStatus["totals"] = {
  merged: 0,
  needsHuman: 0,
  requeued: 0,
  running: 0,
};

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("watch recent strip — history-backed rendering", () => {
  it("history-backed, newest-first: shows history entries not planned issues", async () => {
    // history push order: #310, #311, #312 → newest is #312 → should appear first
    const status: SandcastleStatus = {
      schemaVersion: STATUS_SCHEMA_VERSION,
      state: "running",
      hostId: "host-a",
      runId: "run-jun4",
      run: BASE_RUN,
      totals: { ...BASE_TOTALS, merged: 2, needsHuman: 1 },
      issues: [{ number: 399, title: "planned issue 399", branch: "agent/399", phase: "planned" }],
      history: [
        { number: 310, title: "issue 310 merged",        branch: "agent/310", phase: "merged",       completedAt: "2026-06-18T10:00:00.000Z" },
        { number: 311, title: "issue 311 needs-human",   branch: "agent/311", phase: "needs-human",  completedAt: "2026-06-18T10:01:00.000Z" },
        { number: 312, title: "issue 312 deferred",      branch: "agent/312", phase: "deferred",     completedAt: "2026-06-18T10:02:00.000Z" },
      ],
      updatedAt: "2026-06-18T10:03:00.000Z",
      activity: "planning",
    };

    const frame = await renderFrame(status, 40);

    // All three history entries must appear
    expect(frame).toContain("#310");
    expect(frame).toContain("#311");
    expect(frame).toContain("#312");

    // Planned issue must NOT appear in the recent strip
    expect(frame).not.toContain("#399");

    // Newest-first: #312 must appear before #310 in the frame
    expect(frame.indexOf("#312")).toBeLessThan(frame.indexOf("#310"));
  });

  it("fallback when history empty: shows terminal-phase issues from current batch", async () => {
    const status: SandcastleStatus = {
      schemaVersion: STATUS_SCHEMA_VERSION,
      state: "running",
      hostId: "host-a",
      runId: "run-jun4",
      run: BASE_RUN,
      totals: { ...BASE_TOTALS, merged: 1 },
      issues: [{ number: 320, title: "issue 320 merged", branch: "agent/320", phase: "merged" }],
      history: [],
      updatedAt: "2026-06-18T11:00:00.000Z",
    };

    const frame = await renderFrame(status, 40);

    expect(frame).toContain("#320");
  });

  it("cap + '+N more': shows 6 newest and hides remaining 4 with hint", async () => {
    // 10 history entries, #201..#210, all merged. Newest pushed last = #210.
    const history = Array.from({ length: 10 }, (_, i) => ({
      number: 201 + i,
      title: `issue ${201 + i}`,
      branch: `agent/${201 + i}`,
      phase: "merged" as const,
      completedAt: `2026-06-18T12:${String(i).padStart(2, "0")}:00.000Z`,
    }));

    const status: SandcastleStatus = {
      schemaVersion: STATUS_SCHEMA_VERSION,
      state: "running",
      hostId: "host-a",
      runId: "run-jun4",
      run: BASE_RUN,
      totals: { ...BASE_TOTALS, merged: 10 },
      issues: [],
      history,
      updatedAt: "2026-06-18T12:10:00.000Z",
    };

    const frame = await renderFrame(status, 40);

    // RECENT_CAP = 6, newest-first → #210 and #205 should show; #204 and #201 should not
    expect(frame).toContain("#210");
    expect(frame).toContain("#205");
    expect(frame).not.toContain("#204");
    expect(frame).not.toContain("#201");

    // "+4 more" hint for the 4 hidden entries
    expect(frame).toContain("+4 more");
  });

  it("duplicate issue number: does not crash and both entries render", async () => {
    // #340 appears twice — first deferred, then later merged. This is intentional
    // (issue re-queued then completed) and the composite key fix must handle it.
    const status: SandcastleStatus = {
      schemaVersion: STATUS_SCHEMA_VERSION,
      state: "running",
      hostId: "host-a",
      runId: "run-jun4",
      run: BASE_RUN,
      totals: { ...BASE_TOTALS, merged: 1, needsHuman: 1 },
      issues: [],
      history: [
        { number: 340, title: "issue 340 deferred", branch: "agent/340", phase: "deferred", completedAt: "2026-06-18T13:01:00.000Z" },
        { number: 340, title: "issue 340 merged",   branch: "agent/340", phase: "merged",   completedAt: "2026-06-18T13:02:00.000Z" },
      ],
      updatedAt: "2026-06-18T13:03:00.000Z",
    };

    // The render itself must not throw: a duplicate React key from the two
    // #340 rows would surface as an error here (renderFrame would reject).
    const frame = await renderFrame(status, 40);

    // #340 must appear exactly twice (both history rows render)
    const matches = frame.match(/#340/g) ?? [];
    expect(matches).toHaveLength(2);
  });
});
