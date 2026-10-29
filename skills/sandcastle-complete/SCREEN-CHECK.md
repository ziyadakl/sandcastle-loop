# Reading a screen-check dissent

Reached from step 3 of [`SKILL.md`](SKILL.md) — which runs before the land on an open run PR, and after it on a merged one — whenever an issue carries a `sandcastle:screen-check-watch` marker, or you need the telemetry field names to read the run-level tally.

## What a red check does

The loop writes a browser check per ticket and runs it itself after the build. There is no enforcing mode: a check that disagrees is RECORDED on the issue body and in telemetry, and the ticket ships anyway. The reviewer's pass is the only gate. That is why step 3 exists. (`.sandcastle/lib/harness/screen-check-alarm.ts` holds the rule. A host `.env` still setting `SANDCASTLE_SCREEN_CHECK_ENFORCE` is inert.)

## Dating a hit

The watch section is permanent and lives on its own markers, so a block may be left over from an earlier run. Each block carries a `**Run:** <run id>` line. Match it against THIS run before treating a hit as new — an old block is history, not an anomaly.

## Reading the disagreement itself

A hit means the section `## Screen check: the check did not agree` is on the issue body. The block inside states what the screen showed against what the implementer claimed. That contrast is the finding: report it in the implementer's-claim-versus-screen form, not as "the check failed".

## The receipts

`.sandcastle/telemetry/issues.jsonl` (git-tracked) holds one entry per issue. `screenCheck.verdict` is the per-ticket result; `pictureStored` and `pictureLink` point at the screenshot receipt in Cloudflare R2.

A run whose verdicts are all systemic — `inconclusive`, `environment-fault` or `never-settled` (the page never declared itself finished) — means the checking machinery was broken that night. That is a run-level finding, not a per-ticket one, and it voids the whole run's claim to have looked at the screen.
