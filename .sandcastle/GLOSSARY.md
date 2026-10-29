# The loop

The overnight loop (`.sandcastle/`) is the unattended AI run that claims tickets and writes the app's code with nobody watching. Its words are about tickets, tests and runs, never about the product being built. The product's own words live in the project's root `GLOSSARY.md`, if it keeps one.

## Language

**The loop**:
The unattended run itself. In a session the AI is **me / you**, and a dispatched helper is a **subagent**; never "the agent", which a product glossary may use for a person.
_Avoid_: the agent, the bot

**Run branch**:
The branch a run lands each finished ticket on (`sandcastle/queue-<date>`). It reaches `main` only when the run's own pull request lands, so finished work can sit here, ahead of `main`.
_Avoid_: integration branch (the loop's internal merge workspace is a different thing)

**First test**:
The test the loop writes for a ticket before any code is built, proved to fail on the untouched code, then locked. Called a "check" inside the loop's code and prompts.
_Avoid_: check, when the reader could take it for a product feature's checklist

**Staging worktree**:
The loop's own merge workspace at `.sandcastle/worktrees/staging`.
_Avoid_: staging, bare

**Test database**:
Optional. A project's own Postgres test database (`testDatabase` in `.sandcastle/project.json`): the loop clones a template database once per job and applies the project's schema to the clone. Off by default.

**Shipped-local**:
A ticket the loop finished and landed on the **run branch**, not yet on `main`. Finished work: it never blocks another ticket.
_Avoid_: done (that label comes only once the work is on `main`)

**Quarantine**:
A ticket the loop failed for its own reasons. It is retried on later runs and still blocks any ticket waiting on it.
_Avoid_: needs-human (that label is only for a question the owner must answer)

**Needs-human**:
A ticket stopped on a question only the owner can answer — today, only a ticket too unclear to build.

**Waiting-for-session**:
A ticket the loop stopped retrying after $100 or three tries. A person picks it up in a session; it still blocks.

**Stop label**:
A `stopped:*` label saying why the run halted a ticket.
_Avoid_: failure reason

**Verdict**:
A ruling, after a disagreement, on which side was wrong: the test, the build, or the ticket.
