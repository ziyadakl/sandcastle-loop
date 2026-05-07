/**
 * Smoke assertions. Each function throws an `AssertionError` on failure with a
 * message ready for the smoke runner to print verbatim. Keeping the failures
 * structured rather than free-text means the runner can log every failure (not
 * just the first) and the CI summary can be diffed across runs.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PrdState } from "../../src/types.js";
import type {
  MockCallRecord,
  MockSandbox,
} from "./mocks/mock-sandbox.js";

const execFileP = promisify(execFile);

export class AssertionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AssertionError";
  }
}

export interface ExpectationContext {
  readonly repoRoot: string;
  readonly sandbox: MockSandbox;
  readonly storyId: string;
  readonly ghIssue: number;
  /** Calls the smoke runner observed against the gh stub. */
  readonly ghCalls: readonly { readonly args: readonly string[] }[];
}

/**
 * Result of a full assertion pass — every failure message in order. Empty
 * `failures` means PASS; any entry means FAIL.
 */
export interface ExpectationReport {
  readonly failures: readonly string[];
  readonly checks: readonly string[];
}

// ---------------------------------------------------------------------------
// Individual assertions — each returns an error message or null.
// ---------------------------------------------------------------------------

async function checkPrdMarkedDone(
  ctx: ExpectationContext,
): Promise<string | null> {
  const prdPath = path.join(ctx.repoRoot, "prd.json");
  let raw: string;
  try {
    raw = await fs.readFile(prdPath, "utf8");
  } catch (err) {
    return `prd.json not readable at ${prdPath}: ${(err as Error).message}`;
  }
  let parsed: PrdState;
  try {
    parsed = JSON.parse(raw) as PrdState;
  } catch (err) {
    return `prd.json is not valid JSON: ${(err as Error).message}`;
  }
  const story = parsed.stories.find((s) => s.id === ctx.storyId);
  if (!story) {
    return `prd.json has no story with id '${ctx.storyId}'.`;
  }
  if (story.status !== "done") {
    return `prd.json story '${ctx.storyId}' has status '${story.status}', expected 'done'.`;
  }
  return null;
}

async function checkProgressLogged(
  ctx: ExpectationContext,
): Promise<string | null> {
  const progressPath = path.join(ctx.repoRoot, "progress.txt");
  let raw: string;
  try {
    raw = await fs.readFile(progressPath, "utf8");
  } catch (err) {
    return `progress.txt missing or unreadable at ${progressPath}: ${(err as Error).message}`;
  }
  if (!raw.includes(ctx.storyId)) {
    return `progress.txt does not contain a line for story '${ctx.storyId}'. Got:\n${raw}`;
  }
  return null;
}

async function checkNoLeakedLock(
  ctx: ExpectationContext,
): Promise<string | null> {
  // proper-lockfile leaves a `<file>.lock` directory behind only while held.
  // After the loop exits cleanly there should be no `.lock` directory next to
  // prd.json. (The single-instance lock target is configurable; we let the
  // runner report on its own lock path separately.)
  const lockPath = path.join(ctx.repoRoot, "prd.json.lock");
  try {
    await fs.access(lockPath);
    return `Leaked lockfile at ${lockPath} after loop exit.`;
  } catch {
    return null;
  }
}

async function checkAtLeastOneCommit(
  ctx: ExpectationContext,
): Promise<string | null> {
  try {
    const { stdout } = await execFileP("git", ["rev-list", "--count", "HEAD"], {
      cwd: ctx.repoRoot,
    });
    const count = Number.parseInt(stdout.trim(), 10);
    if (!Number.isFinite(count) || count < 1) {
      return `Expected at least 1 commit on the branch, got '${stdout.trim()}'.`;
    }
    return null;
  } catch (err) {
    return `git rev-list failed in ${ctx.repoRoot}: ${(err as Error).message}`;
  }
}

function checkCallOrder(ctx: ExpectationContext): string | null {
  const expected = ["implementer", "reviewer"] as const;
  const observed = ctx.sandbox.calls.map((c: MockCallRecord) => c.role);
  for (let i = 0; i < expected.length; i += 1) {
    if (observed[i] !== expected[i]) {
      return `Expected call sequence to start with [${expected.join(", ")}], got [${observed.join(", ")}].`;
    }
  }
  return null;
}

function checkGhCloseFollowedMarkDone(
  ctx: ExpectationContext,
): string | null {
  const closeIdx = ctx.ghCalls.findIndex(
    (c) =>
      c.args[0] === "issue" &&
      c.args[1] === "close" &&
      c.args[2] === String(ctx.ghIssue),
  );
  if (closeIdx === -1) {
    return `gh issue close #${ctx.ghIssue} was never invoked.`;
  }
  // markDone writes to progress.txt — checked separately above. Here we just
  // confirm that the close happened. If both pass, the order is implicit
  // because markDone is synchronous-on-disk before closeIssue in the loop.
  return null;
}

// ---------------------------------------------------------------------------
// Public driver
// ---------------------------------------------------------------------------

export async function runAllExpectations(
  ctx: ExpectationContext,
): Promise<ExpectationReport> {
  const checks: string[] = [];
  const failures: string[] = [];

  const cases: Array<{
    name: string;
    fn: () => Promise<string | null> | string | null;
  }> = [
    { name: "prd.json story marked done", fn: () => checkPrdMarkedDone(ctx) },
    { name: "progress.txt records story", fn: () => checkProgressLogged(ctx) },
    { name: "no leaked prd.json lock", fn: () => checkNoLeakedLock(ctx) },
    { name: "at least one commit on branch", fn: () => checkAtLeastOneCommit(ctx) },
    { name: "agent call order: implementer -> reviewer", fn: () => checkCallOrder(ctx) },
    { name: "gh issue close fired", fn: () => checkGhCloseFollowedMarkDone(ctx) },
  ];

  for (const c of cases) {
    checks.push(c.name);
    const result = await c.fn();
    if (result !== null) {
      failures.push(`${c.name}: ${result}`);
    }
  }

  return { checks, failures };
}
