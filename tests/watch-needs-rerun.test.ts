/**
 * DEFECT 3 regression guard: a `needs-rerun` issue is TRANSIENT (its label was
 * released back to `ready-for-agent` for a re-run/peer to reclaim), so it must
 * render in the TUI's ACTIVE panel — matching the web viewer (view-model.js) and
 * the schema's stated intent (schema.ts: "belongs in active not recent"). Before
 * the fix the TUI's allowlist `ACTIVE_PHASES` omitted it AND its `TERMINAL_PHASES`
 * omitted it, so a parked `needs-rerun` issue vanished from BOTH panels.
 *
 * Behavioral: render the real Dashboard with a single `needs-rerun` issue (empty
 * history, as a fresh park has) and assert its phase label surfaces in the frame.
 * Red before the fix: the frame contains neither the issue nor its label.
 */
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink";
import { Dashboard } from "../.sandcastle/watch/sandcastle-watch.js";
import {
  STATUS_SCHEMA_VERSION,
  type SandcastleStatus,
} from "../.sandcastle/lib/status/schema.js";

const status: SandcastleStatus = {
  schemaVersion: STATUS_SCHEMA_VERSION,
  state: "running",
  hostId: "host-a",
  runId: "run-x",
  run: {
    branch: "docs/x",
    repo: "affinity-tracker",
    startedAt: "2026-07-27T00:00:00.000Z",
    iterations: { current: 1, total: 50 },
    maxConcurrent: 2,
  },
  totals: { merged: 0, needsHuman: 0, requeued: 0, running: 0 },
  issues: [
    {
      number: 314,
      title: "parked for re-run",
      branch: "agent/issue-314",
      phase: "needs-rerun" as const,
    },
  ],
  history: [],
  updatedAt: "2026-07-27T18:00:00.000Z",
};

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

async function renderFrame(): Promise<string> {
  const out = fakeStdout();
  const inst = render(
    React.createElement(Dashboard, { state: { status, banner: null }, rows: 40 }),
    { stdout: out, patchConsole: false },
  );
  await new Promise((r) => setTimeout(r, 20));
  inst.unmount();
  return out.get().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

describe("watch TUI renders a needs-rerun issue in the active panel", () => {
  it("shows the needs-rerun issue (number + label) rather than dropping it", async () => {
    const frame = await renderFrame();
    expect(frame).toContain("314");
    expect(frame).toContain("needs-re-run");
  });
});
