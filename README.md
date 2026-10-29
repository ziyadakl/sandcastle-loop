# sandcastle-loop

A project-neutral template for an unattended overnight coding loop, built on [`@ai-hero/sandcastle`](https://www.npmjs.com/package/@ai-hero/sandcastle). You label GitHub issues, start the loop, and read the run's pull request in the morning. `bin/init.mjs` copies the loop into your project as `.sandcastle/`.

The loop is the simplified one described in [ADR 0023](docs/adr/0023-simplified-loop-from-affinity.md): it was taken from the private project it was hardened in, and this repo is updated by copying from that loop, never the reverse.

## What a run does

The loop claims issues labelled `ready-for-agent` (plus a `type:X` label), works several at once in sandboxes (Docker, or host-native on macOS), and for each ticket:

1. **First test (advisory).** A check-writer agent writes one test for the ticket before any code exists, and the loop proves it fails on the untouched code, then locks it. If no usable first test can be produced, the ticket still goes on, and ships labelled `shipped-without-first-test`.
2. **Build.** An implementer agent writes the code against the ticket and the locked first test.
3. **Review, up to three fix rounds.** A reviewer grades the diff. A refusal, a failed check or a time-out hands the ticket to one fixer pass, which gets the same three review rounds.
4. **Ship onto the run branch.** Finished tickets land one at a time on `sandcastle/queue-<date>` and are labelled `shipped-local`. The run branch reaches your base branch through the run's own pull request.

A ticket that still fails is retried on later runs until it has spent $100 in total or been tried three times; then it waits for a session. Only two things reach the owner: a ticket whose wanted result is unclear, and a run holding a migration that deletes or rewrites existing data.

Before the loop lands its own run pull request it runs your `landCheck` command once on the run branch tip. With no `landCheck` set, the loop never lands the run pull request itself; it waits for the owner.

## Install

In a Node project (a `package.json` must exist; the target has no `.sandcastle/` yet):

```sh
npx github:ziyadakl/sandcastle-loop init
# or, in a pnpm project
pnpm add -D github:ziyadakl/sandcastle-loop && pnpm exec sandcastle-loop init
```

`bin/init.mjs` fetches the template, copies it to `.sandcastle/`, adds the `sandcastle`, `sandcastle:watch` and `sandcastle:check-upstream` scripts and the needed dev dependencies to your `package.json`, and records the sandbox (`docker`, or `mac-host` for Xcode/Swift projects) in `.sandcastle/.sandbox-flag`. It refuses if `.sandcastle/` already exists. Then:

```sh
pnpm install
pnpm sandcastle --iterations 50 --max-concurrent 2 --branch <feature>
```

Copy `.sandcastle/.env.example` to `.sandcastle/.env` (or `~/.config/sandcastle/.env`) for keys; with a Claude subscription logged in you need none. The `/sandcastle-init` skill walks the whole setup.

## Settings: `.sandcastle/project.json`

One committed file holds everything that differs per project. Copy `.sandcastle/project.example.json` to `.sandcastle/project.json`. Every key is optional; a missing file runs the defaults.

| Key                    | Meaning                                                                                                                                                                                                                                                                      | Default                                                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `landCheck`            | Command (as an argv array, e.g. `["pnpm","verify"]`) run on the run branch tip before the loop lands its own run pull request. Set `migrations` too if the project has SQL migrations, or a run holding a destructive one can land without you.                              | `null`: the loop never lands its run PR; it waits for the owner                                                    |
| `testDatabase`         | Opt-in Postgres test database: `{ "templateDb": "...", "setupCommand": ["..."] }`. The loop clones the template database per job; `setupCommand` applies schema with the clone's URL in `DATABASE_URL`. Needs `psql` on the host; connection settings are in `.env.example`. | `null` (off): the sandbox gets blank `DATABASE_URL` and `POSTGRES_URL`, so a real database never reaches the agent |
| `migrations`           | `{ "dir": "..." }`: if present, SQL files there are scanned and a migration that deletes or rewrites data is flagged to the owner.                                                                                                                                           | `null` (off)                                                                                                       |
| `checksRoot`           | Folder holding each ticket's first test, as `<checksRoot>/issue-<N>/`.                                                                                                                                                                                                       | `e2e/checks`                                                                                                       |
| `browserCheckCommand`  | Command prefix that runs one browser check; the check's path is appended.                                                                                                                                                                                                    | `null`: `pnpm exec playwright test <path>`                                                                         |
| `e2eScriptPackageJson` | The `package.json` whose `scripts.e2e` an agent may not change.                                                                                                                                                                                                              | `null` (no guard)                                                                                                  |
| `checkFreeze`          | `{ "browserRoots": [], "unitRoots": [], "unitSeeds": [] }`: folders and files that grade a check (comparison helpers, shared test-runner config). They are locked with the check itself.                                                                                     | all empty                                                                                                          |
| `protectedPaths`       | Globs an AI agent may never edit (e2e config, shared helpers, seed data). A touched file is restored; a second touch stops the ticket.                                                                                                                                       | `[]`                                                                                                               |
| `wideReachPaths`       | Globs whose change counts as wide reach for the merge rule.                                                                                                                                                                                                                  | manifests and lockfiles, `.github/`, `.sandcastle/`                                                                |
| `ownerName`            | Name used where the loop says it waits for the owner.                                                                                                                                                                                                                        | `"the owner"`                                                                                                      |
| `commitIdentity`       | Author and committer of every commit an agent writes.                                                                                                                                                                                                                        | `Claude <noreply@anthropic.com>`                                                                                   |

Environment variables (see `.sandcastle/.env.example`): `SANDCASTLE_SHARED_HOST` and `SANDCASTLE_DEV_HOST` (bind addresses your dev scripts may read; blanked inside sandboxes), plus the optional cross-host, timeout and review-escalation knobs.

Put project facts the settings cannot carry (check helpers, seeded test data, a known-failures doc) in a repo-root `SANDCASTLE.md`, copied from `.sandcastle/SANDCASTLE.md.example`; the loop's prompts point agents there.

## Skills

The `/sandcastle-*` skills live in [`skills/`](skills/README.md) and are symlinked into `~/.claude/skills/` by `bash skills/install.sh`.

| Skill                  | Use                                                         |
| ---------------------- | ----------------------------------------------------------- |
| `/sandcastle-init`     | Set up the loop in the current project                      |
| `/sandcastle-run`      | Start a run, on one machine or all your hosts               |
| `/sandcastle-status`   | Report what the loop is doing, or what a finished run left  |
| `/sandcastle-stop`     | Stop a run, gracefully or at once                           |
| `/sandcastle-resume`   | Rejoin a run already in progress                            |
| `/sandcastle-complete` | Land a finished or stopped run                              |
| `/sandcastle-clean`    | Delete leftover worktrees, logs, branches, refs, containers |
| `/sandcastle-profile`  | Show or switch the browser/sandbox profile                  |
| `/sandcastle-update`   | Pull the latest template into a project                     |
| `/sandcastle-feedback` | Audit a session that went wrong                             |

## Tests

```sh
pnpm test        # root tests, then the loop's own suite (vitest run --root .sandcastle)
pnpm typecheck   # tsc over the root and over .sandcastle
pnpm sandcastle:lint   # every {{PLACEHOLDER}} in a prompt must be supplied by main.mts
```

## Layout

- `.sandcastle/`: the loop and its tests (copied into projects)
- `skills/`: the `/sandcastle-*` skills (linked, not copied)
- `bin/init.mjs`: the installer
- `docs/adr/`: decisions; [`CONTEXT.md`](CONTEXT.md) defines the vocabulary
- `archive/`: frozen earlier designs, kept for reference
