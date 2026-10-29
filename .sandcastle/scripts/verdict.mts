#!/usr/bin/env tsx

/**
 * The verdict tool — "when the run's check and the run's builder disagreed,
 * which of them was wrong?" (issue #1117).
 *
 * ## Why this exists
 *
 * The slot to record that answer existed for weeks and nothing ever filled
 * it. Eight real disagreements between 2 and 14 August 2026, costing
 * $239.46, all carry an empty verdict. So the one number the judge design
 * rests on — how often the CHECK is the wrong one — was a feeling.
 *
 * The judge that will fill this in automatically is issue #1118 and is not
 * built yet. This tool is what makes the slot usable in the meantime: a
 * person can rule the disagreements already sitting there, read one back,
 * and get the count. Owner ruling 1 of the 2026-08-16 grilling is that he
 * can overturn any verdict by hand, so a hand path is not a stopgap here —
 * it is the design.
 *
 * ## Where a verdict lives
 *
 * In the GitHub issue BODY, in its own block, and nowhere else. Owner
 * ruling 12: never in `.sandcastle/telemetry/issues.jsonl`, because that
 * file is committed to git and a verdict there would need a pull request
 * every time. The `verdict:*` label is only an index so the count is one
 * query; the body is the record.
 *
 * ## Commands
 *
 *   pnpm sandcastle:verdict                     the count, and who is unruled
 *   pnpm sandcastle:verdict show 1056           read one ticket's verdict
 *   pnpm sandcastle:verdict set 1056 checks-wrong --why "..."
 *
 * EXIT CODE CONTRACT, matching `rework-report.mts`: non-zero means THE TOOL
 * BROKE. An empty count, a ticket with no verdict, zero disagreements — all
 * print a clear line and exit 0. An unflattering number is not a failure.
 */

import { resolve } from "node:path";

import {
  applyVerdictReport,
  configureGh,
  countCheckReadings,
  countVerdicts,
  type CheckReadingCount,
  ensureVerdictLabelsExist,
  readVerdict,
  type VerdictCount,
} from "../lib/state/gh.js";
import {
  VERDICT_MEANINGS,
  VERDICT_VALUES,
  verdictGrounds,
  type Verdict,
  type VerdictRecord,
} from "../lib/state/verdict.js";
import { CHECK_READING_MEANINGS } from "../lib/state/check-reading.js";

const USAGE = [
  "Usage:",
  "  pnpm sandcastle:verdict                          count every verdict, and list the unruled",
  "                                                   (split by whether a check was behind the argument)",
  "  pnpm sandcastle:verdict --issues 805,820          also read tickets too old to carry a label",
  "  pnpm sandcastle:verdict show <issue>             print one ticket's verdict",
  '  pnpm sandcastle:verdict set <issue> <verdict> [--why "..."]',
  "",
  "The four verdicts:",
  ...VERDICT_VALUES.map((v) => `  ${v.padEnd(14)} ${VERDICT_MEANINGS[v]}`),
].join("\n");

/** What one invocation asked for. Pure — no `gh`, no clock, no network — so
 *  the argument rules are testable without touching GitHub. */
export type VerdictArgs =
  | { readonly command: "help" }
  | { readonly command: "count"; readonly extraIssues: readonly number[] }
  | { readonly command: "show"; readonly issue: number }
  | {
      readonly command: "set";
      readonly issue: number;
      readonly verdict: Verdict;
      readonly why?: string;
    };

/** Read a flag's value. A value that itself begins with `-` is treated as
 *  the NEXT flag, not as this one's value — `--why --issues 3` used to
 *  record the reason as the literal text `--issues`. */
function readFlag(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  return value === undefined || value.startsWith("-") ? undefined : value;
}

function parseIssueNumbers(raw: string | undefined): number[] {
  return (raw ?? "")
    .split(",")
    .map((part) => Number(part.trim().replace(/^#/, "")))
    .filter((n) => Number.isInteger(n) && n > 0);
}

function parseIssue(raw: string | undefined): number {
  const n = Number(raw?.replace(/^#/, ""));
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`not an issue number: '${raw ?? ""}'`);
  }
  return n;
}

/**
 * Read one invocation's arguments.
 *
 * A first argument beginning with `-` is a FLAG, never a command — the
 * first real run of this tool typed `--issues 805,820` with no command word
 * and was told `unknown command '--issues'`, because a bare count is the
 * default and nobody types the word "count".
 *
 * Throws for a genuinely unusable invocation (an unknown command, a
 * non-number where an issue belongs, a verdict outside the four), matching
 * this repo's exit-code contract: non-zero means the tool broke.
 */
export function parseArgs(argv: readonly string[]): VerdictArgs {
  if (argv.includes("--help") || argv.includes("-h")) return { command: "help" };
  const first = argv[0];
  const command = first === undefined || first.startsWith("-") ? "count" : first;

  if (command === "count") {
    // The `stopped:*` labels only started being applied in August 2026, so a
    // label search cannot see a disagreement older than that. `--issues` is
    // how those are swept in by number. Six of the eight disagreements issue
    // #1117 measured are in that older, label-less era.
    return { command: "count", extraIssues: parseIssueNumbers(readFlag(argv, "--issues")) };
  }
  if (command === "show") {
    return { command: "show", issue: parseIssue(argv[1]) };
  }
  if (command === "set") {
    const issue = parseIssue(argv[1]);
    const raw = argv[2];
    const verdict = VERDICT_VALUES.find((v) => v === raw);
    if (verdict === undefined) {
      throw new Error(
        `'${raw ?? ""}' is not one of the four verdicts: ${VERDICT_VALUES.join(", ")}`,
      );
    }
    return { command: "set", issue, verdict, why: readFlag(argv, "--why") };
  }
  throw new Error(`unknown command '${command}'`);
}

/**
 * Print one ticket's verdict.
 *
 * **The source is printed, and it is not decoration.** It is the field saying
 * whether "the check was wrong" is even a true sentence about this ticket: on
 * a reviewer refusal with no check behind it there was no check to be wrong,
 * so the line below spells that out rather than leaving a reader to take the
 * verdict's own wording at face value.
 */
export function describeVerdict(record: VerdictRecord): string {
  const grounds = verdictGrounds(record.source);
  return [
    `Verdict:     ${record.verdict} — ${VERDICT_MEANINGS[record.verdict]}`,
    `Decided by:  ${record.decidedBy === "human" ? "a person, by hand" : "the run's judge"}`,
    `When:        ${record.whenIso === "" ? "(not stated)" : record.whenIso}`,
    `Run:         ${record.runId ?? "(not stated)"}`,
    `Argument came from: ${record.source ?? "(not stated)"}`,
    grounds === "no-check"
      ? "             The reviewer refused on grounds with no check behind it,\n" +
        "             so no check ran on this ticket and none of it counts\n" +
        "             towards how often a check turns out to be wrong."
      : "",
    record.why === undefined ? "" : `Why:         ${record.why}`,
    // A ruling this one replaced was paid for too, so `show` prints it. Left
    // out entirely when there is none, which is the ordinary ticket.
    record.superseded === undefined || record.superseded.length === 0
      ? ""
      : [
          "",
          "Earlier rulings on this ticket, replaced by the one above:",
          ...record.superseded.map(
            (s) =>
              `  ${s.verdict} — ${s.decidedBy === "human" ? "a person" : "the run's judge"}` +
              `, ${s.whenIso === "" ? "date not stated" : s.whenIso}` +
              `, argument came from ${s.source ?? "(not stated)"}` +
              `${s.why === undefined ? "" : `\n      ${s.why}`}`,
          ),
        ].join("\n"),
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** One padded line per verdict. The plain-English meaning is spelled out in
 *  the first block only; repeating all four sentences under every block buries
 *  the numbers the reader came for. */
function verdictRows(counts: Record<Verdict, number>, withMeaning = true): string[] {
  return VERDICT_VALUES.map(
    (v: Verdict) =>
      `  ${String(counts[v]).padStart(4)}  ${withMeaning ? `${v.padEnd(14)} ${VERDICT_MEANINGS[v]}` : v}`,
  );
}

function groupTotal(counts: Record<Verdict, number>): number {
  return VERDICT_VALUES.reduce((sum, v) => sum + counts[v], 0);
}

/**
 * One of the two blocks held OUT of the figure, with its heading and the
 * plain sentence saying why it is out.
 *
 * An empty group prints `whenEmpty` as a single line, or nothing at all when
 * that is blank. It is never silently omitted when it holds anything: the
 * whole fault being fixed here is a count that folded two unlike things
 * together, and hiding one of them afterwards would be the same fault wearing
 * a different face.
 */
function groupBlock(
  counts: Record<Verdict, number>,
  heading: readonly string[],
  whenEmpty: string,
): string[] {
  if (groupTotal(counts) === 0) {
    return whenEmpty === "" ? [] : ["", whenEmpty];
  }
  return ["", ...heading, "", ...verdictRows(counts, false)];
}

/**
 * Render the count. Pure, so the wording is testable without GitHub.
 *
 * `extraIssuesGiven` says whether the caller asked for the pre-label era as
 * well. Without it the figure is a count of the LABELLED era only, and the
 * output must say so — this is the one number the whole judge design rests
 * on, and a reader who takes it for an all-time count is misled by six of
 * the eight disagreements it was built to settle.
 *
 * **The rulings are split by whether a check stood behind the argument, and
 * the headline figure covers only the ones that had one.** The judge rules on
 * the reviewer's first refusal too, and most reviewer refusals have no check
 * behind them at all — poor code, a house rule, missing proof the code was
 * run. `checks-wrong` on one of those does not mean a check was wrong,
 * because there was no check; `lib/state/verdict.ts` predicted exactly this
 * and nothing read the field. Every excluded ruling is still PRINTED, under a
 * heading saying why it is out, because a number fixed by hiding half its
 * inputs is the same fault wearing a different face.
 */
export function renderCount(
  result: VerdictCount,
  extraIssuesGiven = false,
  readings?: CheckReadingCount,
): string {
  const tally = result.counts;
  const ruled = VERDICT_VALUES.reduce((sum, v) => sum + tally[v], 0);
  const withCheck = tally.byGrounds["with-check"];
  const withTotal = groupTotal(withCheck);
  const lines = [
    "Which side was wrong, when a CHECK was the thing being argued about",
    "",
    "This block, and only this block, answers \"how often is the check itself",
    "the wrong one\". Every ruling in it came from a screen check that graded a",
    "screen, or a reviewer refusing over a check that went red.",
    "",
    ...verdictRows(withCheck),
    "",
    withTotal === 0
      ? "Arguments with a check behind them: 0. None have been ruled, so there " +
        "is no rate to read off this — not a rate of zero."
      : `Arguments with a check behind them: ${withTotal}. Of those, ` +
        `${withCheck["checks-wrong"]} were the check's fault — ` +
        `${Math.round((withCheck["checks-wrong"] / withTotal) * 100)}%.`,
    // WHAT IS DELIBERATELY NOT IN THE FIGURE ABOVE, printed rather than
    // dropped. The judge also rules on the reviewer's first refusal, and most
    // reviewer refusals have no check behind them at all — poor code, a house
    // rule, or missing proof the code was run. A `checks-wrong` there is not a
    // wrong check, because there was no check. Counting the two together is
    // how this number quietly starts answering a different question.
    ...groupBlock(
      tally.byGrounds["no-check"],
      [
        "Refusals with no check behind them — NOT counted above",
        "",
        "The reviewer refused over poor code, a house rule, or missing proof the",
        "code was run. No check ran on these tickets, so nothing here can be a",
        "wrong check whatever word the ruling used.",
      ],
      "No refusal without a check behind it has been ruled yet.",
    ),
    ...groupBlock(
      tally.byGrounds["not-stated"],
      [
        "Rulings that never said where the argument came from — NOT counted above",
        "",
        "Every verdict written before the run recorded that, and every one typed",
        "by hand. Which pile they belong in is unknown, and a guess either way",
        "would move the figure above, so they are shown apart instead.",
      ],
      "",
    ),
    "",
    "Carrying no ruling of any kind",
    "",
    `  ${String(tally.unrecorded).padStart(4)}  ${"unruled".padEnd(14)} nobody has said which side was wrong`,
    "",
    `Tickets read: ${result.issuesRead.length}. Ruled: ${ruled}.`,
  ];
  // THE DENOMINATOR, printed beside the number it belongs to.
  //
  // The block above counts how often a check turned out to be the wrong one.
  // On its own that figure cannot be acted on: eight wrong checks out of
  // twelve means the run is broken, eight out of three hundred means it is
  // fine, and the two look identical here. So the count of the checks READ is
  // printed in the same breath, and it is printed even when it is zero — a
  // missing denominator that simply vanishes is how the first number silently
  // starts reading as an all-time rate.
  //
  // THE HEADING SAYS TICKETS, NOT READINGS, AND IT SAYS SO ON PURPOSE. Two
  // separate ways "every check the judge opened" was untrue of this number.
  // The check-reading block is REPLACED on every run by design, so a ticket
  // read on ten nights contributes one — the count is tickets, and calling
  // tickets readings is two measures under one name. And on the path where the
  // judge could not be dispatched, the run's own string comparison of the
  // check file can still find a fabricated assertion and a reading is written
  // from that — a check the judge never opened. The wording now covers both;
  // splitting a host-only reading out into its own column needs the record to
  // say who read it, which is a field only `main.mts` can supply.
  if (readings !== undefined) {
    const r = readings.counts;
    lines.push(
      "",
      "Out of how many? Tickets carrying a recorded check reading",
      "",
      "One per ticket, and it is the LATEST reading on that ticket, not one per",
      "reading: the block is replaced every time a check is read again, so a",
      "ticket read on ten nights counts once. A reading is normally the judge's,",
      "and on a night the judge could not be reached the run's own comparison of",
      "the check file against what the check-writer declared can produce one",
      "instead — the ticket itself says which.",
      "",
      `  ${String(r.sound).padStart(4)}  ${"sound".padEnd(14)} ${CHECK_READING_MEANINGS.sound}`,
      `  ${String(r["too-weak"]).padStart(4)}  ${"too-weak".padEnd(14)} ${CHECK_READING_MEANINGS["too-weak"]}`,
      `  ${String(r["ticket-unclear"]).padStart(4)}  ${"ticket-unclear".padEnd(14)} ${CHECK_READING_MEANINGS["ticket-unclear"]}`,
      "",
      r.total === 0
        ? "Tickets with a recorded reading: 0. Nothing has been read yet, so " +
          "there is no rate to read off this — not a rate of zero."
        : `Tickets with a recorded reading: ${r.total}. Of those, ${r.sound} ` +
          `were sound — ${Math.round((r.sound / r.total) * 100)}%.`,
    );
    if (readings.unreadIssues.length > 0) {
      lines.push(
        "",
        "Labelled as read but carrying no reading — NOT counted above, because",
        "a check nobody can vouch for would flatter the total:",
        `  ${readings.unreadIssues.map((n) => `#${n}`).join(", ")}`,
      );
    }
  }
  // Never let a labelled-era count be read as an all-time count. The
  // `stopped:*` labels only began in August 2026, and six of the eight
  // disagreements this tool was built to settle are older than them. USAGE
  // explains the flag, but nobody reads usage after a successful run.
  if (extraIssuesGiven === false) {
    lines.push(
      "",
      "NOT COUNTED: disagreements older than the August 2026 labels — no",
      "query can see them. Add them by number:",
      "  pnpm sandcastle:verdict --issues 805,820,845,848,850,860",
    );
  }
  if (result.unruledIssues.length > 0) {
    lines.push(
      "",
      "Still unruled — each one is a disagreement nobody has settled:",
      `  ${result.unruledIssues.map((n) => `#${n}`).join(", ")}`,
      "",
      'Rule one with:  pnpm sandcastle:verdict set <issue> <verdict> --why "..."',
    );
  }
  return lines.join("\n");
}

export async function run(argv: readonly string[]): Promise<string> {
  const parsed = parseArgs(argv);
  if (parsed.command === "help") return USAGE;
  configureGh({ cwd: process.cwd() });

  if (parsed.command === "show") {
    const record = await readVerdict(parsed.issue);
    return record === undefined
      ? `Issue #${parsed.issue} carries no verdict. Nobody has said which side was wrong.`
      : describeVerdict(record);
  }

  if (parsed.command === "set") {
    // The four `verdict:*` labels are created at the overnight run's
    // startup. A person ruling a disagreement by hand may never have
    // started one — the labels did not exist in this repo at all when this
    // was written — and `gh issue edit --add-label` fails on a label the
    // repo does not have. Creating them here is idempotent and costs one
    // call. The verdict itself would survive the failure anyway, because
    // the body is written before the labels, but the ticket would silently
    // drop out of the count.
    await ensureVerdictLabelsExist({
      onError: (name, err) =>
        process.stderr.write(
          `verdict: could not create the '${name}' label, so this ruling ` +
            `may not be countable until the next run: ${(err as Error).message}\n`,
        ),
    });
    const outcome = await applyVerdictReport(parsed.issue, {
      record: {
        verdict: parsed.verdict,
        decidedBy: "human",
        whenIso: new Date().toISOString(),
        why: parsed.why,
      } satisfies VerdictRecord,
    });
    return outcome === "written"
      ? `Issue #${parsed.issue}: ${parsed.verdict} — ${VERDICT_MEANINGS[parsed.verdict]}`
      : `Issue #${parsed.issue} was left alone: it already carries a verdict set by hand.`;
  }

  return renderCount(
    await countVerdicts({ extraIssues: parsed.extraIssues }),
    parsed.extraIssues.length > 0,
    await countCheckReadings({ extraIssues: parsed.extraIssues }),
  );
}

/** Is this file being run directly, rather than imported by the test? */
function isMain(): boolean {
  if (typeof process.argv[1] !== "string") return false;
  try {
    return resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
  } catch {
    return false;
  }
}

if (isMain()) {
  void (async (): Promise<void> => {
    try {
      process.stdout.write(`${await run(process.argv.slice(2))}\n`);
      process.exit(0);
    } catch (err) {
      process.stderr.write(`verdict: ${(err as Error).message}\n\n${USAGE}\n`);
      process.exit(1);
    }
  })();
}
