/**
 * Spec #1368 decisions 2, 6 (loop side) and 8, at the outside seam: drive the
 * real `runMain` with the startup hooks faked in `Deps` and assert only what
 * the run DID — what it logged, what the dashboard received, and how many
 * failed attempts a killed agent costs. (Which containers are kept or removed
 * is covered in `lib/containers/leftover-containers.test.ts`.)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { git } from "./__fixtures__/git-repo.js";
import { initRepoWithOrigin, makeArgs, makeDeps, scriptedRun } from "./__fixtures__/scripted-run.mts";
import { STATUS_SCHEMA_VERSION } from "./lib/status/schema.js";
import { makeStopCauseStamper } from "./lib/status/stop-cause-stamper.js";
import { appendRetryAttempt, decideRetry, type RetryAttempt } from "./lib/state/retry-budget.js";
import { runMain, type Deps } from "./main.mts";

const BRANCH = "sandcastle/boot-cleanup";

describe("loop start: leftover containers and stop causes", () => {
  let repo: string;
  let cleanup: () => void;
  beforeEach(() => {
    ({ repo, cleanup } = initRepoWithOrigin("sc-boot-cleanup-"));
    git(repo, "checkout", "-q", "-b", BRANCH);
  });
  afterEach(() => cleanup());

  it("logs every container the start sweep removed", async () => {
    const logs: string[] = [];
    const deps = makeDeps({
      sweepLeftoverContainers: async () => ({ removed: ["sandcastle-a1", "sandcastle-b2"] }),
      log: (m: string) => {
        logs.push(m);
      },
    });
    await runMain(makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 0 }), deps);
    expect(logs.join("\n")).toMatch(/removed 2 leftover sandbox container\(s\): sandcastle-a1, sandcastle-b2/);
  });

  it("a docker failure never stops the loop starting", async () => {
    let reaperRan = false;
    const errors: string[] = [];
    const deps = makeDeps({
      sweepLeftoverContainers: async () => {
        throw new Error("docker down");
      },
      checkpointInflight: async () => {
        reaperRan = true;
        return [];
      },
      logError: (m: string) => {
        errors.push(m);
      },
    });
    await runMain(makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 0 }), deps);
    expect(reaperRan).toBe(true);
    expect(errors.join("\n")).toMatch(/docker down/);
  });

  it("a dry run sweeps no container and stamps no ticket", async () => {
    let touched = 0;
    const deps = makeDeps({
      sweepLeftoverContainers: async () => {
        touched += 1;
        return { removed: [] };
      },
      stampStopCauses: async () => {
        touched += 1;
        return [];
      },
    });
    await runMain(makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 0, dryRun: true }), deps);
    expect(touched).toBe(0);
  });

  it("stamps a previous run's in-flight tickets before the new run writes its own status, and publishes the stamp", async () => {
    const statusPath = path.join(repo, ".sandcastle", "status.json");
    mkdirSync(path.dirname(statusPath), { recursive: true });
    writeFileSync(
      statusPath,
      JSON.stringify({
        schemaVersion: STATUS_SCHEMA_VERSION,
        state: "running",
        hostId: "host-a",
        runId: "run-old",
        run: {
          branch: "sandcastle/old",
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
    const pushed: { state?: string; issues?: { stopCause?: string }[] }[] = [];
    const deps = makeDeps({
      // The real adapter, with only the host facts and the network faked.
      stampStopCauses: makeStopCauseStamper({
        repoRoot: repo,
        logError: () => undefined,
        getEnv: (k) =>
          ({
            SANDCASTLE_STATUS_PUSH_URL: "https://dash.example/ingest",
            SANDCASTLE_STATUS_PUSH_TOKEN: "tok",
          })[k],
        fetchFn: (async (_u: unknown, init: { body: string }) => {
          pushed.push(JSON.parse(init.body));
          return { ok: true, status: 200 };
        }) as never,
        bootStartedAt: () => new Date("2026-10-13T21:00:00.000Z"),
        previousBootKernelLog: async () => "Out of memory: Killed process 1 (node)",
      }),
    });
    await runMain(makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 0 }), deps);
    expect(pushed[0]?.state).toBe("stopped");
    expect(pushed[0]?.issues?.[0]?.stopCause).toBe("out-of-memory");
  });
});

describe("decision 8: a ticket whose agent dies with exit 137 costs exactly one failed attempt", () => {
  let repo: string;
  let cleanup: () => void;
  beforeEach(() => {
    ({ repo, cleanup } = initRepoWithOrigin("sc-exit137-"));
    git(repo, "checkout", "-q", "-b", BRANCH);
  });
  afterEach(() => cleanup());

  it("records one ledger line, and the ticket is not re-counted by the fixer's own death", async () => {
    const body = "A ticket.\n\nTarget: subject exists";
    const row = { number: 801, title: "killed", body, labels: ["ready-for-agent"] as string[] };
    const recorded: RetryAttempt[] = [];
    const { deps } = scriptedRun({
      issueNumber: 801,
      branch: "agent/issue-801",
      // Every agent run dies: the builder, then the fixer on the same dead container.
      answers: { implementer: new Error("claude exited with code 137: Killed") },
      deps: {
        recordRetryAttempt: async (_n: number, a: RetryAttempt) => {
          recorded.push(a);
          row.body = appendRetryAttempt(row.body, a);
          return { decision: decideRetry(row) };
        },
        applyRetryDecision: async () => ({ decision: decideRetry(row) }),
      } as Partial<Deps>,
    });
    await runMain(makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 1 }), deps);
    expect(recorded).toHaveLength(1);
  });
});
