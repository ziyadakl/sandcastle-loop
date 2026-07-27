**Required artifacts.** Save the full agent-browser output to
`/tmp/sandcastle-e2e-it{{ITERATION}}.log`:

```
set -o pipefail
bash e2e/<your-script>.sh 2>&1 | tee /tmp/sandcastle-e2e-it{{ITERATION}}.log | node .sandcastle/lib/bound-output.mjs
E2E_STATUS=${PIPESTATUS[0]}   # the script's real exit code — NOT tee's, NOT the filter's
```

Or, if the spec inlines a one-shot `agent-browser batch` call, run that
verbatim:

```
set -o pipefail
agent-browser batch <args from spec> 2>&1 | tee /tmp/sandcastle-e2e-it{{ITERATION}}.log | node .sandcastle/lib/bound-output.mjs
E2E_STATUS=${PIPESTATUS[0]}
```

The `| node .sandcastle/lib/bound-output.mjs` stage is AFTER the tee, so it does
NOT violate the no-filtering rule below: `tee` still writes the FULL log the
reviewer reads, while the filter only bounds what appears in YOUR conversation
(head + tail, always keeping failure/summary lines). `set -o pipefail` +
`${PIPESTATUS[0]}` preserve the command's REAL exit status — read it from
`$E2E_STATUS`, never from the filter's exit code.

**No filtering allowed between agent-browser and tee.** Run the command
EXACTLY as written above (with the args from the spec). Do NOT insert
`| grep`, `| sed`, `| awk`, `--quiet`, `> /dev/null`, or any other
output suppression before the tee. The reviewer reads the resulting log
to detect bail signals (auth redirects, snapshot showing `/login`,
non-zero exit codes that were swallowed). Filtering those signals out
is a prompt-following failure — the reviewer's check 8 will catch and
reject the commit.
