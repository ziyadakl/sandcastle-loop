# Cross-track public API contracts

What every track exports — the integration spec for Track C, the smoke harness, and the upcoming code review pass.

This was written **after** Tracks B/D/E/F shipped, by reading their `index.ts` barrels and leaf-file signatures directly. It is what Track C *must* match. Anything Track C imports that isn't in this doc is contract drift and gets fixed during integration.

---

## Track B — `src/verdicts/`

### Markers (`./markers`)

```ts
const IMPLEMENTER_MARKERS: readonly ["STORY_COMPLETE", "HALT", "RECOVERY_COMPLETE"]
const REVIEWER_MARKERS:    readonly ["ALL_CLEAR", "HAS_BLOCKERS"]
const FIXER_MARKERS:       readonly ["FIXED", "BLOCKED"]
const RECOVERY_MARKERS:    readonly ["RECOVERY_COMPLETE", "HALT"]
const ALL_MARKERS:         readonly [...all of the above]
const HALT_PROMISE = "<promise>HALT</promise>"

type ImplementerMarker = (typeof IMPLEMENTER_MARKERS)[number]
type ReviewerMarker    = (typeof REVIEWER_MARKERS)[number]
type FixerMarker       = (typeof FIXER_MARKERS)[number]
type RecoveryMarker    = (typeof RECOVERY_MARKERS)[number]
type AnyMarker         = (typeof ALL_MARKERS)[number]

function canonicalizeMarker(raw: string): string
function stripDecoration(line: string): string
```

### Schemas (`./schemas`)

```ts
const ImplementerOutputSchema: ZodType<ImplementerOutputParsed>
const ReviewerVerdictSchema:   ZodType<ReviewerVerdictParsed>
const FixerVerdictSchema:      ZodType<FixerVerdictParsed>
const RecoveryDecisionSchema:  ZodType<RecoveryDecisionParsed>
const ConcernSchema, ConcernSeveritySchema
```
Inferred types (`*Parsed`) match `src/types.ts` exactly — guarded at compile time by an `Equals<>` helper.

### Parse (`./parse`)

```ts
type MarkerMode = "tolerant" | "strict" | "contains"
interface ExtractMarkerOptions { mode?: MarkerMode }
interface ParseVerdictOptions  { alreadyAssistantText?: boolean; ... }

function extractMarker<M extends string>(
  text: string,
  allowed: readonly M[],
  options?: ExtractMarkerOptions,
): M

function extractAssistantText(rawStreamJson: string): string

function parseVerdict<T>(
  rawStreamJson: string,
  schema: ZodType<T>,
  options?: ParseVerdictOptions,
): T

class MarkerNotFoundError extends Error
class VerdictParseError   extends Error
```

**Track B does NOT export** `parseRecoveryDecision`, `parseImplementerOutput`, etc. There is **one** `parseVerdict<T>` — the schema is the second argument. Track C must import `parseVerdict` and call it with `RecoveryDecisionSchema` (or whichever schema). The "one parse function, many schemas" pattern is intentional.

---

## Track D — `src/state/`

### Prd (`./prd`)

```ts
function loadPrd(repoRoot: string): Promise<PrdState>
function claimStory(repoRoot: string, storyId: string): Promise<Story>
function pickNextEligibleStory(repoRoot: string): Promise<Story | null>
function releaseStory(repoRoot: string, storyId: string): Promise<void>
function markDone(
  repoRoot: string,
  storyId: string,
  commitSha: string,
  iterNum?: number,
  summary?: string,
): Promise<void>
function quarantineStoryInPrd(
  repoRoot: string,
  storyId: string,
  reason: string,
  attempts: number,
): Promise<void>
```

### GH (`./gh`)

```ts
function transitionLabel(issueNum: number, from: string, to: string): Promise<void>
function closeIssue(issueNum: number, comment?: string): Promise<void>
function getIssueBody(issueNum: number): Promise<string>
```

**Track D does NOT export** `commentOnIssue` or `fetchIssueBody`. The right names are `getIssueBody` (read) and `closeIssue` (write/close, with optional `--comment`). For a standalone issue comment without close, Track C should `execFile("gh", ["issue","comment", ...])` directly OR Track D adds a new export — flagging this as integration item.

### Locks (`./locks`)

```ts
function withPrdLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T>
function withSingleInstance<T>(lockPath: string, fn: () => Promise<T>): Promise<T>
```

---

## Track E — Recovery (archived) and migrations

> **Status (2026-05-11):** The recovery ladder described below now lives at
> `archive/recovery/ladder.ts` and is frozen reference, not live code (moved
> by commit `76de6fa`). The live recovery path is `runRecovery` in
> `.sandcastle/main.mts` — a single Opus pass, no ladder. The three
> actionable diagnose patterns documented below were ported to
> `.sandcastle/lib/diagnose.ts` and feed the recovery prompt as a hint
> (commit `4a791fa`); the Sonnet→Opus escalation and host-side fix execution
> were not ported.

### Recovery ladder (`./ladder`)

```ts
interface HaltContext {
  reason: string;
  priorRc?: number;
  priorWho?: string;
  priorLogPath?: string;
  // Extended after code review (item 9):
  commits?: string;       // git log --oneline {preSha}..HEAD
  uncommitted?: string;   // git status -s
  lastStep?: string;      // last [STEP X/N] marker
}
interface AttemptSummary {
  model: string;
  logFilePath?: string;
  marker?: "RECOVERY_COMPLETE" | "HALT";
  haltReason?: string;
  runCompleted: boolean;  // renamed from `clean` after code review (item 12)
  markerFound: boolean;   // new after code review (item 12)
  commitSha?: string;
}
interface RecoveryLadderConfig   {
  promptTemplatePath: string;
  sonnetModel?: string;          // default "claude-sonnet-4-6"
  opusModel?: string;            // default "claude-opus-4-8"
  idleTimeoutSeconds?: number;   // default 1800
  logDir?: string;               // default `${cwd}/.sandcastle/logs`
  ...
}
interface RecoveryLadderResult   { decision: RecoveryDecision; attempts: AttemptSummary[]; ... }

function runRecoveryLadder(
  sandbox: Sandbox,
  ctx: IterationContext,
  halt: HaltContext,
  config: RecoveryLadderConfig,
): Promise<RecoveryLadderResult>
```

### Quarantine (`./quarantine`)

```ts
interface QuarantineStoryOptions { ghComment?: boolean; ... }

function quarantineStory(
  repoRoot: string,
  story: Story,
  reason: string,
  options?: QuarantineStoryOptions,
): Promise<void>
```

### Migrations (`./drizzle-applier`)

```ts
const BENIGN_ALREADY_EXISTS_REGEX: RegExp

interface MigrationRealError   { file: string; stmt: string; msg: string }
interface ApplyMigrationsResult { applied: number; benignSkipped: number; realErrors: MigrationRealError[] }
interface ApplyMigrationsOptions { databaseUrl?: string; _exec?: ExecRunner; ... }
type ExecRunner = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>

function applyMigrationsBetween(
  repoRoot: string,
  preSha: string,
  postSha: string,
  options?: ApplyMigrationsOptions,
): Promise<ApplyMigrationsResult>

function classifyPsqlErrors(rawOutput: string): { real: string[]; benign: string[] }
function splitSqlStatements(sql: string): string[]
function isDrizzleMigrationPath(p: string): boolean
```

---

## Track F — `tests/smoke/`

Owns the harness only. Doesn't export anything `src/` should consume. Provides:

- A `BindMountSandboxProvider`-shaped mock at `tests/smoke/mocks/mock-sandbox.ts`
- A fake target repo template at `tests/smoke/fixtures/repo/`
- An end-to-end runner at `tests/smoke/run-smoke.ts` (NPM script `npm run smoke`)

Wants from Track C: an injection seam on `runLoop` so the smoke can swap in canned per-role agent results without spinning up Docker. Suggested shape:

```ts
function runLoop(config: LoopConfig & {
  _agentRunner?: (role: AgentRole, model: ModelTier, prompt: string) => Promise<RunResult>
}): Promise<IterationResult[]>
```

Track C is free to pick a different injection name; this doc only requires that *some* seam exists.

---

## Known integration items (write to fix during task #6)

1. Track C imports `parseRecoveryDecision` (does not exist). Replace with `parseVerdict(raw, RecoveryDecisionSchema)`.
2. Track C imports `commentOnIssue` / `fetchIssueBody` from `state/gh.js`. Use `getIssueBody` (read) and either `closeIssue(num, comment)` (close+comment) or call `gh issue comment` via `execFile` directly. Don't expand Track D's surface unless really needed.
3. Track C's `runRecoveryLadder` call site uses a different signature than Track E ships. Align to: `(sandbox, ctx, halt, config)`.
4. Track F needs an injection seam on `runLoop` (see above). Track C must add it — Track F's smoke depends on it for end-to-end coverage.
5. `markDone` is exported from `state/index.ts` correctly. Earlier Track F report flagged it missing — that report is wrong; verified it's in the barrel.

This doc is the source of truth for the code-review pass after integration.
