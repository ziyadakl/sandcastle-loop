# EVIDENCE QUOTE — STRICT verification of the certification's `e2eAssertionLine` field

The quoted line MUST satisfy ALL of:

- Non-empty AND not the literal placeholder `<paste line>` or
  `<the quoted line>`.
- Is a passing-test line from the runner — must match one of:
  - starts with `PASSED ` (pytest verbose),
  - starts with `--- PASS:` (go test),
  - starts with `test ` and ends with ` ... ok` (cargo / go test
    verbose: `test foo ... ok`),
  - contains `test result: ok` (cargo / `cargo test` summary),
  - starts with `OK` (rspec / mix / jUnit-style summary, on its own
    line and accompanied by a per-test count),
  - is the test description text from the test file (verifiably present
    in the diff or repo).
- Actually appears in `/tmp/sandcastle-test-it{{ITERATION}}.log`.
- The log must NOT contain `FAILED`, `failures`, `FAIL `, `test result: FAILED`,
  or `--- FAIL:` lines associated with the in-scope tests.
- Is NOT any of these forbidden generic lines (single source of truth —
  same list the implementer-output schema rejects):
  - empty or whitespace-only line
  - 'collected N items' / 'collected N tests' pytest preamble
  - 'Test Suites:' / 'Tests:' jest summary header alone
  - the literal placeholder '<paste line>' or '<the quoted line>'
  - 'running N tests' (cargo) without a following PASS line
  - bare 'ok' on a line by itself
  - 'test result: ok. 0 passed' (cargo, zero tests run)
  - bare summary counts ('5 passed', '5 passed in 1.23s') with NO
    `PASSED` / `... ok` / `--- PASS:` line above naming a specific test
  - the bare words 'passed', 'failed', 'all green', or 'OK' on a line by
    themselves with no test-name context

If ANY of the above fails, FIRST cross-check against the actual test log:

- If the log clearly shows tests passed (a summary line like `N passed in
  X.YZs`, `test result: ok`, or a non-empty per-file dot/check line like
  `tests/test_foo.py ......`) AND no `FAILED` / `failures` / `--- FAIL:`
  bail signals are present, treat the format mismatch as SOFT — DO NOT
  flag, skip silently. Pytest in default (non-verbose) mode does not emit
  `PASSED test_name` lines, so the implementer cannot quote one literally;
  the dot-summary IS valid evidence that tests ran and passed. Same for
  cargo/go-test summary modes.
- ONLY emit HARD if the log shows zero passing dots/checks, OR if `FAILED`
  / `failures` / `--- FAIL:` signals are present, OR if the implementer's
  quoted line is the literal placeholder `<paste line>` / `<the quoted
  line>` / empty / whitespace-only:

> HARD: certification evidence is fabricated, generic, or doesn't prove
> the test reached its assertion. `<paste the offending line and the rule
> it violated>`.
