/**
 * Loop-cost ticket 03 — docker-only "stuck implementer" safety net.
 *
 * Defense-in-depth. Tickets 01 (bounded output) and 02 (no background-poll)
 * remove the ACTUAL cause of the runaway 40-minute spins we saw in real
 * telemetry; this is the last-resort net for a session that spins anyway. It
 * detects a demonstrably-stuck agent — the SAME tool called with IDENTICAL
 * args many times in a row (e.g. `Bash: cat e2e.log` polled 19×) — and aborts
 * it cheaply, handing whatever it already committed to the reviewer instead of
 * burning the full iteration budget re-reading a growing context.
 *
 * It is OPT-IN (`--stuck-detector`, default off) and DOCKER-ONLY. The mac-host
 * backend runs `claude --print` with no live structured stream, so this net
 * structurally never wires there. Flag-off is byte-for-byte today's behavior.
 *
 * The detector and the run-orchestration helper here are both PURE and fully
 * unit-tested; the only untested surface is the thin git/SDK wiring in
 * `sandbox-provider.ts`, whose remaining validation (does the SDK's
 * `formattedArgs` actually distinguish a poll from an edit on a live docker
 * run?) is the ticket's documented pre-check.
 */

/**
 * Default consecutive-repeat threshold. N≈5–6 is a high-precision signal: a
 * normal read-then-edit investigation burst varies its args every call and
 * never reaches it, while a poll/retry spin repeats one identical call.
 */
export const STUCK_THRESHOLD = 6;

/**
 * Narrow structural shape of the SDK's `AgentStreamEvent`
 * (`@ai-hero/sandcastle` `index.d.ts`). Declared locally rather than imported
 * so the detector has zero compile coupling to the SDK's discriminated union —
 * we only read `type`/`name`/`formattedArgs`.
 */
export interface StreamEvent {
  readonly type: string;
  readonly name?: string;
  readonly formattedArgs?: string;
  readonly message?: string;
}

export class StuckError extends Error {
  readonly toolName: string;
  readonly repeatCount: number;
  constructor(toolName: string, repeatCount: number) {
    super(
      `implementer stuck: repeated ${toolName} ${repeatCount}× in a row with identical args`,
    );
    this.name = "StuckError";
    this.toolName = toolName;
    this.repeatCount = repeatCount;
  }
}

export interface StuckSignal {
  readonly stuck: boolean;
  readonly toolName: string;
  readonly count: number;
}

/**
 * Stateful per-run detector. Feed it every stream event in order; it returns
 * whether the current consecutive-identical-tool-call streak has reached the
 * threshold.
 *
 * - Only `toolCall` events participate. `text` events (the agent's reasoning
 *   between calls) are IGNORED, not treated as a streak-breaker — otherwise a
 *   poll loop that narrates between polls ("still running…") would never trip.
 * - The streak resets when a tool call with a different name-or-args arrives.
 */
export function createStuckDetector(
  opts: { threshold?: number } = {},
): { record(event: StreamEvent): StuckSignal } {
  const threshold = opts.threshold ?? STUCK_THRESHOLD;
  let lastKey: string | null = null;
  let count = 0;
  return {
    record(event: StreamEvent): StuckSignal {
      if (event.type !== "toolCall") {
        return { stuck: false, toolName: "", count };
      }
      const name = event.name ?? "";
      // NUL-join (a real \0, written as the visible `\0` escape — never a
      // space) so no name/args pair can collide with another: \0 can never
      // appear inside a tool name or its formatted args, so this encoding is
      // injective. A space separator WOULD be ambiguous — name="a b"+args="c"
      // and name="a"+args="b c" would share the key "a b c".
      const key = `${name}\0${event.formattedArgs ?? ""}`;
      if (key === lastKey) {
        count += 1;
      } else {
        lastKey = key;
        count = 1;
      }
      return { stuck: count >= threshold, toolName: name, count };
    },
  };
}

/** Minimal run result the helper produces/passes through — a `RunHandle`. */
export interface StuckRunResult {
  readonly stdout: string;
  readonly commits: readonly { sha: string }[];
  readonly iterations?: readonly {
    readonly sessionFilePath?: string;
    readonly sessionId?: string;
  }[];
  /**
   * Set to `true` only on the graceful result {@link buildStuckResult} builds
   * after a stuck-abort. Downstream `runImplementer` reads it to route the
   * recovered partial work to the reviewer instead of tripping its
   * envelope/skill/no-commit gates (which assume a NORMAL run). Absent/`false`
   * on every ordinary run — flag-off behavior is unchanged.
   */
  readonly stuckAborted?: boolean;
}

export interface StuckDetectionHooks<R extends StuckRunResult> {
  /**
   * Invoke the underlying run. MUST pass `signal` to the agent and call
   * `onEvent` for each stream event. Rejects with `signal.reason` on abort
   * (the SDK's documented contract).
   */
  runOnce(signal: AbortSignal, onEvent: (e: StreamEvent) => void): Promise<R>;
  /** HEAD SHA of the worktree BEFORE the run — the base for commit recovery. */
  captureStartSha(): Promise<string>;
  /** Commits made between `startSha` and the (preserved-on-abort) worktree tip. */
  recoverCommits(startSha: string): Promise<readonly { sha: string }[]>;
  /** Build the graceful result returned after a stuck-abort. */
  buildStuckResult(commits: readonly { sha: string }[], detail: string): R;
  /** The caller's existing abort signal (e.g. the hard-ceiling controller). */
  externalSignal?: AbortSignal;
  threshold?: number;
}

/**
 * Run the agent with a live stuck-detector attached.
 *
 * - Composes the caller's `externalSignal` (hard ceiling) with an internal
 *   stuck-abort controller, so EITHER can cancel the run.
 * - On a stuck spin: aborts, then converts the abort into a GRACEFUL return —
 *   recovers whatever the agent committed and returns it as a normal result so
 *   the pipeline's happy path reviews the partial work. Zero commits →
 *   `commits: []`, which trips the pipeline's existing no-commit quarantine.
 *   The abort therefore never surfaces as a generic throw that would waste a
 *   recovery pass.
 * - An EXTERNAL abort (ceiling) or any genuine error is rethrown untouched.
 */
export async function runWithStuckDetection<R extends StuckRunResult>(
  hooks: StuckDetectionHooks<R>,
): Promise<R> {
  const startSha = await hooks.captureStartSha();
  const controller = new AbortController();
  const detector = createStuckDetector({ threshold: hooks.threshold });
  let stuckErr: StuckError | null = null;

  const signal = hooks.externalSignal
    ? AbortSignal.any([hooks.externalSignal, controller.signal])
    : controller.signal;

  const onEvent = (e: StreamEvent): void => {
    if (stuckErr) return; // already aborting — ignore trailing events
    const { stuck, toolName, count } = detector.record(e);
    if (stuck) {
      stuckErr = new StuckError(toolName, count);
      controller.abort(stuckErr);
    }
  };

  try {
    return await hooks.runOnce(signal, onEvent);
  } catch (err) {
    // Only OUR stuck abort converts to a graceful result. We read the abort
    // reason off our own controller's signal (set to the StuckError by
    // `controller.abort(stuckErr)`): `controller.signal.aborted` is true ONLY
    // when WE aborted — an external-ceiling abort trips the composed signal,
    // not this controller — and the `instanceof StuckError` guard confirms it
    // was the stuck path, independent of exactly what `runOnce` rejected with.
    if (
      controller.signal.aborted &&
      controller.signal.reason instanceof StuckError
    ) {
      const commits = await hooks.recoverCommits(startSha);
      return hooks.buildStuckResult(commits, controller.signal.reason.message);
    }
    throw err;
  }
}
