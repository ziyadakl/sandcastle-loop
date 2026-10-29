/**
 * Production adapter for the loop-start container sweep (spec #1368,
 * decision 2): wires `reapLeftoverContainers` to the real process table and
 * Docker. Container environments are never read or logged.
 */
import { execFileSync } from "node:child_process";

import {
  reapLeftoverContainers,
  type LeftoverContainerResult,
} from "./leftover-containers.js";
import { anotherLoopRunsOnThisServer } from "./server-loops.js";

export function sweepLeftoverContainers(): Promise<LeftoverContainerResult> {
  return reapLeftoverContainers({
    otherLoopRunning: async () => anotherLoopRunsOnThisServer(),
    async listContainerNames() {
      // `-a`: stopped containers still hold the agent's secrets. Docker's
      // `name=` filter is a substring match; the sweep keeps true prefixes.
      const out = execFileSync(
        "docker",
        ["ps", "-a", "--filter", "name=^sandcastle-", "--format", "{{.Names}}"],
        { encoding: "utf8", timeout: 30_000 },
      );
      return out.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
    },
    async removeContainers(names) {
      if (names.length === 0) return;
      execFileSync("docker", ["rm", "-f", ...names], {
        encoding: "utf8",
        timeout: 60_000,
        stdio: ["ignore", "ignore", "pipe"],
      });
    },
  });
}
