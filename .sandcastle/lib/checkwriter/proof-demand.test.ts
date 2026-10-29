import { describe, expect, it } from "vitest";

import { defaultProjectConfig, resetProjectConfig, setProjectConfig } from "../project-config.js";
import { EXAMPLE_PROJECT_CONFIG } from "../../__fixtures__/example-project-config.js";

const CHECKS_ROOT = EXAMPLE_PROJECT_CONFIG.checksRoot;
import {
  browserInstrumentGlobs,
  lockedCheckTouches,
  pathTokensIn,
  preauthorizedTestDeletions,
  proofDemandSatisfied,
  proofOfferedByMarker,
  removedTestFiles,
  requiredProofForDiff,
  SCREEN_OR_FLOW_GLOBS,
  unprovableTestFiles,
} from "./proof-demand.js";

// ---------------------------------------------------------------------------
// The tickets that died the night of 2026-08-04, when a 71-ticket run halted
// at ticket 3 having spent $185 to ship 3. These are not illustrative — they
// are the exact diffs, taken from the issues themselves and (where one exists)
// from the real commit. If any of them regresses, this module has failed.
// ---------------------------------------------------------------------------

/** #848 — email template registry. Pure backend; nothing renders it. */
const ISSUE_848_DIFF = [
  "packages/api/src/services/email/queue.ts",
  "packages/api/src/services/email/render-template.ts",
  "packages/db/src/schema.ts",
];

/** #845 — backup watchdog. A cron script nobody ever looks at. */
const ISSUE_845_DIFF = [
  "packages/api/scripts/storage-backup-watchdog-cron.ts",
  "packages/api/scripts/__tests__/storage-backup-watchdog-cron.test.ts",
];

/**
 * #820 — "four team-isolation tests pass even with the guard deleted." The
 * whole deliverable is test files, which is exactly why the cheap
 * `isTestFilePath` carve-out waves it through today with NO proof at all.
 */
const ISSUE_820_DIFF = [
  "packages/api/src/router/__tests__/find-pending-client-invitations.test.ts",
  "packages/api/src/services/widgets/__tests__/staging-rls.integration.test.ts",
];

/**
 * #836 — the real, landed, single-file diff (commit `1f79ca2e`). It shipped on
 * `no-screen-applies` with no red-first proof of any kind. Its entire point was
 * mutation coverage, so it is precisely a ticket that owes a unit proof.
 */
const ISSUE_836_DIFF = [
  "packages/api/src/router/__tests__/widget-tenant-isolation-call-sites.test.ts",
];

/**
 * #927/#928/#929 — repairing broken Playwright specs. You cannot be asked to
 * prove the prover: a red-first check for "this browser check asserts a stale
 * fact" is circular. These are the three tickets the cheap carve-out unblocked
 * and this module must not re-break.
 */
const ISSUE_927_DIFF = ["apps/nextjs/e2e/os-shell-top-bar.spec.ts"];
const ISSUE_928_DIFF = [
  "apps/nextjs/e2e/dev-plaid-sandbox.spec.ts",
  "apps/nextjs/e2e/lib/practice-world-auth.ts",
];

/** The real cash-flow fix, commit `a892c978` — one of the two motivating bugs. */
const CASH_FLOW_FIX_DIFF = [
  "packages/api/src/services/cashflow/cash-flow-team-service.ts",
  "packages/api/src/services/cashflow/__tests__/cash-flow-team-scope.test.ts",
];

/** The real chart fix, commit `ea448668` — the other motivating bug. */
const CHART_FIX_DIFF = [
  "apps/nextjs/src/app/(tracker)/tracker/_components/widgets/config-driven-chart.tsx",
  "apps/nextjs/src/app/(tracker)/tracker/_components/widgets/widget-editor.tsx",
];

describe("requiredProofForDiff — the tickets the folder-only router killed", () => {
  it("demands a unit proof for #848's pure-backend diff, and never a photograph", () => {
    const got = requiredProofForDiff(ISSUE_848_DIFF);
    expect(got.demand).toBe("unit");
    expect(got.screenOrFlowTouches).toEqual([]);
    expect(got.productTouches).toEqual(ISSUE_848_DIFF);
  });

  it("demands a unit proof for #845's cron-script diff", () => {
    expect(requiredProofForDiff(ISSUE_845_DIFF).demand).toBe("unit");
  });

  it("demands a unit proof for #820 — the test-only diff that ships unproven today", () => {
    // THE case this ticket exists for. A test that cannot fail is the exact
    // failure red-first catches, and the cheap carve-out exempts every path
    // here. There is no exemption any more: a test-only diff owes a unit proof.
    const got = requiredProofForDiff(ISSUE_820_DIFF);
    expect(got.demand).toBe("unit");
    expect(got.demand).not.toBe("none");
    expect(got.productTouches).toEqual(ISSUE_820_DIFF);
  });

  it("demands a unit proof for #836's real landed diff, which shipped with none", () => {
    expect(requiredProofForDiff(ISSUE_836_DIFF).demand).toBe("unit");
  });
});

describe("requiredProofForDiff — you cannot be asked to prove the prover", () => {
  it("demands nothing for #927, repairing a Playwright spec", () => {
    // A red-first check proving that a browser check asserts a stale fact is
    // circular — the thing under repair IS the instrument. This is the one
    // carve-out that survives, and it is drawn around the browser instrument
    // itself, not around "test files" in general.
    expect(requiredProofForDiff(ISSUE_927_DIFF).demand).toBe("none");
  });

  it("demands nothing for #928, which also touches the e2e sign-in helper", () => {
    expect(requiredProofForDiff(ISSUE_928_DIFF).demand).toBe("none");
  });

  it("still demands a photograph when a spec repair drags in real app code", () => {
    // The carve-out covers the instrument, not whatever rides along with it.
    const got = requiredProofForDiff([
      ...ISSUE_927_DIFF,
      "apps/nextjs/src/app/(tracker)/tracker/page.tsx",
    ]);
    expect(got.demand).toBe("browser");
  });

  it("never carves out another issue's locked red-first check", () => {
    // Files under apps/nextjs/e2e/checks/** are test-SHAPED, but each one is
    // some issue's locked proof — the mechanism, not material it grades.
    const got = requiredProofForDiff([
      "apps/nextjs/e2e/checks/issue-912/team-net-income.spec.ts",
    ]);
    expect(got.demand).not.toBe("none");
  });
});

describe("requiredProofForDiff — a screen is still photographed", () => {
  it("demands the browser for the real chart fix — one of the two motivating bugs", () => {
    const got = requiredProofForDiff(CHART_FIX_DIFF);
    expect(got.demand).toBe("browser");
    expect(got.screenOrFlowTouches).toEqual(CHART_FIX_DIFF);
  });

  it("demands the browser for a shared UI component", () => {
    expect(requiredProofForDiff(["packages/ui/src/date-period-picker.tsx"]).demand).toBe(
      "browser",
    );
  });

  it("demands the browser for any .tsx in a shared package, wherever it sits", () => {
    expect(
      requiredProofForDiff(["packages/os-shell/src/module-switcher.tsx"]).demand,
    ).toBe("browser");
  });

  it("demands the browser for a non-rendering helper inside an app", () => {
    // An app is the thing with screens; its helpers exist to serve them.
    expect(
      requiredProofForDiff(["apps/nextjs/src/lib/permissions.ts"]).demand,
    ).toBe("browser");
  });

  it("demands the browser when a diff touches BOTH a screen and backend code", () => {
    // The strongest demand any one file raises governs the whole diff. One
    // photograph covers it; a unit test does not.
    const got = requiredProofForDiff([...ISSUE_848_DIFF, ...CHART_FIX_DIFF]);
    expect(got.demand).toBe("browser");
    expect(got.screenOrFlowTouches).toEqual(CHART_FIX_DIFF);
    expect(got.productTouches).toEqual([...ISSUE_848_DIFF, ...CHART_FIX_DIFF]);
  });

  it("does not treat a unit test beside a screen file as a screen touch", () => {
    // Test files never render. This keeps a .test.tsx next to a component from
    // escalating a unit-provable diff into a photograph.
    const got = requiredProofForDiff([
      "apps/nextjs/src/app/(tracker)/tracker/_components/widgets/forecast-widget.test.tsx",
    ]);
    expect(got.screenOrFlowTouches).toEqual([]);
    expect(got.demand).toBe("unit");
  });
});

describe("requiredProofForDiff — the cash-flow bug, and the bar this deliberately moves", () => {
  it("routes the real cash-flow fix to a unit proof, at the seam the bug lives in", () => {
    // DELIBERATE, ARGUED CHANGE from the design-lock spec's "over-photograph
    // all of packages/**". That line was drawn when a unit proof was not on
    // offer, so its only alternatives were a photograph or nothing. The bug
    // itself was a wrong figure computed in a service, and the shipped fix's
    // own test asserted 5_000 where the buggy one asserted 155_000 — a
    // red-first unit test at that seam catches it precisely. The browser route
    // remains available and always satisfies; it is simply no longer the only
    // proof a packages/** change may offer.
    const got = requiredProofForDiff(CASH_FLOW_FIX_DIFF);
    expect(got.demand).toBe("unit");
    expect(got.demand).not.toBe("none");
  });
});

describe("requiredProofForDiff — executing-code folders owe a unit proof (#972 gap 2)", () => {
  it("demands a unit proof for the loop's own source", () => {
    // The sharpest hole in #972: the loop could rewrite its own proof gate
    // owing nothing. `.sandcastle/**` code now owes a unit test.
    expect(
      requiredProofForDiff([
        ".sandcastle/lib/checkwriter/schema.ts",
        ".sandcastle/main.mts",
      ]).demand,
    ).toBe("unit");
  });

  it("demands a unit proof for shared tooling and standalone scripts", () => {
    expect(requiredProofForDiff(["tooling/vitest/base.ts"]).demand).toBe(
      "unit",
    );
    expect(requiredProofForDiff(["scripts/reverify-ledger/index.ts"]).demand).toBe(
      "unit",
    );
  });

  it("never demands a photograph from a code folder — they draw no screen", () => {
    const got = requiredProofForDiff([".sandcastle/main.mts"]);
    expect(got.demand).toBe("unit");
    expect(got.screenOrFlowTouches).toEqual([]);
  });

  it("demands nothing for a .d.ts declaration file — no runnable code to grade", () => {
    expect(
      requiredProofForDiff([".sandcastle/lib/checkwriter/schema.d.ts"]).demand,
    ).toBe("none");
  });

  it("demands nothing for docs, telemetry, settings and shell scripts inside those folders", () => {
    // The owner rejected a blanket flip because it refused doc/data commits.
    // Non-code inside a code folder stays owing nothing.
    expect(
      requiredProofForDiff([
        ".sandcastle/check-writer-prompt.md",
        ".sandcastle/telemetry/issues.jsonl",
        ".sandcastle/Dockerfile",
        "scripts/session-context.sh",
        "tooling/tailwind/index.yml",
      ]).demand,
    ).toBe("none");
  });
});

describe("requiredProofForDiff — when nothing is owed", () => {
  it("demands nothing for docs, CI and root config", () => {
    expect(
      requiredProofForDiff([
        "docs/reference/database.md",
        "scripts/session-context.sh",
        ".github/workflows/ci.yml",
        "package.json",
      ]).demand,
    ).toBe("none");
  });

  it("demands nothing for an empty diff", () => {
    expect(requiredProofForDiff([]).demand).toBe("none");
  });

  it("demands a unit proof for a migration, contradicting nothing", () => {
    // The prompt's own first example of "no screen applies" was a migration,
    // while the old guard refused it (packages/db/migrations/** is packages/**).
    // That disagreement is now resolved in the guard's favour and stated in
    // the prompt: a migration owes a unit proof, because a migration can change
    // what every screen shows.
    expect(
      requiredProofForDiff(["packages/db/migrations/0097_teams_is_solo.sql"])
        .demand,
    ).toBe("unit");
  });
});

describe("requiredProofForDiff — totality", () => {
  it("never throws on a non-array, a blank entry or a non-string", () => {
    expect(
      requiredProofForDiff([
        "",
        // @ts-expect-error deliberately malformed, mirroring
        // detectProtectedPathViolations's own never-throw contract
        null,
        "packages/api/src/services/email/queue.ts",
      ]).demand,
    ).toBe("unit");
    // @ts-expect-error deliberately malformed
    expect(requiredProofForDiff("not an array").demand).toBe("none");
  });

  it("ignores a path containing .. rather than letting it match a glob", () => {
    expect(
      requiredProofForDiff(["packages/api/src/__tests__/../../../etc/passwd"])
        .demand,
    ).toBe("none");
  });
});

describe("proofOfferedByMarker — what each outcome actually proves", () => {
  it("maps each shipping marker to the strength it offers", () => {
    expect(proofOfferedByMarker("CHECKS_WRITTEN")).toBe("browser");
    expect(proofOfferedByMarker("UNIT_CHECK_WRITTEN")).toBe("unit");
    expect(proofOfferedByMarker("NO_SCREEN_APPLIES")).toBe("none");
  });

  it("offers nothing for the two markers that stop the ticket before it ships", () => {
    expect(proofOfferedByMarker("ALREADY_BUILT")).toBeUndefined();
    expect(proofOfferedByMarker("NEEDS_WORLD_DATA")).toBeUndefined();
  });
});

describe("proofDemandSatisfied — the lattice", () => {
  it("accepts a proof at least as strong as the demand", () => {
    expect(proofDemandSatisfied("browser", "browser")).toBe(true);
    expect(proofDemandSatisfied("browser", "unit")).toBe(true);
    expect(proofDemandSatisfied("browser", "none")).toBe(true);
    expect(proofDemandSatisfied("unit", "unit")).toBe(true);
    expect(proofDemandSatisfied("unit", "none")).toBe(true);
    expect(proofDemandSatisfied("none", "none")).toBe(true);
  });

  it("refuses a unit test where a photograph is demanded — the dodge this closes", () => {
    expect(proofDemandSatisfied("unit", "browser")).toBe(false);
  });

  it("refuses a bare 'no screen applies' wherever any proof is owed", () => {
    expect(proofDemandSatisfied("none", "browser")).toBe(false);
    expect(proofDemandSatisfied("none", "unit")).toBe(false);
  });
});

describe("removedTestFiles — the hard stop that holds under EVERY route", () => {
  it("names a deleted browser spec", () => {
    expect(
      removedTestFiles(
        ["apps/nextjs/e2e/team-dashboard.spec.ts", "packages/api/src/x.ts"],
        ["apps/nextjs/e2e/team-dashboard.spec.ts"],
      ),
    ).toEqual(["apps/nextjs/e2e/team-dashboard.spec.ts"]);
  });

  it("names a gutted unit test", () => {
    expect(
      removedTestFiles(
        ["packages/api/src/__tests__/isolation.test.ts"],
        ["packages/api/src/__tests__/isolation.test.ts"],
      ),
    ).toEqual(["packages/api/src/__tests__/isolation.test.ts"]);
  });

  it("catches the worst case: deleting the whole 117-file Playwright suite", () => {
    // The guard's own named worst case. vitest's include is src/**, so a
    // deleted Playwright spec goes green by being absent — nothing downstream
    // would notice.
    const suite = Array.from(
      { length: 117 },
      (_, i) => `apps/nextjs/e2e/regression-${i}.spec.ts`,
    );
    expect(removedTestFiles(suite, suite)).toEqual(suite);
  });

  it("is silent when tests are added or repaired rather than removed", () => {
    expect(
      removedTestFiles(["packages/api/src/__tests__/isolation.test.ts"], []),
    ).toEqual([]);
  });

  it("ignores a removed file that is not test material", () => {
    expect(
      removedTestFiles(
        ["packages/api/src/dead-code.ts"],
        ["packages/api/src/dead-code.ts"],
      ),
    ).toEqual([]);
  });

  it("reports null — not an empty list — when git could not be asked", () => {
    // An empty list is a CLAIM that nothing was removed. Only a real git answer
    // earns that claim; a failure must stay distinguishable from it.
    expect(
      removedTestFiles(["packages/api/src/__tests__/isolation.test.ts"], null),
    ).toBeNull();
  });

  it("stands down when the ISSUE BODY pre-authorised that exact deletion", () => {
    // #850, 2026-08-06. The ticket's own acceptance criteria named the file,
    // named its line count, and named what replaces its coverage — and the
    // gate stopped it anyway, which is the gate asking a question the owner
    // had already answered. Verbatim from the issue body.
    const doomed =
      "packages/api/src/services/storage-backup/__tests__/tar-format.test.ts";
    const body =
      "- [ ] **Declare the intended test deletion in the PR body — do not " +
      "let it arrive unannounced.** Removing `tar-format.ts` also removes " +
      `its test file, \`${doomed}\` (226 lines), because it tests a module ` +
      "that will no longer exist.";
    expect(
      removedTestFiles(
        [doomed, "packages/api/src/services/storage-backup/archive-codec.ts"],
        [doomed],
        body,
      ),
    ).toEqual([]);
  });

  it("still stops the file the SAME body says must NOT be deleted", () => {
    // The other half of #850's paragraph, and the reason a bare
    // path-appears-in-the-body rule would be worse than no rule: the ticket
    // names `archive-codec.test.ts` in the same breath, to forbid touching it.
    const kept =
      "packages/api/src/services/storage-backup/__tests__/archive-codec.test.ts";
    const body =
      "Removing `tar-format.ts` also removes its test file, " +
      "`packages/api/src/services/storage-backup/__tests__/tar-format.test.ts`" +
      ", because it tests a module that will no longer exist. What replaces " +
      `its coverage is the byte-identical round-trip tests in \`${kept}\`, ` +
      `which stay and must still pass. **\`${kept}\` itself is NOT to be ` +
      "deleted or emptied.**";
    expect(removedTestFiles([kept], [kept], body)).toEqual([kept]);
  });

  it("accepts the canonical directive a ticket author should write", () => {
    const doomed = "packages/api/src/__tests__/tar-format.test.ts";
    expect(
      removedTestFiles([doomed], [doomed], `Deletes-test: ${doomed}\n`),
    ).toEqual([]);
    expect(
      removedTestFiles([doomed], [doomed], `Deletes test: ${doomed}`),
    ).toEqual([]);
  });

  it("refuses a MENTION with no deletion in it — tickets name tests they want KEPT", () => {
    // The abuse this is built against. Tickets routinely name a test file
    // because it is the thing to repair; that must never read as permission
    // to delete it instead.
    const named = "packages/api/src/__tests__/isolation.test.ts";
    const body =
      `\`${named}\` asserts a stale fact about the Finance tab. Repair it ` +
      "so it asserts what the launch-hidden nav actually renders.";
    expect(removedTestFiles([named], [named], body)).toEqual([named]);
  });

  it("refuses a partial path — the marker must name the file exactly", () => {
    const doomed = "packages/api/src/services/storage-backup/__tests__/tar.test.ts";
    expect(
      removedTestFiles([doomed], [doomed], "Delete `__tests__/tar.test.ts`."),
    ).toEqual([doomed]);
    expect(
      removedTestFiles([doomed], [doomed], "Delete `tar.test.ts`."),
    ).toEqual([doomed]);
  });

  it("refuses a body that authorises a DIFFERENT file", () => {
    const doomed = "packages/api/src/__tests__/a.test.ts";
    expect(
      removedTestFiles(
        [doomed],
        [doomed],
        "Delete `packages/api/src/__tests__/b.test.ts`, it tests dead code.",
      ),
    ).toEqual([doomed]);
  });

  it("an absent or unreadable issue body authorises nothing", () => {
    // Fails closed: if the loop could not read the ticket, the ticket said
    // nothing, and the stop stands.
    const doomed = "packages/api/src/__tests__/a.test.ts";
    expect(removedTestFiles([doomed], [doomed])).toEqual([doomed]);
    expect(removedTestFiles([doomed], [doomed], null)).toEqual([doomed]);
    expect(removedTestFiles([doomed], [doomed], "")).toEqual([doomed]);
    // @ts-expect-error deliberately malformed
    expect(removedTestFiles([doomed], [doomed], { body: doomed })).toEqual([
      doomed,
    ]);
  });

  it("an unknowable removal set is STILL null, whatever the body authorised", () => {
    // Pre-authorisation narrows what a KNOWN removal set may stop on. It can
    // never turn "git could not be asked" into an all-clear.
    const doomed = "packages/api/src/__tests__/a.test.ts";
    expect(
      removedTestFiles([doomed], null, `Deletes-test: ${doomed}`),
    ).toBeNull();
  });

  it("reports null on a malformed changed-file list too, never an all-clear", () => {
    // Same reasoning as the git-failure case one test up, and the 2026-08-06
    // review caught this contradicting it: a caller that cannot be understood
    // has not earned the claim "nothing was removed" any more than a caller
    // git could not answer for.
    // @ts-expect-error deliberately malformed
    expect(removedTestFiles("nope", [])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PORTED FROM `no-screen-guard.test.ts`, which this module replaced and which
// was deleted with it (issue #956). Everything below encodes an edge the old
// guard's suite had already paid for and this suite did not yet cover. Where
// the ANSWER changed, it changed on purpose and the reason is on the test —
// the old guard had two states (photograph or nothing), this router has three,
// so several files that used to be "stops the ticket" are now "owes a unit
// proof", which is a different sentence, not a weaker one.
// ---------------------------------------------------------------------------

describe("requiredProofForDiff — edges inherited from the guard this replaced", () => {
  it("names ONLY the offending source file out of a diff full of tests", () => {
    // The old carve-out's honesty test: one real source file among many tests
    // still stopped the ticket, and was named alone. The naming still matters
    // — a stop message that gestures at the whole diff is one nobody can act
    // on — but the answer moved: tests are no longer exempt, so they join
    // `productTouches`, while `screenOrFlowTouches` still names only the file
    // that actually forced the photograph.
    const files = [
      "packages/api/src/router/deal.test.ts",
      "apps/nextjs/src/components/widget.test.tsx",
      "apps/nextjs/src/app/page.tsx", // the one that matters
      "packages/api/src/__tests__/isolation.ts",
    ];
    const got = requiredProofForDiff(files);
    expect(got.demand).toBe("browser");
    expect(got.screenOrFlowTouches).toEqual(["apps/nextjs/src/app/page.tsx"]);
    expect(got.productTouches).toEqual(files);
  });

  it("a mixed diff drops the un-owed files entirely, rather than listing them", () => {
    // docs, loop telemetry and CI owe nothing, and must not appear in either
    // evidence list — the stop message is read by a person deciding what to
    // look at. (Loop SOURCE now owes a unit proof, #972 gap 2, so the un-owed
    // loop file here is telemetry, not `.mts`.)
    const got = requiredProofForDiff([
      "docs/reference/database.md",
      "packages/db/src/schema.ts",
      ".sandcastle/telemetry/issues.jsonl",
      "apps/nextjs/src/app/page.tsx",
    ]);
    expect(got.productTouches).toEqual([
      "packages/db/src/schema.ts",
      "apps/nextjs/src/app/page.tsx",
    ]);
    expect(got.screenOrFlowTouches).toEqual(["apps/nextjs/src/app/page.tsx"]);
  });

  it("test SCAFFOLDING is not test material — a setup file or a factory owes a proof", () => {
    // A vitest setup file or a fixture factory can make a test pass without
    // the product changing, so it was never exempt and still is not. It
    // renders nothing, so what it owes is a unit proof rather than a
    // photograph.
    expect(requiredProofForDiff(["packages/api/vitest.setup.ts"]).demand).toBe(
      "unit",
    );
    expect(
      requiredProofForDiff(["packages/api/src/testing/factories.ts"]).demand,
    ).toBe("unit");
  });

  it("the practice-world fixture is not test material — it is the answer key", () => {
    // Belt and braces beside the loop's own refusal of this path: whoever can
    // edit the answer key can make a wrong answer look right.
    expect(
      requiredProofForDiff(["packages/db/scripts/practice-world/deals.ts"])
        .demand,
    ).toBe("unit");
  });

  it("a test file inside a CODE folder owes a unit proof, like its source (#972 gap 2)", () => {
    // Before gap 2, anything outside apps/packages owed nothing. Now the loop's
    // own source and shared tooling owe a unit proof, and their test files —
    // JS/TS code — join `productTouches` exactly as product test files do.
    expect(
      requiredProofForDiff([
        ".sandcastle/main.checkwriter.test.mts",
        ".sandcastle/lib/paths/test-file.ts",
        "tooling/eslint/rule.test.js",
      ]).demand,
    ).toBe("unit");
  });

  it("a code file in a genuinely-unrecognised top-level folder still owes nothing", () => {
    // The accepted cost of naming code folders rather than flipping the
    // default: a new top-level code folder is free until someone adds it.
    expect(
      requiredProofForDiff(["experiments/spike/index.ts"]).demand,
    ).toBe("none");
  });

  it("the receipt sitting beside another issue's locked check is guarded too", () => {
    // `must-fail-first-proof.json` was never test-shaped, so no carve-out ever
    // reached it — and it is the file that makes the byte-lock meaningful.
    const got = requiredProofForDiff([
      `${CHECKS_ROOT}/issue-819/must-fail-first-proof.json`,
    ]);
    expect(got.demand).toBe("browser");
    expect(got.productTouches).toHaveLength(1);
  });

  it("an ordinary e2e spec OUTSIDE the checks root is still carved out", () => {
    // The exclusion is the checks ROOT, not "anything under e2e/". If this
    // ever starts demanding a proof, #927/#928/#929 are blocked again.
    expect(
      requiredProofForDiff(["apps/nextjs/e2e/os-shell-top-bar.spec.ts"]).demand,
    ).toBe("none");
  });

  it("the checks root is not hardcoded twice — it comes from check-path.ts", () => {
    // Guards against the two spellings drifting apart, which is how the
    // exclusion above would silently stop covering the real directory.
    expect(
      requiredProofForDiff([`${CHECKS_ROOT}/issue-1/anything.spec.ts`]).demand,
    ).not.toBe("none");
  });
});

describe("removedTestFiles — edges inherited from the guard this replaced", () => {
  const rootSpec = "apps/nextjs/e2e/os-shell-top-bar.spec.ts";

  it("names only the REMOVED test, never the repaired one beside it", () => {
    const repaired = "apps/nextjs/e2e/finance-reports.spec.ts";
    expect(removedTestFiles([repaired, rootSpec], [rootSpec])).toEqual([
      rootSpec,
    ]);
  });

  it("treats a MALFORMED removal set as unknowable, not as empty", () => {
    // The direction of failure is the whole point: answering "nothing was
    // removed" on a git hiccup silently re-opens the hole.
    // @ts-expect-error deliberately hostile input
    expect(removedTestFiles([rootSpec], "not-an-array")).toBeNull();
  });

  it("removals outside the two workspaces are not this gate's business", () => {
    expect(
      removedTestFiles(
        [".sandcastle/lib/old.test.ts"],
        [".sandcastle/lib/old.test.ts"],
      ),
    ).toEqual([]);
  });

  it("a removed NON-test file is not caught here — but the demand still catches it", () => {
    // Two gates, two jobs. Deleting a source file is not a coverage removal,
    // so this gate is silent; it is still a `packages/**` touch, so the diff
    // still owes a proof and cannot ship on `NO_SCREEN_APPLIES`.
    const src = "packages/api/src/router/deal.ts";
    expect(removedTestFiles([src], [src])).toEqual([]);
    expect(requiredProofForDiff([src]).demand).toBe("unit");
  });
});

describe("the glob sets", () => {
  it("scopes every screen glob to a workspace", () => {
    expect(SCREEN_OR_FLOW_GLOBS.length).toBeGreaterThan(0);
    for (const g of SCREEN_OR_FLOW_GLOBS) {
      expect(g.startsWith("apps/") || g.startsWith("packages/")).toBe(true);
    }
  });

  it("scopes the browser-instrument carve-out to an app's e2e tree", () => {
    expect(browserInstrumentGlobs().length).toBeGreaterThan(0);
    for (const g of browserInstrumentGlobs()) {
      expect(g.startsWith("apps/")).toBe(true);
      expect(g.includes("e2e")).toBe(true);
    }
  });

  it("derives the carve-out from checksRoot: the default root has an e2e/ parent, a bare root has none", () => {
    resetProjectConfig();
    expect(browserInstrumentGlobs()).toEqual(["e2e/**"]);
    setProjectConfig({ ...defaultProjectConfig(), checksRoot: "checks" });
    expect(browserInstrumentGlobs()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The two never-waived buckets, carried across from `no-screen-guard.ts`
// (issue #969) when the router replaced it. Both answer the question "is there
// something here that the screen check's WATCH-ONLY mode must not be allowed to
// wave through", and neither is a screen-check judgement at all.
// ---------------------------------------------------------------------------

describe("unprovableTestFiles — what an UNKNOWABLE removal set puts at risk", () => {
  it("names every test file under the two product workspaces", () => {
    expect(
      unprovableTestFiles([
        "packages/api/src/router/__tests__/deals.test.ts",
        "apps/nextjs/e2e/finance-reports.spec.ts",
        "packages/api/src/router/deals.ts",
        "docs/reference/database.md",
        ".sandcastle/lib/foo.test.ts",
      ]),
    ).toEqual([
      "packages/api/src/router/__tests__/deals.test.ts",
      "apps/nextjs/e2e/finance-reports.spec.ts",
    ]);
  });

  it("is empty for a diff carrying no test file at all — the rule must not fire on every git hiccup", () => {
    // The cost of the fail-closed direction is bounded by this: a diff with no
    // test material in it has no coverage an unknowable removal set could be
    // hiding, so an unaskable git costs it nothing.
    expect(unprovableTestFiles(["packages/api/src/router/deals.ts"])).toEqual([]);
  });

  it("answers [] rather than throwing on junk input", () => {
    expect(unprovableTestFiles(null as never)).toEqual([]);
    expect(unprovableTestFiles(["", "../escape/x.test.ts"] as never)).toEqual([]);
  });
});

describe("lockedCheckTouches — ANOTHER ticket's red-first proof", () => {
  // The directory THIS run's check-writer created — the only thing excluded now
  // (#972 gap 5), never `issue-<N>` derived from the number.
  const OWN_BROWSER_DIR = `${CHECKS_ROOT}/issue-956`;

  it("names a browser check belonging to a different issue", () => {
    expect(
      lockedCheckTouches(
        [`${CHECKS_ROOT}/issue-819/cross-team-rate-cell-delete.spec.ts`],
        [OWN_BROWSER_DIR],
      ),
    ).toEqual([`${CHECKS_ROOT}/issue-819/cross-team-rate-cell-delete.spec.ts`]);
  });

  it("names a UNIT check belonging to a different issue, wherever its package sits", () => {
    // This is the reader `UNIT_CHECKS_ROOT_GLOB` was exported for: the unit
    // side has no single literal root, so "every issue's unit check, anywhere"
    // has to be a shaped pattern.
    expect(
      lockedCheckTouches(
        ["packages/api/src/__checks__/issue-848/x.test.ts"],
        [OWN_BROWSER_DIR],
      ),
    ).toEqual(["packages/api/src/__checks__/issue-848/x.test.ts"]);
  });

  it("does NOT name the exact directory THIS run's check-writer created — writing one is the job", () => {
    // The rule that stops this being a blanket ban. A CHECKS_WRITTEN ticket
    // necessarily adds files under the directory it created this run; excluding
    // that exact directory is what keeps every check-writing ticket movable.
    expect(
      lockedCheckTouches(
        [`${CHECKS_ROOT}/issue-956/team-cash-flow.spec.ts`],
        [OWN_BROWSER_DIR],
      ),
    ).toEqual([]);
  });

  it("NAMES an old issue-N check when THIS run created no directory — the gap 5 fix", () => {
    // A re-dispatch of #956 whose check-writer returns NO_SCREEN_APPLIES creates
    // no directory, and the `issue-956` folder already stood at the base, so the
    // ticket owns no check folder (passed here as `null`). Editing the
    // `issue-956` check an EARLIER
    // run left on `main` is now caught — the old key derived from the number
    // would have skipped it and let a never-waived stop degrade to a waivable
    // one.
    expect(
      lockedCheckTouches(
        ["packages/api/src/__checks__/issue-956/cash-flow.test.ts"],
        null,
      ),
    ).toEqual(["packages/api/src/__checks__/issue-956/cash-flow.test.ts"]);
  });

  it("excludes ONLY the created layout — a different-layout issue-N check is still named", () => {
    // The tightening in one case: this run created the BROWSER directory, so an
    // edit to a UNIT `issue-956` check left by an earlier run is not the current
    // job and is caught.
    expect(
      lockedCheckTouches(
        [
          `${CHECKS_ROOT}/issue-956/team-cash-flow.spec.ts`,
          "packages/api/src/__checks__/issue-956/cash-flow.test.ts",
        ],
        [OWN_BROWSER_DIR],
      ),
    ).toEqual(["packages/api/src/__checks__/issue-956/cash-flow.test.ts"]);
  });

  it("excludes EVERY own folder when a ticket owns two — #1310 had a browser and a unit check folder (#1361)", () => {
    const ownBrowser = `${CHECKS_ROOT}/issue-1310`;
    const ownUnit = "packages/api/src/__checks__/issue-1310";
    const sibling = "packages/api/src/__checks__/issue-1058/relist.test.ts";
    expect(
      lockedCheckTouches(
        [
          `${ownBrowser}/team-access.spec.ts`,
          `${ownUnit}/must-fail-first-proof.json`,
          `${ownUnit}/access-change.test.ts`,
          sibling,
        ],
        [ownBrowser, ownUnit],
      ),
    ).toEqual([sibling]);
  });

  it("an empty own-folder list excludes nothing, exactly as null does", () => {
    expect(
      lockedCheckTouches(
        ["packages/api/src/__checks__/issue-956/cash-flow.test.ts"],
        [],
      ),
    ).toEqual(["packages/api/src/__checks__/issue-956/cash-flow.test.ts"]);
  });

  it("ignores ordinary test material and ordinary source", () => {
    expect(
      lockedCheckTouches(
        [
          "packages/api/src/__tests__/deals.test.ts",
          "apps/nextjs/e2e/finance-reports.spec.ts",
          "packages/api/src/router/deals.ts",
        ],
        [OWN_BROWSER_DIR],
      ),
    ).toEqual([]);
  });

  it("answers [] rather than throwing on junk input", () => {
    expect(lockedCheckTouches(null as never, [OWN_BROWSER_DIR])).toEqual([]);
    expect(lockedCheckTouches(["", 7] as never, [OWN_BROWSER_DIR])).toEqual([]);
  });
});

describe("lockedCheckTouches — the judge-authorised sibling allowlist (#1271)", () => {
  // The ticket being built wrote its own BROWSER check this run.
  const OWN_BROWSER_DIR = `${CHECKS_ROOT}/issue-1235`;
  /** #1058's check — the real file three of whose cases went red on 2026-09-10. */
  const SIBLING =
    "packages/api/src/__checks__/issue-1058/cross-team-relist-guard.test.ts";

  it("lets through exactly the sibling path the run's own judge ruling named", () => {
    expect(lockedCheckTouches([SIBLING], [OWN_BROWSER_DIR], [SIBLING])).toEqual(
      [],
    );
  });

  it("still names a SECOND file in the same sibling directory — the allowlist is per file, not per directory", () => {
    // The whole point of an exact-path allowlist: authorising one case file
    // must not quietly authorise everything beside it.
    const neighbour =
      "packages/api/src/__checks__/issue-1058/relist-fixtures.test.ts";
    expect(
      lockedCheckTouches([SIBLING, neighbour], [OWN_BROWSER_DIR], [SIBLING]),
    ).toEqual([neighbour]);
  });

  it("authorises nothing when the allowlist entry is not itself a locked check path", () => {
    // A caller handing in `packages/api/src/router/deals.ts` must not thereby
    // open any check directory — and must not open THAT file either, which is
    // not under a locked glob and so was never a hit to begin with.
    const source = "packages/api/src/router/deals.ts";
    expect(
      lockedCheckTouches([SIBLING, source], [OWN_BROWSER_DIR], [source]),
    ).toEqual([SIBLING]);
  });

  it("ignores a `..`-bearing allowlist entry entirely", () => {
    const escape = `packages/api/src/__checks__/issue-1058/../issue-1058/cross-team-relist-guard.test.ts`;
    expect(lockedCheckTouches([SIBLING], [OWN_BROWSER_DIR], [escape])).toEqual([
      SIBLING,
    ]);
  });

  it("matches the exact path only — never a prefix, a directory, or a basename", () => {
    const dir = "packages/api/src/__checks__/issue-1058";
    const basename = "cross-team-relist-guard.test.ts";
    expect(lockedCheckTouches([SIBLING], [OWN_BROWSER_DIR], [dir])).toEqual([
      SIBLING,
    ]);
    expect(lockedCheckTouches([SIBLING], [OWN_BROWSER_DIR], [basename])).toEqual([
      SIBLING,
    ]);
  });

  it("answers exactly as the two-argument form does on junk allowlist input", () => {
    expect(lockedCheckTouches([SIBLING], [OWN_BROWSER_DIR], [])).toEqual([
      SIBLING,
    ]);
    expect(
      lockedCheckTouches([SIBLING], [OWN_BROWSER_DIR], ["", 7] as never),
    ).toEqual([SIBLING]);
    expect(
      lockedCheckTouches([SIBLING], [OWN_BROWSER_DIR], null as never),
    ).toEqual([SIBLING]);
  });

  it("does not resurrect this run's own check directory as a hit", () => {
    // The own-prefix skip runs FIRST and is untouched by the allowlist.
    expect(
      lockedCheckTouches(
        [`${OWN_BROWSER_DIR}/live-deal-named-while-filing.spec.ts`],
        [OWN_BROWSER_DIR],
        [SIBLING],
      ),
    ).toEqual([]);
  });
});

describe("pathTokensIn — the tokeniser `testPathsIn` is now built on (#1271)", () => {
  it("returns the raw `/`-joined tokens, markdown escapes already undone", () => {
    // The same route-group + backslash-escape fixture the deletion parser is
    // pinned on, read one layer lower: the token is whole and unescaped, and
    // the trailing punctuation is still on it (its strip belongs to the
    // caller, which is what keeps `testPathsIn` byte-identical).
    const escaped =
      "apps/nextjs/src/app/(tracker)/tracker/\\_components/forms/deal-form.test.tsx";
    expect(pathTokensIn(`Deletes-test: ${escaped}.`)).toEqual([
      "apps/nextjs/src/app/(tracker)/tracker/_components/forms/deal-form.test.tsx.",
    ]);
  });

  it("finds every token on a line, and none where there is no `/`", () => {
    expect(
      pathTokensIn("packages/api/src/x.test.ts and packages/db/src/y.test.ts"),
    ).toEqual(["packages/api/src/x.test.ts", "packages/db/src/y.test.ts"]);
    expect(pathTokensIn("Tests  1 failed | 459 passed")).toEqual([]);
  });

  it("leaves `testPathsIn`'s own answers exactly as they were", () => {
    // The regression guard for the lift itself: the deletion parser reads the
    // route-group fixture the same way it did before `pathTokensIn` existed.
    const R =
      "apps/nextjs/src/app/(tracker)/tracker/_components/forms/deal-form.test.tsx";
    expect(preauthorizedTestDeletions(`Deletes-test: ${R}`)).toEqual([R]);
  });
});

describe("preauthorizedTestDeletions — the parser, at its own seam", () => {
  const P = "packages/api/src/services/x/__tests__/legacy.test.ts";

  it("reads the canonical directive, in either spelling and any case", () => {
    expect(preauthorizedTestDeletions(`Deletes-test: ${P}`)).toEqual([P]);
    expect(preauthorizedTestDeletions(`deletes test: ${P}`)).toEqual([P]);
    expect(preauthorizedTestDeletions(`DELETES-TEST:   ${P}   `)).toEqual([P]);
    expect(preauthorizedTestDeletions(`Deletes-test: \`${P}\``)).toEqual([P]);
  });

  it("reads several directives, one per line, de-duplicated and ordered", () => {
    const q = "apps/nextjs/e2e/legacy.spec.ts";
    expect(
      preauthorizedTestDeletions(
        `Deletes-test: ${P}\nsomething else\nDeletes-test: ${q}\nDeletes-test: ${P}`,
      ),
    ).toEqual([P, q]);
  });

  it("reads a PROSE sentence that both names the path and says it goes", () => {
    expect(
      preauthorizedTestDeletions(
        `Removing the module also removes its test file, \`${P}\` (226 lines).`,
      ),
    ).toEqual([P]);
    expect(
      preauthorizedTestDeletions(`\`${P}\` is deleted along with the module.`),
    ).toEqual([P]);
  });

  // #1038, 2026-09-04. The ticket named its doomed file IN FULL, in the body,
  // before the run — and the gate stopped it anyway after a $26 night. Two
  // separate breaks in one path, both in this repo's ordinary spelling.
  describe("a Next.js route-group path, as this repo actually writes one", () => {
    const R =
      "apps/nextjs/src/app/(tracker)/tracker/_components/forms/deal-form.test.tsx";

    it("reads a `(group)` segment whole, instead of truncating at it", () => {
      expect(preauthorizedTestDeletions(`Deletes-test: ${R}`)).toEqual([R]);
    });

    it("reads it through a markdown backslash-escape of the underscore", () => {
      // GitHub renders `\_` as `_`, so this LOOKS correct to whoever wrote it.
      const escaped = R.replace("/_components", "/\\_components");
      expect(escaped).toContain("\\_components");
      expect(preauthorizedTestDeletions(`Deletes-test: ${escaped}`)).toEqual([
        R,
      ]);
    });

    it("clears the removal stop for that exact file, and nothing else", () => {
      const other = "apps/nextjs/src/app/(tracker)/other.test.tsx";
      expect(removedTestFiles([R], [R], `Deletes-test: ${R}`)).toEqual([]);
      expect(
        removedTestFiles([R, other], [R, other], `Deletes-test: ${R}`),
      ).toEqual([other]);
    });

    it("still refuses parentheses that are PROSE around a path", () => {
      // The exclusion this relaxed was right about these. A paren that does
      // not close at the end of its own segment authorises nothing new.
      expect(
        preauthorizedTestDeletions(
          `The old suite (see ${R}) is deleted with the panel.`,
        ),
      ).toEqual([R]);
      expect(
        preauthorizedTestDeletions(`Delete the module (lib/state/gh.ts).`),
      ).toEqual([]);
    });
  });

  it("refuses a sentence that names the path without removing it", () => {
    expect(
      preauthorizedTestDeletions(`Repair \`${P}\` so it asserts the new shape.`),
    ).toEqual([]);
    expect(
      preauthorizedTestDeletions(`Add three cases to \`${P}\`.`),
    ).toEqual([]);
  });

  it("refuses a NEGATED sentence, even one full of deletion words", () => {
    // The exact shape #850 carries about the file it wants KEPT. A negation
    // disqualifies the whole sentence rather than being parsed around — the
    // cost of being wrong here is one ticket stopping for a person, and the
    // cost of being wrong the other way is deleted coverage shipping.
    expect(
      preauthorizedTestDeletions(`**\`${P}\` itself is NOT to be deleted.**`),
    ).toEqual([]);
    expect(
      preauthorizedTestDeletions(`Do not delete \`${P}\` — it must still pass.`),
    ).toEqual([]);
    expect(
      preauthorizedTestDeletions(`Never remove \`${P}\`.`),
    ).toEqual([]);
  });

  it("keeps the two sentences of one paragraph apart", () => {
    // #850's real paragraph in miniature: the doomed file and the protected
    // file share a markdown line. Sentence, not line, is the unit.
    const kept = "packages/api/src/services/x/__tests__/keep.test.ts";
    expect(
      preauthorizedTestDeletions(
        `Removing the module also removes \`${P}\`. Its coverage moves to ` +
          `\`${kept}\`, which stays. **\`${kept}\` is NOT to be deleted.**`,
      ),
    ).toEqual([P]);
  });

  it("takes only test-shaped paths, so a source file cannot be authorised here", () => {
    // This function feeds a TEST-coverage stop. A body naming a source file as
    // deleted is ordinary and must not widen anything.
    expect(
      preauthorizedTestDeletions("Delete `packages/api/src/tar-format.ts`."),
    ).toEqual([]);
  });

  it("is total on junk", () => {
    expect(preauthorizedTestDeletions("")).toEqual([]);
    expect(preauthorizedTestDeletions(null)).toEqual([]);
    expect(preauthorizedTestDeletions(undefined)).toEqual([]);
    expect(preauthorizedTestDeletions(42 as never)).toEqual([]);
  });

  it("refuses a `..`-bearing path outright", () => {
    expect(
      preauthorizedTestDeletions(
        "Deletes-test: packages/api/src/__tests__/../../../apps/x.test.ts",
      ),
    ).toEqual([]);
  });
});

describe("preauthorizedTestDeletions — the loop writes into the issue body too", () => {
  // THE HOLE THIS CLOSES, found while building the feature. "Owner-authored"
  // is a claim about the issue body, and the issue body is not entirely
  // owner-authored: `applyStopReport` / `applyScreenCheckWatchReport`
  // (`lib/state/stop-reasons.ts`) append a MACHINE-written section to it. The
  // stop report for this very gate names the deleted path and the word
  // "DELETES" in one sentence — so a ticket stopped once would authorise its
  // own deletion on the retry. Every `<!-- sandcastle:*:start/end -->` region
  // is therefore cut out before a word of the body is read.
  const doomed =
    "packages/api/src/services/storage-backup/__tests__/tar-format.test.ts";

  /** Verbatim shape of what the gate itself wrote onto #850. */
  const stopReport =
    `<!-- sandcastle:stop-report:start -->\n` +
    `## Stopped: check disagreement\n\n` +
    `check-writer-test-coverage-removed: issue #850 — the finished diff ` +
    `DELETES or empties 1 test file(s) under apps/** or packages/**: ` +
    `${doomed}. This is never waived.\n\n` +
    `**What the builder produced:**\n` +
    `The finished diff DELETED or emptied 1 test file(s): ${doomed}.\n` +
    `<!-- sandcastle:stop-report:end -->`;

  it("refuses a path the loop's OWN stop report named", () => {
    expect(
      preauthorizedTestDeletions(`Replace the hand-rolled tar.\n\n${stopReport}`),
    ).toEqual([]);
  });

  it("refuses it even when the machine section was truncated mid-write", () => {
    const truncated = stopReport.slice(0, stopReport.indexOf("**What the"));
    expect(
      preauthorizedTestDeletions(`Replace the hand-rolled tar.\n\n${truncated}`),
    ).toEqual([]);
  });

  it("refuses a path named only inside the screen-check watch section", () => {
    expect(
      preauthorizedTestDeletions(
        `Replace the hand-rolled tar.\n\n` +
          `<!-- sandcastle:screen-check-watch:start -->\n` +
          `The diff deleted \`${doomed}\`.\n` +
          `<!-- sandcastle:screen-check-watch:end -->`,
      ),
    ).toEqual([]);
  });

  it("still reads the OWNER's half of a body that also carries a stop report", () => {
    // The positive control: cutting the machine sections must not cut the
    // ticket. Without this, a parser that returned [] for everything would
    // pass all three refusals above.
    expect(
      preauthorizedTestDeletions(
        `Removing \`tar-format.ts\` also removes its test file, ` +
          `\`${doomed}\` (226 lines).\n\n${stopReport}`,
      ),
    ).toEqual([doomed]);
  });
});
