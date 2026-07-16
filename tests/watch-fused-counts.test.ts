/**
 * Regression: the terminal `sandcastle-watch` viewer renders FUSED cross-host
 * counts (own + every folded peer), not own-host-only counts.
 *
 * Spec (cross-host unified viewer design, Terminal viewer § / Non-goals §): v1
 * "shows fused counts." `foldPeers` deliberately keeps the top-level `totals`
 * own-only (a publish invariant), so the viewer must sum own + peers at render
 * time via `sumTotalsAcrossHosts`. This renders the SAME merged local
 * status.json the viewer reads (own merged=2, one same-run peer merged=3) and
 * asserts the Counts pill row reads the fused "5 merged", never the own-only
 * "2 merged".
 */
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink";
import { Dashboard } from "../.sandcastle/watch/sandcastle-watch.js";
import { foldPeers } from "../.sandcastle/lib/status/merge.js";
import {
  STATUS_SCHEMA_VERSION,
  type SandcastleStatus,
} from "../.sandcastle/lib/status/schema.js";

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

const RUN: SandcastleStatus["run"] = {
  branch: "docs/x",
  repo: "test-repo",
  startedAt: "2026-07-14T00:00:00.000Z",
  iterations: { current: 1, total: 50 },
  maxConcurrent: 2,
};

describe("sandcastle-watch terminal viewer — cross-host fused counts", () => {
  it("renders the fused own+peer merged count, not the own-only count", async () => {
    const peer: SandcastleStatus = {
      schemaVersion: STATUS_SCHEMA_VERSION,
      state: "running",
      hostId: "host-b",
      runId: "run-1",
      run: RUN,
      totals: { merged: 3, needsHuman: 0, requeued: 0, running: 0 },
      issues: [],
      history: [],
      updatedAt: "2026-07-14T10:00:00.000Z",
    };
    const own: SandcastleStatus = {
      schemaVersion: STATUS_SCHEMA_VERSION,
      state: "running",
      hostId: "host-a",
      runId: "run-1",
      run: RUN,
      totals: { merged: 2, needsHuman: 0, requeued: 0, running: 0 },
      issues: [],
      history: [],
      updatedAt: "2026-07-14T10:00:01.000Z",
    };

    const merged = foldPeers(own, [peer]);
    const frame = await renderFrame(merged, 40);

    // Fused merged count = own 2 + peer 3 = 5.
    expect(frame).toContain("5 merged");
    // And must NOT show the own-only count.
    expect(frame).not.toContain("2 merged");
  });
});
