/**
 * prd.json state machine — atomic claim/release/mark-done/quarantine.
 *
 * The bash original (refs/claim-story.sh.local-fork, refs/mark-done.sh.local-fork,
 * refs/afk-ralph.sh.local-fork ~L162-187 quarantine_story) used `flock -x 200`
 * with strict env-var passthrough into jq to avoid shell-injection on the reason
 * string. In TypeScript we don't shell out for the mutation — we read, mutate
 * the in-memory object, and atomically rename a temp file — so the injection
 * vector is gone by construction. The lock semantics are preserved via
 * `proper-lockfile` on prd.json itself.
 *
 * Schema is validated locally with Zod (intentionally not imported from Track B's
 * src/verdicts/ — prd.json is a user-land file format, separate concern from
 * agent verdict schemas).
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { PrdState, Story, StoryStatus } from "../types.js";
import { withPrdLock } from "./locks.js";
import { transitionLabel } from "./gh.js";

// --- Zod schema (local — see header) -------------------------------------

const StoryStatusSchema = z.enum([
  "pending",
  "in_progress",
  "done",
  "quarantined",
  // bash driver writes "needs_human" for quarantines; both are accepted on
  // read, new TS-side quarantine writes use "needs_human" to match bash.
  "needs_human",
]);

// .passthrough() preserves any unknown bash-era keys on round-trip so we don't
// silently strip fields the bash driver may have written that we don't model
// yet.
const StorySchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    status: StoryStatusSchema,
    ghIssue: z.number().int().positive().optional(),
    attempts: z.number().int().nonnegative().optional(),
    quarantinedAt: z.string().optional(),
    quarantineReason: z.string().optional(),
    claimedBy: z.string().optional(),
    claimedAt: z.string().optional(),
    blockedBy: z.array(z.string()).optional(),
  })
  .passthrough();

const PrdStateSchema = z
  .object({
    stories: z.array(StorySchema),
  })
  .passthrough();

// --- Path helpers --------------------------------------------------------

function prdPath(repoRoot: string): string {
  return path.join(repoRoot, "prd.json");
}

function progressPath(repoRoot: string): string {
  return path.join(repoRoot, "progress.txt");
}

// --- I/O helpers ---------------------------------------------------------

async function readPrd(repoRoot: string): Promise<PrdState> {
  const raw = await fs.readFile(prdPath(repoRoot), "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `prd.json at ${prdPath(repoRoot)} is not valid JSON: ${
        (err as Error).message
      }`,
    );
  }
  const result = PrdStateSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `prd.json at ${prdPath(repoRoot)} failed schema validation: ${result.error.message}`,
    );
  }
  // Cast through unknown — Zod's inferred type is structurally identical to PrdState
  // but TS doesn't know that, and we don't want to re-export the Zod types.
  return result.data as unknown as PrdState;
}

async function writePrdAtomic(
  repoRoot: string,
  state: PrdState,
): Promise<void> {
  const target = prdPath(repoRoot);
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  const body = `${JSON.stringify(state, null, 2)}\n`;
  await fs.writeFile(tmp, body, "utf8");
  await fs.rename(tmp, target);
}

// --- Public API ----------------------------------------------------------

/**
 * Read prd.json from disk and validate. NOT lock-protected on its own —
 * callers that need a consistent read+write cycle wrap with `withPrdLock`.
 */
export async function loadPrd(repoRoot: string): Promise<PrdState> {
  return readPrd(repoRoot);
}

/**
 * Atomically claim a specific story by id. Throws if the story doesn't exist
 * or isn't pending. Mutates status -> in_progress, transitions GH label if
 * ghIssue is set, returns the updated story.
 */
export async function claimStory(
  repoRoot: string,
  storyId: string,
): Promise<Story> {
  return withPrdLock(repoRoot, async () => {
    const state = await readPrd(repoRoot);
    const story = state.stories.find((s) => s.id === storyId);
    if (!story) {
      throw new Error(`claimStory: story id '${storyId}' not found in prd.json`);
    }
    if (story.status !== "pending") {
      throw new Error(
        `claimStory: story '${storyId}' has status '${story.status}', expected 'pending'`,
      );
    }
    story.status = "in_progress";
    await writePrdAtomic(repoRoot, state);

    if (typeof story.ghIssue === "number") {
      // GH transition is best-effort outside the on-disk write — if it fails,
      // the on-disk claim still stands (loop driver detects label drift in
      // recovery). We do NOT swallow the error from prd.json itself; that's
      // the source of truth.
      await transitionLabel(story.ghIssue, "ready-for-agent", "in-progress");
    }
    // Return a defensive copy so callers can't mutate our cached state.
    return { ...story };
  });
}

/**
 * Find the first eligible pending story, claim it, return it. Returns null if
 * no pending stories are eligible. A pending story is eligible when its
 * `blockedBy` array is empty/absent OR every story it lists is `done` in the
 * same prd state. The whole operation runs under a single lock so two
 * concurrent loops can't pick the same story.
 *
 * Mirrors bash `pick_next_story` semantics: a `blockedBy` reference to an
 * unknown story id is a data error — log and skip the candidate; do NOT throw,
 * because one bad story shouldn't stall the entire loop.
 */
export async function pickNextEligibleStory(
  repoRoot: string,
): Promise<Story | null> {
  return withPrdLock(repoRoot, async () => {
    const state = await readPrd(repoRoot);

    // Build a status lookup once so eligibility checks are O(1) per blocker.
    const statusById = new Map<string, StoryStatus>();
    for (const s of state.stories) {
      statusById.set(s.id, s.status);
    }

    const isEligible = (s: Story): boolean => {
      if (s.status !== "pending") return false;
      if (!s.blockedBy || s.blockedBy.length === 0) return true;
      for (const blockerId of s.blockedBy) {
        const blockerStatus = statusById.get(blockerId);
        if (blockerStatus === undefined) {
          // Data error: blockedBy points at a non-existent story id. Log and
          // skip this candidate rather than throwing — one bad row shouldn't
          // kill the whole loop.
          console.error(
            `pickNextEligibleStory: story '${s.id}' has blockedBy reference to unknown story id '${blockerId}' — skipping candidate`,
          );
          return false;
        }
        if (blockerStatus !== "done") return false;
      }
      return true;
    };

    const story = state.stories.find(isEligible);
    if (!story) {
      return null;
    }
    story.status = "in_progress";
    await writePrdAtomic(repoRoot, state);

    if (typeof story.ghIssue === "number") {
      await transitionLabel(story.ghIssue, "ready-for-agent", "in-progress");
    }
    return { ...story };
  });
}

/**
 * Release a previously-claimed story back to pending. Used by recovery /
 * cleanup paths when the loop dies mid-iteration.
 */
export async function releaseStory(
  repoRoot: string,
  storyId: string,
): Promise<void> {
  await withPrdLock(repoRoot, async () => {
    const state = await readPrd(repoRoot);
    const story = state.stories.find((s) => s.id === storyId);
    if (!story) {
      throw new Error(
        `releaseStory: story id '${storyId}' not found in prd.json`,
      );
    }
    if (
      story.status === "done" ||
      story.status === "quarantined" ||
      story.status === "needs_human"
    ) {
      // Releasing a completed/quarantined story is a programming error — fail loud.
      throw new Error(
        `releaseStory: refusing to release story '${storyId}' with status '${story.status}'`,
      );
    }
    story.status = "pending";
    await writePrdAtomic(repoRoot, state);
  });
}

/**
 * Mark a story done. Appends a line to progress.txt. Does NOT close the GH
 * issue — Track C's loop driver calls `closeIssue` separately after this.
 *
 * The progress line format mirrors the bash original's convention:
 *   `[it=N] {id} — {summary}`
 * where summary is supplied by the loop driver (commit subject, e2e marker, etc).
 */
export async function markDone(
  repoRoot: string,
  storyId: string,
  commitSha: string,
  iterNum?: number,
  summary?: string,
): Promise<void> {
  await withPrdLock(repoRoot, async () => {
    const state = await readPrd(repoRoot);
    const story = state.stories.find((s) => s.id === storyId);
    if (!story) {
      throw new Error(`markDone: story id '${storyId}' not found in prd.json`);
    }
    story.status = "done" satisfies StoryStatus;
    await writePrdAtomic(repoRoot, state);

    const itTag = typeof iterNum === "number" ? `[it=${iterNum}]` : "[it=?]";
    const summaryText = summary ?? story.title;
    const line = `${itTag} ${storyId} — ${summaryText} (commit ${commitSha})\n`;
    await fs.appendFile(progressPath(repoRoot), line, "utf8");
  });
}

/**
 * Move a story to the `quarantined` terminal state, recording why and how
 * many attempts it took. Mirrors the bash quarantine_story shape but without
 * the env-var-passthrough-into-jq dance — the bash version needed that to
 * defend against shell-metacharacter injection in the reason string when
 * passing it to `jq` via `--arg`. In TS we mutate the parsed object directly,
 * so the reason can be any string with zero escaping concerns.
 *
 * Also transitions the GH label to "quarantine" if ghIssue is set.
 */
export async function quarantineStoryInPrd(
  repoRoot: string,
  storyId: string,
  reason: string,
  attempts: number,
): Promise<void> {
  const ghIssueToTransition = await withPrdLock(repoRoot, async () => {
    const state = await readPrd(repoRoot);
    const story = state.stories.find((s) => s.id === storyId);
    if (!story) {
      throw new Error(
        `quarantineStoryInPrd: story id '${storyId}' not found in prd.json`,
      );
    }
    // Match bash quarantine_story: write "needs_human" (not "quarantined")
    // and clear any prior claim so a stale hostname/timestamp doesn't linger
    // on a quarantined record.
    story.status = "needs_human";
    story.quarantineReason = reason;
    story.attempts = attempts;
    story.quarantinedAt = new Date().toISOString();
    story.claimedBy = undefined;
    story.claimedAt = undefined;
    await writePrdAtomic(repoRoot, state);
    return story.ghIssue;
  });

  if (typeof ghIssueToTransition === "number") {
    // "*" means "we don't know the prior label, just add quarantine"
    await transitionLabel(ghIssueToTransition, "*", "quarantine");
  }
}
