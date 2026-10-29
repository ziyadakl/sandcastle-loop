#!/usr/bin/env tsx

/**
 * The refusal report — "over the last N runs, how many tickets did the loop
 * refuse, and how many of those refusals were later shown to be wrong?"
 * (issue #1096).
 *
 * ## Why this exists
 *
 * The loop refuses a ticket when its reviewer will not pass the finished code
 * after every retry the run allows. It has done this thirteen times across
 * nine runs. Seven of one night's eight refusals were later built by hand and
 * shipped — the work was good enough, the refusal was wrong, and it cost a
 * full build cycle each. But a fair refusal and a wrong one looked identical
 * for ever, so the refusal rule could not be tuned: nobody knew its error rate.
 *
 * Now every refusal stamps an outcome checkbox onto its ticket body, and
 * whoever later builds the ticket by hand and closes it ticks whether the
 * refusal was correct. This reads those ticks back and counts them.
 *
 * ## Where the answer lives
 *
 * On the ticket BODY, not in run telemetry — the refusal and the later close
 * happen on different runs (grilling decision 2026-08-25). This reads the
 * bodies of every ticket wearing `stopped:reviewer-refused`.
 *
 * ## Commands
 *
 *   pnpm sandcastle:refusals              every refusal, grouped by the run that made it
 *   pnpm sandcastle:refusals --last 3     only the three most recent runs
 *
 * EXIT CODE CONTRACT, matching `verdict.mts`: non-zero means THE TOOL BROKE.
 * Zero refusals, an unflattering error rate — all print a clear line and exit
 * 0. An ugly number is not a failure.
 */

import { resolve } from "node:path";

import { configureGh, countRefusals, type RefusalRow } from "../lib/state/gh.js";

const USAGE = [
  "Usage:",
  "  pnpm sandcastle:refusals            every refusal, grouped by the run that made it",
  "  pnpm sandcastle:refusals --last N   only the N most recent runs",
].join("\n");

/** Read `--last N`, or `undefined` for all runs. Throws on a non-number, per
 *  the exit-code contract (a bad flag is the tool being misused). */
export function parseLast(argv: readonly string[]): number | undefined {
  const i = argv.indexOf("--last");
  if (i === -1) return undefined;
  const raw = argv[i + 1];
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`--last expects a positive whole number, got '${raw ?? ""}'`);
  }
  return n;
}

const UNKNOWN_RUN = "(run not recorded)";

/** One run's refusals, newest run first. */
interface RunGroup {
  readonly runId: string;
  /** The latest `whenIso` seen in the group, for ordering runs. Empty string
   *  sorts last, so a group with no timestamps never displaces a dated run. */
  readonly latestWhen: string;
  readonly rows: readonly RefusalRow[];
}

/** Group refusals by the run that made them, newest run first. */
export function groupByRun(rows: readonly RefusalRow[]): RunGroup[] {
  const byRun = new Map<string, RefusalRow[]>();
  for (const row of rows) {
    const key = row.runId ?? UNKNOWN_RUN;
    (byRun.get(key) ?? byRun.set(key, []).get(key)!).push(row);
  }
  const groups: RunGroup[] = [...byRun.entries()].map(([runId, groupRows]) => ({
    runId,
    latestWhen: groupRows.reduce((max, r) => (r.whenIso && r.whenIso > max ? r.whenIso : max), ""),
    rows: groupRows,
  }));
  // Newest run first; runs with no timestamp fall to the end, then by name so
  // the order is stable across invocations.
  groups.sort((a, b) => {
    if (a.latestWhen !== b.latestWhen) return a.latestWhen < b.latestWhen ? 1 : -1;
    return a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0;
  });
  return groups;
}

/**
 * Render the report. Pure, so the wording is testable without GitHub.
 *
 * The headline is the one number the whole ticket exists to produce — how many
 * refusals were later shown wrong — and it is printed beside its denominator
 * (how many refusals have been judged at all), because "3 wrong" means nothing
 * until you know it is 3 of 4 or 3 of 300.
 */
export function renderRefusalReport(
  rows: readonly RefusalRow[],
  opts: { readonly last?: number } = {},
): string {
  const allGroups = groupByRun(rows);
  const groups =
    opts.last === undefined ? allGroups : allGroups.slice(0, opts.last);
  const scoped = groups.flatMap((g) => g.rows);

  const count = (o: RefusalRow["outcome"]): number =>
    scoped.filter((r) => r.outcome === o).length;
  const wrong = count("wrong");
  const correct = count("correct");
  const unjudged = count("unjudged");
  const ambiguous = count("ambiguous");
  const judged = wrong + correct;

  const scopeLine =
    opts.last === undefined
      ? `Every recorded refusal: ${scoped.length} across ${groups.length} run(s).`
      : `The ${groups.length} most recent run(s) (of ${allGroups.length}): ` +
        `${scoped.length} refusal(s).`;

  const lines = [
    "How often the loop refused a ticket, and how often it was wrong to",
    "",
    scopeLine,
    "",
    `  ${String(scoped.length).padStart(4)}  refusals in scope`,
    `  ${String(wrong).padStart(4)}  later shown WRONG   (built by hand and shipped anyway)`,
    `  ${String(correct).padStart(4)}  confirmed correct  (the code really was not good enough)`,
    `  ${String(unjudged).padStart(4)}  not yet judged     (nobody has ticked a box)`,
    ...(ambiguous > 0
      ? [`  ${String(ambiguous).padStart(4)}  ambiguous          (both boxes ticked — needs a hand fix)`]
      : []),
    "",
    judged === 0
      ? "No refusal has been judged yet, so there is no error rate to read off " +
        "this — not a rate of zero. Tick a box on a closed refused ticket to " +
        "start the count."
      : `Of the ${judged} refusals judged so far, ${wrong} were wrong — ` +
        `${Math.round((wrong / judged) * 100)}%.`,
  ];

  if (unjudged > 0) {
    lines.push(
      "",
      "Refused but never judged — tick correct or wrong on each when it closes:",
      `  ${scoped.filter((r) => r.outcome === "unjudged").map((r) => `#${r.issue}`).join(", ")}`,
    );
  }

  if (groups.length > 0) {
    lines.push("", "By run, newest first:");
    for (const g of groups) {
      const w = g.rows.filter((r) => r.outcome === "wrong").length;
      const c = g.rows.filter((r) => r.outcome === "correct").length;
      const u = g.rows.filter((r) => r.outcome === "unjudged").length;
      lines.push(
        `  ${g.runId}: ${g.rows.length} refusal(s) — ` +
          `${w} wrong, ${c} correct, ${u} unjudged  ` +
          `[${g.rows.map((r) => `#${r.issue}`).join(", ")}]`,
      );
    }
  }

  return lines.join("\n");
}

export async function run(argv: readonly string[]): Promise<string> {
  if (argv.includes("--help") || argv.includes("-h")) return USAGE;
  const last = parseLast(argv);
  configureGh({ cwd: process.cwd() });
  const { rows } = await countRefusals();
  return renderRefusalReport(rows, { last });
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
      process.stderr.write(`refusal-report: ${(err as Error).message}\n\n${USAGE}\n`);
      process.exit(1);
    }
  })();
}
