/**
 * Does the ACTIVE sandcastle profile's sandbox have a browser to run a
 * check in (issue #933)?
 *
 * The check-writer can order one of two runners for a check
 * (`checkKindForMarker` in `check-kind.ts`): `browser` (a Playwright spec)
 * or `unit` (a vitest test). Which sandbox image the loop actually built
 * this run is a SEPARATE axis, recorded in `.sandcastle/profile` and
 * switched by the `/sandcastle-profile` skill (see
 * `.sandcastle/variants/*​/overrides/variant-intro.md`, and the `minimal`
 * variant's own: "no browser stack, no Playwright ... The screen check does
 * not exist under this variant"). Nothing wired those two axes together —
 * the check-writer prompt tells the agent, in words, to prefer a browser
 * check when torn, and under `minimal` that advice is simply wrong, because
 * the sandbox image that profile builds has no chromium in it at all
 * (`.sandcastle/variants/minimal/Dockerfile`). A prompt instruction is
 * advisory; nothing stopped the agent from ordering a check the sandbox
 * cannot run.
 *
 * This module is the missing wire: a real filesystem read of which profile
 * is active, and a pure decision over its name. `main.mts`'s `runCheckWriter`
 * refuses a `browser`-kind check outright when this says `false` — see the
 * call site there for the enforcement, which is a branch, not prompt text.
 *
 * `BROWSERLESS_PROFILES` names only `minimal`: it is the one variant the
 * template ships whose own Dockerfile has no Playwright/chromium install at
 * all (`playwright` and `agent-browser` both bake in a browser stack, just
 * different instruments; `mac-host` is a host-native variant for iOS/macOS
 * targets this project — a Next.js web app — never runs). An unrecognised
 * or missing profile name defaults to `true` (browser available) — the same
 * reading `.sandcastle/profile` gets today when the file is absent, so a
 * project that predates profiles, or a custom variant this list does not
 * yet know about, keeps today's behaviour rather than silently losing its
 * browser checks.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Variants known to ship a sandbox image with no browser stack at all.
 * Exported so a test (or a future variant) can read the exact set rather
 * than re-deriving it.
 */
export const BROWSERLESS_PROFILES: ReadonlySet<string> = new Set(["minimal"]);

/**
 * Read the active profile name from `<worktreePath>/.sandcastle/profile` —
 * the SAME file `/sandcastle-profile` writes and the wrapper script reads
 * to pick `--sandbox`. Read from the ISSUE'S OWN worktree, not
 * `ctx.args.repoRoot`: the file is a tracked, committed part of the branch
 * (`git ls-files .sandcastle/profile`), so the worktree checked out for
 * this ticket carries whichever profile was active when that commit landed,
 * and that is the one true answer to "which sandbox is this ticket running
 * in" — matching how `hasPreexistingCheckFiles` and every other per-issue
 * worktree read in this loop already work.
 *
 * Never throws: a missing file, an empty file, or an unreadable path all
 * read as `undefined` — "unknown", not "browserless". See the module doc
 * for why `undefined` defaults to browser-available.
 */
export function readActiveProfile(worktreePath: string): string | undefined {
  try {
    const raw = readFileSync(
      path.join(worktreePath, ".sandcastle", "profile"),
      "utf8",
    ).trim();
    return raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Can a `browser`-kind check actually run under this profile?
 *
 * Pure: the only input is the profile name, never a filesystem read itself
 * — that is {@link readActiveProfile}'s job, kept separate so this decision
 * is trivially unit-testable without a temp directory.
 */
export function profileHasBrowser(profile: string | undefined): boolean {
  if (profile === undefined) return true;
  return !BROWSERLESS_PROFILES.has(profile);
}
