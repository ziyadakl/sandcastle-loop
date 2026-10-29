/**
 * Run identity — what a run WAS, recorded from the run's own inputs.
 *
 * WHY THIS EXISTS: on the 2026-07-31 run, `.sandcastle/.last-run-mode` said
 * `opus-4.8` while the log proved `budgetModels` had actually run (the
 * implementer escalated to `claude-sonnet-5`, a rung only the budget ladder
 * has; the post-merge fixer ran `claude-sonnet-5`, again budget-only). A $297
 * run was therefore not comparable to the next one at all — a cost delta could
 * not be attributed to code changes versus a different model profile.
 *
 * The fix has two halves:
 *   1. `profile` is derived from the SAME inputs `roleModelsFor` branches on
 *      (`main.mts`), never from a written-down mode file. Never read
 *      `.last-run-mode` here — that is the file that lied.
 *   2. The RESOLVED `roleModels` map travels alongside the label. That is what
 *      makes a mislabeled profile SELF-DETECTING: a run tagged `budget` whose
 *      implementer default is an Opus id is visibly wrong from the record
 *      alone, without needing the log.
 *
 * `promptHashes` closes the other confounder: a prompt edit between two runs
 * changes cost, and without a hash it is invisible.
 *
 * NOTE: this module deliberately does NOT import `main.mts` — it is an
 * 8,700-line module and importing it from `lib/` invites a cycle. The ladder
 * below is therefore a HAND-MAINTAINED MIRROR of `roleModelsFor`. What keeps
 * the mirror honest is a parity test in `main.test.mts` ("run-identity profile
 * ladder mirrors roleModelsFor") — it CAN import `main.mts` safely (the CLI
 * entry is `isMain()`-guarded) and deep-equals `resolveRunIdentity().roleModels`
 * against `roleModelsFor()` for every input combination, so a precedence flip
 * or a map swap on either side fails loudly. The tests in this module's own
 * `run-identity.test.ts` assert against `models.js` only and cannot catch a
 * desync — do not rely on them for that.
 *
 * NEVER-THROW: run identity is telemetry. A capture failure must never be able
 * to block a launch (see `capture.ts` / `timing.ts`), so every filesystem read
 * is individually guarded and a total reader failure still yields a usable
 * identity with empty hashes.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { OpusProfile } from "../../models.js";
import {
  budgetModels,
  codexModels,
  models,
  opus5Models,
} from "../../models.js";
import type { AgentBackend } from "../../providers.js";
import type { RoleModelEntry, RunIdentity } from "../status/schema.js";

/**
 * The prompt files whose contents materially shape a run's cost and behavior.
 * Keys in `promptHashes` are these BARE BASENAMES — never absolute paths, which
 * differ per host and per sub-worktree and would make two hosts on the same run
 * look like different runs.
 */
export const PROMPT_FILES = [
  "implement-prompt.md",
  "review-prompt.md",
  "merge-prompt.md",
  "post-merge-review-prompt.md",
  "post-merge-fix-prompt.md",
] as const;

/** Length of the recorded digest prefix — enough to be collision-free in
 *  practice for a handful of prompt files, short enough to eyeball in a diff. */
const HASH_PREFIX_LEN = 12;

/**
 * Inputs to identity resolution. Mirrors `roleModelsFor`'s parameter exactly
 * (plus `provider`) so a caller in `main.mts` passes the SAME variables it
 * already passes there — that shared source is the whole point.
 */
export interface RunIdentityArgs {
  readonly backend?: AgentBackend;
  readonly opusProfile?: OpusProfile;
  readonly budget?: boolean;
  /**
   * Claude-backend endpoint override (`kimi` | `glm`, see
   * `lib/hosts/launch.ts`). A separate axis from `profile`: it leaves the model
   * map untouched, so a kimi run is otherwise indistinguishable from default
   * claude.
   */
  readonly provider?: string;
}

/** Injectable seams. Both default to the real environment. */
export interface RunIdentityDeps {
  /** Defaults to `readFileSync`. Injected so a throwing reader is testable
   *  without touching the real filesystem. */
  readonly readFile?: (absPath: string) => string | Buffer;
  /** Directory holding the prompt files. Defaults to `.sandcastle/`. */
  readonly sandcastleDir?: string;
}

type RoleConfigMap = Readonly<
  Record<string, { readonly default: string; readonly escalations: readonly string[] }>
>;

/**
 * The profile ladder, resolving the label and its map TOGETHER in one branch
 * chain. Deriving them separately would let them drift inside this very
 * function, which is precisely the failure the `roleModels` field exists to
 * catch — so they must share a single decision.
 *
 * Precedence mirrors `roleModelsFor` in `main.mts`:
 *   `backend === "codex"` → codex, else `budget === true` → budget,
 *   else `opusProfile === "5"` → opus5, else default.
 */
function selectProfile(args: RunIdentityArgs): {
  profile: RunIdentity["profile"];
  map: RoleConfigMap;
} {
  if (args.backend === "codex") return { profile: "codex", map: codexModels };
  if (args.budget === true) return { profile: "budget", map: budgetModels };
  if (args.opusProfile === "5") return { profile: "opus5", map: opus5Models };
  return { profile: "default", map: models };
}

/**
 * Deep-copy a role map into the schema's mutable shape. Copying is required
 * twice over: the source arrays are `readonly` (and the schema's are not), and
 * handing out a live reference to module-level config would let a snapshot
 * consumer mutate the run's model map.
 */
function copyRoleModels(map: RoleConfigMap): Record<string, RoleModelEntry> {
  const out: Record<string, RoleModelEntry> = {};
  for (const [role, cfg] of Object.entries(map)) {
    out[role] = { default: cfg.default, escalations: [...cfg.escalations] };
  }
  return out;
}

/**
 * Short sha256 of one file, or `""` if it cannot be read for ANY reason.
 * Follows `lib/restart-detector.ts`'s `hashOrEmpty` pattern (a missing file
 * records as empty rather than throwing), differing only in truncating the
 * digest. The key is always emitted by the caller, so `""` reads as "this file
 * was unreadable" and never as "hashing didn't happen".
 */
function hashOrEmpty(
  readFile: (absPath: string) => string | Buffer,
  absPath: string,
): string {
  try {
    const contents = readFile(absPath);
    if (typeof contents !== "string" && !Buffer.isBuffer(contents)) return "";
    return createHash("sha256")
      .update(contents)
      .digest("hex")
      .slice(0, HASH_PREFIX_LEN);
  } catch {
    return "";
  }
}

/** Absolute path of `.sandcastle/`, resolved from this module's own location
 *  (`.sandcastle/lib/telemetry/`) so it never depends on the process cwd. */
function defaultSandcastleDir(): string {
  return join(import.meta.dirname, "..", "..");
}

/**
 * Resolve the identity of the current run.
 *
 * Never throws. `backend` and `provider` are passed through verbatim and are
 * OMITTED when not supplied — recording an invented default is the exact
 * failure mode of `.last-run-mode`.
 */
export function resolveRunIdentity(
  args: RunIdentityArgs,
  deps: RunIdentityDeps = {},
): RunIdentity {
  const { profile, map } = selectProfile(args);
  const readFile = deps.readFile ?? readFileSync;
  const dir = deps.sandcastleDir ?? defaultSandcastleDir();

  const promptHashes: Record<string, string> = {};
  for (const file of PROMPT_FILES) {
    promptHashes[file] = hashOrEmpty(readFile, join(dir, file));
  }

  return {
    profile,
    ...(args.backend === undefined ? {} : { backend: args.backend }),
    ...(args.provider === undefined ? {} : { provider: args.provider }),
    roleModels: copyRoleModels(map),
    promptHashes,
  };
}
