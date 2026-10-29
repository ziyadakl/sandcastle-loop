/**
 * Best-effort outbound status push (live mission-control feed).
 *
 * The loop already writes `status.json` and publishes a git ref, but both are
 * PULL surfaces: a reader only learns about a change when it next looks, and
 * the ref is only republished once per iteration. Neither ever carries a run's
 * terminal state or its final cost, because those are written after the last
 * publish — which is how a finished run kept rendering as "running / planning"
 * for half an hour, and how a dashboard reported a third of what a run spent.
 *
 * This module closes that gap by pushing each committed snapshot to an HTTP
 * endpoint as it happens. It is wired into `commit()` — the single choke point
 * every mutator already funnels through — so it inherits maximal granularity
 * for free, including the post-`finish()` cost write.
 *
 * THREE HARD RULES, in priority order:
 *
 *   1. NEVER throw into a run. Telemetry must not be able to fail a build. Every
 *      path here swallows, exactly like `status-sync.ts` — the fail-soft lives
 *      INSIDE the module so no call site can forget it.
 *   2. NEVER block. `commit()` is synchronous by contract (see the store header:
 *      making it async reintroduces the torn-write race), so `push()` returns
 *      immediately and the request happens on its own.
 *   3. NEVER pile up. A slow endpoint must not accumulate in-flight requests for
 *      the lifetime of a run, so at most ONE request is in flight and interim
 *      snapshots coalesce into the next send.
 *
 * Disabled unless both `SANDCASTLE_STATUS_PUSH_URL` and
 * `SANDCASTLE_STATUS_PUSH_TOKEN` are set, so an unconfigured host behaves
 * byte-identically to before.
 *
 * ...AND disabled unconditionally under a test runner — see
 * {@link isTestRunner} for why that guard lives HERE and nowhere else.
 */

import type { SandcastleStatus } from "./schema.js";

/** Terminal loop states — these flush immediately, bypassing the coalescer. */
const TERMINAL_STATES: ReadonlySet<string> = new Set([
  "done",
  "stopped",
  "unhealthy",
]);

/**
 * Minimum gap between sends for ordinary updates. Low enough to feel live,
 * high enough that a burst of mutators (a phase change writes several times in
 * quick succession) collapses into one request instead of a stampede.
 */
const COALESCE_MS = 1_000;

/** A hung endpoint must not hold a socket open for the rest of the run. */
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * `history` is append-only and never truncated by the store, so a long run's
 * snapshot grows without bound. The dashboard only renders the most recent
 * entries, so cap what goes over the wire — the on-disk file stays complete.
 */
const MAX_HISTORY = 30;

export interface StatusPusher {
  /** Queue `snapshot` for delivery. Returns immediately; never throws. */
  push(snapshot: SandcastleStatus): void;
  /**
   * Flush any pending snapshot and wait briefly for in-flight work. Called on
   * shutdown so a run's terminal state and final cost actually leave the box.
   * Never throws, never waits longer than the request timeout.
   */
  flush(): Promise<void>;
}

export interface StatusPusherOpts {
  readonly url?: string;
  readonly token?: string;
  /** Injectable for tests. Defaults to global fetch. */
  readonly fetchFn?: typeof fetch;
  /**
   * Env bag for the test-runner guard only (see {@link isTestRunner}).
   * Defaults to `process.env`, so the guard applies whether or not a caller
   * knows this seam exists — that default is the whole point.
   */
  readonly getEnv?: (k: string) => string | undefined;
  /** Best-effort log sink; failures here are swallowed too. */
  readonly logError?: (line: string) => void;
  /** Injectable clock, ms. */
  readonly nowMs?: () => number;
  /** Minimum ms between ordinary sends. */
  readonly coalesceMs?: number;
}

/**
 * Is this process a test run?
 *
 * WHY THIS EXISTS, AND WHY IT IS A DETECTOR RATHER THAN AN OPT-IN OR AN
 * INJECTION.
 *
 * The project's own suite calls the real `runMain`, which builds a real pusher
 * from the real environment. Agents run that suite INSIDE the loop's sandbox
 * container, which inherits the orchestrator's env — including both push
 * variables — so every such test run POSTed genuine-looking snapshots to the
 * owner's live dashboard. `os.hostname()` in a container is the container id,
 * so each run landed as a brand-new machine, and the circuit-breaker tests end
 * `unhealthy` — a TERMINAL state, which bypasses the coalescer and flushes
 * immediately. Six phantom machines were polluting the dashboard's totals.
 *
 * The three candidate fixes are not equivalent:
 *
 *   - Inject a null pusher from the tests. Rejected: `runMain` constructs its
 *     pusher internally and its `Deps` seam carries no telemetry, so this means
 *     a NEW seam that every future test must remember to pass. The one test
 *     that forgets is the one that publishes.
 *   - Require an explicit opt-in env var to push. Rejected for the mirror-image
 *     reason: it moves the burden onto the REAL hosts. A var that must be
 *     present for telemetry to work is a var that will be missing after the
 *     next box rebuild, and the failure is silent.
 *   - Detect the runner (this). The suppression lives inside the module every
 *     push path already funnels through, keyed on a variable vitest sets by
 *     itself in every worker. A new test file inherits it with no knowledge and
 *     no ceremony, a new production host inherits nothing at all, and there is
 *     no call site that can forget it — which is the requirement.
 *
 * Keyed on `VITEST` / `VITEST_WORKER_ID` specifically, not on `NODE_ENV`:
 * `NODE_ENV=test` is a value someone could plausibly set on a real host, and
 * silently muting a live host's telemetry is the failure this must not trade
 * itself for.
 */
export function isTestRunner(
  getEnv: (k: string) => string | undefined = (k) => process.env[k],
): boolean {
  return (
    (getEnv("VITEST") ?? "").trim() !== "" ||
    (getEnv("VITEST_WORKER_ID") ?? "").trim() !== ""
  );
}

/** Read config from an env bag. Returns undefined members when unset. */
export function pushConfigFromEnv(getEnv: (k: string) => string | undefined): {
  url?: string;
  token?: string;
} {
  // Primary guard. This is the ONLY route from the real environment to a live
  // pusher (`main.mts` spreads this straight into `createStatusPusher`), so
  // reporting "unconfigured" here disables push for the whole process without
  // touching what a configured production host does — same bag, no VITEST, same
  // two values as before.
  if (isTestRunner(getEnv)) return {};

  const url = (getEnv("SANDCASTLE_STATUS_PUSH_URL") ?? "").trim();
  const token = (getEnv("SANDCASTLE_STATUS_PUSH_TOKEN") ?? "").trim();
  return {
    url: url.length > 0 ? url : undefined,
    token: token.length > 0 ? token : undefined,
  };
}

/**
 * Shrink a snapshot to what a live dashboard actually renders. Pure — the
 * caller's object is never mutated, because `status` is the store's live
 * working object and trimming it in place would corrupt the on-disk file.
 */
export function trimForPush(snapshot: SandcastleStatus): SandcastleStatus {
  const history = snapshot.history ?? [];
  if (history.length <= MAX_HISTORY) return snapshot;
  return { ...snapshot, history: history.slice(-MAX_HISTORY) };
}

/**
 * A no-op pusher. Returned when push is unconfigured so call sites stay
 * branch-free and the disabled path costs nothing.
 */
export function nullPusher(): StatusPusher {
  return {
    push(): void {},
    async flush(): Promise<void> {},
  };
}

export function createStatusPusher(opts: StatusPusherOpts): StatusPusher {
  const { url, token } = opts;
  if (url === undefined || token === undefined) return nullPusher();

  // Backstop for the guard in `pushConfigFromEnv`, so a FUTURE call site that
  // assembles a URL and token some other way still cannot reach the network
  // from a test. Scoped to "no `fetchFn` was injected": a test that hands in a
  // fetch double is by definition exercising this module, not the dashboard,
  // and those tests keep working untouched. Anything under vitest that would
  // have used the process's real `fetch` gets a no-op instead.
  if (opts.fetchFn === undefined && isTestRunner(opts.getEnv)) {
    return nullPusher();
  }

  // Re-bind post-guard: `send` is a hoisted function declaration, so TS does
  // not carry the narrowing above into its body.
  const endpoint: string = url;
  const bearer: string = token;

  const fetchFn = opts.fetchFn ?? fetch;
  const logError = opts.logError ?? ((): void => {});
  const nowMs = opts.nowMs ?? ((): number => Date.now());
  const coalesceMs = opts.coalesceMs ?? COALESCE_MS;

  // The latest snapshot we have been handed but not yet delivered. Newer always
  // replaces older — a stale intermediate state has no value to a live view.
  let pending: SandcastleStatus | undefined;
  let inFlight: Promise<void> | undefined;
  let lastSentAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Logged once per run, not per failure: a dashboard that is down would
  // otherwise flood the run log with identical lines.
  let warned = false;

  function warnOnce(line: string): void {
    if (warned) return;
    warned = true;
    try {
      logError(`[status-push] ${line} — continuing (telemetry only)`);
    } catch {
      // never fail a run over telemetry, not even the error log
    }
  }

  async function send(snapshot: SandcastleStatus): Promise<void> {
    // AbortSignal.timeout is not available on every runtime the loop runs on,
    // so fall back to a manual controller rather than crashing at import time.
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetchFn(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify(trimForPush(snapshot)),
        signal: controller.signal,
      });
      if (!res.ok) warnOnce(`endpoint returned ${res.status}`);
    } catch (err) {
      warnOnce((err as Error)?.message ?? "request failed");
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * Drain the pending snapshot. Loops rather than recursing so that a snapshot
   * queued WHILE a request was in flight is still delivered — otherwise the
   * final state of a run could be dropped precisely because the previous send
   * was slow.
   */
  async function drain(): Promise<void> {
    while (pending !== undefined) {
      const next = pending;
      pending = undefined;
      lastSentAt = nowMs();
      await send(next);
    }
  }

  function schedule(immediate: boolean): void {
    if (inFlight !== undefined) return; // drain() will pick `pending` up
    const since = nowMs() - lastSentAt;
    const wait = immediate ? 0 : Math.max(0, coalesceMs - since);

    if (wait === 0) {
      inFlight = drain().finally(() => {
        inFlight = undefined;
        // A snapshot may have arrived during the final await.
        if (pending !== undefined) schedule(false);
      });
      return;
    }
    if (timer !== undefined) return; // already waiting out the coalesce window
    timer = setTimeout(() => {
      timer = undefined;
      schedule(true);
    }, wait);
    // Never hold the process open for a telemetry timer.
    (timer as { unref?: () => void })?.unref?.();
  }

  return {
    push(snapshot: SandcastleStatus): void {
      try {
        pending = snapshot;
        // A terminal state carries the run's final cost and outcome — the two
        // things the pull surfaces structurally cannot show. Never let it sit
        // in a coalesce window it might not survive.
        schedule(TERMINAL_STATES.has(snapshot.state));
      } catch {
        // push() is called from a synchronous commit(); it must be inert.
      }
    },

    async flush(): Promise<void> {
      try {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        if (pending !== undefined) schedule(true);
        if (inFlight !== undefined) await inFlight;
      } catch {
        // shutdown must not fail over telemetry
      }
    },
  };
}
