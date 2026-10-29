/**
 * Spec #1368 decision 6, the dashboard half: the stamped snapshot must be
 * PUBLISHED, not just written to the local file the loop's next status store
 * replaces. These tests read what the dashboard endpoint received, for both
 * callers: the loop's adapter, and the boot script run as a real process.
 */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SandcastleStatusSchema, STATUS_SCHEMA_VERSION } from "./schema.js";
import { makeStopCauseStamper } from "./stop-cause-stamper.js";

const execFileAsync = promisify(execFile);

const OOM_LOG = "kernel: Out of memory: Killed process 4242 (node)\n";

/** A status file as the real store writes it, with one ticket left in flight. */
function writeInFlightStatus(repoRoot: string): void {
  mkdirSync(join(repoRoot, ".sandcastle"), { recursive: true });
  writeFileSync(
    join(repoRoot, ".sandcastle", "status.json"),
    JSON.stringify({
      schemaVersion: STATUS_SCHEMA_VERSION,
      state: "running",
      hostId: "host-a",
      runId: "run-1",
      run: {
        branch: "sandcastle/x",
        repo: "r",
        startedAt: "2026-10-13T19:00:00.000Z",
        iterations: { current: 1, total: 2 },
        maxConcurrent: 1,
        tickets: { done: 0, working: 1, waiting: 0, cap: 2 },
      },
      totals: { merged: 0, needsHuman: 0, requeued: 0, running: 1 },
      issues: [
        { number: 7, title: "t", branch: "agent/issue-7", phase: "implementer" },
      ],
      history: [],
      updatedAt: "2026-10-13T20:00:00.000Z",
      pid: 1,
    }),
  );
}

describe("stamped stop causes reach the dashboard", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "stamper-"));
    writeInFlightStatus(repo);
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("loop path: the pusher receives the snapshot with issues[].stopCause, flushed before the stamper returns", async () => {
    const received: unknown[] = [];
    const stamp = makeStopCauseStamper({
      repoRoot: repo,
      logError: () => undefined,
      getEnv: (k) =>
        ({
          SANDCASTLE_STATUS_PUSH_URL: "https://dash.example/ingest",
          SANDCASTLE_STATUS_PUSH_TOKEN: "tok",
        })[k],
      fetchFn: (async (_url: unknown, init: { body: string; headers: Record<string, string> }) => {
        // slow endpoint: a stamper that does not await the flush would return first
        await new Promise((r) => setTimeout(r, 50));
        received.push({ body: JSON.parse(init.body), auth: init.headers.Authorization });
        return { ok: true, status: 200 };
      }) as never,
      bootStartedAt: () => new Date("2026-10-13T21:00:00.000Z"),
      previousBootKernelLog: async () => OOM_LOG,
    });
    expect(await stamp()).toEqual([7]);
    expect(received).toHaveLength(1);
    const { body, auth } = received[0] as { body: Record<string, any>; auth: string };
    expect(auth).toBe("Bearer tok");
    expect(body.state).toBe("stopped");
    expect(body.issues[0].stopCause).toBe("out-of-memory");
    expect(SandcastleStatusSchema.safeParse(body).success).toBe(true);
  });

  it("a second run finds nothing in flight and pushes nothing more", async () => {
    const received: unknown[] = [];
    const args = {
      repoRoot: repo,
      logError: () => undefined,
      getEnv: (k: string) =>
        ({
          SANDCASTLE_STATUS_PUSH_URL: "https://dash.example/ingest",
          SANDCASTLE_STATUS_PUSH_TOKEN: "tok",
        })[k],
      fetchFn: (async (_u: unknown, init: { body: string }) => {
        received.push(JSON.parse(init.body));
        return { ok: true, status: 200 };
      }) as never,
      bootStartedAt: () => new Date("2026-10-13T21:00:00.000Z"),
      previousBootKernelLog: async () => "",
    };
    await makeStopCauseStamper(args)();
    expect(received).toHaveLength(1);
    await makeStopCauseStamper(args)(); // second run: already stamped and stopped
    expect(received).toHaveLength(1);
  });

  it("boot script path: a real process loads .sandcastle/.env and pushes the stamped snapshot before exiting", async () => {
    const bodies: Record<string, any>[] = [];
    const server: Server = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        bodies.push(JSON.parse(data));
        res.writeHead(200).end("ok");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as AddressInfo).port;
      writeFileSync(
        join(repo, ".sandcastle", ".env"),
        `SANDCASTLE_STATUS_PUSH_URL=http://127.0.0.1:${port}/ingest\nSANDCASTLE_STATUS_PUSH_TOKEN=tok\n`,
      );
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const k of Object.keys(env)) {
        if (k.startsWith("VITEST") || k.startsWith("SANDCASTLE_")) delete env[k];
      }
      // The real boot facts: this machine booted before the file's 2026-10-13
      // timestamp's successor, so the cause is loop-exited or server-restarted
      // depending on uptime; either way it must be one of the three values.
      const script = join(process.cwd(), ".sandcastle", "scripts", "stamp-stop-cause.mts");
      await execFileAsync("pnpm", ["exec", "tsx", script, "--repo-root", repo], {
        env,
        cwd: process.cwd(),
        timeout: 120_000,
      });
      expect(bodies).toHaveLength(1);
      expect(bodies[0]!.state).toBe("stopped");
      expect(["out-of-memory", "server-restarted", "loop-exited"]).toContain(
        bodies[0]!.issues[0].stopCause,
      );
    } finally {
      server.close();
    }
  }, 150_000);
});
