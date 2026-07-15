/**
 * Tests for the pure poll-reducer that drives the `sandcastle-watch` viewer.
 *
 * The load-bearing property is LAST-GOOD RETENTION: a torn write, a transient
 * IO error, or a future-version snapshot must never blank the dashboard. Each
 * case below asserts that `status` survives and the right banner is raised.
 */
import { describe, it, expect } from "vitest";
import {
  reduce,
  type ReadResult,
  type ViewState,
} from "../.sandcastle/watch/reducer.js";
import {
  STALE_AFTER_MS,
  STATUS_SCHEMA_VERSION,
  type SandcastleStatus,
} from "../.sandcastle/lib/status/schema.js";

const EMPTY: ViewState = { status: null, banner: null };

// A valid snapshot. `updatedAt` is read back into `nowMs` so the staleness gate
// stays satisfied and a good read clears the banner.
const VALID_UPDATED_AT = "2026-06-04T12:00:00.000Z";
const VALID_NOW = Date.parse(VALID_UPDATED_AT);

const validStatus: SandcastleStatus = {
  schemaVersion: STATUS_SCHEMA_VERSION,
  state: "running",
  hostId: "host-a",
  runId: "run-jun4",
  run: {
    branch: "sandcastle/run-jun4",
    repo: "affinity-tracker",
    startedAt: "2026-06-04T11:30:00.000Z",
    iterations: { current: 12, total: 50 },
    maxConcurrent: 2,
  },
  totals: { merged: 3, needsHuman: 1, requeued: 0, running: 2 },
  issues: [
    {
      number: 337,
      title: "backfilled txns uncategorized",
      branch: "agent/issue-337",
      phase: "implementer",
    },
  ],
  history: [],
  updatedAt: VALID_UPDATED_AT,
};

const validRaw = JSON.stringify(validStatus);

function enoent(): ReadResult {
  return { ok: false, kind: "enoent", error: new Error("ENOENT") };
}
function ok(raw: string): ReadResult {
  return { ok: true, raw };
}

describe("reduce", () => {
  it("ENOENT before any read → waiting, status stays null", () => {
    const s = reduce(EMPTY, enoent(), VALID_NOW);
    expect(s.status).toBeNull();
    expect(s.banner).toBe("waiting");
  });

  it("a valid snapshot → status set, banner cleared", () => {
    const s = reduce(EMPTY, ok(validRaw), VALID_NOW);
    expect(s.status).not.toBeNull();
    expect(s.status?.run.repo).toBe("affinity-tracker");
    expect(s.status?.issues).toHaveLength(1);
    expect(s.banner).toBeNull();
  });

  it("a torn / unparseable read → RETAINS last-good status, banner stale", () => {
    const good = reduce(EMPTY, ok(validRaw), VALID_NOW);
    // Truncated JSON — deterministically fails JSON.parse.
    const torn = reduce(
      good,
      ok(`{"schemaVersion":${STATUS_SCHEMA_VERSION},"state":"run`),
      VALID_NOW,
    );
    expect(torn.status).toBe(good.status); // same object, not blanked
    expect(torn.status?.run.repo).toBe("affinity-tracker");
    expect(torn.banner).toBe("stale");
  });

  it("a schemaVersion mismatch → RETAINS last-good, banner outdated", () => {
    const good = reduce(EMPTY, ok(validRaw), VALID_NOW);
    const future = JSON.stringify({
      ...validStatus,
      schemaVersion: STATUS_SCHEMA_VERSION + 1,
    });
    const out = reduce(good, ok(future), VALID_NOW);
    expect(out.status).toBe(good.status); // last-good retained
    expect(out.banner).toBe("outdated");
  });

  // --- audit issue #4 follow-up: STATUS_SCHEMA_VERSION bump for `unhealthy` ---

  it("version skew (current+1, simulating a newer loop / older viewer) → graceful 'outdated' banner, NOT 'stale'", () => {
    // Locks the raw-version guard in reducer.ts: it reads `schemaVersion`
    // BEFORE safeParse, so a version-skewed snapshot is routed to "outdated"
    // and never reaches (and fails) the strict enum parse. This is the lever
    // that makes the STATUS_SCHEMA_VERSION bump for `unhealthy` safe — an old
    // viewer sees a graceful banner instead of a misleading "stale" one that
    // would hide the real failure.
    const skewed = JSON.stringify({
      ...validStatus,
      schemaVersion: STATUS_SCHEMA_VERSION + 1,
    });
    const s = reduce(EMPTY, ok(skewed), VALID_NOW);
    expect(s.banner).toBe("outdated");
    expect(s.banner).not.toBe("stale");
  });

  it("full sequence: enoent → valid → torn → mismatch keeps last-good throughout", () => {
    let s = reduce(EMPTY, enoent(), VALID_NOW);
    expect(s.status).toBeNull();
    expect(s.banner).toBe("waiting");

    s = reduce(s, ok(validRaw), VALID_NOW);
    expect(s.status?.run.repo).toBe("affinity-tracker");
    expect(s.banner).toBeNull();
    const firstGood = s.status;

    s = reduce(s, ok("not json at all"), VALID_NOW);
    expect(s.status).toBe(firstGood);
    expect(s.banner).toBe("stale");

    s = reduce(s, ok(JSON.stringify({ ...validStatus, schemaVersion: 99 })), VALID_NOW);
    expect(s.status).toBe(firstGood);
    expect(s.banner).toBe("outdated");
  });

  it("a good but old snapshot → stale (loop died without a terminal write)", () => {
    // Past the heartbeat-aware window: a live loop would have re-stamped by now.
    const wayLater = VALID_NOW + STALE_AFTER_MS + 1_000;
    const s = reduce(EMPTY, ok(validRaw), wayLater);
    expect(s.status).not.toBeNull();
    expect(s.banner).toBe("stale");
  });

  it("a healthy running phase under the stale window → NOT stale", () => {
    // Older than the legacy 8s gate, but inside the heartbeat window — a long
    // implementer/reviewer phase must not false-fire "stale".
    const s = reduce(EMPTY, ok(validRaw), VALID_NOW + STALE_AFTER_MS - 1_000);
    expect(s.status).not.toBeNull();
    expect(s.banner).toBeNull();
  });

  it("state=done → banner 'done' even when old (a finished run is NOT stale)", () => {
    const done = JSON.stringify({ ...validStatus, state: "done" });
    // 60s past updatedAt: a done run stops writing, so age must be ignored.
    const s = reduce(EMPTY, ok(done), VALID_NOW + 60_000);
    expect(s.status?.state).toBe("done");
    expect(s.banner).toBe("done");
  });

  it("state=stopped → banner 'stopped', write-age ignored", () => {
    const stopped = JSON.stringify({ ...validStatus, state: "stopped" });
    const s = reduce(EMPTY, ok(stopped), VALID_NOW + 60_000);
    expect(s.banner).toBe("stopped");
  });

  it("state=restarting + fresh → live (banner null), kept visible across relaunch", () => {
    const restarting = JSON.stringify({ ...validStatus, state: "restarting" });
    const s = reduce(EMPTY, ok(restarting), VALID_NOW + 1_000);
    expect(s.banner).toBeNull();
  });

  it("state=restarting + old → escalates to stale (catches a hung relaunch)", () => {
    const restarting = JSON.stringify({ ...validStatus, state: "restarting" });
    const s = reduce(EMPTY, ok(restarting), VALID_NOW + STALE_AFTER_MS + 1_000);
    expect(s.banner).toBe("stale");
  });

  it("an IO error after a good read → keeps last-good, banner stale", () => {
    const good = reduce(EMPTY, ok(validRaw), VALID_NOW);
    const io: ReadResult = { ok: false, kind: "ioerror", error: new Error("EIO") };
    const s = reduce(good, io, VALID_NOW);
    expect(s.status).toBe(good.status);
    expect(s.banner).toBe("stale");
    expect(s.lastError).toBe("EIO");
  });

  it("identical consecutive good reads → SAME ViewState reference (dedup)", () => {
    // Same bytes, same banner ⇒ same reference, so React/Ink skip the repaint.
    // This is what stops a quiet feed from jittering 4×/sec on unchanged content.
    const first = reduce(EMPTY, ok(validRaw), VALID_NOW);
    const second = reduce(first, ok(validRaw), VALID_NOW);
    expect(second).toBe(first);
  });

  it("same bytes but now past the stale window → re-renders (NOT deduped)", () => {
    const fresh = reduce(EMPTY, ok(validRaw), VALID_NOW);
    expect(fresh.banner).toBeNull();
    const later = reduce(fresh, ok(validRaw), VALID_NOW + STALE_AFTER_MS + 1_000);
    expect(later).not.toBe(fresh); // banner crossed to stale → new state
    expect(later.banner).toBe("stale");
    expect(later.status?.run.repo).toBe("affinity-tracker");
  });

  it("a good read after a torn read re-renders the recovery (dedup off across error)", () => {
    const good = reduce(EMPTY, ok(validRaw), VALID_NOW);
    const torn = reduce(good, ok("{bad"), VALID_NOW); // stale; drops raw
    const recovered = reduce(torn, ok(validRaw), VALID_NOW);
    expect(recovered).not.toBe(torn);
    expect(recovered.banner).toBeNull();
    expect(recovered.status?.run.repo).toBe("affinity-tracker");
  });

  it("preserves the optional activity field through a good read", () => {
    const withActivity = JSON.stringify({ ...validStatus, activity: "merging" });
    const s = reduce(EMPTY, ok(withActivity), VALID_NOW);
    expect(s.status?.activity).toBe("merging");
  });

  it("accepts an UNKNOWN activity value (permissive schema → forward-compatible)", () => {
    // A newer loop emitting a label this viewer doesn't know must NOT be treated
    // as a torn/outdated read (which would freeze an un-synced consumer's viewer).
    const future = JSON.stringify({ ...validStatus, activity: "fixer" });
    const s = reduce(EMPTY, ok(future), VALID_NOW);
    expect(s.status?.activity).toBe("fixer");
    expect(s.banner).toBeNull();
  });
});
