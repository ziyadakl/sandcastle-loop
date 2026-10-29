import { agentIdentityArgs } from "../git/identity.js";
import type { HostConfig } from "./registry.js";
import type { HostOutcome, HostResult } from "./result.js";
import { isLocalHost } from "./registry.js";

// Multi-host control (workstream B4) — the per-host LAUNCH safety gate.
//
// `runLaunch` factors the prose pre-flight from the sandcastle-run / -stop
// skills into real, testable code: it runs the safety checks IN ORDER on a
// single host and short-circuits to a {@link HostResult} on the first failure —
// it NEVER forces anything (no `git pull`, no `git reset`, no token forwarding,
// and it never merges origin/main wholesale into the run branch). One step is a
// SELF-HEALING repair rather than a gate (4.5: stale `.sandcastle/` machinery is
// synced to origin/main and the launch proceeds). Only when every gate passes
// does it build + exec the launch command detached.
//
// The transport is an INJECTED collaborator ({@link LaunchDeps.exec}): the gate
// steps (reachable, not-running, clean tree, ff-only update, SELF-HEAL stale
// machinery, auth, launch) are each driven through a fake exec in
// ./launch.test.ts, which never touches real ssh/git. The real exec (local spawn
// vs `ssh <alias> -- <argv>`) lives in the thin ../scripts/launch.mts runner,
// mirroring the check-upstream.ts / .mts split.

/**
 * The fixed set of agent modes a launch may request. `claude` (the default
 * Anthropic backend), `codex` (OpenAI backend), the two
 * claude-backend endpoint overrides `kimi` / `glm` (see providers.ts), and
 * `budget` (claude backend with the cheaper Sonnet-5 implementer first pass —
 * see `modeFlag`). This is the launch surface's own axis — the skills ask the
 * user for one of these and the launcher's `scripts/launch.mts` takes it as
 * `--mode`; `modeFlag`
 * below then translates it into the `--backend`/`--provider` flags main.mts
 * actually accepts (main.mts has no `--mode` option). It is deliberately
 * distinct from the narrower `AgentBackend` (claude|codex) and `ProviderName`
 * (anthropic|kimi|glm) types, neither of which covers this exact set.
 */
export const LAUNCH_MODES = [
  "claude",
  "codex",
  "kimi",
  "glm",
  "budget",
] as const;
export type LaunchMode = (typeof LAUNCH_MODES)[number];

/** Type guard: is `s` one of the four canonical launch modes? */
export function isLaunchMode(s: string): s is LaunchMode {
  return (LAUNCH_MODES as readonly string[]).includes(s);
}

/** Result of running one argv on a host. Mirrors main.mts runGit's shape. */
export interface ExecResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * The process's numeric exit code: 0 on success, the child's exit status on a
   * normal non-zero exit, and a coerced value >= 2 for a spawn/exec error that
   * never produced an exit status (e.g. ENOENT). ADDITIVE to `ok` — every other
   * gate still branches on `ok` and is unaffected. Step 4.5 alone needs the code
   * because `ok:false` conflates two outcomes of `git diff --quiet` that must be
   * handled differently: exit 1 = ".sandcastle differs" (act on it) versus exit
   * >= 2 = a git ERROR (bad object, corrupt index — refuse, do not sync).
   */
  readonly exitCode: number;
}

export interface LaunchDeps {
  /**
   * Run `argv` on `host`: locally when `transport === "local"`, else over
   * `ssh <transport> -- <argv>`. The command runs with the host's repo checkout
   * as its working directory (so `$PWD` inside a `bash -lc` script is that
   * repo root — the pgrep cwd filter and the remote PATH prefix both rely on it).
   */
  exec: (host: HostConfig, argv: string[]) => Promise<ExecResult>;
}

export interface LaunchSpec {
  readonly branch: string;
  readonly mode: LaunchMode;
  readonly iterations: number;
  readonly base?: string;
  /**
   * Whether this launch is a fresh `run` or a `resume` of an existing branch.
   *
   * LAUNCHER-ONLY, exactly like {@link LaunchSpec.base}: it never becomes a
   * flag on the loop's command line. `scripts/launch.mts` consumes it to decide
   * whether to DISCOVER the branch (resume) or require one (run); by the time
   * the spec reaches here the branch is already resolved, and the gate leaves
   * the host checked out on it either way.
   *
   * There is nothing left for main.mts to be told. Starting the loop on a
   * branch that already carries work IS the resume: main.mts's own startup
   * reconciliation re-reads the branch, re-claims nothing, and reports the
   * already-shipped issues ("N issue(s) already carry 'shipped-local' with no
   * open PR — will surface them in this run's PR"). Confirmed in production on
   * 2026-08-16, resuming `sandcastle/queue-20260815` after a dead restart: the
   * plain run form picked up all 18 shipped issues unaided.
   */
  readonly action: "run" | "resume";
  readonly dryRun?: boolean;
  /**
   * Which GitHub label the loop claims work under, forwarded verbatim to
   * main.mts's `--label` (issue #966). Optional and left UNSET by default so
   * main.mts owns its own `ready-for-agent` default — a single source of truth
   * for the queue's normal label. Set it (e.g. `phase-1`) to release the queue
   * in phased batches on a multi-host run, which the launcher could not do
   * before because it dropped every flag it did not itself understand.
   */
  readonly label?: string;
}

/** Path of the per-host launch log; per-host (not shared) to avoid confounds. */
function logPath(host: HostConfig): string {
  return `/tmp/sandcastle-${host.name}.log`;
}

/**
 * The wrapper invocation + its flags (no detach wrapping). Per-host concurrency
 * comes from the REGISTRY (`host.maxConcurrent`), which always wins over any
 * spec-level hint. Split out so the detach forms below share one flag string.
 */
function wrapperInvocation(host: HostConfig, spec: LaunchSpec): string {
  const flags = [
    `--branch ${spec.branch}`,
    modeFlag(spec.mode),
    `--iterations ${spec.iterations}`,
    `--max-concurrent ${host.maxConcurrent}`,
  ];
  // NOTE: spec.base is intentionally NOT forwarded. main.mts's parseSandcastleArgs
  // runs `parseArgs({ strict:true })` with NO `--base` option, so emitting
  // `--base <x>` here makes the loop die with "Unknown option '--base'" and kills
  // every all-machines launch. `--base` is consumed by scripts/launch.mts for the
  // launcher's own use (the gate leaves the host checked out on spec.branch); it
  // must never reach the wrapper/main.mts command line.
  //
  // spec.label, by contrast, IS forwarded (issue #966): main.mts DOES accept
  // `--label NAME`, so a phased-batch label like `phase-1` reaches the loop
  // safely. Only emitted when set — an unset label lets main.mts fall back to
  // its own `ready-for-agent` default rather than the launcher hard-coding it.
  if (spec.label) flags.push(`--label ${spec.label}`);
  //
  // NOTE: spec.action is NOT forwarded either, for the identical reason as
  // `--base` above — and this line USED to emit `--resume`, which walked
  // straight into that trap. `parseSandcastleArgs` (main.mts:1381) is
  // `parseArgs({ strict:true })` and its options map has no `resume` key, so
  // every `--action resume` launch died instantly with
  // "Unknown option '--resume'". The `--base` warning was written directly
  // above the offending line and nobody read it downwards.
  //
  // Nothing replaces the flag: resuming IS running on the branch that already
  // holds the work. See LaunchSpec.action for the production proof.
  return `bash .sandcastle/sandcastle-wrapper.sh ${flags.join(" ")}`;
}

/**
 * Translate a {@link LaunchMode} into the flag(s) `main.mts`'s
 * `parseSandcastleArgs` actually accepts. main.mts is `parseArgs({ strict:true })`
 * with NO `--mode` option — emitting `--mode <x>` makes the loop die with
 * "Unknown option '--mode'" (the live-dogfood bug this closes). The four launch
 * modes map to main.mts's own axes (main.mts:665-791):
 *   - `claude` / `codex` → the `--backend` agent-backend switch
 *   - `kimi`   / `glm`   → the claude-backend `--provider` endpoint override
 * The exhaustive `switch` with a `never` default fails to compile if a fifth
 * LaunchMode is ever added, forcing this map to stay in lock-step.
 */
function modeFlag(mode: LaunchMode): string {
  switch (mode) {
    case "claude":
      return "--backend claude";
    case "budget":
      // Cross-host budget parity: claude backend + the implementer's cheaper
      // Sonnet-5 first pass (Opus escalation on retry preserved). main.mts's
      // --budget is claude-only and mutually exclusive with codex/provider/opus5,
      // so it rides on the default claude backend. Closes the "budget is
      // single-host only" gap so an all-machines run can be budget on every host.
      return "--backend claude --budget";
    case "codex":
      return "--backend codex";
    case "kimi":
      return "--provider kimi";
    case "glm":
      return "--provider glm";
    default: {
      const _exhaustive: never = mode;
      throw new Error(`unhandled launch mode: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Shell expression for the loop's own systemd unit name: `sandcastle-` plus
 * the checkout's folder name, with every character systemd rejects in a unit
 * name turned into `_`. The /sandcastle-run skill launches a local loop under
 * this same expression, so both roads share one unit per checkout. Two
 * checkouts with the same folder name share it too, and refuse each other.
 */
export const OWN_SERVICE_UNIT_SH = `sandcastle-$(printf %s "\${PWD##*/}" | tr -c 'A-Za-z0-9_.-' _)`;

/** Marker the launch command prints when the loop's unit is already active. */
export const ALREADY_RUNNING_MARKER = "sandcastle-launch: already-running";

/**
 * Build the exact detached launch command string for `host`. Where the host
 * runs a systemd user manager AND the user lingers (the Linux servers), the
 * loop starts as its own transient user service, named by
 * {@link OWN_SERVICE_UNIT_SH}:
 *
 *   systemd-run --user --collect --unit="$u" --working-directory="$PWD" \
 *     -E PATH=… -E HOME="$HOME" -E SANDCASTLE_… \
 *     bash -c 'exec <wrapper> > <log> 2>&1 </dev/null'
 *
 * `nohup … & disown` and `setsid` detach from the shell but leave the loop
 * inside whatever systemd unit ran the shell, and systemd kills a whole unit
 * when it stops. On 2026-10-13 a loop launched from a T3 Code chat died that
 * way: `t3code.service` restarted at 18:20:31 UTC and SIGKILLed the loop with
 * it, two hours into three tickets. Its own unit makes the loop outlive the
 * launching app and the ssh session. Lingering is what keeps the user's
 * systemd manager, and so the unit, alive after the last login ends; without
 * it the manager stops ~10 s after logout and takes the loop with it, so a
 * non-lingering host keeps the old detach form below.
 *
 * Side effects of the unit, both deliberate:
 * - The loop gets the user manager's environment, not the launching shell's.
 *   PATH, HOME and every exported `SANDCASTLE_*` setting are copied across;
 *   any other one-off export is not. Pool credentials are unaffected: the loop
 *   reads them from `~/.config/sandcastle/.env` through HOME.
 * - When the loop exits, systemd stops anything it left running in the unit.
 *
 * If the unit is already active, the command prints
 * {@link ALREADY_RUNNING_MARKER} and fails, and {@link runLaunch} reports
 * `already-running`, the same outcome step 2's process check gives.
 *
 * Elsewhere (no systemd user manager, e.g. macOS, or no lingering), the
 * detach form differs by transport:
 *
 * - local: `nohup <wrapper> > <log> 2>&1 </dev/null & disown` — NO `setsid`
 *   (it does not exist on macOS and mis-parses into a double launch).
 * - remote (ssh): the remote Linux shell reaps children when ssh closes, so it
 *   MUST `setsid nohup <wrapper> … </dev/null &` to survive the disconnect.
 *
 * Every form puts `$PWD/node_modules/.bin` on PATH: a non-interactive ssh shell
 * has a minimal PATH, and a local shell may lack a global `tsx` install, so the
 * vendored `node_modules/.bin/tsx` must be on PATH for the bare `tsx` in the
 * wrapper to resolve. The local exec runs with cwd = repoRoot
 * (scripts/launch.mts), so `$PWD/node_modules/.bin` is correct for local too.
 * The command runs under `bash -lc` (for `compgen`), and its arms sit on
 * their own lines because a fallback ending in `&` cannot take a `;`.
 *
 * This is returned verbatim in `HostResult.detail` for `--dry-run`, so it is the
 * single source of truth for both the dry-run preview and the real exec.
 */
export function buildLaunchCommand(host: HostConfig, spec: LaunchSpec): string {
  const wrapper = wrapperInvocation(host, spec);
  const toLog = `> ${logPath(host)} 2>&1 </dev/null`;
  const binPath = `"$PWD/node_modules/.bin:$PATH"`;
  const ownServiceHost =
    `systemctl --user show-environment >/dev/null 2>&1 && ` +
    `[ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" = yes ]`;
  const ownService = [
    `  u="${OWN_SERVICE_UNIT_SH}"`,
    `  if systemctl --user is-active --quiet "$u"; then echo "${ALREADY_RUNNING_MARKER}: $u" >&2; exit 1; fi`,
    `  systemd-run --user --collect --unit="$u" --working-directory="$PWD" ` +
      `-E PATH=${binPath} -E HOME="$HOME" $(compgen -e | sed -n 's/^SANDCASTLE_.*/-E &/p') ` +
      `bash -c ${shq(`exec ${wrapper} ${toLog}`)}`,
  ].join("\n");
  const detached = isLocalHost(host)
    ? `  PATH=${binPath} nohup ${wrapper} ${toLog} & disown`
    : `  PATH=${binPath} setsid nohup ${wrapper} ${toLog} &`;
  return [`if ${ownServiceHost}; then`, ownService, "else", detached, "fi"].join("\n");
}

/**
 * POSIX single-quote shell escape: wrap `s` in single quotes, and rewrite each
 * embedded single quote as `'\''` (close-quote, an escaped literal quote,
 * reopen-quote). Inside single quotes every other byte — spaces, `$`, `&&`,
 * double quotes, newlines — is literal, so the result reconstructs `s` exactly
 * when the remote POSIX shell re-parses it.
 */
function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Build the SINGLE shell-command string handed to `ssh <alias> "<cmd>"` for a
 * remote host: `cd <shq(repoPath)> && <argv.map(shq).join(" ")>`. A
 * non-interactive `ssh <alias>` lands in the login dir, so we `cd` into the
 * host's repo checkout first; and because ssh space-joins its args and the
 * remote shell re-parses them, every argv element is shell-quoted so a
 * multi-line element (the pgrep script, or a `bash -lc '<script>'` launch)
 * round-trips instead of being mangled.
 */
export function buildRemoteCommand(
  repoPath: string,
  argv: readonly string[],
): string {
  return `cd ${shq(repoPath)} && ${argv.map(shq).join(" ")}`;
}

/**
 * The cwd-filtered pgrep from the sandcastle-stop skill, run ON the host over
 * exec. It is project-scoped: a bare `pgrep .sandcastle/main.mts` matches EVERY
 * repo's loop on the machine, so we keep only pids whose working directory is
 * this repo root (`$PWD`, since exec runs in the checkout). Non-empty stdout
 * means a live loop for THIS repo is already running.
 */
const PGREP_SCRIPT = [
  "for pid in $(pgrep -f '\\.sandcastle/main\\.mts (--iterations|--max-tickets|--issue|--max-concurrent|--repo-root|--branch)'); do",
  '  cwd=$(lsof -a -d cwd -p "$pid" -Fn 2>/dev/null | sed -n "s/^n//p")',
  '  [ "$cwd" = "$PWD" ] && echo "$pid"',
  "done",
].join("\n");

/**
 * The exact commit subject the step-4.5 self-heal mints. A CONSTANT because it
 * is also the DISCRIMINATOR: the touched-probe lists the subjects of branch
 * commits that changed `.sandcastle` (minus telemetry) and treats the branch as
 * carrying its own machinery work only when some subject is NOT this one —
 * otherwise a single heal would count as a "branch touch" and disarm the guard
 * permanently on every later resume.
 */
export const SELF_HEAL_COMMIT_SUBJECT =
  "chore(sandcastle): self-heal stale .sandcastle to origin/main before launch";

/**
 * The pathspec pair every step-4.5 probe AND the sync itself are scoped to:
 * `.sandcastle` minus its telemetry directory. The loop commits
 * `.sandcastle/telemetry/issues.jsonl` on the run branch after every processed
 * issue (commitReworkStore), so WITHOUT the exclusion the touched-probe reads
 * that bookkeeping as intentional machinery work and skips the heal on
 * essentially every real resume — and the sync scope must match, so the heal
 * never reverts the branch's own telemetry data to main's.
 */
export const SANDCASTLE_MINUS_TELEMETRY = [
  ".sandcastle",
  ":(exclude).sandcastle/telemetry",
] as const;

/**
 * The graft sentinel: a file that exists in `.sandcastle` ONLY when the local
 * customizations have been re-grafted after a `/sandcastle-update` template
 * pull. Before syncing to origin/main, step 4.5 checks this path exists in
 * origin/main's tree — if it is absent, main's `.sandcastle` is an
 * un-re-grafted template drop, and "healing" to it would DOWNGRADE the
 * branch's healthy machinery. The heal refuses instead.
 *
 * The first-test lock (`lib/judge/check-freeze.ts`, issue #1118) — local-only,
 * no upstream counterpart. It was `lib/judge/ruling.ts` until spec #1334
 * deleted the judge; repointed in the SAME commit, because a sentinel naming a
 * deleted file makes every host launch refuse to heal.
 */
export const GRAFT_SENTINEL_PATH = ".sandcastle/lib/judge/check-freeze.ts";

function skip(
  host: HostConfig,
  outcome: HostOutcome,
  detail?: string,
): HostResult {
  return detail
    ? { host: host.name, outcome, detail }
    : { host: host.name, outcome };
}

/**
 * Run the launch safety gate for one host, short-circuiting on the first
 * failure. Order (each step is a `deps.exec` on the host):
 *
 *   1. reachable        — `true`; not ok -> `unreachable`
 *   2. not-running      — cwd-filtered pgrep; a surviving pid -> `already-running`
 *   3. clean tree       — `git status --porcelain`; non-empty -> `dirty-tree`
 *   4. ff-only update   — leave the host checked out ON `<branch>`, fast-
 *                         forwarded to origin's tip, WITHOUT ever force-resetting
 *                         (never pull, never reset — ff-only). `git fetch origin
 *                         <branch>` (fetch fails -> `diverged`); then if the
 *                         local branch exists (`git rev-parse --verify --quiet
 *                         refs/heads/<branch>`), `git checkout <branch>` + `git
 *                         merge --ff-only FETCH_HEAD` (non-ff -> `diverged`); if
 *                         it is absent locally, `git checkout -b <branch>
 *                         FETCH_HEAD` (create at the fetched tip — no reset).
 *                         Then re-verify HEAD is attached AND equals `<branch>`
 *                         via `git symbolic-ref --short HEAD`;
 *                         detached OR wrong branch -> `preflight-error`. Step 3
 *                         already guaranteed a clean tree, so `git checkout` is
 *                         safe.
 *   4.5 self-heal       — DETECT and repair stale loop machinery so a RESUMED run
 *                         branch never runs 2-day-old `.sandcastle/` code. The
 *                         ff-only update (step 4) fast-forwards the run branch to
 *                         ITS OWN `origin/<branch>` tip, not to `origin/main`, so a
 *                         `.sandcastle/` fix that landed on main after the branch
 *                         was cut is otherwise silently ignored (the 2026-08-31
 *                         incident: the loop ran stale machinery and quarantined
 *                         healthy tickets for hours). `git fetch origin main`
 *                         (fails -> `preflight-error`; without main we can neither
 *                         check nor sync). Then compare `.sandcastle` (MINUS the
 *                         telemetry dir — {@link SANDCASTLE_MINUS_TELEMETRY}) to
 *                         origin/main via `git diff --quiet origin/main -- …`,
 *                         reading its EXIT CODE (not `ok`): 0 = current -> proceed
 *                         silently; >= 2 = a git error -> `preflight-error`
 *                         ("could not compare … (git error)") rather than
 *                         misreading an error as staleness; 1 = DIFFERS. On a
 *                         difference, guard the DIRECTION first: list the subjects
 *                         of the branch's own commits that touched
 *                         `.sandcastle`-minus-telemetry (`git log --format=%s
 *                         origin/main..HEAD -- …`; two-dot = commits since the
 *                         merge-base, no separate merge-base exec needed). Any
 *                         subject other than the heal's own
 *                         {@link SELF_HEAL_COMMIT_SUBJECT} means the branch
 *                         carries its OWN machinery work (a fix on the branch, or
 *                         dogfooding — `.sandcastle/**` is NOT protected, so this
 *                         is legitimate): DO NOT auto-revert it — `console.warn`
 *                         and launch on the branch's own machinery. Telemetry
 *                         bookkeeping commits and prior heal commits are NOT
 *                         touches — without those exemptions the guard disarms on
 *                         essentially every real resume. Heal ONLY on pure
 *                         staleness, and only after the GRAFT SENTINEL probe
 *                         (`git cat-file -e origin/main:<{@link
 *                         GRAFT_SENTINEL_PATH}>`) confirms origin/main's
 *                         `.sandcastle` has been re-grafted — an un-re-grafted
 *                         template drop on main would DOWNGRADE the branch's
 *                         healthy machinery, so that case warns and launches on
 *                         the branch's own machinery instead. On `--dry-run`,
 *                         stop here: report that a heal WOULD run, mutate
 *                         nothing. The heal itself is SELF-HEALING, not a halt —
 *                         a TRUE tree replacement of ONLY
 *                         `.sandcastle`-minus-telemetry: `git rm -r --quiet
 *                         --ignore-unmatch …` (so files DELETED/RENAMED on
 *                         main are staged for removal too — a plain `checkout
 *                         origin/main -- .sandcastle` never removes them, and a
 *                         deletion-only diff would then stage nothing, fail the
 *                         commit "nothing to commit", and false-halt every host on
 *                         the shared run branch), THEN `git checkout origin/main --
 *                         …` (NEVER a wholesale `merge origin/main`, which
 *                         would drag main's product changes onto the in-flight run
 *                         branch — the stale-base landmine), commit it under the
 *                         agent git identity (`agentIdentityArgs` — author the
 *                         configured agent name, never the owner), then PUSH the
 *                         heal commit (`git push origin <branch>`) so a second
 *                         host's step-4 fetch lands on the healed tip instead of
 *                         minting a divergent heal of its own; a rejected push
 *                         (a peer healed first) is retried as fetch + ff-only
 *                         onto the peer's tip, and only if that also fails does
 *                         it `preflight-error`. Log loudly, then PROCEED to
 *                         launch. If the sync fails AFTER the `git rm` (checkout
 *                         or commit errors), a compensating restore (`git
 *                         checkout HEAD -- .sandcastle` + `git restore --staged
 *                         .sandcastle`) is attempted so the host is not left
 *                         with the machinery deleted, and the `preflight-error`
 *                         detail says whether the restore succeeded.
 *   5. auth             — `gh auth status` + `gh issue list -L 1`; either fails
 *                         -> `auth-failed`. No token is EVER forwarded — the
 *                         host uses its own credentials.
 *   6. launch           — build the command and, unless `dryRun`, exec it
 *                         detached -> `launched`. `dryRun` returns `launched`
 *                         with the command in `detail` WITHOUT exec'ing it.
 *
 * Any unexpected thrown error degrades to `preflight-error` rather than
 * crashing a multi-host sweep.
 */
export async function runLaunch(
  host: HostConfig,
  spec: LaunchSpec,
  deps: LaunchDeps,
): Promise<HostResult> {
  // One shape, many failure sites (step 4.5 alone has seven): a
  // `preflight-error` whose detail is the failing command's stderr, falling
  // back to a caller-supplied description when the command was silent.
  const preflightError = (failed: ExecResult, fallback: string): HostResult =>
    skip(host, "preflight-error", failed.stderr.trim() || fallback);
  try {
    // 1. reachable
    const reach = await deps.exec(host, ["true"]);
    if (!reach.ok)
      return skip(host, "unreachable", reach.stderr.trim() || undefined);

    // 2. not already running (cwd-filtered pgrep on the host)
    const pgrep = await deps.exec(host, ["bash", "-lc", PGREP_SCRIPT]);
    if (pgrep.ok && pgrep.stdout.trim() !== "") {
      return skip(
        host,
        "already-running",
        `pid ${pgrep.stdout.trim().split(/\s+/)[0]}`,
      );
    }

    // 3. clean working tree
    const status = await deps.exec(host, ["git", "status", "--porcelain"]);
    if (status.ok && status.stdout.trim() !== "") {
      return skip(host, "dirty-tree");
    }

    // 4. fast-forward-only update — never pull, never reset. Leave the host
    //    checked out ON spec.branch, fast-forwarded to origin's tip.
    const fetch = await deps.exec(host, [
      "git",
      "fetch",
      "origin",
      spec.branch,
    ]);
    if (!fetch.ok)
      return skip(host, "diverged", fetch.stderr.trim() || "fetch failed");

    const localExists = await deps.exec(host, [
      "git",
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${spec.branch}`,
    ]);
    if (localExists.ok) {
      // Local branch exists: check it out, then ff-only merge origin's tip onto
      // it. Step 3 guaranteed a clean tree, so the checkout can't lose work.
      const checkout = await deps.exec(host, ["git", "checkout", spec.branch]);
      if (!checkout.ok) {
        return skip(
          host,
          "preflight-error",
          checkout.stderr.trim() || `checkout ${spec.branch} failed`,
        );
      }
      const merge = await deps.exec(host, [
        "git",
        "merge",
        "--ff-only",
        "FETCH_HEAD",
      ]);
      if (!merge.ok)
        return skip(host, "diverged", merge.stderr.trim() || undefined);
    } else {
      // Absent locally: create the branch at the fetched tip — no reset.
      const checkout = await deps.exec(host, [
        "git",
        "checkout",
        "-b",
        spec.branch,
        "FETCH_HEAD",
      ]);
      if (!checkout.ok) {
        return skip(
          host,
          "preflight-error",
          checkout.stderr.trim() || `checkout -b ${spec.branch} failed`,
        );
      }
    }

    // re-verify HEAD is attached AND equals spec.branch after the update
    const symref = await deps.exec(host, [
      "git",
      "symbolic-ref",
      "--short",
      "HEAD",
    ]);
    const head = symref.stdout.trim();
    if (!symref.ok || head === "") {
      return skip(host, "preflight-error", "HEAD is detached after update");
    }
    if (head !== spec.branch) {
      return skip(
        host,
        "preflight-error",
        `HEAD is ${head} after update, expected ${spec.branch}`,
      );
    }

    // 4.5 self-heal stale loop machinery. Step 4 fast-forwarded the run branch to
    //     ITS OWN origin tip, NOT to origin/main — so on a RESUME the checkout may
    //     still carry whatever `.sandcastle/` code the branch was cut with, missing
    //     any fix that landed on main since. Detect that (diff vs origin/main),
    //     and if stale, sync ONLY `.sandcastle/` to origin/main and proceed. This
    //     is a self-healing repair, not a refuse-and-halt gate.
    const fetchMain = await deps.exec(host, ["git", "fetch", "origin", "main"]);
    if (!fetchMain.ok) {
      // Cannot verify staleness without origin/main, and cannot sync from a ref
      // we failed to fetch — abort clearly rather than risk running stale.
      return preflightError(
        fetchMain,
        "fetch origin main failed (cannot verify loop machinery is current)",
      );
    }
    // Does the checkout's `.sandcastle/` (minus telemetry — the loop's own
    // bookkeeping is per-branch data, not machinery) differ from origin/main?
    // `git diff --quiet` reports this through its EXIT CODE, and reading `ok`
    // alone conflates two outcomes: 0 = identical, 1 = differs, >= 2 = a git
    // ERROR (bad object, corrupt index). A git error must NOT be misread as
    // "stale" and trigger a needless sync — refuse it instead.
    const differsProbe = await deps.exec(host, [
      "git",
      "diff",
      "--quiet",
      "origin/main",
      "--",
      ...SANDCASTLE_MINUS_TELEMETRY,
    ]);
    if (differsProbe.exitCode !== 0 && differsProbe.exitCode !== 1) {
      return preflightError(
        differsProbe,
        "self-heal: could not compare .sandcastle to origin/main (git error)",
      );
    }
    let dryRunWouldHeal = false;
    if (differsProbe.exitCode === 1) {
      // `.sandcastle/` differs from origin/main. That is EITHER pure staleness
      // (main is simply newer and the branch never touched `.sandcastle`) OR the
      // branch deliberately carries its OWN `.sandcastle` work — a machinery fix
      // that landed on the branch but not yet main, or the loop dogfooding a
      // machinery change on its own branch. `.sandcastle/**` is NOT a protected
      // path, so a dispatched issue can legitimately land such work. Reverting
      // it to main would be silent loss of committed work, so DIRECTION matters:
      // only heal when the diff is pure staleness.
      //
      // Distinguish by listing the SUBJECTS of the branch's own commits that
      // touched `.sandcastle`-minus-telemetry (two-dot `origin/main..HEAD` =
      // exactly the commits since the merge-base, with no separate merge-base
      // exec). A bare `git diff HEAD <merge-base>` here would read the loop's
      // own bookkeeping as intentional work and disarm the guard on essentially
      // every real resume: the telemetry commits are already outside the
      // pathspec, and a PRIOR heal commit (recognisable by its exact
      // {@link SELF_HEAL_COMMIT_SUBJECT}) is the guard's own doing, not the
      // branch's. Only a commit with any OTHER subject counts as a touch.
      const touchedLog = await deps.exec(host, [
        "git",
        "log",
        "--format=%s",
        "origin/main..HEAD",
        "--",
        ...SANDCASTLE_MINUS_TELEMETRY,
      ]);
      if (!touchedLog.ok) {
        return preflightError(
          touchedLog,
          "self-heal: `git log origin/main..HEAD -- .sandcastle` failed",
        );
      }
      const branchAuthoredSubjects = touchedLog.stdout
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s !== "" && s !== SELF_HEAL_COMMIT_SUBJECT);

      if (branchAuthoredSubjects.length > 0) {
        // The branch's own `.sandcastle` work is INTENTIONAL — auto-reverting it
        // to main would silently destroy committed work. Do not heal; launch on
        // the branch's own machinery, but say so loudly so a human can see it.
        console.warn(
          `[launch] ${host.name}: ${spec.branch} carries its OWN .sandcastle/ ` +
            `changes since it diverged from origin/main — auto-heal SKIPPED so ` +
            `the branch's intentional machinery work is NOT reverted. Launching ` +
            `on the branch's .sandcastle/.`,
        );
      } else {
        // Pure staleness — but do not sync BLINDLY. `/sandcastle-update` template
        // pulls land on main missing the local customizations (the judge, the
        // identity splice, this very step); "healing" to such a tree would
        // DOWNGRADE the branch's healthy machinery and commit the downgrade.
        // Probe the graft sentinel in origin/main's tree first.
        const sentinel = await deps.exec(host, [
          "git",
          "cat-file",
          "-e",
          `origin/main:${GRAFT_SENTINEL_PATH}`,
        ]);
        if (!sentinel.ok) {
          console.warn(
            `[launch] ${host.name}: origin/main's .sandcastle looks ` +
              `un-re-grafted (missing ${GRAFT_SENTINEL_PATH}) — REFUSING to ` +
              `downgrade the branch's machinery to it. Launching on the ` +
              `branch's .sandcastle/. Re-graft the local customizations on ` +
              `main, then resume again to heal.`,
          );
        } else if (spec.dryRun) {
          // Probes above are read-only; everything from here on MUTATES the
          // branch (rm/checkout/commit/push). A dry run reports instead.
          dryRunWouldHeal = true;
        } else {
          // Sync ONLY `.sandcastle`-minus-telemetry — NEVER a wholesale `git
          // merge origin/main`, which would relocate/revert in-flight product
          // work on the run branch (the stale-base landmine), and never the
          // telemetry dir, which is the branch's own data.
          //
          // Make it a TRUE tree replacement. `git checkout origin/main -- …`
          // only ADDS/UPDATES paths that exist in origin/main; it never removes
          // a `.sandcastle` file DELETED or RENAMED on main, and this repo
          // renumbers/renames machinery routinely. So `git rm -r` the tracked
          // tree FIRST (step 3 guaranteed a clean tree; `.sandcastle/.env` is
          // git-ignored so a tracked-only `git rm` never touches it), then check
          // main's tree back in — deletions staged, not orphaned. Without the
          // `git rm`, a deletion-only diff stages nothing, the commit fails
          // "nothing to commit", and — since all hosts share the run branch —
          // every host false-halts.
          const syncRm = await deps.exec(host, [
            "git",
            "rm",
            "-r",
            "--quiet",
            "--ignore-unmatch",
            ...SANDCASTLE_MINUS_TELEMETRY,
          ]);
          if (!syncRm.ok) {
            return preflightError(
              syncRm,
              "self-heal: `git rm -r --ignore-unmatch .sandcastle` failed",
            );
          }
          // From here until the commit lands, the working tree has the
          // machinery DELETED. A failure that returns now would leave the host
          // unable to launch at all (the dirty-tree gate refuses next time), so
          // every failure path below first attempts a compensating restore back
          // to HEAD's tree and reports whether it worked.
          const restoreAfterFailedSync = async (): Promise<string> => {
            const restore = await deps.exec(host, [
              "git",
              "checkout",
              "HEAD",
              "--",
              ".sandcastle",
            ]);
            const unstage = await deps.exec(host, [
              "git",
              "restore",
              "--staged",
              ".sandcastle",
            ]);
            return restore.ok && unstage.ok
              ? "working tree restored to HEAD"
              : "RESTORE FAILED — .sandcastle may be missing or partially staged; run `git checkout HEAD -- .sandcastle && git restore --staged .sandcastle` by hand";
          };
          // `git checkout <commit> -- <path>` updates both the index and the
          // working tree, so the restored tree is staged and ready to commit.
          const syncCheckout = await deps.exec(host, [
            "git",
            "checkout",
            "origin/main",
            "--",
            ...SANDCASTLE_MINUS_TELEMETRY,
          ]);
          if (!syncCheckout.ok) {
            const restored = await restoreAfterFailedSync();
            return skip(
              host,
              "preflight-error",
              `${
                syncCheckout.stderr.trim() ||
                "self-heal: `git checkout origin/main -- .sandcastle` failed"
              } (${restored})`,
            );
          }
          // Commit the synced machinery under the AGENT identity — author must
          // be the configured agent identity, never the owner. Step 3 guaranteed
          // a clean tree, so the only thing staged is the `.sandcastle`
          // replacement.
          const syncCommit = await deps.exec(host, [
            "git",
            ...agentIdentityArgs(),
            "commit",
            "--no-gpg-sign",
            "-m",
            SELF_HEAL_COMMIT_SUBJECT,
          ]);
          if (!syncCommit.ok) {
            const restored = await restoreAfterFailedSync();
            return skip(
              host,
              "preflight-error",
              `${
                syncCommit.stderr.trim() ||
                "self-heal: commit of synced .sandcastle failed"
              } (${restored})`,
            );
          }
          // PUSH the heal commit. Without this, every host of a multi-host
          // resume mints its OWN heal commit on the shared branch and the first
          // run-end push splits it — peers then skip as `diverged`. Pushed, a
          // second host's step-4 fetch fast-forwards onto the healed tip and its
          // own probe finds nothing stale.
          const push = await deps.exec(host, [
            "git",
            "push",
            "origin",
            spec.branch,
          ]);
          if (!push.ok) {
            // Most likely a PEER healed and pushed first. Try to adopt its tip:
            // fetch + ff-only (never a reset). If our own heal commit has
            // already diverged from the peer's, the ff fails and we halt
            // clearly rather than launching a split branch.
            const refetch = await deps.exec(host, [
              "git",
              "fetch",
              "origin",
              spec.branch,
            ]);
            const ff = refetch.ok
              ? await deps.exec(host, ["git", "merge", "--ff-only", "FETCH_HEAD"])
              : refetch;
            if (!ff.ok) {
              return preflightError(
                push,
                `self-heal: push of the heal commit to origin/${spec.branch} was rejected and the branch could not fast-forward onto the peer's tip`,
              );
            }
          }
          // Log loudly — a run that silently swapped its own machinery
          // mid-flight is something a human must be able to see after the fact.
          console.warn(
            `[launch] ${host.name}: .sandcastle/ was STALE versus origin/main — ` +
              `replaced .sandcastle/ with origin/main's version (deletions ` +
              `included, telemetry kept), committed it to ${spec.branch} and ` +
              `pushed before launch (self-heal).`,
          );
        }
      }
    }

    // 5. auth — host uses its OWN gh credentials; never forward a token
    const ghAuth = await deps.exec(host, ["gh", "auth", "status"]);
    if (!ghAuth.ok)
      return skip(host, "auth-failed", ghAuth.stderr.trim() || undefined);
    const ghIssue = await deps.exec(host, ["gh", "issue", "list", "-L", "1"]);
    if (!ghIssue.ok)
      return skip(host, "auth-failed", ghIssue.stderr.trim() || undefined);

    // 6. launch
    const command = buildLaunchCommand(host, spec);
    if (spec.dryRun) {
      // A dry run runs every read-only probe but mutates nothing — including
      // the step-4.5 heal, which reports here instead of syncing.
      return {
        host: host.name,
        outcome: "launched",
        detail: dryRunWouldHeal
          ? `${command} (would self-heal .sandcastle from origin/main)`
          : command,
      };
    }
    const launched = await deps.exec(host, ["bash", "-lc", command]);
    if (!launched.ok && launched.stderr.includes(ALREADY_RUNNING_MARKER)) {
      return skip(host, "already-running", launched.stderr.trim());
    }
    if (!launched.ok) {
      return skip(
        host,
        "preflight-error",
        launched.stderr.trim() || "launch command failed",
      );
    }
    return { host: host.name, outcome: "launched", detail: command };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return skip(host, "preflight-error", detail);
  }
}
