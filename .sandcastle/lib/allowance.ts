/**
 * Waiting out an empty account pool (tokenmaxxing build plan 4.5).
 *
 * The loop's agents reach Claude through the account pool (CLIProxyAPI). When
 * every pooled login is out of allowance, retrying on a fallback model or
 * deferring the ticket up to `MAX_DEFERRALS` times only burns the deferral
 * budget and parks good tickets. Nothing can succeed until a login's
 * allowance resets, so the loop waits until the soonest reset instead.
 *
 * ## What the pool sends when every login is out (CLIProxyAPI v8.0.15)
 *
 * - Every login already cooling down: HTTP 429, body
 *   `{"type":"error","error":{"type":"rate_limit_error","message":"All
 *   credentials for model <m> are cooling down via provider <p>"}}`, and a
 *   `Retry-After` header with the seconds to the soonest cooldown end
 *   (`sdk/cliproxy/auth/selector.go:122-162, 349-361, 529-539`;
 *   `sdk/api/handlers/claude/code_handlers.go:448-481`).
 * - The logins running out during this very request: the last upstream 429
 *   is passed through, with no reset hint (`conductor_home.go:283-289`).
 *
 * Claude Code retries a 429 itself and finally prints `API Error: 429 <body>`.
 * Only the body survives into the error the loop sees; the `Retry-After`
 * header does not. So the reset time is read from the pool's management API
 * (`GET /v0/management/auth-files`: per login `unavailable` and
 * `next_retry_after`, `internal/api/handlers/management/auth_files.go:654-726`;
 * plus the Anthropic rate-limit headers it saved per login and per model under
 * `quota.signals` and `model_quotas.<model>.signals`, `:801-836`).
 *
 * How the loop uses this (`main.mts`): the fallback-model retry is skipped on
 * the pool's cooldown answer; the pipeline catch releases the ticket without
 * spending its deferral budget and closes the run's {@link AllowanceGate};
 * every worker waits at the gate before it is dealt another ticket.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { isRateLimitError } from "./error-classification.js";

const COOLDOWN_RE =
  /All credentials for model .+? are cooling down|\bmodel_cooldown\b/i;

/** The pool's own "every login for this model is out" answer. */
export function isPoolCooldownError(msg: string): boolean {
  return COOLDOWN_RE.test(msg);
}

/** Added to a reset time before the loop deals again, so it does not race the
 *  pool's own cooldown clock by a second. */
export const RESET_MARGIN_MS = 30_000;

/**
 * How long to wait when the pool said every login is out but its reset time
 * could not be read (management API unreachable, or the cooldown is per-model
 * and so not visible in the per-login listing). Short on purpose: a re-check
 * that finds the pool still empty costs one fast-failing agent start.
 */
export const FALLBACK_WAIT_MS = 10 * 60_000;

export interface AllowanceWait {
  /** Epoch ms after which the loop may deal again. */
  readonly untilMs: number;
  /** `pool`: read from the pool's per-login state. `fallback`: the pool said
   *  it is empty, but no reset time could be read. */
  readonly source: "pool" | "fallback";
  /** One line for the log. */
  readonly detail: string;
}

interface AuthFileEntry {
  readonly name?: unknown;
  readonly provider?: unknown;
  readonly disabled?: unknown;
  readonly unavailable?: unknown;
  readonly next_retry_after?: unknown;
  readonly quota?: { readonly signals?: unknown };
  readonly model_quotas?: Record<string, { readonly signals?: unknown }>;
}

const WINDOW_UTILIZATION_RE = /^anthropic-ratelimit-unified-(.+)-utilization$/i;

/**
 * When the Anthropic headers the pool saved for a login say a window is used
 * up (`-<window>-utilization` at 1 or more), the latest of those windows'
 * `-<window>-reset` times (unix seconds): every exhausted window must reset
 * before the login serves again. `undefined` when no window is used up.
 * Signal names: CLIProxyAPI keeps every `anthropic-ratelimit-unified-*`
 * response header (`sdk/cliproxy/auth/quota_signals.go`), canonical-cased.
 */
function signalsBackAt(signals: unknown, nowMs: number): number | undefined {
  if (signals === null || typeof signals !== "object") return undefined;
  const byLower = new Map(
    Object.entries(signals as Record<string, unknown>).map(([k, v]) => [
      k.toLowerCase(),
      String(v),
    ]),
  );
  let back: number | undefined;
  for (const [key, value] of byLower) {
    const window = WINDOW_UTILIZATION_RE.exec(key)?.[1];
    if (window === undefined || !(Number(value) >= 1)) continue;
    const resetSec = Number(
      byLower.get(`anthropic-ratelimit-unified-${window}-reset`),
    );
    const resetMs = resetSec * 1000;
    if (!Number.isFinite(resetMs) || resetMs <= nowMs) continue;
    if (back === undefined || resetMs > back) back = resetMs;
  }
  return back;
}

/** When this login can serve `model` again: a future epoch ms, or
 *  `undefined` when it looks usable now. */
function loginBackAt(
  entry: AuthFileEntry,
  model: string | undefined,
  nowMs: number,
): number | undefined {
  if (entry.unavailable === true) {
    const t =
      typeof entry.next_retry_after === "string"
        ? Date.parse(entry.next_retry_after)
        : NaN;
    if (Number.isFinite(t) && t > nowMs) return t;
  }
  const times = [
    signalsBackAt(entry.quota?.signals, nowMs),
    model === undefined
      ? undefined
      : signalsBackAt(entry.model_quotas?.[model]?.signals, nowMs),
  ].filter((t): t is number => t !== undefined);
  return times.length === 0 ? undefined : Math.max(...times);
}

/** The model named in the pool's cooldown answer, if any. */
function cooldownModel(msg: string): string | undefined {
  return /All credentials for model (\S+) are cooling down/i.exec(msg)?.[1];
}

/**
 * The soonest moment any enabled Claude login is back, when every one of them
 * is out. `undefined` when at least one looks usable, or there are none.
 */
function soonestBack(
  reply: unknown,
  model: string | undefined,
  nowMs: number,
): number | undefined {
  const raw = (reply as { files?: unknown } | null)?.files;
  const entries = (Array.isArray(raw) ? raw : []) as AuthFileEntry[];
  let soonest: number | undefined;
  for (const entry of entries) {
    if (entry.provider !== "claude" || entry.disabled === true) continue;
    const back = loginBackAt(entry, model, nowMs);
    if (back === undefined) return undefined;
    if (soonest === undefined || back < soonest) soonest = back;
  }
  return soonest;
}

/**
 * Decide whether an agent's error means every pooled Claude login is out,
 * and if so until when the loop should wait. `null` means "not an empty pool":
 * the caller keeps its ordinary rate-limit handling.
 *
 * Evidence, strongest first: the pool's per-login state says every login is
 * out (wait until the soonest comes back); else the pool's own cooldown answer
 * (wait {@link FALLBACK_WAIT_MS}, then try again); else not an empty pool.
 */
export async function allowanceWait(
  msg: string,
  opts: {
    readonly nowMs: number;
    readonly readAuthFiles?: () => Promise<unknown>;
  },
): Promise<AllowanceWait | null> {
  if (!isRateLimitError(msg)) return null;
  let soonest: number | undefined;
  let readError: string | undefined;
  if (opts.readAuthFiles !== undefined) {
    try {
      soonest = soonestBack(
        await opts.readAuthFiles(),
        cooldownModel(msg),
        opts.nowMs,
      );
    } catch (err) {
      readError = (err as Error).message;
    }
  }
  if (soonest !== undefined) {
    return {
      untilMs: soonest + RESET_MARGIN_MS,
      source: "pool",
      detail: `every pooled Claude login is out; the soonest is back at ${new Date(soonest).toISOString()}`,
    };
  }
  if (!isPoolCooldownError(msg)) return null;
  return {
    untilMs: opts.nowMs + FALLBACK_WAIT_MS,
    source: "fallback",
    detail:
      `the pool answered that every login is cooling down, but no reset time could be read` +
      (readError === undefined ? "" : ` (${readError.slice(0, 200)})`) +
      `; checking again in ${FALLBACK_WAIT_MS / 60_000} minutes`,
  };
}

/** The longest single sleep, so a waiting worker notices a shutdown soon. */
const WAIT_SLICE_MS = 60_000;

export interface AllowanceGate {
  /** Hold every worker until `wait.untilMs` (the latest such time wins). */
  close(wait: AllowanceWait): void;
  /** Resolve once the gate is open again, or as soon as `shouldStop()` is
   *  true. Sleeps in slices of at most a minute. */
  waitWhileClosed(shouldStop: () => boolean): Promise<void>;
}

/**
 * The run-wide "the pool is empty" gate. A ticket whose agent found the pool
 * empty closes it; each worker passes through it before it is dealt another
 * ticket, so no fresh ticket is started (and failed) while nothing can run.
 */
export function createAllowanceGate(deps: {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (line: string) => void;
}): AllowanceGate {
  let untilMs = 0;
  let announced = false;
  return {
    close(wait) {
      if (wait.untilMs <= untilMs) return;
      untilMs = wait.untilMs;
      announced = false;
      deps.log(
        `[allowance] ${wait.detail} — no new ticket is dealt until ${new Date(untilMs).toISOString()} (source: ${wait.source})`,
      );
    },
    async waitWhileClosed(shouldStop) {
      if (deps.now() >= untilMs) return;
      while (!shouldStop()) {
        const left = untilMs - deps.now();
        if (left <= 0) {
          if (!announced) {
            announced = true;
            deps.log(`[allowance] reset time reached — resuming dealing tickets`);
          }
          return;
        }
        await deps.sleep(Math.min(left, WAIT_SLICE_MS));
      }
    },
  };
}

/** Where the pool's management key lives on every machine that runs the loop
 *  (tokenmaxxing ticket #17; chmod 600). */
export const DEFAULT_POOL_KEY_FILE = path.join(
  homedir(),
  ".config/tokenmaxxing/pool-management-key",
);

/**
 * A reader for the pool's per-login state: `GET /v0/management/auth-files` on
 * the same address the agents use (`ANTHROPIC_BASE_URL`). `undefined` when the
 * loop has no pool address, so a loop not on the pool keeps its old handling.
 * The key is read on each call and never appears in an error.
 */
export function poolAuthFilesReader(opts: {
  readonly baseUrl: string | undefined;
  readonly keyFile?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}): (() => Promise<unknown>) | undefined {
  const base = opts.baseUrl?.trim();
  if (!base) return undefined;
  const url = `${base.replace(/\/+$/, "")}/v0/management/auth-files`;
  const doFetch = opts.fetch ?? fetch;
  const keyFile = opts.keyFile ?? DEFAULT_POOL_KEY_FILE;
  return async () => {
    let key: string;
    try {
      key = readFileSync(keyFile, "utf8").trim();
    } catch {
      throw new Error(`pool management key not readable at ${keyFile}`);
    }
    const res = await doFetch(url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    if (!res.ok) throw new Error(`pool management API answered ${res.status} at ${url}`);
    return (await res.json()) as unknown;
  };
}
