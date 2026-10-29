# All machines (2+ hosts)

The multi-machine branch of [`SKILL.md`](SKILL.md): the VPS **and** this Mac **and** any other VPS, running as one combined loop over a single GitHub queue. Reach this file only when the resolved target set has **two or more hosts** — "all my hosts", "across my machines", "this Mac + the VPS", `--all`.

A single remote host — the default `vps`-only run — is **not** this file. It uses the remote start sequence in `SKILL.md`, which already covers the registry, the per-host gates, pushing the branch, and `launch.mts`. Everything here is what those gates do **not** cover once a second machine joins.

**Say the cost out loud before launching.** Multi-host has no cross-host coordination of migration numbers and no journal merge driver, so a schema-touching run collides by construction and costs a human reconciliation session. Each targeted host also opens **its own run PR**, and all of them must be reconciled before any can merge. The 2026-07-30 evidence is in [`INCIDENTS.md`](INCIDENTS.md). This is why one host is the default; a user who explicitly picks all machines gets one line naming both costs, not a lecture.

## What a second machine adds

1. **Cross-host flags on, on EVERY host.** The combined run only coordinates if both `SANDCASTLE_CROSS_HOST_LEASE=1` and `SANDCASTLE_CROSS_HOST_SYNC=1` are set, in each host's `.env` or `~/.config/sandcastle/.env`. SYNC-without-LEASE makes the loop refuse to start. If you cannot confirm both on a host, warn — without them the machines double-work and never hand off.

2. **Run every per-host gate against every target, not just the first.** The remote start sequence in `SKILL.md` gates one machine; here run the whole set once per targeted host over its transport — `psql` present, clean tree, orphaned lease reconcile, stale-worktree and container reap, ghost-ref purge. A host that crashed on a previous run carries its own stranded locks, `in-progress` labels, worktrees and containers, and a per-host gap is invisible unless you check each host. A failing host is **skipped**, never forced: report it as `skipped (<reason>)` and launch the rest. Same preserves apply per host — never touch a live peer's lock, never remove a `wip/issue-*` worktree.

3. **Pick the targets and name them out loud.** Default = every host in the registry; `--host <name>` or the user's phrasing narrows it. **Report which hosts you are targeting** before launching any of them — this is the one place the user can catch a host they did not mean to spend a night on. The plan itself is made **once**, here, and the identical branch, mode and iteration count go to every host, so the machines act as one loop over one queue.

4. **Launch the targets ONE AT A TIME.** Two hosts that plan simultaneously race on the same narrow claimable set and the second exits on an empty iteration (2026-07-25, in `INCIDENTS.md`). Launch a host, wait until it has actually claimed work, then launch the next. Order the local host first when it is a target — it is fastest to confirm — then the remotes.
   - **Dry-run first** with `--dry-run` across all hosts, to show the user the exact command each host would run before committing.
   - Then per host: launch with `--host <name>`, then **poll until it has claimed** — every ~10s, up to ~90s, check whether that host's `in-progress` label count has risen, or its log shows a `plan:` / `claimed` / `→ agent/issue-` line (local: tail the per-project log; remote: `ssh <alias> 'tail -n 40 <its log path>'`). The moment claim is confirmed, move on.
   - If a host has not claimed after ~90s, launch the next **anyway** and note it in the summary (e.g. "host `hub` hadn't claimed after 90s — launched `local` regardless; check it with /sandcastle-status"). one slow dispatcher never stalls the fan-out.

## Reporting and after

Report the per-host outcome the launch script prints — one line each: `launched`, or `skipped (<reason>)` where the reason is `unreachable / already-running / dirty-tree / diverged / auth-failed / preflight-error`. Tell the user what to fix on a skipped host (a `diverged` host has local commits not on origin — resolve by hand). **Never forward credentials to a remote host**; each uses its own auth.

Watch the combined run with `/sandcastle-status` (its all-machines branch) or `pnpm sandcastle:watch` — the viewer fuses every host's counts. Stop with `/sandcastle-stop --all`, adding `--now` when the user must leave immediately, which checkpoints in-flight work first. To bring a stopped machine back into an in-flight run without planning new work, use `/sandcastle-resume`.

**Mode translation is the same as any remote target** — the table in `SKILL.md`'s _Remote target_ section, applied identically to every host. `budget` crosses hosts; the Opus-5 profile does not.
