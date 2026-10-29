#!/usr/bin/env tsx

/**
 * Flip a run whose pre-start install failed to `unhealthy` (#1370).
 *
 * Usage: tsx .sandcastle/scripts/mark-run-unhealthy.mts --repo-root <path> --reason <text>
 *
 * Called by sandcastle-wrapper.sh when the pre-start package install fails or
 * times out, so the viewer stops showing a dead run as Live. Only a running /
 * restarting / stopping status file is rewritten; a final state or a missing
 * file is left alone. Idempotent and best-effort: a push failure logs one line
 * and still exits 0; only bad flags exit non-zero. Logic lives in
 * ../lib/status/mark-unhealthy.ts; this file only owns I/O.
 */

import { makeRunUnhealthyMarker } from "../lib/status/mark-unhealthy.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let repoRoot: string | undefined;
  let reason: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo-root" && argv[i + 1] !== undefined) {
      repoRoot = argv[++i]!;
    } else if (argv[i] === "--reason" && argv[i + 1] !== undefined) {
      reason = argv[++i]!;
    } else {
      console.error(
        `sandcastle:mark-run-unhealthy: unknown or incomplete flag: ${argv[i]}`,
      );
      process.exit(1);
    }
  }
  if (repoRoot === undefined || reason === undefined) {
    console.error("sandcastle:mark-run-unhealthy: --repo-root and --reason are required");
    process.exit(1);
  }
  // Same loader as the loop, so the push URL/token resolve identically.
  // The caller is a failed install, so node_modules may be broken and main.mts
  // may not load. The local status write must still happen; only the push
  // settings from the dotenv files are lost.
  try {
    const { loadDotenv } = await import("../main.mts");
    loadDotenv(repoRoot);
  } catch (err) {
    console.error(
      `sandcastle:mark-run-unhealthy: could not load push settings (${err instanceof Error ? err.message : String(err)}); marking locally only`,
    );
  }
  const result = await makeRunUnhealthyMarker({
    repoRoot,
    reason,
    logError: (line) => console.error(`sandcastle:mark-run-unhealthy: ${line}`),
  })();
  console.log(result === "marked" ? "marked run unhealthy" : "nothing to mark");
}

main().catch((err) => {
  // Best-effort: a runtime failure here must not mask the failure that called us.
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(0);
});
