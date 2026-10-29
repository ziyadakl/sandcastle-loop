/**
 * The loop's way to shout (Piece G of the screen-check design).
 *
 * This is ONE honest seam, always real, never a placeholder:
 *
 *   1. ALWAYS logs loudly (`logError`, never `log`) — the one part of "fail
 *      loudly" that needs no external service and can never be
 *      misconfigured into silence.
 *   2. ALWAYS attempts a real HTTP push to ntfy, to `https://ntfy.sh/<topic>`
 *      with the topic read from the `NTFY_TOPIC` environment variable. When
 *      `NTFY_TOPIC` is unset the push is skipped and the skip itself is
 *      logged: unset => skip, log why.
 *
 * With no topic set, this alarm takes its skip path every time and never
 * fires; set `NTFY_TOPIC` on the host to receive pushes.
 */

export interface AlarmEvent {
  readonly title: string;
  /** Free-text body — the reason, in plain words, for a human reading a push notification. */
  readonly body: string;
  readonly issueNumber?: number;
}

type FetchLike = typeof fetch;

export interface RaiseAlarmOptions {
  readonly topic?: string;
  readonly fetchImpl?: FetchLike;
  readonly logError: (msg: string) => void;
  /** Default 10s — see the doc comment on {@link ALARM_FETCH_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

export interface RaiseAlarmResult {
  readonly sent: boolean;
  readonly reason?: string;
}

/**
 * Every call site that awaits `raiseAlarm` does so on a ticket's critical
 * path (`.sandcastle/main.mts`'s `reportStop` and the never-settled/
 * picture-not-stored call sites) — a wedged ntfy endpoint with no ceiling
 * would stall that ticket for as long as the socket stays open, on top of
 * the actual failure it's trying to report. 10s is generous for a single
 * small POST and still bounded.
 */
const ALARM_FETCH_TIMEOUT_MS = 10_000;

/**
 * Strips CR/LF from a value about to be interpolated into an HTTP header.
 * No call site is injectable today (`event.title` is always a fixed
 * string literal at the call site, never user/ticket-controlled text), but
 * `event.body` — free text, and `reportStop`'s callers do interpolate
 * ticket-derived detail into it — sits one refactor away from also landing
 * in a header. Cheap enough to apply unconditionally rather than trust
 * that boundary to hold forever.
 */
function stripCrlf(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}

/**
 * Always logs loudly; always attempts the real ntfy push, bounded by
 * {@link ALARM_FETCH_TIMEOUT_MS}. `opts.topic` defaults to
 * `process.env.NTFY_TOPIC` (the same variable the VPS cron alert unit and
 * `cache-recon-cron.ts` read) so production call sites need pass nothing.
 */
export async function raiseAlarm(
  event: AlarmEvent,
  opts: RaiseAlarmOptions,
): Promise<RaiseAlarmResult> {
  const prefix = event.issueNumber !== undefined ? `[issue=${event.issueNumber}] ` : "";
  opts.logError(`ALARM: ${prefix}${event.title} — ${event.body}`);

  const topic = opts.topic ?? process.env.NTFY_TOPIC;
  if (!topic) {
    opts.logError(
      `${prefix}ntfy push skipped: NTFY_TOPIC unset (see docs/reference/vps-setup.md "Notifications")`,
    );
    return { sent: false, reason: "NTFY_TOPIC unset" };
  }

  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`https://ntfy.sh/${topic}`, {
      method: "POST",
      headers: {
        Title: stripCrlf(event.title),
        Priority: "high",
        Tags: "robot,rotating_light",
      },
      body: event.body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? ALARM_FETCH_TIMEOUT_MS),
    });
    if (res.ok) return { sent: true };
    const reason = `ntfy HTTP ${res.status}`;
    opts.logError(`${prefix}ntfy push failed: ${reason}`);
    return { sent: false, reason };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    opts.logError(`${prefix}ntfy push failed: ${reason}`);
    return { sent: false, reason };
  }
}
