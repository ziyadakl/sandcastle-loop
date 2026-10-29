/**
 * Spec #1368 decision 2: at loop start, remove every `sandcastle-` container
 * (running or stopped) left by a dead run, but ONLY when no other loop runs on
 * this server. Driven through the ports (`otherLoopRunning`, `listContainerNames`,
 * `removeContainers`) with fakes, asserting which containers were removed.
 */
import { describe, expect, it } from "vitest";

import {
  reapLeftoverContainers,
  type LeftoverContainerPorts,
} from "./leftover-containers.js";

function fakePorts(opts: {
  otherLoop: boolean;
  names: string[];
  listThrows?: boolean;
}): { ports: LeftoverContainerPorts; removed: string[][] } {
  const removed: string[][] = [];
  return {
    removed,
    ports: {
      otherLoopRunning: async () => opts.otherLoop,
      listContainerNames: async () => {
        if (opts.listThrows) throw new Error("docker down");
        return opts.names;
      },
      removeContainers: async (names) => {
        removed.push([...names]);
      },
    },
  };
}

describe("reapLeftoverContainers", () => {
  it("removes every sandcastle- container, stopped ones included, and keeps anything else", async () => {
    const { ports, removed } = fakePorts({
      otherLoop: false,
      // `docker ps --filter name=` is a substring match, so lookalikes come back too.
      names: ["sandcastle-aaaa", "sandcastle-bbbb", "my-sandcastle-db", "postgres"],
    });
    const result = await reapLeftoverContainers(ports);
    expect(removed).toEqual([["sandcastle-aaaa", "sandcastle-bbbb"]]);
    expect(result).toEqual({ removed: ["sandcastle-aaaa", "sandcastle-bbbb"] });
  });

  it("removes nothing, and does not even list, while another loop runs on the server", async () => {
    const { ports, removed } = fakePorts({ otherLoop: true, names: ["sandcastle-live"] });
    const result = await reapLeftoverContainers(ports);
    expect(removed).toEqual([]);
    expect(result).toEqual({ removed: [], skipped: "other-loop-running" });
  });

  it("makes no remove call when there is nothing to remove", async () => {
    const { ports, removed } = fakePorts({ otherLoop: false, names: ["postgres"] });
    expect(await reapLeftoverContainers(ports)).toEqual({ removed: [] });
    expect(removed).toEqual([]);
  });

  it("a failing docker listing is reported to the caller to log, never swallowed into a removal", async () => {
    const { ports, removed } = fakePorts({ otherLoop: false, names: [], listThrows: true });
    await expect(reapLeftoverContainers(ports)).rejects.toThrow("docker down");
    expect(removed).toEqual([]);
  });
});
