/**
 * The FREE half of the test-verification gate: read the coding agent's own
 * session log and reject the one case that needs no container at all — the
 * agent wrote `SANDCASTLE-TEST: pass` into its commit body while its log shows
 * it never invoked a test command.
 *
 * This is a PRE-FILTER, and the asymmetry below is the whole design:
 *
 *   - It may REJECT. "No test command appears anywhere in the run's logs" is
 *     trustworthy because the ABSENCE of a command is hard to produce by
 *     accident — an agent that ran tests leaves the invocation in its log.
 *   - It may NEVER APPROVE. A log that LOOKS like tests ran proves nothing
 *     about the final commit: agents run tests mid-work and keep editing
 *     afterwards, and the log is agent-produced text that a model could emit
 *     without executing anything. So the only non-rejecting verdict is
 *     `inconclusive`, and `inconclusive` means "go do the real in-sandbox run"
 *     — never "ship".
 *
 * Ambiguity therefore resolves TOWARD the expensive path, not away from it:
 * a missing log, an empty log, an unreadable directory, or a format this
 * module does not recognize are all `inconclusive`. That is the same
 * ABSENT ≠ ZERO discipline `shouldRecordDiffMeasurement` applies in
 * `../review/diff-measurement.ts` — an unmeasured thing is not a failed thing.
 *
 * Everything except {@link readAgentLogsForBranch} is pure, so the rules are
 * exercisable against string literals.
 */
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

/**
 * One agent log as the classifier consumes it. `path` is carried only so a
 * quarantine reason can name the file a human should open.
 */
export interface AgentLogFile {
  readonly path: string;
  readonly text: string;
}

/**
 * The two verdicts this filter is allowed to reach. There is deliberately no
 * `test-command-seen` member: a positive-looking log is not evidence of
 * anything (see the module doc), so it collapses into `inconclusive` and the
 * real run happens anyway.
 */
export type TestCommandEvidence = "no-test-command-seen" | "inconclusive";

export interface LogPrefilterVerdict {
  readonly evidence: TestCommandEvidence;
  /** Human-readable; lands verbatim in the quarantine message. */
  readonly reason: string;
}

/**
 * Every command shape that could plausibly START a test run in this repo, plus
 * slack. Matching is deliberately over-broad — a match only costs us the real
 * container run we were going to do anyway, while a MISS is a false rejection
 * of a healthy ticket. Covers `pnpm test`, `pnpm --filter <pkg> test`,
 * `pnpm --filter <pkg> run test`, `pnpm turbo run test`, `pnpm test:e2e`
 * (`\btest\b` matches before the colon), bare/`npx` `vitest`, and the
 * playwright and jest equivalents. Scanned against the WHOLE log rather than
 * just tool-call lines, so even prose mentioning a runner pushes us to
 * `inconclusive`.
 */
const TEST_INVOCATION_RE =
  /\bvitest\b|\bjest\b|\bplaywright\b|\b(?:pnpm|npm|npx|pnpx|yarn|bun|bunx|turbo|dlx)\b[^\n]{0,200}\btest\b/i;

/**
 * The header the sandcastle SDK's file display writes at the top of every run
 * log. Its presence is what lets us treat "no test command in here" as a fact
 * about a REAL run rather than a fact about a file we failed to understand.
 * Verified present in all 334 logs currently on disk under `.sandcastle/logs/`.
 */
const RUN_LOG_MARKER = /^--- Run started:/m;

/**
 * Classify ONE log. `no-test-command-seen` requires all three of: text
 * present, format recognized, and no plausible invocation anywhere. Anything
 * else is `inconclusive`.
 */
export function classifyAgentLog(text: string | undefined): TestCommandEvidence {
  if (text === undefined || text.trim() === "") return "inconclusive";
  if (!RUN_LOG_MARKER.test(text)) return "inconclusive";
  return TEST_INVOCATION_RE.test(text) ? "inconclusive" : "no-test-command-seen";
}

/**
 * Fold every log an issue's run produced into one verdict. Rejection needs
 * UNANIMITY over a non-empty set: at least one log must exist, and every one
 * of them must show no test command. A single inconclusive log — including one
 * belonging to a different role, e.g. the reviewer running the suite the
 * implementer skipped — is enough to send the gate to the real run, because
 * tests demonstrably WERE invoked somewhere on this branch and the rejection
 * sentence would be false.
 *
 * Zero logs is `inconclusive`, never a rejection: an agent that produced no log
 * is an agent we observed nothing about.
 */
export function classifyIssueAgentLogs(
  logs: readonly AgentLogFile[],
): LogPrefilterVerdict {
  if (logs.length === 0) {
    return {
      evidence: "inconclusive",
      reason: "no agent session log was found on disk for this branch",
    };
  }
  const inconclusiveLogs = logs.filter(
    (l) => classifyAgentLog(l.text) === "inconclusive",
  );
  if (inconclusiveLogs.length > 0) {
    return {
      evidence: "inconclusive",
      reason:
        `${inconclusiveLogs.length} of ${logs.length} session log(s) either show a ` +
        `test invocation or could not be classified`,
    };
  }
  return {
    evidence: "no-test-command-seen",
    reason:
      `${logs.length} session log(s) for this branch contain no test-command ` +
      `invocation at all (checked: ${logs.map((l) => path.basename(l.path)).join(", ")})`,
  };
}

/**
 * Mirror of the SDK's `sanitizeBranchForFilename` (see
 * `@ai-hero/sandcastle` dist `index.js`), which is what turns the per-issue
 * branch `agent/issue-<N>` into the `agent-issue-<N>` prefix the log files
 * actually carry. Duplicated rather than imported because the SDK does not
 * export it; kept as its own named function so the coupling is greppable.
 */
export function sanitizeBranchForLogFilename(branch: string): string {
  return branch.replace(/[/\\:*?"<>|]/g, "-");
}

/**
 * The filename segment that marks a file in `.sandcastle/logs/` as a CHECK-RUN
 * transcript (`lib/harness/check-run-log.ts`) rather than a thinking agent's
 * session log.
 *
 * Lives HERE, beside {@link sanitizeBranchForLogFilename}, because both are
 * facts about the naming of files in that one directory, and because the
 * dependency has to run in exactly this direction: the writer imports the
 * naming rules from the reader, so the reader can exclude the writer's files
 * without closing a module cycle. One constant, two users, nothing to drift.
 */
export const CHECK_RUN_LOG_MARKER = "-checkrun-";

/** True when `filename` is a check-run transcript rather than an agent session log. */
export function isCheckRunLogFilename(filename: string): boolean {
  return filename.includes(CHECK_RUN_LOG_MARKER) && filename.endsWith(".log");
}

/**
 * Read every `<sanitized-branch>-<role>.log` the SDK wrote for this branch
 * under `<repoRoot>/.sandcastle/logs/` — implementer, its retries, reviewer,
 * recovery. ALL roles, because the verdict above is about whether a
 * test command was invoked anywhere on the branch.
 *
 * Fail-quiet by design: a missing directory or an unreadable file yields fewer
 * (or zero) logs, which {@link classifyIssueAgentLogs} turns into
 * `inconclusive`. An IO problem must never become a rejection.
 */
export function readAgentLogsForBranch(
  repoRoot: string,
  branch: string,
): readonly AgentLogFile[] {
  const dir = path.join(repoRoot, ".sandcastle", "logs");
  const prefix = `${sanitizeBranchForLogFilename(branch)}-`;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: AgentLogFile[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".log")) continue;
    // NOT AN AGENT SESSION. `lib/harness/check-run-log.ts` writes the check
    // runner's own transcripts into this directory under the same
    // `<branch>-…​.log` shape, and every one of them contains the `pnpm …
    // test` / `playwright` command the LOOP invoked. Folding those in would
    // make this filter's rejection sentence — "these session logs contain no
    // test-command invocation at all" — a statement about the loop's runs
    // rather than the builder's, and would leave the cheap rejection
    // unreachable for every ticket that carries a check. This gate is about
    // what the AGENT did.
    if (isCheckRunLogFilename(name)) continue;
    const full = path.join(dir, name);
    try {
      out.push({ path: full, text: readFileSync(full, "utf8") });
    } catch {
      // Unreadable file: skip it. Dropping it can only shrink the evidence
      // set, and a shrunken set can only make us MORE likely to be
      // inconclusive — never more likely to reject.
    }
  }
  return out;
}
