# Reading a screen-check dissent

Reached from step 4 of [`SKILL.md`](SKILL.md) — which runs BEFORE the merge, while every issue in the run is still open — whenever an issue carries a `sandcastle:screen-check-watch` marker, or you need the telemetry field names to read the run-level tally.

## What the two modes mean

The loop writes a browser check per ticket and runs it itself after the build. What happens when that check disagrees depends on the mode:

- **Watch-only** (the default — `SANDCASTLE_SCREEN_CHECK_ENFORCE` unset) — the ticket ships anyway. It gets `Closes #N` and it closes on merge. The disagreement is recorded on the issue body and nowhere else. This is why step 4 exists.
- **Enforcing** — a dissenting ticket never shipped at all. It stopped with a `stopped:*` label instead.

**Which mode ran is not in the telemetry file.** Read it from the run log's startup line, printed once per host: `grep 'screen check:' <run.log>` → `screen check: WATCH-ONLY` or `screen check: ENFORCING`.

## Dating a hit

**Hits are expected under enforcement too.** The watch section is permanent and lives on its own markers, precisely so a ticket watched on one night and stopped on another keeps both facts. So a marker may be left over from an earlier watch-only night. Check each hit's run identifier against THIS run before treating it as new — an old marker is history, not an anomaly.

## Reading the disagreement itself

A hit means the section `## Screen check (watch-only): the browser did not agree` is on the issue body. The block inside states what the screen showed against what the implementer claimed. That contrast is the finding: report it in the implementer's-claim-versus-screen form, not as "the check failed".

## The receipts

`.sandcastle/telemetry/issues.jsonl` (git-tracked) holds one entry per issue. `screenCheck.verdict` is the per-ticket result; `pictureStored` and `pictureLink` point at the screenshot receipt in Cloudflare R2.

A run whose verdicts are all systemic — `inconclusive`, `environment-fault` or `never-settled` (the page never declared itself finished) — means the checking machinery was broken that night. That is a run-level finding, not a per-ticket one, and it voids the whole run's claim to have looked at the screen.
