/**
 * The check-writer's verdict envelope (issue #911, Piece D of
 * `docs/specs/2026-08-04-screen-check-design-lock.md`).
 *
 * A separate agent writes the acceptance check BEFORE the builder starts,
 * reading the ticket plus the codebase as it stands. It is allowed to say
 * exactly FIVE things (four until issue #956 added `UNIT_CHECK_WRITTEN`), and
 * they must arrive as five DISTINCT, independently validated shapes — not five
 * free-text sentences a caller has to guess apart by regex. That is the whole
 * point of a schema here: `main.mts` branches on `marker`, and each branch's
 * required fields are enforced at PARSE time (mirrors
 * `ImplementerOutputSchema`'s cross-field `superRefine` in
 * `lib/verdicts/schemas.ts`), so a malformed envelope fails loudly before it
 * can be misread as one of the other four outcomes. The `switch` below is
 * exhaustive by construction, so a sixth marker cannot be added without a
 * decision being made here about what it requires.
 *
 * ## Why `NEEDS_WORLD_DATA` has no numeric field
 *
 * The spec is explicit: "It never proposes the figures." That is enforced
 * structurally, not by convention — this schema has no field that could hold
 * a dollar amount, a row count, or a seed value for that outcome. The
 * check-writer can only describe the gap in words (`worldDataNeeded`); there
 * is nowhere in the shape to smuggle a number through.
 *
 * ## Why `inherited` is a top-level boolean, not folded into the marker
 *
 * A ticket can arrive carrying its own already-proven-red check (Piece J:
 * real-data bugs, translated into the practice world by a supervised
 * diagnosis session). The check-writer must recognise that and NOT rewrite
 * it — the must-fail-first rule is already satisfied on the way in, by a
 * person who watched it go red. `inherited` is independent of which of the
 * five things the agent is saying (in practice it is only ever `true`
 * alongside `CHECKS_WRITTEN` — recognising an existing check IS "here are
 * the checks", just not authored this pass) so it stays a separate field
 * rather than a marker value of its own.
 *
 * `main.mts` does NOT take this field on faith — see
 * `hasPreexistingCheckFiles` in `check-path.ts`, which is the HOST's own
 * filesystem observation of whether check files existed before the
 * check-writer's pass ran. A mismatch between the agent's claim and the
 * host's own observation is resolved in the host's favour (never trust a
 * self-report over a directly observable fact) — `main.mts`'s
 * `runCheckWriter` computes `inherited` from that observation ALONE, never
 * OR'd with this field.
 *
 * ## Why an unusable `checkPath` fails PARSING, not just command-building
 *
 * `buildCheckCommand` (`check-path.ts`) already re-validates `checkPath`
 * against `isSafeCheckRelativePath` and returns `undefined` for anything
 * unsafe — a whitelist discipline, not a re-trust of this string. Before
 * this schema ALSO enforced the same rule at parse time, an unsafe
 * `checkPath` (e.g. one containing a space, so `isSafeCheckRelativePath`
 * rejects it but `z.string().min(1)` happily accepts it) let a
 * `CHECKS_WRITTEN` envelope parse successfully, `buildCheckCommand` return
 * `undefined`, `mustFailFirst` resolve to `"inconclusive"` (which never
 * blocks), and the WHOLE ship-time browser gate — no browser, no picture,
 * no screen-check telemetry — get skipped silently, because the gate at
 * the ship funnel only engages `checkWriterCheckCommand !== undefined`.
 * Enforcing the same whitelist here means that path can no longer be
 * reached at all: an unsafe `checkPath` now fails Zod validation, which
 * `parseVerdict` turns into a `VerdictParseError` `runCheckWriterStage`
 * catches and turns into an explicit, loud `stopped:no-failing-check`
 * quarantine — never a silent fall-through to "nothing to check".
 */

import { z } from "zod";

import { extractAllJsonFences } from "../verdicts/parse.js";
import { checkKindForMarker } from "./check-kind.js";
import { isSafeCheckRelativePath } from "./check-path.js";
import {
  isSafeUnitCheckPackage,
  isSafeUnitCheckRelativePath,
} from "./unit-check-path.js";

/**
 * The five things the check-writer is allowed to say.
 *
 * `UNIT_CHECK_WRITTEN` is the fifth (issue #956). It is `CHECKS_WRITTEN` with a
 * different runner and nothing else changed: the new vitest test is proven RED
 * against untouched code, minting the same must-fail-first receipt with the
 * same sha256 lock over the check's exact bytes, and re-run GREEN at ship time.
 * It exists because a ticket with no screen — an email queue, a cron script, a
 * database rule — could previously only photograph nothing or prove nothing,
 * and the second is what it kept choosing. WHICH of the two a given diff is
 * entitled to offer is decided from the finished diff by `proof-demand.ts`,
 * never by this envelope.
 */
export const CHECK_WRITER_MARKERS = [
  "CHECKS_WRITTEN",
  "UNIT_CHECK_WRITTEN",
  "ALREADY_BUILT",
  "NEEDS_WORLD_DATA",
  "NO_SCREEN_APPLIES",
  /** The ticket leaves a product question open (spec #1334 fix pass): the
   *  ticket stops for the owner with `ticketQuestion` written on it. */
  "TICKET_UNCLEAR",
] as const;
export type CheckWriterMarker = (typeof CHECK_WRITER_MARKERS)[number];

/** What {@link reconcileCheckWriterMarkers} decided about one output. */
export type CheckWriterMarkerReconciliation =
  | { readonly kind: "agree"; readonly marker: CheckWriterMarker }
  | {
      readonly kind: "reconciled";
      /** The marker the stage should act on — always the ENVELOPE's. */
      readonly marker: CheckWriterMarker;
      /** What the bare last line said instead. */
      readonly lineMarker: CheckWriterMarker;
    }
  | {
      readonly kind: "disagree";
      readonly lineMarker: CheckWriterMarker;
      readonly envelopeMarker: CheckWriterMarker;
    };

/**
 * The `marker` field of the LAST fenced ```json``` block in `text`, or
 * `undefined` when there is no fenced block, the last one is not JSON, or it
 * carries no string `marker`. This is the ONE input
 * {@link reconcileCheckWriterMarkers} needs beyond the two markers: whether
 * the envelope `parseVerdict` handed back is the block the agent finished on,
 * or an earlier draft it fell back to. Deliberately reads only the marker —
 * no schema, no validation — because the question is "which block", not
 * "is it valid".
 */
export function lastFenceMarkerOf(text: string): string | undefined {
  // `extractAllJsonFences` returns LAST-first — the same order `parseVerdict`
  // walks — so index 0 is the block the agent ended on.
  const last = extractAllJsonFences(text)[0];
  if (last === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(last);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const marker = (parsed as { marker?: unknown }).marker;
    return typeof marker === "string" ? marker : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The last-line outcome marker (`extractMarker`) against the fenced envelope's
 * own `marker` field (`parseVerdict`) — two independent passes over the same
 * output that nothing compared until the 2026-08-04 review's finding #2. When
 * they disagree, the pipeline branches on the LINE and takes every payload
 * field from the ENVELOPE, so a `CHECKS_WRITTEN` line over a
 * `NO_SCREEN_APPLIES` envelope switched off both ship-time gates at once.
 * That pair, and every other cross-outcome pair, still `disagree`s here and
 * stops the ticket as `stopped:check-disagreement`.
 *
 * ONE pair is reconciled instead (2026-09-10): both markers WRITE A CHECK —
 * "writes a check" is asked of `checkKindForMarker`, the single derivation of
 * that question (`check-kind.ts`), never a second hand-kept list here, so a
 * sixth check-writing marker cannot be silently left out. On 2026-09-10 #1249
 * (the commission-engine Team wall) and #1235 (naming a live deal while
 * filing an unrelated one) both died on it in one run, on attempt 4 and
 * attempt 2, with $0 of builder spend: a self-consistent `UNIT_CHECK_WRITTEN`
 * envelope — `checkPackage` plus a `.test.ts` `checkPath`, which this file's
 * `superRefine` accepts under NO other marker — closed by `CHECKS_WRITTEN` on
 * the last line, read by the model as the generic "the checks are written"
 * rather than as the browser runner's own name. The envelope wins that
 * disagreement because it is the reading the ship gate actually consumes AND
 * the one whose payload the schema has already checked against its marker;
 * the bare line carries no payload to check anything against. Taking the
 * line instead would hand a `.test.ts` path to the browser route,
 * `checkWriterCheckLocation` would return `undefined`, and the ticket would
 * proceed with NO proof — the exact silent hole finding #2 closed.
 *
 * ## `lastFenceMarker` — the envelope must be the block the agent ENDED on
 *
 * `parseVerdict` walks the fenced blocks last-to-first and returns the first
 * that passes the schema. So an envelope can be an EARLIER draft the agent
 * abandoned, handed back because the final block failed validation — the
 * stale-block hazard `CheckWriterMarkerEnvelopeMismatchError`'s doc names as
 * a reason the stop exists. A reconcile that trusted such an envelope would
 * proceed on the draft. So the written-versus-written pair reconciles ONLY
 * when the last fenced block's own `marker` equals the envelope's (see
 * {@link lastFenceMarkerOf}); otherwise the envelope demonstrably did not
 * come from the final block, and the pair disagrees exactly as before. (An
 * agreeing pair whose envelope is a stale draft with the SAME marker is
 * unchanged by this function — it was never a marker disagreement, and the
 * downstream fail-closed guards — the missing-helper scan, the package
 * resolve, the must-fail-first proof — are what bound it.)
 *
 * The caller still logs and counts a reconciled pair (the prompt was
 * tightened in the same change; this is how "does the model still do it" is
 * measured), and a `disagree` result is still a loud stop.
 */
export function reconcileCheckWriterMarkers(
  lineMarker: CheckWriterMarker,
  envelopeMarker: CheckWriterMarker,
  lastFenceMarker: string | undefined,
): CheckWriterMarkerReconciliation {
  if (lineMarker === envelopeMarker) {
    return { kind: "agree", marker: envelopeMarker };
  }
  const bothWriteACheck =
    checkKindForMarker(lineMarker) !== undefined &&
    checkKindForMarker(envelopeMarker) !== undefined;
  if (bothWriteACheck && lastFenceMarker === envelopeMarker) {
    return { kind: "reconciled", marker: envelopeMarker, lineMarker };
  }
  return { kind: "disagree", lineMarker, envelopeMarker };
}

const CheckWriterOutputBaseSchema = z.object({
  marker: z.enum(CHECK_WRITER_MARKERS),
  /**
   * True when the check-writer recognised a check that arrived with the
   * ticket already proven red by a person, rather than authoring a new one.
   * Only meaningful alongside `CHECKS_WRITTEN` — the field still parses
   * (defaulting false) on the other four markers so a confused agent that
   * sets it there doesn't fail the whole envelope over an inapplicable flag.
   * The `.default(false)` is what makes that promise true: an envelope that
   * OMITS the field parses to `false` rather than being rejected as malformed,
   * which is exactly how a correct `NEEDS_WORLD_DATA` refusal on #1146/#1091
   * was demoted to a parse-error quarantine before this was fixed.
   */
  inherited: z.boolean().default(false),
  /** Which screen/route/page this check targets, in the agent's own words. */
  screen: z.string().min(1).optional(),
  /**
   * Path to the check file, RELATIVE to the per-issue check directory — which
   * directory that is depends on the marker, and so does the extension:
   * `apps/nextjs/e2e/checks/issue-<N>/team-cash-flow.spec.ts` for
   * `CHECKS_WRITTEN` (`isSafeCheckRelativePath`, `check-path.ts`) and
   * `<checkPackage>/src/__checks__/issue-<N>/email-registry.test.ts` for
   * `UNIT_CHECK_WRITTEN` (`isSafeUnitCheckRelativePath`,
   * `unit-check-path.ts`). Never an absolute path, never one containing `..`.
   * Re-validated by THIS schema's own `superRefine` below (alongside the
   * matching command builder's independent re-check at the point it's used) —
   * an unsafe `checkPath` fails PARSING, it never merely fails to build a
   * runnable command. See the module doc comment's "Why an unusable
   * `checkPath` fails parsing" section for why that distinction matters; the
   * argument is identical on both routes.
   */
  checkPath: z.string().min(1).optional(),
  /**
   * The workspace directory hosting a `UNIT_CHECK_WRITTEN` check — always
   * `packages/<name>`, never `apps/*` (issue #956). Meaningless on the other
   * four markers, which is why it is optional here and REQUIRED by the
   * `UNIT_CHECK_WRITTEN` arm below rather than by the field's own type.
   *
   * The envelope names a DIRECTORY and never a package name: the npm name that
   * ends up inside the run command is read by the host from that directory's
   * own `package.json` (`resolveUnitCheckPackage`), so the only thing an agent
   * influences is which directory the host consults — and that is whitelisted
   * by `isSafeUnitCheckPackage` here, before anything is opened.
   */
  checkPackage: z.string().min(1).optional(),
  /** Evidence the ticket is already built — what was found, and where. */
  alreadyBuiltEvidence: z.string().min(1).optional(),
  /**
   * Free-text description of what the practice world is missing. NEVER a
   * proposed figure or row — see the module doc comment for why there is no
   * field this could hide in.
   */
  worldDataNeeded: z.string().min(1).optional(),
  /** Why no screen applies to this ticket. */
  noScreenReason: z.string().min(1).optional(),
  /** The exact product question the ticket leaves open (`TICKET_UNCLEAR`). */
  ticketQuestion: z.string().min(1).optional(),
  // No `coverage` field (spec #1334 SE): issue #1118's per-criterion coverage
  // declaration had one reader, the judge, which spec #1334 deleted. An older
  // envelope that still sends one parses — zod drops the unknown key.
});

export const CheckWriterOutputSchema = CheckWriterOutputBaseSchema.superRefine(
  (val, ctx) => {
    switch (val.marker) {
      case "CHECKS_WRITTEN":
        if (val.checkPath === undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["checkPath"],
            message:
              "CHECKS_WRITTEN requires checkPath — the file under the per-issue " +
              "check directory this envelope is about, whether freshly authored " +
              "or (when inherited=true) recognised as already present.",
          });
        } else if (!isSafeCheckRelativePath(val.checkPath)) {
          // An unusable checkPath must STOP the ticket, loudly and
          // distinctly — never silently fall through to
          // `buildCheckCommand` returning `undefined`, which downstream
          // used to resolve to `mustFailFirst: "inconclusive"` (never
          // blocks) and a `checkCommand: undefined` that skips the WHOLE
          // ship-time browser gate (`checkWriterCheckCommand !==
          // undefined` at the ship funnel). Failing here, at the schema
          // boundary, means the caller (`runCheckWriter`) never even
          // reaches that branch — `parseVerdict` throws `VerdictParseError`
          // instead, which `runCheckWriterStage` now catches and turns
          // into an explicit `stopped:no-failing-check` quarantine (see
          // `main.mts`'s `buildAnywayUnusableCheckWriterEnvelope` — since #1198 A
          // that road BUILDS the ticket with no check rather than stopping it,
          // but the unsafe path is still refused as a check, which is the
          // property this enforcement exists for).
          ctx.addIssue({
            code: "custom",
            path: ["checkPath"],
            message:
              `CHECKS_WRITTEN's checkPath must be a single safe relative ` +
              `path ending in .spec.ts, no "..", no leading "/", no shell ` +
              `metacharacters (see isSafeCheckRelativePath in ` +
              `check-path.ts) — got ${JSON.stringify(val.checkPath)}.`,
          });
        }
        if (val.screen === undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["screen"],
            message:
              "CHECKS_WRITTEN requires screen — which page/route the check targets.",
          });
        }
        break;
      case "UNIT_CHECK_WRITTEN":
        // THE SAME ARGUMENT AS THE CHECKS_WRITTEN ARM ABOVE, VERBATIM — see
        // that arm's comment and the module doc's "Why an unusable `checkPath`
        // fails parsing" section rather than a second copy of it here. Only the
        // names change: `buildUnitCheckCommand` in place of `buildCheckCommand`,
        // `.test.ts` in place of `.spec.ts`. An unsafe path that PARSES makes
        // the command builder return `undefined`, and `undefined` reads
        // downstream as "nothing to check", which skips the whole ship-time
        // gate in silence. Failing here means that path cannot be reached.
        //
        // ONE THING IS NEW ON THIS SIDE, and it is why `checkPackage` is
        // validated with the same force as `checkPath`: the host turns this
        // directory into an npm package NAME by reading its `package.json`, and
        // that name is interpolated into a shell string. A whitelist before the
        // filesystem is consulted at all is what keeps that safe
        // (`isSafeUnitCheckPackage`), and refusing `apps/*` here is a rule
        // rather than a coincidence — a unit check inside an app is itself a
        // changed file under `apps/**`, so it would raise a `browser` demand
        // purely by existing and then be structurally unable to meet it.
        if (val.checkPath === undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["checkPath"],
            message:
              "UNIT_CHECK_WRITTEN requires checkPath — the file under this " +
              "issue's unit check directory (<checkPackage>/src/__checks__/" +
              "issue-<N>/) that this envelope is about.",
          });
        } else if (!isSafeUnitCheckRelativePath(val.checkPath)) {
          ctx.addIssue({
            code: "custom",
            path: ["checkPath"],
            message:
              `UNIT_CHECK_WRITTEN's checkPath must be a single safe relative ` +
              `path ending in .test.ts, no "..", no leading "/", no shell ` +
              `metacharacters (see isSafeUnitCheckRelativePath in ` +
              `unit-check-path.ts) — got ${JSON.stringify(val.checkPath)}. ` +
              `.spec.ts is the BROWSER runner's extension and is refused here: ` +
              `no package's vitest include collects one, so it would "pass" by ` +
              `being absent. .test.tsx is refused too — a component test draws ` +
              `something, and anything that draws belongs on CHECKS_WRITTEN.`,
          });
        }
        if (val.checkPackage === undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["checkPackage"],
            message:
              "UNIT_CHECK_WRITTEN requires checkPackage — the workspace " +
              "directory hosting the check (e.g. `packages/api`). Without it " +
              "there is no package to --filter and no vitest config to run " +
              "under, so no command can be built at all.",
          });
        } else if (!isSafeUnitCheckPackage(val.checkPackage)) {
          ctx.addIssue({
            code: "custom",
            path: ["checkPackage"],
            message:
              `UNIT_CHECK_WRITTEN's checkPackage must be exactly ` +
              `packages/<name> — two lowercase segments, no "..", no shell ` +
              `metacharacters (see isSafeUnitCheckPackage in ` +
              `unit-check-path.ts) — got ${JSON.stringify(val.checkPackage)}. ` +
              `apps/* is refused on purpose: any apps/** touch demands a ` +
              `BROWSER proof, and a unit proof never satisfies one, so a unit ` +
              `check inside an app would create a demand it cannot meet simply ` +
              `by existing. Use CHECKS_WRITTEN there.`,
          });
        }
        // NO `screen` REQUIREMENT, deliberately. There is no page to name — a
        // unit check is the outcome for a ticket that renders nothing, and
        // demanding a screen here would be asking for the photograph this
        // route exists precisely because nobody can take.
        break;
      case "ALREADY_BUILT":
        if (val.alreadyBuiltEvidence === undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["alreadyBuiltEvidence"],
            message:
              "ALREADY_BUILT requires alreadyBuiltEvidence — what you found, " +
              "and where, that proves this ticket (or a sibling ticket) already " +
              "shipped this work.",
          });
        }
        break;
      case "NEEDS_WORLD_DATA":
        if (val.worldDataNeeded === undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["worldDataNeeded"],
            message:
              "NEEDS_WORLD_DATA requires worldDataNeeded — describe the gap in " +
              "words (e.g. \"needs a deal in Conditional status with a " +
              "co-listing agent\"). Never propose figures or rows.",
          });
        }
        break;
      case "NO_SCREEN_APPLIES":
        if (val.noScreenReason === undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["noScreenReason"],
            message:
              "NO_SCREEN_APPLIES requires noScreenReason — why this ticket " +
              "owes no proof in EITHER runner, i.e. why it lands nowhere " +
              "inside apps/** or packages/** at all (a loop change under " +
              ".sandcastle/, a docs-only change, tooling/, scripts/, a root " +
              "config file, a .github/ workflow). This declaration is " +
              "re-checked against the FINISHED diff at ship time by " +
              "`proof-demand.ts`, not taken on faith. Two things that are NOT " +
              "examples of it: a migration (packages/db/ sits inside " +
              "packages/**, so it owes a UNIT proof — use UNIT_CHECK_WRITTEN), " +
              "and a test-only diff (the blanket test-file carve-out is GONE — " +
              "it is what let #820 ship proven by nothing). The one carve-out " +
              "left is repairing the browser instrument itself under " +
              "apps/*/e2e/, and it excludes apps/nextjs/e2e/checks/, which " +
              "holds other issues' locked proofs. Separately, and under EVERY " +
              "marker rather than this one: a diff that DELETES or empties a " +
              "test file under apps/** or packages/** stops the ticket, and no " +
              "outcome waives it.",
          });
        }
        break;
      case "TICKET_UNCLEAR":
        if (val.ticketQuestion === undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["ticketQuestion"],
            message:
              "TICKET_UNCLEAR requires ticketQuestion — the one product " +
              "question the ticket leaves open, worded so the owner can answer " +
              "it without reading any code.",
          });
        }
        break;
      default: {
        // EXHAUSTIVENESS GUARD (issue #956). `CHECK_WRITER_MARKERS` grew from
        // four to five in this ticket, and this switch is where each member's
        // required fields are decided. Without this arm a SIXTH marker would
        // compile silently and parse with NO cross-field requirement at all —
        // an envelope carrying nothing, accepted, and then branched on
        // downstream by `main.mts`. The `never` assignment turns adding one
        // into a compile error HERE, which forces the decision to be made in
        // the one place equipped to make it. The throw is unreachable while
        // the enum and this switch agree; it exists so that a marker smuggled
        // past the compiler (a hand-widened cast, a stale build) still fails
        // loudly rather than parsing into an unvalidated envelope.
        const unhandled: never = val.marker;
        throw new Error(
          `CheckWriterOutputSchema: no validation arm for marker ` +
            `${String(unhandled)} — add one before adding the marker.`,
        );
      }
    }
  },
);

export type CheckWriterOutputParsed = z.infer<typeof CheckWriterOutputSchema>;
