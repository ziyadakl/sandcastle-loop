/**
 * Planner — single-shot agent that runs once at the start of every loop
 * wake-up. Reads every open `ready-for-agent` issue and returns a
 * priority-ordered queue plus a who-blocks-who map.
 *
 * Why an agent and not regex? Issue authors phrase blockers many ways:
 * `Blocked by: #5`, `Depends on #5`, `Requires #5`, `(blocks: #5)`, etc.
 * A small Claude call handles whatever wording shows up across projects.
 *
 * Implementation notes:
 *
 *   - We would prefer Sandcastle's `Output.object({ tag, schema })` helper
 *     because it validates the JSON payload for us and the tag-matching
 *     contract is exactly what we want (single-shot, tag must appear in the
 *     prompt). Sandcastle 0.5.8 (this repo's pinned version) does NOT export
 *     `Output` from its package entrypoint — see
 *     `node_modules/@ai-hero/sandcastle/dist/index.d.ts`. So we instruct the
 *     agent to emit the JSON inside `<plan>...</plan>` tags ourselves, then
 *     extract+validate it through Track B's {@link parseVerdict} (which
 *     already implements the tag-extract + Zod-validate pipeline used by the
 *     reviewer/fixer). If a future sandcastle version exposes `Output`,
 *     swapping is a localized change to {@link runPlanner}.
 *
 *   - The output schema {@link PlannerOutputSchema} is the LOAD-BEARING
 *     contract — the loop iterates on `priorityOrder` and skips stories whose
 *     blockers (per `dependencies`) are still open. Adding fields here without
 *     coordinating with the loop track is forbidden.
 */

import { z } from "zod";
import { claudeCode } from "@ai-hero/sandcastle";
import type { Sandbox } from "@ai-hero/sandcastle";
import { parseVerdict, VerdictParseError } from "../../src/verdicts/index.js";

// ---------------------------------------------------------------------------
// Schema — the load-bearing contract with the loop
// ---------------------------------------------------------------------------

/**
 * Internal raw shape — pre-cross-field-validation. Exported as
 * {@link PlannerOutputSchema} below with a {@link buildPlannerOutputSchema}
 * helper so callers that know the input issue numbers can ALSO assert that
 * `priorityOrder` is a permutation of the input set. The default export is
 * the input-agnostic schema (still rejects internal duplicates / dangling
 * dependency references) so existing call sites keep working.
 */
const PlannerOutputBaseSchema = z.object({
  /**
   * Issue numbers in the order the loop should attempt them. The loop walks
   * this list, skips any issue whose blockers are still open (per
   * `dependencies`), and works the first eligible one.
   */
  priorityOrder: z.array(z.number().int().positive()),
  /**
   * Map of who-blocks-who. Each entry says "issue #N is blocked by issues
   * #A, #B, #C". An empty `blockedBy` array means the issue has no blockers
   * but is still listed (e.g. the planner enumerates every issue for
   * traceability). Issues with NO blockers may be omitted entirely.
   *
   * Blocker numbers in `blockedBy` may be ANY positive integer — they are
   * NOT required to appear in `priorityOrder`. Rationale: the loop checks
   * each blocker's actual state (open / closed / done) at run-time, which
   * means a blocker referencing an already-closed issue (a perfectly normal
   * case after an issue has been completed in a prior loop wake-up) MUST
   * still be representable here. The planner can't easily tell from the
   * input list whether a missing-from-input issue is closed or just absent;
   * we relax this rule and let the loop do the closed-check at run-time.
   */
  dependencies: z.array(
    z.object({
      issue: z.number().int().positive(),
      blockedBy: z.array(z.number().int().positive()),
    }),
  ),
});

/**
 * Input-agnostic schema. Enforces:
 *
 *   - `priorityOrder` has no duplicates.
 *   - Every entry in `dependencies[i].issue` exists in `priorityOrder`
 *     (the planner cannot block an issue it didn't priority-order).
 *
 * It does NOT enforce that `priorityOrder` is a permutation of the input
 * issue numbers — that requires knowing the input. Callers with input
 * context should use {@link buildPlannerOutputSchema} instead.
 */
export const PlannerOutputSchema = PlannerOutputBaseSchema.superRefine(
  (val, ctx) => {
    // 1. priorityOrder duplicate check.
    const seen = new Set<number>();
    for (let i = 0; i < val.priorityOrder.length; i++) {
      const n = val.priorityOrder[i]!;
      if (seen.has(n)) {
        ctx.addIssue({
          code: "custom",
          path: ["priorityOrder", i],
          message: `priorityOrder contains duplicate issue #${n}`,
        });
      }
      seen.add(n);
    }

    // 2. Every dependencies[i].issue must appear in priorityOrder.
    for (let i = 0; i < val.dependencies.length; i++) {
      const dep = val.dependencies[i]!;
      if (!seen.has(dep.issue)) {
        ctx.addIssue({
          code: "custom",
          path: ["dependencies", i, "issue"],
          message:
            `dependencies[${i}].issue references #${dep.issue} which is ` +
            `not in priorityOrder`,
        });
      }
      // blockedBy: intentionally NOT membership-checked — see schema docstring.
    }
  },
);

export type PlannerOutput = z.infer<typeof PlannerOutputSchema>;

/**
 * Build a stricter schema that ALSO asserts:
 *
 *   - Every entry in `priorityOrder` exists in `inputIssueNumbers`
 *     (the planner cannot priority-order an issue it wasn't given).
 *   - `priorityOrder` is a permutation of `inputIssueNumbers`
 *     (no missing input issues; together with the duplicate check on
 *     priorityOrder this means exact-set equality).
 *
 * Callers that have access to the input issue list (i.e. the loop driver
 * post-fetch) should validate the agent's output against THIS schema; the
 * input-agnostic {@link PlannerOutputSchema} stays for general use.
 */
export function buildPlannerOutputSchema(
  inputIssueNumbers: readonly number[],
): z.ZodType<PlannerOutput> {
  const inputSet = new Set(inputIssueNumbers);
  return PlannerOutputBaseSchema.superRefine((val, ctx) => {
    // Re-run the input-agnostic checks first so callers using this schema
    // get the same diagnostic precision as the default schema.
    const seen = new Set<number>();
    for (let i = 0; i < val.priorityOrder.length; i++) {
      const n = val.priorityOrder[i]!;
      if (seen.has(n)) {
        ctx.addIssue({
          code: "custom",
          path: ["priorityOrder", i],
          message: `priorityOrder contains duplicate issue #${n}`,
        });
      }
      seen.add(n);

      // Membership check.
      if (!inputSet.has(n)) {
        ctx.addIssue({
          code: "custom",
          path: ["priorityOrder", i],
          message:
            `priorityOrder contains #${n} which was not in the input ` +
            `issue list`,
        });
      }
    }

    // Permutation check: every input issue must appear in priorityOrder.
    for (const n of inputSet) {
      if (!seen.has(n)) {
        ctx.addIssue({
          code: "custom",
          path: ["priorityOrder"],
          message:
            `priorityOrder is missing input issue #${n} (must be a ` +
            `permutation of the input list)`,
        });
      }
    }

    for (let i = 0; i < val.dependencies.length; i++) {
      const dep = val.dependencies[i]!;
      if (!seen.has(dep.issue)) {
        ctx.addIssue({
          code: "custom",
          path: ["dependencies", i, "issue"],
          message:
            `dependencies[${i}].issue references #${dep.issue} which is ` +
            `not in priorityOrder`,
        });
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Public input / config / error
// ---------------------------------------------------------------------------

export interface PlannerInput {
  openIssues: Array<{
    number: number;
    title: string;
    body: string;
    labels: string[];
    /** ISO-8601 string. Used as the within-priority tiebreaker (oldest first). */
    createdAt: string;
  }>;
}

export interface PlannerConfig {
  /** Defaults to "claude-sonnet-4-6". */
  model?: string;
  /**
   * Idle timeout in seconds for the underlying sandbox.run() call. Defaults
   * to 600 (Sandcastle's default) — the planner is cheap, but a single
   * malformed prompt shouldn't be allowed to wedge the loop.
   */
  idleTimeoutSeconds?: number;
}

/**
 * Thrown when the agent's output cannot be parsed into a valid
 * {@link PlannerOutput}. Carries the offending raw text so callers can log it.
 */
export class PlannerError extends Error {
  public readonly rawText: string;
  public readonly cause: Error;
  public constructor(message: string, cause: Error, rawText: string) {
    super(
      `${message}\n--- offending planner output (first 2000 chars) ---\n` +
        `${rawText.slice(0, 2000)}\n--- end ---`,
    );
    this.name = "PlannerError";
    this.cause = cause;
    this.rawText = rawText;
  }
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/**
 * The static planner system instructions. The synonym list here is the
 * differentiator vs. a regex: it tells the agent to recognize "Blocked by",
 * "Depends on", "Requires", "Needs", "After", "Waits on", and inline
 * parentheticals like `(blocks: #5)` — i.e. whatever phrasing real issue
 * authors use.
 *
 * The `<plan>` tag is included so it always appears in the resolved prompt
 * (a future Output.object swap requires this; parseVerdict relies on it too).
 */
const PLANNER_INSTRUCTIONS = `You are the Planner. Once per loop wake-up, you read every open \`ready-for-agent\` issue and return a priority-ordered queue plus a who-blocks-who map. The downstream loop walks your queue in order and skips any issue whose blockers are still open.

INPUTS: a list of open issues, each with { number, title, body, labels, createdAt }.

Your job:

1. DEPENDENCY EXTRACTION. Read each issue's body. Record every dependency you find. Recognize ALL of these phrasings as equivalent — they all mean "this issue is blocked by issue #N":

   - "Blocked by: #N", "Blocked by #N", "blocked-by #N"
   - "Depends on: #N", "Depends on #N", "depends-on #N"
   - "Requires #N", "Requires: #N"
   - "Needs #N", "Needs: #N"
   - "After #N" (when used in a dependency context, not a date)
   - "Waits on #N", "Waiting on #N"
   - Inline / parenthesized forms: "(blocks: #5)", "[depends-on: #5]", "blocked-by:#5"
   - Multiple blockers on one line: "Blocked by: #3, #5, #7" or "Blocked by #3 and #5"
   - Markdown checklists: "- [ ] Blocked by #5"

   Do NOT count mentions in code blocks, examples, or "see also #N" / "related to #N" / "cf. #N" — those are references, not blockers. If an issue clearly references another issue but the wording is genuinely ambiguous, treat it as NOT a blocker.

   Only record blockers that point to issue numbers ACTUALLY PRESENT in the input list. Drop dangling references.

2. PRIORITY ORDERING. Sort the issue numbers into \`priorityOrder\` using these rules, in this exact precedence:

   a. Label-driven priority bucket: \`priority:high\` first, then \`priority:medium\`, then \`priority:low\`. Issues with NO priority label are treated as \`priority:medium\`.
   b. Within the same priority bucket, OLDEST createdAt first (lexicographic ISO-8601 compare).

   Do NOT topologically sort by dependencies — the loop handles skipping blocked issues at run-time. Your job is just to express priority order; the loop combines it with your \`dependencies\` map.

3. OUTPUT. Emit exactly one JSON object inside a single \`<plan>...</plan>\` block. The schema is:

   \`\`\`
   {
     "priorityOrder": number[],
     "dependencies": [{ "issue": number, "blockedBy": number[] }]
   }
   \`\`\`

   - \`priorityOrder\` must contain every input issue's number, exactly once. No duplicates, no extras, no issues that weren't in the input.
   - \`dependencies\` should list every issue that has at least one blocker. Issues with no blockers may be omitted (or included with \`blockedBy: []\` — both are accepted).
   - Emit ONLY the \`<plan>\` block. No prose before or after, no commentary, no markdown fences.

If the input list is empty, emit \`<plan>{"priorityOrder":[],"dependencies":[]}</plan>\`.`;

/**
 * Render the per-call prompt: static instructions + the issue list. Each
 * issue's body is included in full so the planner can read inline blocker
 * phrasing (`Depends on #5`, etc.) verbatim.
 */
export function buildPlannerPrompt(input: PlannerInput): string {
  if (input.openIssues.length === 0) {
    return (
      `${PLANNER_INSTRUCTIONS}\n\n` +
      `INPUT: there are zero open ready-for-agent issues.\n\n` +
      `Emit <plan>{"priorityOrder":[],"dependencies":[]}</plan> and stop.`
    );
  }

  const renderedIssues = input.openIssues
    .map((iss) => {
      const labelStr =
        iss.labels.length === 0 ? "(none)" : iss.labels.join(", ");
      return (
        `==== Issue #${iss.number} ====\n` +
        `Title: ${iss.title}\n` +
        `Labels: ${labelStr}\n` +
        `Created at: ${iss.createdAt}\n` +
        `Body:\n${iss.body}\n` +
        `==== end #${iss.number} ====`
      );
    })
    .join("\n\n");

  return (
    `${PLANNER_INSTRUCTIONS}\n\n` +
    `INPUT — ${input.openIssues.length} open issue(s):\n\n` +
    `${renderedIssues}\n\n` +
    `Now emit your single <plan>...</plan> block.`
  );
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run the planner against a live sandbox. Returns a validated
 * {@link PlannerOutput}; throws {@link PlannerError} if the agent's output
 * can't be parsed.
 *
 * Single-shot: maxIterations === 1. We rely on the `<plan>` tag appearing in
 * the prompt (it does, via {@link buildPlannerPrompt}) so that a future swap
 * to `Output.object({ tag: "plan", schema: PlannerOutputSchema })` would Just
 * Work without re-engineering the prompt.
 */
export async function runPlanner(
  sandbox: Sandbox,
  input: PlannerInput,
  config?: PlannerConfig,
): Promise<PlannerOutput> {
  const model = config?.model ?? "claude-sonnet-4-6";
  const idleTimeoutSeconds = config?.idleTimeoutSeconds ?? 600;

  const prompt = buildPlannerPrompt(input);

  const result = await sandbox.run({
    agent: claudeCode(model),
    prompt,
    maxIterations: 1,
    idleTimeoutSeconds,
    name: "planner",
  });

  // Track B's parseVerdict handles both stream-json envelopes and
  // already-extracted assistant text. sandbox.run.stdout is the combined
  // stdout from all iterations — for stream-json mode that's the
  // envelope-encoded blob; for plain text it's the raw assistant text. We
  // call parseVerdict in stream-json mode first; if there are no envelopes
  // (i.e. plain stdout), we retry as already-extracted text.
  const rawText = result.stdout;

  // Build an input-aware schema so we additionally enforce:
  //   - priorityOrder is a permutation of input.openIssues numbers
  //   - every priorityOrder entry exists in the input
  // (The duplicate / dependency-membership checks live in the schema too.)
  const inputAwareSchema = buildPlannerOutputSchema(
    input.openIssues.map((i) => i.number),
  );

  try {
    return parseVerdict(rawText, inputAwareSchema, { jsonTag: "plan" });
  } catch (err) {
    if (err instanceof VerdictParseError) {
      // Fallback path: maybe stdout is plain text (not stream-json envelopes).
      try {
        return parseVerdict(rawText, inputAwareSchema, {
          jsonTag: "plan",
          alreadyAssistantText: true,
        });
      } catch (err2) {
        const cause2 = err2 instanceof Error ? err2 : new Error(String(err2));
        throw new PlannerError(
          "Planner output failed schema validation (tried both stream-json and plain-text decode).",
          cause2,
          rawText,
        );
      }
    }
    const cause = err instanceof Error ? err : new Error(String(err));
    throw new PlannerError(
      "Planner output failed schema validation.",
      cause,
      rawText,
    );
  }
}
