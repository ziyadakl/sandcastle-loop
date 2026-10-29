#!/usr/bin/env tsx

/**
 * Stamp `issues[].stopCause` on tickets a dead run left in flight (spec #1368).
 *
 * Usage: tsx .sandcastle/scripts/stamp-stop-cause.mts [--repo-root <path>]
 *
 * Idempotent and best-effort; safe to run from a systemd boot unit
 * (`ExecStart=... stamp-stop-cause.mts --repo-root /path/to/checkout`) so the
 * cause is published even when no loop restarts. Run it only when no loop is
 * alive on the checkout (at boot none is). Never overwrites an existing cause.
 * Publishes the stamped snapshot to the dashboard with the push settings the
 * loop uses (`.sandcastle/.env` via the loop's own `loadDotenv`), and waits for
 * that push to finish before exiting. All logic lives in
 * ../lib/status/stop-cause-stamper.ts; this file only owns I/O.
 */

import { join } from "node:path";

import { makeStopCauseStamper } from "../lib/status/stop-cause-stamper.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let repoRoot = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo-root" && argv[i + 1] !== undefined) {
      repoRoot = argv[++i]!;
    } else {
      console.error(
        `sandcastle:stamp-stop-cause: unknown or incomplete flag: ${argv[i]}`,
      );
      process.exit(1);
    }
  }
  // Same loader as the loop, so the push URL/token resolve identically. Imported
  // lazily: main.mts only runs its CLI when it is the entry script.
  const { loadDotenv } = await import("../main.mts");
  loadDotenv(repoRoot);
  const stamped = await makeStopCauseStamper({
    repoRoot,
    logError: (line) => console.error(`sandcastle:stamp-stop-cause: ${line}`),
  })();
  console.log(
    stamped.length > 0
      ? `stamped stop cause on ${stamped.map((n) => `#${n}`).join(", ")}`
      : "nothing to stamp",
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
