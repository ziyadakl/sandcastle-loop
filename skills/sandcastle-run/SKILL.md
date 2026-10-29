---
name: sandcastle-run
description: Start the sandcastle loop — the unattended coding run that claims issues and writes code with nobody watching. Use when the user wants to kick off the overnight loop or invokes /sandcastle-run, on one machine or across all their hosts.
---

# Sandcastle Run

Starts the loop — the unattended run that claims `ready-for-agent` issues and writes code with nobody watching.

**Three phases, in this order.** Do not reorder them and do not skip ahead:

1. **Pre-flight** — refuse before spending anything.
2. **Plan** — scope the run, then ask the launch questions.
3. **Launch gate** — re-check what planning could have invalidated, then start.

Every check below ends in one of three verdicts — **pass**, **skipped because X**, or **refuse** — and all of them have a verdict before you write the launch line.

**Refuse** means one thing throughout: surface the problem and stop. Never auto-fix, never `--force`, never stash or delete on the user's behalf.

**Every command in this file names the machine it runs on** — bare for the launch machine, transported for the target. A command that names neither has not been checked.

**Point at a check by its name, never its number.** The numbers are display order and shift whenever a check is inserted or merged; a pointer that says "check 4" goes silently wrong when that happens, which it has.

The evidence behind every refusal here is [`INCIDENTS.md`](INCIDENTS.md). Read it when you are tempted to soften a rule, or when the user asks why a gate exists.

## Output discipline — this governs everything below

`/sandcastle-run` is a **run command, not a research report**. The user wants it to launch, not to watch you think.

- **Every passing check produces zero user-facing text.** Run them silently — no "Let me check…", no "Found it — line 143…", no play-by-play.
- **Speak only when a check refuses or blocks**, or to ask the launch questions. A block gets one short plain-English line: what is wrong, and the one command to fix it.
- **A surprise is investigated silently and acted on** — an unexpected process, a missing script, a contradiction. The user needs the outcome, not the investigation.
- **On a clean run the user sees exactly two things:** the launch questions (Phase 2, not optional) and the final summary. Plain English, a few short lines each. Never recount the checks you passed, the files you read, or the contradictions you resolved.

If you catch yourself typing a sentence that explains a check that passed, delete it.

## Which machines

Resolve the target set in this order:

1. **Flags or explicit phrasing named it** (`--host`, `--all`, "just the VPS", "all my hosts") → that is the answer. Do not ask.
2. **`.sandcastle/hosts.json` lists exactly one host, or is missing** → that host. Do not ask.
3. **Otherwise** → **default to `vps` alone** (decided 2026-08-04). Still carry the **Machines** question in the Phase 2 picker so the user can override in the same breath, but if they answer the other questions and leave this one alone, run on `vps`.

**The default is ONE host, not this host.** This Mac stays a listed, selectable host — it is simply not the default worker. One host is the default because multi-host collides by construction on migration numbers and costs a human reconciliation session; the 2026-07-30 evidence is in [`INCIDENTS.md`](INCIDENTS.md).

**Silence is not an answer.** A bare `/sandcastle-run` does not tell you which machines to use, so you do not know. The picker asks it; do not let "I need to get moving" become a reason to guess.

**The launch path forks on the TARGET HOST'S `transport`, never on how many hosts you picked.** A target whose `transport` is literally `"local"` starts here via the wrapper. **Any** target with an ssh-alias transport — including a single-host `vps` pick — pushes the branch and goes through the launch script. Counting hosts to choose the path is the bug that silently runs a `vps`-only answer on the laptop.

**Two or more hosts → also read [`all-machines.md`](all-machines.md)** beside this file, and follow it in addition to everything here. One remote host is not that file.

## Producing work for the loop

The dispatch contract: an issue runs only if it carries **both** `ready-for-agent` AND a `type:X` label.

The pipeline that ends in eligible issues is `/grill-me` or `/grill-with-docs` → `/to-prd` → `/to-issues` → `/triage-plus-skills`. The first three shape the work and are owned by their upstream authors — do not assume their label outputs, they change. Only the last step is non-substitutable: **`/triage-plus-skills` is the only skill that stamps `type:X`**. Bare `/triage` is not enough.

With no eligible issues, point the user at this pipeline instead of starting the loop.

---

# Phase 1 — Pre-flight

Checks run on one of two machines, and the split matters once the target is remote:

- **Here** = the machine you were invoked on. It creates and pushes the run branch, so its git state gates every run.
- **On the target** = the machine that will actually run the loop. Its commands are **transported**, defined once at the head of that section.

## Here — the launch machine

1. **Initialized?** No `.sandcastle/main.mts` in cwd → tell the user to run `/sandcastle-init` first and stop.

   **Pick the launch root: the project's main checkout**, the first path in `git worktree list`. A session's own folder (a chat app's thread folder, `.claude/worktrees/*`) is the wrong root: it carries no `node_modules`, so `tsx` is missing and the image build fails, and the app deletes the folder when the thread is archived, taking a loop launched from it along. Every "here" command below runs with `-C <repo-root>` or from inside it. The run branch is checked out in the launch root, so it must not also be checked out in the session's folder.

2. **GitHub auth usable?** Confirm `gh auth status` succeeds; if not, tell the user to `gh auth login` and stop.

   **Refresh `GH_TOKEN` if needed.** On macOS `gh auth login` stores the token in the Keychain, so mounting `~/.config/gh/hosts.yml` into the sandbox carries no usable token and `gh issue list` inside the container returns 401. Check `hosts.yml` for an `oauth_token:` line — if present the mount suffices, skip extraction. Otherwise run `gh auth token`; if it returns a token and no env source resolves `GH_TOKEN`, append `GH_TOKEN=<token>` to `~/.config/sandcastle/.env` (host-level, so every project benefits; `mkdir -p` and `chmod 600` if new). If `GH_TOKEN` already resolves, leave it alone. Verify the target file is git-ignored before writing.

3. **Branch check — two gates.**
   - **Current branch** is `main` or `master` → refuse, tell the user to switch to a feature branch.
   - **`--branch main` or `--branch master` in the flags** → refuse, independently of the current branch. The orchestrator targets the value passed to `--branch`, so a feature-branch cwd does not make `--branch main` safe.

   **Common misreading.** A recent commit on `main` is not evidence that `--branch main` was the mechanism. The pipeline puts merges on `main` via staging→main promotion or via PR, never via the orchestrator targeting `main` directly. Check the commit's provenance — PR number, branch lineage — before citing it as proof a flag worked.

4. **Clean working tree — HARD REFUSAL, no override.** **Any** uncommitted change, staged change, or untracked file blocks the run. There is no "harmless" exception and no `--force`, and you do not stash, commit, or delete anything to get past it — another session may own those edits. A dirty tree does not fail at launch; it fails at the end, after the whole night's spend, and the run ships a PR containing none of the work ([`INCIDENTS.md`](INCIDENTS.md), 2026-08-01).

   Run in the launch root (`--repo-root` if passed):

   ```
   git -C <repo-root> status --porcelain
   ```

   Empty → continue silently. Any output → **refuse**, showing the offending paths (already prefixed: `??` untracked, ` M` modified, `M ` staged, `UU` conflicted) and one line: "the loop can't start on a dirty tree — a stray file blocks the final promotion and the run ends with a PR that ships nothing. Commit, stash (`git stash -u`), or delete these, then re-run."

   Ignored files are already excluded (no `--ignored`), so `.sandcastle/worktrees/`, `.sandcastle/logs/`, `.env` and `.last-run-mode` never trip this.

   **Also refuse on an interrupted git operation**, which blocks merges the same way and shows no modified files once resolved:

   ```
   git -C <repo-root> rev-parse -q --verify MERGE_HEAD; \
   ls -d <repo-root>/.git/rebase-merge <repo-root>/.git/rebase-apply <repo-root>/.git/CHERRY_PICK_HEAD 2>/dev/null
   ```

   Any hit → refuse with "finish or abort the in-progress `<merge|rebase|cherry-pick>` first (`git <op> --continue` or `--abort`), then re-run."

   This check runs again in Phase 3. Do not treat one pass as covering the whole run.

5. **Canonical labels present?** The orchestrator writes `ready-for-agent`, `in-progress`, `done`, `needs-human`, `merged-to-staging` and `quarantine`, and crashes the claim path (or the post-merge path, for `merged-to-staging`) if any is missing. `/sandcastle-init` creates them but they drift.

   ```
   gh label list --json name --limit 200
   ```

   Missing subset empty → continue. Otherwise stop with: "missing canonical labels: `<comma-list>`. Run `/sandcastle-init` to recreate them, or `gh label create <name>` — only the names matter." Do not auto-create; a run command surfaces drift, it does not mutate the remote.

6. **Loop already running — for THIS project?** A bare `pgrep` is project-blind and gives a false "already running" that blocks a legitimate launch. Scope by the process's working directory:

   ```
   for pid in $(pgrep -f '[.]sandcastle/main[.]mts (--max-tickets|--iterations|--issue|--max-concurrent|--repo-root|--branch)'); do
     cwd=$(lsof -a -d cwd -p "$pid" -Fn 2>/dev/null | sed -n 's/^n//p')
     [ "$cwd" = "<repo-root>" ] && echo "$pid"
   done
   ```

   The bracketed `[.]` keeps the pattern from matching its own command line, which the owner's wait-loop hook refuses. `--max-tickets` is the loop's current first flag; a pattern without it misses a running loop. A surviving PID → this project's loop is alive; tell the user and offer `/sandcastle-stop` first. Other projects' loops are irrelevant — continue silently, do not report them.

   **To stop any loop, always use `/sandcastle-stop --now`.** It releases leases, deletes lease locks (`refs/locks/issue-N`) and checkpoints in-flight work. A `kill -9` strands all of that and the next launch stalls.

7. **The queue.** Two mutually exclusive paths.

   **With `--issue N` in the args** (one-shot; parse N as a positive integer, else refuse with "invalid `--issue` value"):

   ```
   gh issue view <N> --json number,state,labels
   ```

   - **gh failed** → bubble its error verbatim and stop (auth, network, or a typo'd number — the user needs to see which).
   - **`state` != `OPEN`** → stop: "issue #N is `<state>` — sandcastle only runs on open issues. Re-open it on GitHub if you want to retry."
   - **`in-progress` present** → stop: "issue #N still has `in-progress`, likely orphaned from a crashed run. Remove it (`gh issue edit <N> --remove-label in-progress`), confirm `ready-for-agent` is set, then re-run."
   - **`ready-for-agent` absent** → stop: "issue #N isn't labeled `ready-for-agent` — sandcastle only claims issues with that label. Add it on GitHub (or `gh issue edit <N> --add-label ready-for-agent`) and re-run."
   - All three pass → skip Phase 2 entirely (one-shot runs on the current branch) and go to Phase 3.

   **Without `--issue`** (dispatcher mode):

   ```
   gh issue list --state open --label ready-for-agent --json number,title,body,labels --limit 100
   ```

   Reuse this result in Phase 2 — do not re-query.
   - **Empty queue** → stop: "no open issues labeled `ready-for-agent` — the dispatcher has nothing to claim. Use `/triage-plus-skills` to stamp `type:X` and `ready-for-agent` first." Treat the queue as empty the same way when `SANDCASTLE.md` exists at the repo root and _every_ ready issue lacks a `type:` label — the dispatcher excludes them all and the loop exits on iteration 1.
   - **Blocked-issue phrasing** → the loop's ticket dispatch enforces only the directive **`Blocked by: #N`** (colon required; `Blocked-by:` too), per ADR 0013. Case-insensitively scan titles and bodies for `blocked on #`, `depends on #`, `blocks #`, `blocked by #`, `waiting on #`; any match in the other phrasings, or a bare `blocked by` with no colon, is prose the dispatch **ignores** — warn that ordering will not be honoured and to rewrite it as `Blocked by: #N`. A referenced blocker counts as resolved only when it is **closed**, not merely labelled `done` or `merged-to-staging` while still open — warn on any still-open blocker with the issue numbers.
   - **Blocker concentration — compute it, state the number, make the user choose.** "Some issues are blocked" is not the finding that matters; how much of the queue collapses onto one unshipped ticket is. Build the `Blocked by: #N` graph over the ready set and count, per blocker, how many ready issues depend on it **transitively** (a chain #811→#809→#803 counts against #803).

     If any single blocker gates **half or more** of the ready queue, put it to the user before spending anything, as the blocker question in the Phase 2 picker, with the arithmetic: "N of M ready issues depend on #B, directly or through a chain. The loop dispatches at most `max-concurrent` issues per wave and cannot start a blocked issue. If #B fails or quarantines, all N are dead for the rest of the run and the loop drains after one wave — the remaining iterations are unreachable." Offer the two real options: **ship the blocker first** as its own short run, confirm it lands, then launch the dependents; or **launch anyway**, knowing the run is one wave deep if the blocker fails.

     Do not soften this into a passing note. A prose warning already lived here and did not stop the 2026-08-02 run ([`INCIDENTS.md`](INCIDENTS.md)).

   - **Never advise "holding" a blocked issue by removing `ready-for-agent`.** A `Blocked by: #N` issue stays `ready-for-agent` with the note in its body — the dispatcher auto-excludes it while #N is open and auto-claims it once #N closes (ADR 0013). Unlabelling it defeats the auto-pickup, because the dispatcher cannot see a label-less issue.

## On the target — the machine that will run the loop

Every command in this section is **transported** — it runs on the machine that will run the loop, never on the machine you were invoked on. `transport` is the registry's own word for this, in `.sandcastle/hosts.json`.

- `transport: "local"` → the two machines are the same. The command runs bare.
- Any ssh alias, `vps` included → `ssh <alias> 'cd <repoPath> && <command>'`

Probes and remedies transport alike: the image you build, the lock you delete, the worktree you remove. **A command you did not transport did not run.** It succeeds against the wrong machine and the check reads as passed.

The target is provisional until the picker answers. If the Machines question returns a different machine, this whole section transports again to it before launch. A failing target is **skipped with a reason**, never forced.

With two or more hosts, [`all-machines.md`](all-machines.md) governs how this whole section repeats per host.

8. **Host registry (remote targets only).** Read `.sandcastle/hosts.json`; each entry is `{ name, transport: "local"|"<ssh-alias>", maxConcurrent, repoPath }`. **`repoPath` is REQUIRED for every remote host** — the absolute path to the checkout on that machine. Without it the registry parser refuses the whole file, because a non-interactive `ssh <alias>` lands in `$HOME`, not the checkout. It is optional and ignored for `local`. Missing file → tell the user to create it and stop. Seed:

   ```json
   {
     "hosts": [
       { "name": "local", "transport": "local", "maxConcurrent": 2 },
       {
         "name": "vps",
         "transport": "vps",
         "maxConcurrent": 1,
         "repoPath": "<absolute path of the checkout on that host>"
       }
     ]
   }
   ```

9. **Clean tree on the target.** Same rule and same reason as the clean-tree check on the launch machine, run over the transport: `ssh <alias> 'git -C <repoPath> status --porcelain'`. Non-empty → that host does not launch. Report `skipped (dirty-tree)` with the offending paths; never `-f`, stash, or clean a remote checkout on the user's behalf. The same end-of-run promotion failure applies per host, so a dirty host burns a night and ships nothing.

10. **`psql` present — only when `testDatabase` or `migrations` is set in `.sandcastle/project.json`; otherwise skip. REFUSE if missing.** The host-side database steps shell out to `psql` on the machine running the loop. Absent, **every** database-touching issue fails with a misleading `psql exited 1 with no parseable ERROR lines` and quarantines to `needs-human` — the loop looks healthy while poisoning every such issue ([`INCIDENTS.md`](INCIDENTS.md), 2026-07-25).

    ```
    command -v psql
    ```

    Non-zero → refuse with the fix for that host's OS: macOS → `brew install libpq && brew link --force libpq`; Linux → `sudo apt-get install -y postgresql-client`.

11. **Sandbox runtime.** Read `.sandcastle/.sandbox-flag` (one bare line: `docker` or `mac-host`; missing → default `docker`, matching the wrapper's fallback). Read `.sandcastle/profile` for the human-readable name, used in messages only. Call the value `sandbox_runtime`.

    **`docker`** — check in order until one responds: `docker ps` (Docker Desktop or OrbStack), `podman ps`, `colima status`. None respond → "no container runtime is running", recommend starting their installed one; nothing installed → point at `/sandcastle-init`, which carries the install recommendations (OrbStack first on Mac).

    **`mac-host`** — the loop runs host-native, no Docker. **Classify the target first** by inspecting the project root, then run only the matching branch:
    - `Package.swift` present **and** no `.xcodeproj`/`.xcworkspace` → **macOS-GUI SwiftPM target**. Run `swift --version`; failure → refuse with "the Swift command-line toolchain isn't available — run `xcode-select --install`". Confirm `Package.swift` still exists; gone → refuse with "no `Package.swift` found". Do **not** run `xcodebuild` or `xcrun simctl` here — the mac-host executor needs only `git`, PATH and `swift`, and refusing on `xcodebuild` is a false positive.
    - Otherwise → **iOS / Xcode target**. Run `xcodebuild -version`; failure → refuse with "Xcode not installed or command-line tools not selected". Run `xcrun simctl list devices available | grep -q .`; failure → refuse with "no iOS Simulator runtime installed — run `xcodebuild -downloadPlatform iOS`".

12. **Docker image built? — `docker` runtime only.** Skip entirely under `mac-host`; the Dockerfile is inert there. Iteration 1 fails immediately with `Image 'sandcastle:<name>' not found locally` when the image is missing — common on fresh worktrees or after a prune.

    **When the project's `package.json` has a `sandcastle:build-image` script, the loop owns the image name: run `pnpm sandcastle:build-image` and continue** (add `--image-name NAME` only if the user passed one). It builds under the exact name the loop runs, and rebuilds when the image's Claude Code is older than this machine's. A name worked out by hand here once drifted from the loop's (the 2026-10-13 wrong-image night in [`INCIDENTS.md`](INCIDENTS.md)).

    Otherwise: image name = `--image-name NAME` if the user passed it, else `sandcastle:<basename of repo-root, lowercased>` (Docker image names are lowercase; the library lowercases the default the same way). Check `docker image inspect <image-name> > /dev/null 2>&1`. Exists → continue. Missing → build it before launching:

    ```
    <pkg-mgr-bin>/sandcastle docker build-image --image-name <image-name> --dockerfile .sandcastle/Dockerfile
    ```

    `<pkg-mgr-bin>` is `node_modules/.bin`. The build takes ~30s and produces a ~750MB image — stream its output so the user sees progress, and do not background it. A failed build → bubble its stderr verbatim and stop; iteration 1 would fail the same way. On success, log `built <image-name> (Dockerfile=.sandcastle/Dockerfile)` and continue.

13. **`.sandcastle/` prompt files committed? — `mac-host` ONLY.** **Skip under `docker`** — there the orchestrator reads prompts from the launch root, so a gitignored `.sandcastle/` is the normal template default and checking here refuses healthy repos ([`INCIDENTS.md`](INCIDENTS.md)). Under `mac-host` the executor reads prompts from inside each per-issue worktree, which carries only tracked files:

    ```
    git ls-files --error-unmatch .sandcastle/implement-prompt.md >/dev/null 2>&1; echo $?
    ```

    `0` → continue. Non-zero → refuse: "on the `mac-host` profile the loop reads prompts from inside each per-issue worktree, which carries only git-tracked files — and `.sandcastle/` isn't committed, so the implementer would fail with `prompt file not found`. Commit the tooling first: `git add .sandcastle/ && git commit -m \"chore: track sandcastle tooling\"` — your `.env` stays excluded via `.sandcastle/.gitignore` (verify with `git status --porcelain .sandcastle/.env` showing nothing staged)." Do not auto-commit into the user's product repo; that is their call.

14. **Is a loop alive on the target, and are its locks real?** A hard-killed loop leaves `refs/locks/issue-N` locks and `in-progress` labels stranded, and this launch would read them as claimed by a live peer and stall. A _running_ loop leaves locks that look identical. Tell them apart on the target itself — the launch machine's process list proves nothing about another machine, and measuring the target's locks against it marks every lock dead.

    ```
    pgrep -f '[.]sandcastle/main[.]mts (--max-tickets|--iterations|--issue|--max-concurrent|--repo-root|--branch)'
    ```

    Keep a PID when its working directory is the target's `repoPath` — `readlink -f /proc/<pid>/cwd` on Linux, `lsof -a -d cwd -p <pid> -Fn` on macOS.
    - **A PID survives** → the target's loop is alive. Offer `/sandcastle-stop`, do not launch a second loop onto it, and leave every lock alone.
    - **None survive** → the locks are orphaned. Per issue: `git update-ref -d refs/locks/issue-N` and `gh issue edit N --remove-label in-progress --add-label ready-for-agent`.

    Delete op: name the dead owner before removing. A lock held by a live loop, or by a peer host still running, is real.

15. **Reap leftovers from aborted runs.**
    - **Stale per-issue worktrees:** for each `.sandcastle/worktrees/agent-issue-*` whose branch sits at the base SHA with **no new commits**, `git worktree remove --force <path>` and delete its branch. **Preserve any worktree checked out on a `wip/issue-*` branch** — that holds real checkpointed work.
    - **Orphaned containers:** `docker rm` any **exited** `sandcastle-*` containers; leave running ones alone. Skip under `mac-host`.
    - Delete op — confirm a branch is at base with no commits before removing, and only remove exited containers.
    - **This deliberately keeps any `agent/issue-*` branch that HAS commits.** That is real work. But a kept branch is exactly the one that gets silently resumed at its old tip — **Phase 3 gates those.** "Reap ran" does not cover them.

16. **Purge ghost cross-host refs and stale lease locks.** Stale coordination refs from a retired or previous run poison the sync and can fake a merge `CONFLICT` on iteration 1 ([`INCIDENTS.md`](INCIDENTS.md)).
    - **Enumerate** on local, origin and the target: `refs/sandcastle/{lanes,peers,peer-status,status,conflict}/*` and `refs/locks/issue-*`. Local/host `git for-each-ref`; origin `git ls-remote origin 'refs/sandcastle/*' 'refs/locks/*'`; remote `ssh <alias> 'git -C <repoPath> for-each-ref refs/sandcastle refs/locks'`.
    - **Stale** = points at a commit not in the current run branch's history, matches an `archive/*` tag, or belongs to a dead or retired prior run.
    - **Delete:** local/host `git update-ref -d <ref>` (remote via `ssh <alias> 'git -C <repoPath> update-ref -d <ref>'`); origin `git push origin :<ref>`.
    - **CRITICAL — preserve `refs/sandcastle/strand/*` and `refs/sandcastle/wip/*`.** They hold real checkpointed work; deleting them destroys it. Never sweep them.
    - Delete op: cite per ref the commit it points at and why it is stale, before removing.

17. **Cross-host switches coherent — remote targets only.** The pair `SANDCASTLE_CROSS_HOST_LEASE=1` and `SANDCASTLE_CROSS_HOST_SYNC=1` lives in each host's `.env` or `~/.config/sandcastle/.env`. **SYNC set without LEASE makes the loop refuse to start** — and a host that took part in an earlier multi-host run is exactly where a half-set pair survives. Read both on the target and refuse before launching if SYNC is on and LEASE is not, naming the file to fix. Both off is fine for a single-host run; both on is fine. With two or more hosts, [`all-machines.md`](all-machines.md) requires both on everywhere.

---

# Phase 2 — Plan the run

Skip this whole phase on `--issue N` (one-shot runs on the current branch — go straight to Phase 3).

This is the friction-killer. A bare `/sandcastle-run` auto-discovers everything mechanical — surveys the queue, picks a base, names the branch, sizes the ticket cap — so the user never hand-picks a base branch or invents a name. It then asks only the operational choices they want control of. Treat any of `--branch` / `--label` / `--max-tickets` / `--max-concurrent` the user did pass as fixed, and auto-derive only the rest.

1. **Filter to dispatchable, then group.** Does `SANDCASTLE.md` exist at the repo root (`test -f SANDCASTLE.md`)?
   - **Yes** → skill discipline is on and the dispatch contract needs both labels. Partition the ready set from the queue check into **dispatchable** (has a `type:`) and **typeless**. The dispatcher excludes typeless issues and the host re-validates them out, so they will not run. Count, group, name and size using **only the dispatchable set**, and surface the typeless ones among the picker's inline warnings: "#X, #Y are `ready-for-agent` but missing a `type:` label — they won't be dispatched. Run `/triage-plus-skills` (the only skill that stamps `type:`) or add one by hand." Every ready issue typeless → the dispatchable queue is empty; say so and do not launch.
   - **No** → skill discipline is off; every `ready-for-agent` issue is dispatchable.

   Then **group the dispatchable issues** into epics or themes, strongest signal first: an explicit parent reference in the body (`epic #N`, `parent #N`, `part of #N`), a shared milestone, a shared area label, or a common title prefix or feature noun. Short kebab slug plus count per group. One cohesive feature is one group.

2. **Note runnability.** Carry per group which issues are `Blocked by: #N` with #N still open, since the dispatcher excludes those until #N closes — e.g. "marketing ×7, 1 blocked by #468".

3. **Pick the base branch.** Skip if the user passed `--branch`. Base = freshly fetched `origin/main` (`git fetch origin main --quiet`), unless the user names another. The launch root usually sits on the last run's branch, so "the current branch" is the wrong base; the run lands on `main`, and the launch gate refuses any run branch behind it.

4. **Name the run branch here; create it after the picker.** The scope answer renames it, and Phase 3 compares every leftover branch against the created name — so a branch cut before the answer is cut against a name that is about to change. Always fresh, dated and human-readable, which keeps an unattended batch off the shared integration line.
   - `theme` = one group → its slug; two groups → `slugA+slugB`; three or more, or no clean grouping → `queue`. **Scoped to one epic by the picker → that epic's slug alone.**
   - `name = sandcastle/<theme>-$(date +%Y%m%d)`.
   - **Branch already exists** (`git rev-parse --verify --quiet refs/heads/<name>`) → **reuse it** and continue the same batch. This is the relaunch path after a drain. Do not suffix `-2`. `git checkout <name>`. Reuse continues a batch only while the branch is still current: a leftover from an earlier day forks from a stale `main` and looks identical to a same-day relaunch, and Phase 3's base-currency gate is what tells the two apart (the 2026-08-28 stale-run-branch night in [`INCIDENTS.md`](INCIDENTS.md)).
   - Otherwise `git checkout -b <name> <base>`.
   - Pass `--branch <name>` to the loop.
   - **The launch worktree MUST be on `<name>`** — load-bearing, not cosmetic. The orchestrator cuts each per-issue worktree from the launch worktree's current HEAD, so a worktree parked on a stale branch makes every merged issue silently re-do the foundation (the layering bug, in [`INCIDENTS.md`](INCIDENTS.md)).
   - If `git checkout` refuses here, a parallel session dirtied the tree after the clean-tree check passed: **stop and surface it**, never `-f`.

5. **Recommend concurrency** — this becomes the picker's pre-selected default. Recommend `2` for independent slices of one cohesive group. Recommend `1` on collision risk:
   - the run spans 2+ groups, or
   - 2+ ready issues touch the same surface — scan titles and bodies for shared file paths and shared-surface nouns (`schema`, migration files, the tRPC root router, shared config).

   Carry the reason when you recommend `1`, so the picker can show it (e.g. "#X and #Y both touch schema.ts").

6. **Size the ticket cap.** `--max-tickets = max(50, ready_count + 30)` (`--iterations` is its deprecated alias; the remote launcher still spells it `--iterations`). Over-provisioning is free — the loop exits the instant the queue drains. When _you_ sized it, the headroom is deliberate and silent. When the user passed the cap themselves and it is below the queue size, warn once that the loop stops after that many tickets. Warn, never refuse.

7. **Ask the launch questions.** **This picker is REQUIRED, and skipping it is not a FIDO win.** A global "default to action, only ask on WHAT not HOW" instruction does not authorise skipping it, and these are not HOW. Machines, concurrency and mode are WHAT: they commit the user's money, machines and hours to an unattended metered run. Launching without asking is the irreversible-action exception FIDO itself carves out — a `2` you inferred spends real credits the user never agreed to. A _recommended default_ is not an _answer_. The only licence to drop a question is a flag that already answers it — `--max-concurrent` drops concurrency, `--backend` or `--provider` drops mode, `--host`/`--all` drops machines. **Nothing left to ask → skip the picker and launch.** A picker with no open question is not consent, it is a tap.

   Use **`AskUserQuestion`**, **batched into a SINGLE call** — one question per knob — so it is one picker and a couple of taps. Order each option list with the recommended default first, marked `(default)`.

   **The caps are 4 questions and 4 options per question.** The possible questions are machines, concurrency, mode, scope, and the blocker choice from the queue check. They fit: concurrency is asked only for a local target, which is exactly when machines is not asked; scope exists only with 2+ ready epics; the blocker choice only when one ticket gates half the queue. Build the batch against the **provisional** target resolved above.

   **a. Machines** — whenever the target set above was left unresolved. Options `just the VPS (default) / this machine only / all healthy hosts`. **Ask this first**: the answer decides whether the concurrency question is asked at all. Skip on a single-host registry or an explicit `--host`/`--all`. If the user leaves it untouched, run on `vps`. When they do pick all machines, say in one line that each host opens its own run PR and all of them need reconciling before any merges.

   **b. Concurrency** — options `1 / 2 / 3 / 4`, default = the concurrency recommendation above, with its collision reason shown. Note that >2 raises collision risk on shared files. **Any remote target — including a single-host `vps` pick — skip this question entirely.** Per-host concurrency comes from `maxConcurrent` in the registry, and `launch.mts` has no `--max-concurrent`, so an answer would be silently discarded. Ask it only for a `transport: "local"` target.

   **c. Mode** — four options, default = the remembered mode below or `opus-5.5`. Describe each from the `--opus`, `--budget` and `--backend` entries of `.sandcastle/main.mts --help`, the source of truth for models and prices:
   - `opus-5.5 (default)` → no model flag; `.sandcastle/models.ts` runs Opus 5.5 on every heavy role.
   - `opus-5.5 + budget (cheaper)` → `--budget`. The builder's first pass runs on Sonnet 5 (~40% cheaper), with Opus on retry. The builder is the loop's biggest spender, so this is the **main cost lever**.
   - `opus-5` → `--opus 5`, the step back if Opus 5.5 misbehaves.
   - `codex` → `--backend codex`.

   `kimi` and `glm` stay out of the four because of the option cap. They remain reachable through the picker's **Other** field or `--provider kimi|glm`, which drops this question.

   **e. Blocker choice** — only when the queue check found one ticket gating half or more of the ready queue. Options `launch all (default) / the blocker alone first`, with the arithmetic in the question text.

   **On a remote target the picker's answer is translated, and not all of it survives** — see _Remote target_ under "Start the loop" before you promise the user a model.

   **d. Scope** — only with 2+ ready epics. Options `both interleaved / <epic-A> only / <epic-B> only`, default `both`. Picking one epic scopes the run to it and names the branch for that single epic.

   **Surface the warnings inline while asking**, so the choice is informed: a base you resolved rather than inherited, any `Blocked by:` ordering caveat, and any typeless `ready-for-agent` issues that will not run.

   **After the answers, in this order:** apply the scope answer to the branch name, then create and check out the run branch, then record the mode, then re-run Phase 1's "On the target" section if the Machines answer changed the target, then Phase 3.

8. **Remember the mode** so "ask every time" stays one tap. Read `.sandcastle/.last-run-mode` (one line: `opus-5.5`|`opus-5`|`codex`|`kimi`|`glm`) for the default; absent → `opus-5.5`. A legacy `claude` or `opus-4.8` value means `opus-5.5`. Write the pick back after the user answers.

   **`opus-5.5 + budget` persists as `opus-5.5`** — never persist a budget variant. `--budget` is a money decision worth re-offering every run, so it is re-presented as its own option each time. Ensure `.last-run-mode` is git-ignored.

---

# Phase 3 — Launch gate

These run **immediately before the launch line**, after planning and the picker. Each catches something that was fine at Phase 1 and is not any more.

0. **Did the picker change the target?** If the Machines answer differs from the target you checked in Phase 1, **re-run the whole "On the target" section of Phase 1 against the new machine** before anything else here. Skipping this launches onto a machine with no clean-tree check, no `psql` check, no container runtime check, no image, and no reap — the 2026-07-25 silent-quarantine night in [`INCIDENTS.md`](INCIDENTS.md) is exactly that state.

1. **Clean tree, again.** Planning, branch creation and the picker all take time, and a parallel session can dirty the tree in between. Re-run the clean-tree check's `git status --porcelain` and abort the launch if it is no longer empty. Run this before pushing the run branch on the remote path too. It is nearly free.

2. **The run branch must contain current `origin/main` — REFUSE if it doesn't.** A run branch cut from — or reused from — a checkout behind `main` builds every issue on stale code: the loop runs machinery and app code `main` has already moved past, re-does shipped work, and labels its own failures with rules `main` has since fixed. Phase 2's reuse path is the common way in — an existing `sandcastle/<theme>-<date>` from an earlier day forks from an old `main` and looks identical to a same-day relaunch.

   Run on the launch machine, **after** the run branch is checked out. Fetch first — this machine's own `origin/main` ref can itself lag:

   ```
   git fetch origin main --quiet
   git merge-base --is-ancestor origin/main <name> && echo CURRENT \
     || echo "STALE: <name> is $(git rev-list --count <name>..origin/main) commits behind origin/main"
   ```

   **`CURRENT`** → continue silently. **`STALE`** → **refuse.** Report the fork point (`git show -s --format='%ci %s' $(git merge-base origin/main <name>)`) and how far behind it is. Say plainly: "this run would build on code behind `main` — the loop runs stale machinery, redoes shipped work, and mislabels its failures" (the 2026-08-28 stale-run-branch night in [`INCIDENTS.md`](INCIDENTS.md)).

   **A branch this run cut minutes ago, with zero unique commits, is not a leftover.** `main` simply moved during planning: fast-forward it silently (`git merge --ff-only origin/main`) and continue. For any older branch:

   **Offer both remedies; never decide.** Both are safe when the branch holds no unique commits (`git rev-list --count origin/main..<name>` returns `0`) — cite that count first.
   - **Bring it current** — `git rebase origin/main <name>`. Conflicts → stop; never resolve them inside a launch.
   - **Cut fresh** — the branch is a stale leftover, not a live batch: archive it (`git branch -m <name> archive/<name>-stale-$(date +%Y%m%d)`), then recreate `<name>` from `origin/main`.

   Re-push the corrected branch to origin before a remote launch, so the host fast-forwards onto current code. This gate and the stale-`agent/issue-*` gate below are the two "is the base current?" checks; they are siblings, run back-to-back.

3. **Stale leftover `agent/issue-*` branches — REFUSE, with the remedy.** Run this **after** the run branch is checked out — that is the only moment `<name>` is definitive, on both the fresh and the relaunch path. The reaper deliberately preserves the branches this catches, so "reap ran" does not cover it.

   **Run it on the machine that will run the loop**, wrapped over the transport for a remote target. The branches that get silently resumed live in the target's checkout; scanning this Mac for a `vps` run returns nothing and the gate passes on a hazard it never looked at. `<name>` is the run branch you just created here and pushed.

   ```
   for b in $(git for-each-ref --format='%(refname:short)' 'refs/heads/agent/issue-*'); do
     git merge-base --is-ancestor <name> "$b" 2>/dev/null || echo "STALE $b $(git rev-parse --short "$b")"
   done
   ```

   **No output** → continue silently. **Any `STALE` line** → **refuse.** Per branch, report the branch, its tip SHA, the date and subject of its last commit (`git log -1 --format='%ad %s' --date=short <branch>`), and whether that issue is in this run's claimable set. Say plainly: "these will be resumed at a stale base and will burn a full slice each producing nothing" ([`INCIDENTS.md`](INCIDENTS.md), 2026-08-02).

   **Offer both remedies; never decide for them.** Deleting a branch with commits is a delete op — cite the tip SHA first.
   - **Discard and start clean** (the old attempt predates a fix it depended on): archive to `refs/sandcastle/archive/issue-<N>-stale-<date>` via `git update-ref`, remove any attached worktree (`git worktree remove --force .sandcastle/worktrees/agent-issue-<N>`), then `git branch -D agent/issue-<N>`. The archive ref is free, invisible and makes the discard reversible.
   - **Bring it current** (the old attempt holds work worth keeping): `git rebase <name> agent/issue-<N>`. Conflicts → stop; do not resolve conflicts on the user's behalf inside a launch.

   Branches whose issue is **not** in the claimable set may be left alone — say so explicitly rather than ignoring them silently. **Preserve `wip/issue-*` branches and `refs/sandcastle/wip/*` refs**; those are checkpointed work with their own resume path.

4. **API key for the chosen mode.** Only now is the mode certain. The orchestrator loads keys from a chain, first hit per key winning: `process.env` → `$SANDCASTLE_ENV_FILE` → `<repoRoot>/.sandcastle/.env` → `<repoRoot>/.env` → `$XDG_CONFIG_HOME/sandcastle/.env` or `~/.config/sandcastle/.env`.

   **Check only the key the chosen mode needs:**
   - `opus-5.5` and `opus-5` → both use the local Claude subscription. **No API key. Skip entirely** — this is the common case, and demanding a key here is a false alarm that blocks the default run.
   - `codex` → uses Codex's own auth, validated on its own path. **Skip.**
   - `--provider kimi` → `KIMI_API_KEY`. `--provider glm` → `GLM_API_KEY`. `--provider anthropic` → `ANTHROPIC_API_KEY`.

   When a key is required, confirm it resolves (substitute the var):

   ```
   ( source "$HOME/.config/sandcastle/.env" 2>/dev/null; \
     source "<repoRoot>/.env" 2>/dev/null; \
     test -n "$KIMI_API_KEY" )
   ```

   Unresolved → tell the user to create `~/.config/sandcastle/.env` (recommended, set once for all projects; `mkdir -p ~/.config/sandcastle && chmod 600 …`) or `<repoRoot>/.env` (project-only), using `.sandcastle/.env.example` as a template, then stop.

   **When a flag already fixed the mode, run this at the end of Phase 1 instead** — before Phase 2 creates a branch and writes `.last-run-mode`, so a missing key does not leave a branch and a persisted mode behind for a run that never happened.

---

# Start the loop

Detect the package manager the same way `/sandcastle-init` does: `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `package-lock.json` → npm.

Then fork on the **target's transport**, never on how many hosts were picked.

## Local target (`transport: "local"`)

**The real launcher is the wrapper — `bash .sandcastle/sandcastle-wrapper.sh`.** Never call `tsx .sandcastle/main.mts` directly: the wrapper adds two load-bearing things the direct call skips — **hot-reload restart** (exit 75, so a recovery agent's on-disk fix gets picked up) and **`--sandbox` forwarding** from `.sandcastle/.sandbox-flag`.

Confirm the launcher exists silently — `node --print "require('./package.json').scripts?.sandcastle || ''"`.

- **Script present** → launch through the package manager. Copy these verbatim; only `npm run` takes the `--` separator, and a stray `--` makes pnpm fail to parse and the orchestrator never starts:
  - pnpm: `pnpm sandcastle <flags>`
  - npm: `npm run sandcastle -- <flags>`
  - yarn: `yarn sandcastle <flags>`
- **Script missing** (older template, or a hand-wired setup) → do not hunt for an alternative and do not fall back to `tsx`. Launch the wrapper directly with `node_modules/.bin` on PATH so bare `tsx` inside it resolves, then add the script so next time is clean. Do not announce either — a missing script is a silently-handled snag, not a blocker.

  ```
  PATH="$PWD/node_modules/.bin:$PATH" bash .sandcastle/sandcastle-wrapper.sh <flags>
  npm pkg set scripts.sandcastle="bash .sandcastle/sandcastle-wrapper.sh"
  ```

Foreground is for short test runs. Background is the default at `--max-tickets >= 5`. Run every launch line from the launch root, whose `node_modules` the wrapper needs:

- **Use a per-project log path** — `/tmp/sandcastle-<repo-basename>.log`. A shared `/tmp/sandcastle.log` interleaves two projects' loops into one file. Remember the exact path for the alive-check and the summary.
- **Fork on whether the machine can host the loop as its own service** — `systemctl --user show-environment >/dev/null 2>&1 && [ "$(loginctl show-user "$(id -un)" -p Linger --value)" = yes ] && echo own-service` (the Linux servers: yes; macOS: no). Lingering keeps the user's systemd manager, and so the loop, alive after logout; without it the manager stops ~10 s after the last login ends and takes the loop with it.
  - **Own service (Linux)** → launch the loop as its own user service, so it lives outside the app that ran this skill. The unit name is the same shell expression `OWN_SERVICE_UNIT_SH` in `.sandcastle/lib/hosts/launch.ts` uses, so this road and `/sandcastle-resume` share one unit per checkout:

    ```
    u="sandcastle-$(printf %s "${PWD##*/}" | tr -c 'A-Za-z0-9_.-' _)"
    systemd-run --user --collect --unit="$u" --working-directory="$PWD" \
      -E PATH="$PWD/node_modules/.bin:$PATH" -E HOME="$HOME" \
      $(env | sed -n 's/^\(SANDCASTLE_[A-Za-z0-9_]*\)=.*/-E \1/p') \
      bash -c 'exec <launch> > /tmp/sandcastle-<basename>.log 2>&1 < /dev/null'
    pid=$(systemctl --user show "$u" -p MainPID --value)
    ```

    The `env | sed` line works in zsh and bash alike; `-E NAME` with no value copies that variable from the calling shell. A chat's `nohup … & disown` leaves the loop inside the chat app's service, and systemd kills that whole service on a restart: on 2026-10-13 a T3 Code restart SIGKILLed a two-hour, three-ticket run mid-check-writer (`INCIDENTS.md`). The loop gets the service manager's environment: PATH, HOME and every exported `SANDCASTLE_*` setting are copied across, any other one-off export is not. If `systemd-run` refuses because the unit already exists, a loop for this checkout is still running: report it as running rather than renaming the unit.

  - **Otherwise (macOS, or no lingering)** → `nohup <launch> > /tmp/sandcastle-<basename>.log 2>&1 < /dev/null & disown`, with `pid=$!` captured **before** `disown`, or it is gone. Never prefix `setsid` — it does not exist on macOS and can make the shell spawn the loop twice.

- **The alive-check reads the log, then the captured PID or unit.** The loop runs its own pre-flight first and can refuse within seconds, so wait (bounded) for the first deal or a refusal:

  ```
  timeout 120 bash -c 'until grep -qE "dealer refill|pre-flight checks failed" /tmp/sandcastle-<basename>.log; do sleep 2; done'
  ```

  `dealer refill` plus a live process (`systemctl --user is-active "$u"`, or `kill -0 $pid`) → launched. `pre-flight checks failed` → the loop refused: show its message, fix what it names, and launch again. One refusal needs the owner's yes first, and only when `testDatabase` is set in `.sandcastle/project.json`: **the test-database template is BEHIND this checkout.** The fix is the project's own template-rebuild command (its `SANDCASTLE.md` names it); it deletes and rebuilds that template database, and every delete waits for the owner's yes. Ask it as one question: "The test database template is N changes behind the code. Rebuild it (deletes and remakes the template only) and launch again?" On the owner's yes, run it on the target, then relaunch. The refusal costs seconds and no money, which is why this check waits for the loop's own pre-flight rather than running before launch. A timeout → show the log's tail.

- Any monitor you set up keys on this run's log path or captured PID.

## Remote target (any ssh-alias transport, `vps` included)

Do not launch locally via the wrapper. The branch was created here; push it and hand off:

1. **Push the run branch to origin** so the host can fetch it — the launch gate fast-forwards the host onto it.
2. **Launch through the shared script.** Per-host concurrency comes from the registry automatically:

   ```
   tsx .sandcastle/scripts/launch.mts --action run --branch <run-branch> --mode <mode> --iterations <n> [--host <name>]
   ```

   **`--mode` is its own axis and takes only `claude | codex | kimi | glm | budget`** (`LAUNCH_MODES` in `.sandcastle/lib/hosts/launch.ts`), which `modeFlag` then translates into the `--backend`/`--provider`/`--budget` flags `main.mts` actually accepts — `main.mts` itself has no `--mode`. Passing anything else fails immediately with `--mode must be claude|codex|kimi|glm|budget`. Translate the picker's answer:

   | Picker answer       | `--mode`     | Carried?                                                     |
   | ------------------- | ------------ | ------------------------------------------------------------ |
   | `opus-5.5`          | `claude`     | yes                                                          |
   | `opus-5.5 + budget` | `budget`     | yes — the cheaper Sonnet-5 implementer first pass does cross |
   | `opus-5`            | `claude`     | **no** — the Opus-5 profile is single-host only              |
   | `codex`             | `codex`      | yes                                                          |
   | `kimi` / `glm`      | `kimi`/`glm` | yes                                                          |

   Anything outside the five fails instantly with `--mode must be claude|codex|kimi|glm|budget`. The `--opus 5.5|5` profile is threaded only on the single-host `main.mts` path, so when the user picked `opus-5` for a remote target, say in one line that it runs on the standard Claude profile — the summary never names a model that is not running.

   **Never pass `--base`** — `main.mts` has no such flag and rejects it with `Unknown option '--base'`, killing the launch instantly. The run branch already exists and is pushed, so the host fast-forwards onto `--branch`.

   **Dry-run first** with `--dry-run` to show the user the exact command the host would run — especially the remote ssh and detach line — before committing.

3. **Report the outcome** the script prints: `launched`, or `skipped (<reason>)` where the reason is `unreachable / already-running / dirty-tree / diverged / auth-failed / preflight-error`. Never force a skipped host; tell the user what to fix (a `diverged` host has local commits not on origin — resolve by hand). **Never forward credentials to a remote host**; it uses its own auth.

**After a remote launch:** watch with `/sandcastle-status`. Stop with `/sandcastle-stop` — add `--now` when the user must leave immediately, which checkpoints in-flight work first. To bring a stopped machine back into an in-flight run without planning new work, use `/sandcastle-resume`.

**Two or more hosts → [`all-machines.md`](all-machines.md)** adds the cross-host flags, the per-host repeat, and the one-at-a-time launch order. Follow it in addition to this section.

---

# The summary

A few short lines, plain English. Never recount the checks that passed or dump command output.

- The grouping, base, branch name, concurrency with a one-word reason, the ticket cap, and the model actually running.
- The alive-check result, the log path, and "run /sandcastle-status to watch".
- How the run lands. Where the project's `CLAUDE.md` defines landing (when `landCheck` is set in `.sandcastle/project.json`, the loop lands its own run pull request after that command passes on the run branch tip; with no `landCheck` it never lands it and waits for the owner), say that. Otherwise give `git checkout <base> && git merge --ff-only <name>`.
- The mid-run reality: _"The dispatcher re-checks `ready-for-agent` every cycle, so anything you grill mid-run gets claimed automatically — as long as the bucket doesn't fully empty. If it drains to zero the loop exits cleanly by design; just re-run `/sandcastle-run` and it continues on the same branch."_

---

# Flags

The source of truth is the `HELP_TEXT` block in `.sandcastle/main.mts` (or `--help`): every flag, its default, which flags combine, and the models each mode runs. Read it before naming a flag or a model to the user; this file keeps no copy, because its last copy went stale. Pass flags through verbatim when the user names them.

**Defaults when planning is skipped** (one-shot `--issue N`): `--max-tickets 50`, `--max-concurrent 2`, `--branch <current-branch>`. Otherwise Phase 2 fills them.
