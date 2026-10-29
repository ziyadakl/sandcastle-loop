/**
 * Boot-time sweep of sandbox containers left by a dead run (spec #1368,
 * decision 2). A container that outlives its loop keeps the agent's secrets in
 * its environment, running or stopped, so the loop removes every
 * `sandcastle-` container when it starts.
 *
 * Safe only when NO other loop runs on this server: the per-checkout lock
 * cannot see a loop in another checkout, and that loop's containers look
 * identical. The server-wide check is the `otherLoopRunning` port
 * (`server-loops.ts`).
 *
 * Pure: every effect is a port, so tests drive it with fakes. The container
 * environment is never read or printed here.
 */

/** Every sandbox container the library starts is named `sandcastle-<uuid>`. */
export const SANDBOX_CONTAINER_PREFIX = "sandcastle-";

export interface LeftoverContainerPorts {
  /** True when a loop process other than ours runs anywhere on this server. */
  otherLoopRunning(): Promise<boolean>;
  /** Names of containers matching `sandcastle-` — running AND stopped. May over-match. */
  listContainerNames(): Promise<readonly string[]>;
  removeContainers(names: readonly string[]): Promise<void>;
}

export interface LeftoverContainerResult {
  readonly removed: readonly string[];
  readonly skipped?: "other-loop-running";
}

export async function reapLeftoverContainers(
  ports: LeftoverContainerPorts,
): Promise<LeftoverContainerResult> {
  if (await ports.otherLoopRunning()) {
    return { removed: [], skipped: "other-loop-running" };
  }
  // Docker's `name=` filter is a substring match; keep only true prefix matches.
  const victims = (await ports.listContainerNames()).filter((n) =>
    n.startsWith(SANDBOX_CONTAINER_PREFIX),
  );
  if (victims.length === 0) return { removed: [] };
  await ports.removeContainers(victims);
  return { removed: victims };
}
