/**
 * Lock primitives.
 *
 * - `withPrdLock` — per-mutation prd.json lock. proper-lockfile creates
 *   `prd.json.lock` adjacent to prd.json itself, retries with backoff if
 *   another process holds it. NEVER swallows acquisition failures — the bash
 *   original's `|| true` was a known correctness bug.
 *
 * - `withSingleInstance` — top-level driver lock. One loop per repo,
 *   stale-after-60s so a crash doesn't permanently wedge restarts.
 *
 * Both wrap the body in try/finally so the lock is always released, even
 * when the body throws.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as lockfile from "proper-lockfile";

/**
 * Run `fn` while holding an exclusive lock on the prd.json at `repoRoot`.
 * Uses proper-lockfile with a small retry budget so a contended write
 * yields rather than instantly throwing. The .lock file lives at
 * `<repoRoot>/prd.json.lock` (proper-lockfile's default convention).
 *
 * Lock-acquisition failures propagate — callers MUST handle them.
 */
export async function withPrdLock<T>(
  repoRoot: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prdJson = path.join(repoRoot, "prd.json");
  // proper-lockfile will throw ENOENT on a missing target; that's the caller's
  // bug to fix (no prd.json = no claim). We don't pre-create it here.
  const release = await lockfile.lock(prdJson, {
    realpath: false,
    retries: { retries: 5, factor: 1.2, minTimeout: 50, maxTimeout: 500 },
    stale: 30_000,
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}

/**
 * Top-level driver wrapper. Acquires an exclusive lock on `lockPath` for the
 * duration of `fn`. If another loop is already running against the same path,
 * throws a clear error rather than waiting (no retries).
 *
 * `stale: 60_000` so a previous-loop crash doesn't permanently block restarts;
 * proper-lockfile reclaims the lock after 60s of staleness.
 */
export async function withSingleInstance<T>(
  lockPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  // proper-lockfile requires the locked file to exist. If lockPath doesn't
  // exist, create it as an empty marker so we have something stable to lock.
  await ensureFileExists(lockPath);

  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(lockPath, {
      realpath: false,
      retries: 0,
      stale: 60_000,
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOCKED") {
      throw new Error(
        `withSingleInstance: another loop is running (lock at ${lockPath} is held). Stop the other loop or wait for it to finish.`,
      );
    }
    throw err;
  }
  try {
    return await fn();
  } finally {
    await release();
  }
}

/**
 * Acquire the same single-instance lock as `withSingleInstance` but return
 * the release function so the caller can manage lifetime manually. Use this
 * when wrapping the entire body of a long-running driver (e.g. `runMain`)
 * in `withSingleInstance` would require restructuring around an existing
 * try/finally that's already handling other cleanup (signal handlers, etc).
 *
 * Throws with the same `another loop is running` message as
 * `withSingleInstance` on ELOCKED — callers should distinguish that case
 * from real errors and exit cleanly rather than re-throwing.
 */
export async function acquireSingleInstanceLock(
  lockPath: string,
): Promise<() => Promise<void>> {
  await ensureFileExists(lockPath);
  try {
    return await lockfile.lock(lockPath, {
      realpath: false,
      retries: 0,
      stale: 60_000,
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOCKED") {
      throw new Error(
        `acquireSingleInstanceLock: another loop is running (lock at ${lockPath} is held). Stop the other loop or wait for it to finish.`,
      );
    }
    throw err;
  }
}

async function ensureFileExists(p: string): Promise<void> {
  try {
    await fs.access(p);
  } catch {
    await fs.mkdir(path.dirname(p), { recursive: true });
    const fh = await fs.open(p, "a");
    await fh.close();
  }
}
