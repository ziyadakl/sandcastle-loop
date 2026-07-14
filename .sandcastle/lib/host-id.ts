// ADR 0019 — cross-host issue lease: host identity + lock TTL config.
import { hostname as osHostname } from "node:os";

/** Default lock lease TTL, in seconds (15 minutes). Used when
 * SANDCASTLE_LOCK_TTL_SEC is unset or invalid. */
export const DEFAULT_LOCK_TTL_SEC = 900;

/** Max length of a sanitized host id, so it stays a tidy branch/ref fragment. */
const MAX_HOST_ID_LEN = 40;

type GetEnv = (key: string) => string | undefined;

/**
 * Sanitize an arbitrary hostname / host-id into a string that is safe to embed
 * in a git branch or ref name: lower-cased, only `[a-z0-9._-]`, no repeated
 * separators, no leading/trailing separators, capped length.
 */
function sanitizeHostId(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-") // any unsafe run → single dash
    .replace(/[-._]{2,}/g, "-") // collapse any run of separators → single dash
    .replace(/^[-._]+|[-._]+$/g, "") // trim leading/trailing separators
    .slice(0, MAX_HOST_ID_LEN);
}

/**
 * Resolve this host's identity for cross-host issue leasing.
 *
 * Uses `SANDCASTLE_HOST_ID` when set to a non-empty (trimmed) value, else falls
 * back to `os.hostname()`. The result is always sanitized to a branch/ref-safe
 * fragment. `getEnv` and `hostname` are injectable seams so tests stay
 * deterministic without touching real process.env / os state.
 */
export function resolveHostId(
  getEnv: GetEnv = (k) => process.env[k],
  hostname: () => string = osHostname,
): string {
  const explicit = (getEnv("SANDCASTLE_HOST_ID") ?? "").trim();
  const raw = explicit !== "" ? explicit : hostname();
  return sanitizeHostId(raw);
}

/**
 * Resolve the lock-lease TTL in seconds. Honors `SANDCASTLE_LOCK_TTL_SEC` when
 * it parses to a positive integer; otherwise falls back to
 * {@link DEFAULT_LOCK_TTL_SEC}. Rejects NaN, non-integers, zero and negatives.
 */
export function resolveLockTtlSec(
  getEnv: GetEnv = (k) => process.env[k],
): number {
  const raw = (getEnv("SANDCASTLE_LOCK_TTL_SEC") ?? "").trim();
  if (raw === "") return DEFAULT_LOCK_TTL_SEC;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_LOCK_TTL_SEC;
  return n;
}
