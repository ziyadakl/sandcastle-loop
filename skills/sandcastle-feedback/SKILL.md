---
name: sandcastle-feedback
description: After a sandcastle session goes wrong, export the real transcript and dispatch a clean-context subagent to audit it, returning findings to the user. Use when the user runs /sandcastle-feedback, says "write sandcastle feedback", "audit this sandcastle session", or "capture what went wrong with sandcastle".
argument-hint: "[optional: focus area, e.g. 'lockfile dedup' or 'launch-worktree drift']"
---

## Pick the right mode FIRST

Before doing anything else, decide which mode this invocation is in. The two modes use different machinery — picking the wrong one wastes effort.

- **DIRECT PROPOSAL mode** — user wants a specific forward-looking change captured for the sandcastle template: "add /simplify to the loop", "make X work for other projects", "propose Y". Memory is not under suspicion — the user is asking you to *write something down*, not *figure out what went wrong*. Skip the transcript export. Skip the subagent. Just write a focused proposal directly from your in-context conversation. Fast.
- **AUDIT mode** — user wants to know what went wrong in this session, or passed no argument at all. Memory IS under suspicion (the same context that produced the bugs is the one summarising them). This is when you need the full machinery: export transcript → dispatch clean-context subagent → relay findings.

**How to pick — the right test is not verb-matching.** "Fix the disk-drift bug" sounds forward-looking but is retrospective; a lazy verb-match would skip the audit and hallucinate a cause from polluted memory. Use this test instead:

> **Does the ask reference something that happened in this session?**

- **Yes — references past session events** (an incident, a bug we hit, "what we found", "the issue from earlier", "the X we discussed") → **AUDIT mode**, even if phrased with a forward verb. The transcript is needed because in-context memory of those events is suspect.
- **No — fresh forward-looking ask with no past-incident reference** ("add /simplify to the loop", "make X work for other projects", "include Y in the template") → **DIRECT PROPOSAL mode**. Nothing to audit.
- **Ambiguous or you can't decide in 2 seconds** → **AUDIT mode**. Default safer. Over-auditing costs a minute; under-auditing ships a wrong proposal built on a hallucinated cause.

**Short-circuit for empty-argument invocations.** If the user passed no argument AND there's no recent loop error to triage (check `/tmp/sandcastle.log` tail or `pgrep -af .sandcastle/main.mts`; if loop is running cleanly with no recent error markers, that counts as "no recent error"), the full machinery is probably overkill — they may just want a quick health check. Ask one short question: "no argument and no recent error — do you want a full retrospective audit, or a quick status check (`sandcastle-status`)?" If they say status, hand off to `/sandcastle-status` instead. If they say audit, proceed. Don't burn a subagent's context on a session where nothing went wrong.

After picking, state the mode in one short line to the user ("DIRECT PROPOSAL — fresh ask, no past incident referenced" or "AUDIT — your ask references the X bug from earlier this session"). That makes the choice auditable; the user can correct you in one word if you got it wrong.

The audit file (AUDIT mode) serves two purposes: (a) the summary you relay in this chat, (b) a paste-able handoff for a fresh Claude Code session pointed at the sandcastle template repo.

**The canonical paste is the chat output you produce in step 4 — not the audit file alone.** The chat output includes the host context block (hostname, paths, scp recipe) that the file lacks. If the user pipes the file's content alone to another session, provenance is lost.

## DIRECT PROPOSAL mode procedure

If the focus-area is forward-looking, do NOT export the transcript and do NOT dispatch a subagent. Just:

1. Write the proposal to a file at `mktemp -t sc-proposal-XXXXXX.md`. Three short sub-sections:
   - **The change** — what to add/modify in the sandcastle template (file paths + brief description).
   - **Why** — the one-paragraph justification from the in-context conversation.
   - **Rollout** — which files (active prompt + variants, main.mts, etc.), what verification, propagation via `/sandcastle-update`.
2. Print the file path and an inline summary (2–4 sentences) in plain English. Include a host context block (hostname, cwd, file path, scp recipe) so the user can paste the reply into a fresh session on another host.
3. Stop. The user can re-run with no argument later if they want a full audit.

## AUDIT mode procedure

If the focus-area is retrospective or absent, run the full machinery:

> **Minimize round-trips.** Each separate Bash call is its own sequential model turn with latency. Batch the export setup (locate session → write the MODE line → run the filter → create the audit path) into as few Bash calls as possible, ideally one combined script. Don't give schema-probing its own call — the defensive filter and the fallback ladder below absorb schema variance without a separate peek.

1. **Export the real transcript.** Claude Code writes every session to JSONL at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. The encoding replaces both `/` and `.` with `-`, so `/home/u/proj/.claude/wt/x` becomes `-home-u-proj--claude-wt-x` (two dashes where the `.` was).
   - Find current session: `ls -t ~/.claude/projects/$(pwd | sed 's|[/.]|-|g')/*.jsonl | head -1`
   - **Fallback if not found** (encoding quirks vary across Claude Code versions): list `~/.claude/projects/` and pick the directory whose name, when dashes are mapped back to `/` and `.` candidates, matches `pwd`. Or just `ls -t ~/.claude/projects/*/*.jsonl | head -1` after confirming with the user there's only one active session.
   - Create export path: `EXPORT=$(mktemp -t sc-feedback-export-XXXXXX.md)`.
   - **Write `MODE: TRANSCRIPT` as the literal first line** (`printf 'MODE: TRANSCRIPT\n' > "$EXPORT"`). The subagent reads this line to know which mode produced the file.

   **Why a flat dump is WRONG — the transcript is a TREE, not a list.** Every entry carries a `uuid` and a `parentUuid`. When the user **rewinds or edits a message**, Claude Code does NOT delete the old turns — it forks a new branch and keeps *both* in the JSONL. A naive "select every user/assistant line" filter sweeps the **abandoned branches in too**, so rewound/scrapped work leaks into the audit and the clean-context subagent treats discarded work as real — defeating the entire reason this skill audits from the transcript instead of from polluted memory.

   **Primary path — branch-aware export.** The JSONL is append-only, so the live branch always ends at the *last real message*. Anchor there and walk `parentUuid` back to the root, keeping only that path — child→parent traversal can never enter an abandoned sibling. Sidechains (subagent turns) are dropped too. The emit selects stay **defensive** (`?` guards) because sandcastle sessions span Claude Code versions and carry `queue-operation`, `attachment`, `file-history-snapshot`, `summary` entries alongside `user`/`assistant`. Append to `$EXPORT` with this EXACT filter (paste verbatim — `-s` slurp is required to build the parent index):

   ```sh
   jq -r -s '
     (map(select(.uuid != null))) as $rows
     | ($rows | map({key:.uuid, value:.}) | from_entries) as $byid
     | ($rows | map(select(.type=="user" or .type=="assistant")) | last | .uuid) as $tip
     | ([ $tip | recurse($byid[.].parentUuid // empty) ] | reduce .[] as $u ({}; .[$u]=true)) as $inpath
     | [ $rows[] | select((.isSidechain != true) and ($inpath[.uuid] == true)) ]
     | .[]
     | (
         ( select(.type=="user" and (.message?.content? | type == "string")) | "\n\n## USER\n\n" + .message.content ),
         ( select(.type=="assistant" and .message?.content?) | .message.content[]? | select(.type=="text") | "\n\n## ASSISTANT\n\n" + .text )
       )
   ' "$SESSION_FILE" >> "$EXPORT"
   ```
     - **Parens are load-bearing.** jq's `|` binds looser than `,`, so the two emit branches MUST stay wrapped — `( (USER…), (ASSISTANT…) )`. Without the parens the USER string gets piped into `.message.content` and every user line errors with `Cannot index string with string "message"`.
     - The walk: `recurse($byid[.].parentUuid // empty)` starts at the live tip and follows parent pointers to the root; `// empty` stops at the root (null parent). `$inpath` is the set of live-branch uuids; only those entries are emitted, in file (chronological) order.

   **Fallback ladder — test for CONTENT, not file size.** The `MODE:` line means the file is never zero bytes, so check for the *absence of content blocks*: `BLOCKS=$(grep -cE '^## (USER|ASSISTANT)' "$EXPORT")`.
   - **`BLOCKS` is 0** → the branch-aware filter found no `uuid`/`parentUuid` (older or changed schema; jq errors to stderr and emits nothing). Reset the file (`printf 'MODE: TRANSCRIPT\n' > "$EXPORT"`) and run the **naive, schema-light filter** — streaming (no `-s`, so it can partially succeed on a file with one bad line) and still defensive:
     ```sh
     jq -r '( select(.type=="user" and (.message?.content? | type == "string")) | "\n\n## USER\n\n" + .message.content ), ( select(.type=="assistant" and .message?.content?) | .message.content[]? | select(.type=="text") | "\n\n## ASSISTANT\n\n" + .text )' "$SESSION_FILE" >> "$EXPORT"
     ```
   - **Still 0 after the naive filter** (session file missing/unreadable, or schema totally different) → *you* (main agent) write `MODE: RECONSTRUCTED` as the first line and reconstruct from in-context history. The subagent has no history, so this fallback MUST happen here. (If RECONSTRUCTED triggers on a session you know had real turns, check for `.text`-on-user entries — some Claude Code versions put user text directly on `.text` instead of `.message.content`; adjust the field path and re-run before falling back to memory.)
   - Keep evidence in whichever path runs: commit hashes, file paths, error text, config snippets.
   - If the export crosses ~200KB, warn the user. Subagent context will be tight.

2. **Create audit output path:** `AUDIT=$(mktemp -t sc-feedback-audit-XXXXXX.md)`.

3. **Dispatch a subagent** (Agent tool, general-purpose, clean context). Keep this subagent on a strong model (Opus) — AUDIT is invoked precisely when something broke and memory is suspect, so unlike a mechanical handoff extraction it is the heavy, high-stakes case and must not be downgraded. Read `subagent-prompt.xml` from this skill's directory and use its contents as the dispatch prompt, replacing the `{{...}}` placeholders. Do not paraphrase, reorder, or drop tags — XML tags are load-bearing.

4. **Relay to the user.** Output must be copy-pasteable into a fresh Claude Code session on a different host (e.g. VPS → Mac). Structure:

   - **Host context block** (always first):
     ```
     --- sandcastle-feedback handoff ---
     Host: <hostname>
     Working directory: <absolute pwd>
     Is sandcastle template repo: <yes/no>
     Export: <absolute path to $EXPORT>
     Audit: <absolute path to $AUDIT>
     Retrieve from another host: scp <user>@<hostname>:<audit path> .
     ```
   - **Summary** (2–4 sentences, plain English): what broke, what was fixed in-session, what the audit recommends next.
   - **Full audit content inlined** under the summary. If the audit file is over ~50KB, inline only "Recommended Next Session" + "Sandcastle Issues" and tell the user to scp the rest.

## Constraints

- Plain English in everything you say to the user. Non-technical tone.
- Audit runs in the **subagent's** context, not yours. Do not pre-audit before dispatching.
- Never commit export or audit files to git — they live in `mktemp` paths.
