import { describe, it, expect } from "vitest";
import type { GitRunResult } from "../.sandcastle/lib/state/issue-lease.js";
import { discoverRefPeers } from "../.sandcastle/lib/state/ref-peers.js";

const PREFIX = "refs/sandcastle/status/";

/** Build a fake `run` that returns a fixed ls-remote result. */
function fakeRun(result: Partial<GitRunResult>) {
  const full: GitRunResult = { ok: true, stdout: "", stderr: "", ...result };
  return async (..._args: string[]): Promise<GitRunResult> => full;
}

describe("discoverRefPeers", () => {
  it("parses a multi-line ls-remote and returns the peer suffixes", async () => {
    const stdout = [
      `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\t${PREFIX}alpha`,
      `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\t${PREFIX}beta`,
    ].join("\n");
    const peers = await discoverRefPeers(fakeRun({ stdout }), "origin", PREFIX, "self");
    expect(peers).toEqual(["alpha", "beta"]);
  });

  it("ignores refs that do not match the prefix", async () => {
    const stdout = [
      `1111111111111111111111111111111111111111\trefs/heads/main`,
      `2222222222222222222222222222222222222222\t${PREFIX}gamma`,
      `3333333333333333333333333333333333333333\trefs/sandcastle/lanes/other`,
    ].join("\n");
    const peers = await discoverRefPeers(fakeRun({ stdout }), "origin", PREFIX, "self");
    expect(peers).toEqual(["gamma"]);
  });

  it("excludes this host's own ref", async () => {
    const stdout = [
      `4444444444444444444444444444444444444444\t${PREFIX}self`,
      `5555555555555555555555555555555555555555\t${PREFIX}peer`,
    ].join("\n");
    const peers = await discoverRefPeers(fakeRun({ stdout }), "origin", PREFIX, "self");
    expect(peers).toEqual(["peer"]);
  });

  it("excludes an empty-string peer (a bare prefix ref)", async () => {
    const stdout = [
      `6666666666666666666666666666666666666666\t${PREFIX}`,
      `7777777777777777777777777777777777777777\t${PREFIX}real`,
    ].join("\n");
    const peers = await discoverRefPeers(fakeRun({ stdout }), "origin", PREFIX, "self");
    expect(peers).toEqual(["real"]);
  });

  it("returns [] when ls-remote is not ok", async () => {
    const peers = await discoverRefPeers(
      fakeRun({ ok: false, stdout: `x\t${PREFIX}alpha` }),
      "origin",
      PREFIX,
      "self",
    );
    expect(peers).toEqual([]);
  });

  it("returns [] on empty stdout", async () => {
    const peers = await discoverRefPeers(fakeRun({ stdout: "" }), "origin", PREFIX, "self");
    expect(peers).toEqual([]);
  });
});
