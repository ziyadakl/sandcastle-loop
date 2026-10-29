/**
 * Issue #972 gap 1 — the ship-time re-run mints a FRESH nonce and rebuilds the
 * command around it, instead of replaying the must-fail-first proof's nonce that
 * builder-authored code (running inside the check's process) already knows.
 */
import { describe, expect, it } from "vitest";

import { buildCheckCommand } from "./lib/checkwriter/check-path.js";
import {
  checkNonceFromCommand,
  newCheckNonce,
} from "./lib/harness/tally-signals.js";
import { shipTimeRunCommand } from "./main.mts";

const BROWSER_LOCATION = {
  kind: "browser" as const,
  issueNumber: 972,
  checkPath: "gap-one.spec.ts",
  checkDir: "apps/nextjs/e2e/checks/issue-972",
  checkDirGlob: "apps/nextjs/e2e/checks/issue-972/**",
};

describe("shipTimeRunCommand — a fresh nonce for the ship-time re-run (#972 gap 1)", () => {
  it("mints a FRESH nonce and rebuilds the command when the location is in hand", () => {
    const staleNonce = newCheckNonce();
    const staleCommand = buildCheckCommand(972, "gap-one.spec.ts", staleNonce)!;
    expect(checkNonceFromCommand(staleCommand)).toBe(staleNonce);

    const { command, nonce } = shipTimeRunCommand({
      checkCommand: staleCommand,
      location: BROWSER_LOCATION,
      worktreePath: "/repo",
    });

    // A genuinely fresh nonce, not the one builder code already saw...
    expect(nonce).not.toBe(staleNonce);
    // ...and the REBUILT command writes its report under that same fresh nonce,
    // so the evidence line reads under it rather than inconclusive.
    expect(checkNonceFromCommand(command)).toBe(nonce);
    expect(command).not.toBe(staleCommand);
  });

  it("falls back to the replayed nonce when no location is threaded (a test double)", () => {
    const staleNonce = newCheckNonce();
    const staleCommand = buildCheckCommand(972, "gap-one.spec.ts", staleNonce)!;

    const { command, nonce } = shipTimeRunCommand({ checkCommand: staleCommand });

    expect(command).toBe(staleCommand);
    expect(nonce).toBe(staleNonce);
  });

  it("falls back when a unit rebuild cannot resolve its package — never a false green", () => {
    const staleNonce = newCheckNonce();
    const staleCommand = buildCheckCommand(972, "gap-one.spec.ts", staleNonce)!;

    const { command, nonce } = shipTimeRunCommand({
      checkCommand: staleCommand,
      location: {
        kind: "unit",
        issueNumber: 972,
        checkPath: "gap-one.test.ts",
        checkDir: "packages/api/src/__checks__/issue-972",
        checkDirGlob: "packages/api/src/__checks__/issue-972/**",
      },
      // No checkPackage → rebuildCheckCommandFor returns undefined → fallback.
      worktreePath: "/repo",
    });

    expect(command).toBe(staleCommand);
    expect(nonce).toBe(staleNonce);
  });
});
