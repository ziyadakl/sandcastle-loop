/**
 * #1370: a run whose wrapper died before the loop could relaunch (failed
 * install, failed first start) must not keep showing as Live. These tests drive
 * the helper on a real status file, and the script as a real process.
 */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { markRunUnhealthy } from "./mark-unhealthy.js";
import { SandcastleStatusSchema, STATUS_SCHEMA_VERSION } from "./schema.js";

const execFileAsync = promisify(execFile);

function snapshot(state: string): Record<string, unknown> {
  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    state,
    hostId: "host-a",
    runId: "run-1",
    run: {
      branch: "sandcastle/x",
      repo: "r",
      startedAt: "2026-10-13T19:00:00.000Z",
      iterations: { current: 1, total: 2 },
      maxConcurrent: 1,
      tickets: { done: 0, working: 0, waiting: 0, cap: 2 },
    },
    totals: { merged: 0, needsHuman: 0, requeued: 0, running: 0 },
    issues: [],
    history: [],
    updatedAt: "2026-10-13T20:00:00.000Z",
    activity: "building",
    pid: 1,
  };
}

describe("markRunUnhealthy", () => {
  let repo: string;
  let statusPath: string;
  const write = (state: string): void =>
    writeFileSync(statusPath, JSON.stringify(snapshot(state)));
  const read = (): Record<string, unknown> =>
    JSON.parse(readFileSync(statusPath, "utf8"));

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "mark-unhealthy-"));
    mkdirSync(join(repo, ".sandcastle"));
    statusPath = join(repo, ".sandcastle", "status.json");
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it.each(["running", "restarting", "stopping"])(
    "flips a %s run to unhealthy, carries the reason, stays schema-valid",
    async (state) => {
      write(state);
      const result = await markRunUnhealthy({ statusPath, reason: "pnpm install failed" });
      expect(result).toBe("marked");
      const after = read();
      expect(after.state).toBe("unhealthy");
      expect(after.activity).toBe("pnpm install failed");
      expect(after.updatedAt).not.toBe("2026-10-13T20:00:00.000Z");
      expect(SandcastleStatusSchema.safeParse(after).success).toBe(true);
    },
  );

  it.each(["done", "stopped", "unhealthy"])("leaves a %s run untouched", async (state) => {
    write(state);
    const before = readFileSync(statusPath, "utf8");
    expect(await markRunUnhealthy({ statusPath, reason: "x" })).toBe("unchanged");
    expect(readFileSync(statusPath, "utf8")).toBe(before);
  });

  it("does nothing for a missing or torn file", async () => {
    expect(await markRunUnhealthy({ statusPath, reason: "x" })).toBe("unchanged");
    writeFileSync(statusPath, "{ torn");
    expect(await markRunUnhealthy({ statusPath, reason: "x" })).toBe("unchanged");
    expect(readFileSync(statusPath, "utf8")).toBe("{ torn");
  });

  it("publishes the marked snapshot and waits for the push; a push failure still leaves the local write", async () => {
    write("restarting");
    const pushed: unknown[] = [];
    let flushed = false;
    await markRunUnhealthy({
      statusPath,
      reason: "r",
      pusher: {
        push: (s: unknown) => void pushed.push(s),
        flush: async () => void (flushed = true),
      } as never,
    });
    expect(pushed).toHaveLength(1);
    expect((pushed[0] as { state: string }).state).toBe("unhealthy");
    expect(flushed).toBe(true);

    write("running");
    const errors: string[] = [];
    await markRunUnhealthy({
      statusPath,
      reason: "r",
      pusher: {
        push: () => {
          throw new Error("boom");
        },
        flush: async () => {},
      } as never,
      onError: (e) => errors.push((e as Error).message),
    });
    expect(read().state).toBe("unhealthy");
    expect(errors).toEqual(["boom"]);
  });

  it("script: a real process marks the file and exits 0 with push unconfigured; bad flags exit non-zero", async () => {
    write("restarting");
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(env)) {
      if (k.startsWith("VITEST") || k.startsWith("SANDCASTLE_")) delete env[k];
    }
    const script = join(process.cwd(), ".sandcastle", "scripts", "mark-run-unhealthy.mts");
    await execFileAsync(
      "pnpm",
      ["exec", "tsx", script, "--repo-root", repo, "--reason", "install failed"],
      { env, cwd: process.cwd(), timeout: 120_000 },
    );
    expect(read().state).toBe("unhealthy");
    expect(read().activity).toBe("install failed");
    await expect(
      execFileAsync("pnpm", ["exec", "tsx", script, "--bogus"], {
        env,
        cwd: process.cwd(),
        timeout: 120_000,
      }),
    ).rejects.toMatchObject({ code: expect.any(Number) });
  }, 150_000);
});
