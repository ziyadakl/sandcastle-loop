#!/usr/bin/env tsx

/**
 * PRE-COMMIT template guard runner. Thin by design: it owns only I/O — reading
 * the staged paths from git and the process env — then hands them to the pure
 * decision in ../lib/state/template-commit-guard.ts (tested there). Mirrors the
 * thin-runner shape of ./checkpoint-stop.mts.
 *
 * Exit 1 (blocking the commit) ONLY when the lib says so: a staged template path
 * (.sandcastle/lib/**, skills/**) AND an agent/loop env marker (CLAUDECODE /
 * SANDCASTLE_LOOP). A human maintainer has neither marker, so their commits to
 * these paths exit 0 and pass untouched. Invoked as:
 * `tsx .sandcastle/scripts/check-template-commit.mts`.
 */

import { execFileSync } from "node:child_process";
import { blockTemplateCommit } from "../lib/state/template-commit-guard.js";

function stagedPaths(): string[] {
  let out: string;
  try {
    out = execFileSync("git", ["diff", "--cached", "--name-only"], {
      encoding: "utf8",
    });
  } catch {
    // Can't read the index (not a repo, git missing) — never wedge the commit.
    return [];
  }
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

const decision = blockTemplateCommit({
  stagedPaths: stagedPaths(),
  env: process.env,
});

if (decision.blocked) {
  console.error(decision.reason ?? "sandcastle: template commit blocked.");
  process.exit(1);
}

process.exit(0);
