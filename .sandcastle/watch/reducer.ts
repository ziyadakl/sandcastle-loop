/**
 * Pure poll-reducer for the `sandcastle-watch` viewer.
 *
 * Side-effect-free so the viewer and its unit test share one code path: the
 * viewer feeds it the result of a `readFileSync`, the test feeds it canned
 * `ReadResult`s. Every branch keeps the LAST-GOOD status on the screen rather
 * than blanking out — a torn write, a transient IO error, or a freshly-deleted
 * file must never flicker the dashboard to empty.
 *
 * The schema is the single source of truth (see
 * `.sandcastle/lib/status/schema.ts`). The `.js` extension on the import is
 * correct for `tsx`/Bundler resolution.
 */
import {
  SandcastleStatusSchema,
  STATUS_SCHEMA_VERSION,
  STALE_AFTER_MS,
  type SandcastleStatus,
} from "../lib/status/schema.js";

/** Result of attempting to read the status file off disk. */
export type ReadResult =
  | { ok: true; raw: string }
  | { ok: false; kind: "enoent" | "ioerror"; error: unknown };

/** What the banner is telling the user, or `null` for a clean live feed. */
export type Banner =
  | "waiting"
  | "stale"
  | "outdated"
  | "done"
  | "stopped"
  | null;

/** The viewer's render state. `status` is always the last snapshot we trust. */
export type ViewState = {
  status: SandcastleStatus | null;
  banner: Banner;
  lastError?: string;
};

function errMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Fold one read into the next view state. Pure: no IO, no clock — `nowMs` is
 * passed in so staleness is deterministic and testable.
 */
export function reduce(
  prev: ViewState,
  read: ReadResult,
  nowMs: number,
): ViewState {
  // The file does not exist (loop not started yet, or status removed).
  if (!read.ok && read.kind === "enoent") {
    return { status: prev.status, banner: "waiting" };
  }

  // A transient IO error: keep last-good on screen, surface the error.
  if (!read.ok) {
    return {
      status: prev.status,
      // If we already had a status, the feed has gone quiet — call it stale.
      // With nothing yet, we're still waiting for a first good read.
      banner: prev.status ? "stale" : prev.banner ?? "stale",
      lastError: errMessage(read.error),
    };
  }

  // We have raw bytes. Parse defensively — a torn write is normal under polling.
  let obj: unknown;
  try {
    obj = JSON.parse(read.raw);
  } catch {
    // Unparseable (likely a half-written file). Keep last-good, mark stale.
    return { status: prev.status, banner: "stale" };
  }

  // Version check must read the RAW object: the zod schema pins schemaVersion
  // to a literal, so a future-version snapshot would FAIL safeParse and never
  // reach a "version mismatch" branch otherwise. Guard on a real number so a
  // half-written object missing the field falls through to "stale" below.
  const rawVersion = (obj as { schemaVersion?: unknown })?.schemaVersion;
  if (typeof rawVersion === "number" && rawVersion !== STATUS_SCHEMA_VERSION) {
    return { status: prev.status, banner: "outdated" };
  }

  const parsed = SandcastleStatusSchema.safeParse(obj);
  if (!parsed.success) {
    // Valid JSON but not a valid snapshot (torn / partial). Keep last-good.
    return { status: prev.status, banner: "stale" };
  }

  // A good snapshot. Terminal run states are AUTHORITATIVE: the loop told us it
  // finished, so honor that instead of inferring liveness from write-age. A done
  // run stops writing by design and must NOT be relabeled "stale — loop may have
  // stopped". Non-terminal states (running / restarting) can still go stale if
  // the feed stops advancing — a crashed loop, or a hot-reload relaunch that
  // hung. NB: a healthy `running` phase that takes longer than STALE_AFTER_MS
  // also trips this, because the store only writes on transitions (no
  // heartbeat) — that's a worker-side gap, not something the reducer can fix.
  if (parsed.data.state === "done") {
    return { status: parsed.data, banner: "done" };
  }
  if (parsed.data.state === "stopped") {
    return { status: parsed.data, banner: "stopped" };
  }

  const updatedMs = Date.parse(parsed.data.updatedAt);
  const isStale =
    Number.isFinite(updatedMs) && nowMs - updatedMs > STALE_AFTER_MS;

  return { status: parsed.data, banner: isStale ? "stale" : null };
}
