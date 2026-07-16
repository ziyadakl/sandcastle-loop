/**
 * Per-host outcome model + formatter for the multi-host commands.
 *
 * Each host a multi-host command touches produces exactly one {@link HostResult}.
 * The seven outcomes below cover the safety-gate decisions: either the loop was
 * launched on that host, or it was skipped for one specific reason.
 */

export type HostOutcome =
  | "launched"
  | "unreachable"
  | "already-running"
  | "dirty-tree"
  | "diverged"
  | "auth-failed"
  | "preflight-error";

export interface HostResult {
  readonly host: string; // HostConfig.name
  readonly outcome: HostOutcome;
  readonly detail?: string; // optional extra context (error text, branch, etc.)
}

/** True iff the loop was actually launched on this host. */
export function isLaunched(r: HostResult): boolean {
  return r.outcome === "launched";
}

/**
 * A stable, human one-liner for a single host result, e.g.
 *   `hub: launched`
 *   `hub: skipped (dirty-tree)`
 *   `hub: skipped (diverged) — local commits not on origin`
 *
 * The switch is exhaustive over {@link HostOutcome}; the `never` default makes
 * adding a new outcome a compile error until it's handled here.
 */
export function formatHostResult(r: HostResult): string {
  let body: string;
  switch (r.outcome) {
    case "launched":
      body = "launched";
      break;
    case "unreachable":
    case "already-running":
    case "dirty-tree":
    case "diverged":
    case "auth-failed":
    case "preflight-error":
      body = `skipped (${r.outcome})`;
      break;
    default: {
      const _exhaustive: never = r.outcome;
      return _exhaustive;
    }
  }

  const line = `${r.host}: ${body}`;
  return r.detail ? `${line} — ${r.detail}` : line;
}

/**
 * Newline-joined per-host lines plus a trailing summary line, e.g.
 *   `1 launched, 2 skipped`.
 */
export function formatHostResults(rs: HostResult[]): string {
  const launched = rs.filter(isLaunched).length;
  const skipped = rs.length - launched;
  const summary = `${launched} launched, ${skipped} skipped`;
  const lines = rs.map(formatHostResult);
  return [...lines, summary].join("\n");
}
