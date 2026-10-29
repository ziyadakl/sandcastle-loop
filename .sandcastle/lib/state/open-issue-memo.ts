/**
 * A short-lived, single-flight memo over ONE expensive read.
 *
 * Built for `listOpenIssuesWithBodies` — the 500-row `gh issue list` the
 * `Blocked-by:` gate runs on. That gate fires twice for every ticket the loop
 * considers: once over the whole plan the moment the planner answers, and then
 * again per card as each worker picks one up seconds later. With eight workers
 * that is nine identical round-trips inside a few seconds, all of them reading
 * a tracker that has not changed.
 *
 * ## Why the TTL is short, and why `invalidate()` exists at all
 *
 * The deal-time half of that gate is the half that matters: a dependent can sit
 * on the dealer's stack while its blocker is claimed out from under it, and the
 * label flip that proves it (`ready-for-agent` → `in-progress`) is one the LOOP
 * ITSELF performs. A memo that served a listing from before that flip would
 * hand the gate the exact stale answer it exists to catch — so the claim site
 * calls {@link Memo.invalidate} the instant it flips a label, and the TTL is
 * only there to collapse the burst between two reads with no claim in between.
 * Time alone is never trusted to notice a change the loop made itself.
 *
 * A failed read caches NOTHING: an error must not be replayed for the rest of
 * the window, and the caller's own retry has to be able to reach `gh` again.
 */

/** How long a successful read may be replayed, absent an explicit invalidate. */
export const OPEN_ISSUE_MEMO_TTL_MS = 15_000;

export interface Memo<T> {
  /** The memoised value: cached, in-flight, or freshly fetched. */
  read(): Promise<T>;
  /** Drop the cached value. Call after ANY write that could change it. */
  invalidate(): void;
}

export function createMemo<T>(
  fetch: () => Promise<T>,
  opts: { readonly ttlMs?: number; readonly now?: () => number } = {},
): Memo<T> {
  const ttlMs = opts.ttlMs ?? OPEN_ISSUE_MEMO_TTL_MS;
  const now = opts.now ?? ((): number => Date.now());
  let cached: { at: number; value: T } | undefined;
  let inFlight: Promise<T> | undefined;

  return {
    async read(): Promise<T> {
      if (cached !== undefined && now() - cached.at < ttlMs) return cached.value;
      // Single flight: several workers hitting an expired memo at the same
      // instant share ONE fetch rather than each starting their own.
      if (inFlight !== undefined) return await inFlight;
      // `Promise.resolve().then(fetch)` rather than calling `fetch()` inline:
      // a `fetch` that throws SYNCHRONOUSLY would otherwise run the settle
      // handlers below before `inFlight` had been assigned, and the cleanup
      // would leave a rejected promise parked there for every later caller.
      const pending = Promise.resolve()
        .then(fetch)
        .then((value) => {
          cached = { at: now(), value };
          return value;
        })
        .catch((err: unknown) => {
          cached = undefined;
          throw err;
        })
        .finally(() => {
          // Cleared via the captured `pending`, never by trusting whatever
          // `inFlight` holds now — by the time this runs another caller may
          // already have started the next one.
          if (inFlight === pending) inFlight = undefined;
        });
      inFlight = pending;
      return await pending;
    },
    invalidate(): void {
      cached = undefined;
    },
  };
}
