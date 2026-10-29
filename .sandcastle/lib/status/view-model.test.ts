import { describe, expect, it } from "vitest";

// #1191 finding F: the web viewer's `meta.perMachine` per-ticket tally used
// to default straight to 0 for an old-build peer (one whose snapshot has no
// `run.tickets`/`tickets` field), so it rendered a peer that had shipped a
// run's worth of tickets, or was mid-run, as flat "0 done, 0 working,
// 0 waiting". `web/view-model.js` is plain JS (the browser bundle can't
// import TS — the same reasoning `lib/cost/ledger.test.ts` documents for its
// own `ROLE_ORDER` mirror test), so it is pinned here by importing it
// directly, the same way that test does.
async function loadViewModel() {
  return (await import("../../web/view-model.js")) as {
    buildViewModel: (
      snap: unknown,
      nowMs: number,
      aliasMap?: Record<string, string>,
      probe?: Record<string, unknown>,
    ) => {
      meta: {
        perMachine: Array<{
          label: string;
          done: number;
          working: number;
          waiting: number;
          cap: number;
        }>;
      };
    };
  };
}

const NOW = Date.parse("2026-09-02T12:00:00.000Z");

/** A minimal own-snapshot shape `buildViewModel` accepts. */
function snap(over: Record<string, unknown> = {}) {
  return {
    hostId: "mac",
    state: "running",
    updatedAt: new Date(NOW).toISOString(),
    run: { iterations: { current: 3, total: 10 } },
    issues: [],
    totals: {},
    ...over,
  };
}

describe("buildViewModel — meta.perMachine (#1191 finding F)", () => {
  it("uses run.tickets directly for the own host when present", async () => {
    const { buildViewModel } = await loadViewModel();
    const vm = buildViewModel(
      snap({
        run: {
          iterations: { current: 3, total: 10 },
          tickets: { done: 4, working: 2, waiting: 1, cap: 10 },
        },
      }),
      NOW,
    );
    expect(vm.meta.perMachine[0]).toEqual({
      label: "Mac",
      done: 4,
      working: 2,
      waiting: 1,
      cap: 10,
    });
  });

  it("falls back to iterations.current for done, and derives working/waiting from issues, when tickets is absent (an old-build peer)", async () => {
    const { buildViewModel } = await loadViewModel();
    const vm = buildViewModel(
      snap({
        run: { iterations: { current: 6, total: 10 } }, // no `tickets`
        issues: [
          { number: 1, title: "a", branch: "b", phase: "implementer" },
          { number: 2, title: "b", branch: "b", phase: "planned" },
          { number: 3, title: "c", branch: "b", phase: "merged" },
          { number: 4, title: "d", branch: "b", phase: "check-writer" },
        ],
      }),
      NOW,
    );
    expect(vm.meta.perMachine[0]).toEqual({
      label: "Mac",
      // Old round-counter stand-in, NOT 0.
      done: 6,
      // "implementer" and "check-writer" are both still being worked —
      // neither is `planned` nor a terminal phase (merged/needs-human/
      // deferred).
      working: 2,
      waiting: 1,
      cap: 10,
    });
  });

  it("applies the same fallback to a PEER's tally, not just the own host", async () => {
    const { buildViewModel } = await loadViewModel();
    const vm = buildViewModel(
      snap({
        peers: [
          {
            hostId: "vps",
            state: "running",
            iterations: { current: 8, total: 20 },
            // no `tickets` field — a pre-#902 peer.
            issues: [
              { number: 5, title: "e", branch: "b", phase: "reviewer" },
              { number: 6, title: "f", branch: "b", phase: "planned" },
              { number: 7, title: "g", branch: "b", phase: "planned" },
            ],
            totals: {},
            updatedAt: new Date(NOW).toISOString(),
          },
        ],
      }),
      NOW,
    );
    const peerRow = vm.meta.perMachine.find((m) => m.label === "VPS");
    expect(peerRow).toEqual({
      label: "VPS",
      done: 8,
      working: 1,
      waiting: 2,
      cap: 20,
    });
  });

  it("a genuinely empty issues array and no iterations at all degrades to all zeros, never throws", async () => {
    const { buildViewModel } = await loadViewModel();
    const vm = buildViewModel(
      snap({ run: {}, issues: [] }),
      NOW,
    );
    expect(vm.meta.perMachine[0]).toEqual({
      label: "Mac",
      done: 0,
      working: 0,
      waiting: 0,
      cap: 0,
    });
  });
});
