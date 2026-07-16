/**
 * Shared ref-peer discovery for the cross-host transports (ADR 0019 / 0020).
 *
 * Both {@link ./status-sync.ts}'s `fetchPeers` and {@link ./lane-sync.ts}'s
 * `discoverPeers` list peer hostIds by `ls-remote`-ing a `refs/sandcastle/<ns>/*`
 * namespace and stripping the prefix off each matching ref. The parse loop was
 * line-for-line identical apart from the prefix constant, so it lives here once.
 *
 * FAIL-SOFT on discovery: a non-ok `ls-remote` returns `[]` (discovery must
 * never crash a cycle). This intentionally does NOT wrap the runner in a
 * try/catch — a thrown runner propagates so each caller keeps its own surrounding
 * fault policy (status-sync's outer catch vs lane-sync's throw-on-write).
 */

import type { GitRunResult } from "./issue-lease.js";

/** A repo-bound git runner: `run(...args)` shells out with a fixed cwd. */
type RefRunner = (...args: string[]) => GitRunResult | Promise<GitRunResult>;

/**
 * List peer hostIds that have published a ref under `prefix` on `remote`,
 * EXCLUDING `selfHostId` (and any empty/bare-prefix ref). Returns `[]` on a
 * non-ok `ls-remote`.
 */
export async function discoverRefPeers(
  run: RefRunner,
  remote: string,
  prefix: string,
  selfHostId: string,
): Promise<string[]> {
  const ls = await run("ls-remote", remote, `${prefix}*`);
  if (!ls.ok) return [];
  const peers: string[] = [];
  for (const line of ls.stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const ref = trimmed.split(/\s+/)[1];
    if (!ref || !ref.startsWith(prefix)) continue;
    const peer = ref.slice(prefix.length);
    if (peer === "" || peer === selfHostId) continue;
    peers.push(peer);
  }
  return peers;
}
