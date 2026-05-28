**Required artifacts.** Save the full agent-browser output to
`/tmp/sandcastle-e2e-it{{ITERATION}}.log`:

```
bash e2e/<your-script>.sh 2>&1 | tee /tmp/sandcastle-e2e-it{{ITERATION}}.log
```

Or, if the spec inlines a one-shot `agent-browser batch` call, run that
verbatim:

```
agent-browser batch <args from spec> 2>&1 | tee /tmp/sandcastle-e2e-it{{ITERATION}}.log
```

**No filtering allowed between agent-browser and tee.** Run the command
EXACTLY as written above (with the args from the spec). Do NOT insert
`| grep`, `| sed`, `| awk`, `--quiet`, `> /dev/null`, or any other
output suppression before the tee. The reviewer reads the resulting log
to detect bail signals (auth redirects, snapshot showing `/login`,
non-zero exit codes that were swallowed). Filtering those signals out
is a prompt-following failure — the reviewer's check 8 will catch and
reject the commit.
