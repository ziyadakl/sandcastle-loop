/**
 * `guttedFilesBetween` against a REAL git repo — the coverage-removal hard stop
 * end to end, including the two attacks that walked straight through it.
 *
 * WHY REAL GIT AND NOT A PARSED-STRING FIXTURE. Both holes closed here were
 * invisible to a string fixture, because both are about what git ACTUALLY
 * prints rather than what the parser was told to expect:
 *
 *   1. A 200-line suite replaced by `it("noop", () => {});` prints
 *      `1<TAB>200<TAB>path` — `added` is 1, not 0, so the old `added === 0`
 *      predicate said "not gutted" and the ticket shipped. The module's own
 *      doc claimed deleting and emptying "read identically in numstat". They
 *      do not.
 *   2. A root `.gitattributes` carrying `*.spec.ts binary` makes a DELETED
 *      spec print `-<TAB>-<TAB>path`, which parses as 0/0, so `deleted > 0`
 *      was false and the removal set came back EMPTY for a commit that
 *      `git rm`-ed the whole browser suite.
 *
 * Neither could be written as a fixture without first knowing the answer, and
 * knowing the answer was the entire missing step. So every case below drives
 * real commits.
 *
 * The sibling unit file `coverage-removal.test.ts` covers the pure parsers and
 * the ratio decision; this file covers the composition and the git contract.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { removedTestFiles } from "../checkwriter/proof-demand.js";
import { commitInto, git } from "../../__fixtures__/git-repo.js";
import {
  diffStatsBetween,
  guttedFilesBetween,
  reviewDiffStats,
} from "./diff-measurement.js";

/** A believable N-case suite — the thing a gutting attack destroys. */
function suiteOf(cases: number, label = "case"): string {
  const lines = [
    `import { describe, expect, it } from "vitest";`,
    ``,
    `import { isolate } from "../isolate.js";`,
    ``,
    `describe("tenant isolation", () => {`,
  ];
  for (let i = 0; i < cases; i++) {
    lines.push(
      `  it("${label} ${i} cannot read another team's row", () => {`,
      `    expect(isolate(${i})).toBe(true);`,
      `  });`,
      ``,
    );
  }
  lines.push(`});`, ``);
  return lines.join("\n");
}

let repo: string;

const commit = (files: Record<string, string>, message: string): string =>
  commitInto(repo, files, message);

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), "sc-coverage-removal-"));
  git(repo, "init", "-q", "-b", "issue-956");
  git(repo, "config", "user.email", "test@test");
  git(repo, "config", "user.name", "test");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("guttedFilesBetween — HOLE 1: a suite replaced by a no-op stub", () => {
  it("reports a 200-case suite gutted down to a one-line stub", () => {
    const before = commit(
      { "packages/api/src/__tests__/isolation.test.ts": suiteOf(200) },
      "seed the isolation suite",
    );
    const after = commit(
      { "packages/api/src/__tests__/isolation.test.ts": `it("noop", () => {});\n` },
      "feat: (gut the suite)",
    );
    // BEFORE THE FIX this was `[]`: numstat prints `1  200  <path>`, and
    // `added === 0` is false for 1.
    expect(guttedFilesBetween(repo, before, after)).toEqual([
      "packages/api/src/__tests__/isolation.test.ts",
    ]);
  });

  it("reports a gut that hides behind a comment block", () => {
    // The obvious evasion of a "how big were the hunks" rule: delete the
    // suite, add back enough LINES that added/deleted looks ordinary. What is
    // left is still not a test suite, and the size question still says so.
    //
    // The band this does NOT close, stated plainly rather than left for
    // someone to discover: a ratio is a ratio, so padding the file back up to
    // more than COVERAGE_COLLAPSE_RATIO of its original BYTES escapes this
    // instrument. Measured on this exact fixture, 150 filler lines lands at
    // 0.249 and 160 would clear 0.25. That is the price of a threshold with a
    // 2x margin to real history; the alternative is a rule that quarantines
    // healthy refactors, which is the worse failure.
    const before = commit(
      { "packages/api/src/__tests__/isolation.test.ts": suiteOf(200) },
      "seed",
    );
    const filler = Array.from(
      { length: 60 },
      (_, i) => `// TODO(${i}): reinstate this later`,
    ).join("\n");
    const after = commit(
      {
        "packages/api/src/__tests__/isolation.test.ts": `${filler}\nit("noop", () => {});\n`,
      },
      "feat: (gut the suite, padded)",
    );
    expect(guttedFilesBetween(repo, before, after)).toEqual([
      "packages/api/src/__tests__/isolation.test.ts",
    ]);
  });
});

describe("guttedFilesBetween — HOLE 2: a `.gitattributes binary` mark", () => {
  it("reports a DELETED spec that a binary mark made invisible to numstat", () => {
    // The full attack, in the two commits it really takes. Commit 1 adds a
    // ROOT `.gitattributes` — a root file, which raises no proof demand at
    // all. Commit 2 removes the browser suite. Under the old rule the removal
    // set came back empty, because numstat prints `-  -  <path>` for a file
    // git has been told is binary and `deleted > 0` is then false.
    const before = commit(
      {
        "apps/nextjs/e2e/deals.spec.ts": suiteOf(60, "deal"),
        "apps/nextjs/e2e/contacts.spec.ts": suiteOf(40, "contact"),
      },
      "seed the browser suite",
    );
    commit({ ".gitattributes": "*.spec.ts binary\n" }, "chore: tidy attributes");
    git(repo, "rm", "-q", "apps/nextjs/e2e/deals.spec.ts");
    git(repo, "commit", "-q", "-m", "feat: (remove the spec)");
    const after = git(repo, "rev-parse", "HEAD");

    // Prove the attack is real in THIS repo before believing the assertion:
    // numstat must genuinely be printing `-`/`-` here.
    const numstat = git(
      repo,
      "diff",
      "--numstat",
      "--no-renames",
      before,
      after,
      "--",
      "apps/nextjs/e2e/deals.spec.ts",
    );
    expect(numstat.startsWith("-\t-\t")).toBe(true);

    expect(guttedFilesBetween(repo, before, after)).toEqual([
      "apps/nextjs/e2e/deals.spec.ts",
    ]);
  });

  it("reports a spec EMPTIED behind a binary mark, not only a deleted one", () => {
    // The same dodge without the delete: leave the file in place, so
    // `--diff-filter=D` never mentions it, and let the binary mark hide the
    // line counts. Only the size question can answer this one.
    const before = commit(
      {
        ".gitattributes": "*.spec.ts binary\n",
        "apps/nextjs/e2e/deals.spec.ts": suiteOf(60, "deal"),
      },
      "seed",
    );
    const after = commit(
      { "apps/nextjs/e2e/deals.spec.ts": "" },
      "feat: (empty the spec)",
    );
    expect(guttedFilesBetween(repo, before, after)).toEqual([
      "apps/nextjs/e2e/deals.spec.ts",
    ]);
  });
});

describe("guttedFilesBetween — removals it already caught, still caught", () => {
  it("reports a plain delete", () => {
    const before = commit(
      { "apps/nextjs/e2e/a.spec.ts": suiteOf(20), "README.md": "seed\n" },
      "seed",
    );
    git(repo, "rm", "-q", "apps/nextjs/e2e/a.spec.ts");
    git(repo, "commit", "-q", "-m", "delete the spec");
    const after = git(repo, "rev-parse", "HEAD");
    expect(guttedFilesBetween(repo, before, after)).toEqual([
      "apps/nextjs/e2e/a.spec.ts",
    ]);
  });

  it("reports a file emptied to zero bytes", () => {
    const before = commit({ "apps/nextjs/e2e/a.spec.ts": suiteOf(20) }, "seed");
    const after = commit({ "apps/nextjs/e2e/a.spec.ts": "" }, "empty it");
    expect(guttedFilesBetween(repo, before, after)).toEqual([
      "apps/nextjs/e2e/a.spec.ts",
    ]);
  });

  it("reports EVERY file when a whole suite directory is deleted", () => {
    const before = commit(
      {
        "apps/nextjs/e2e/a.spec.ts": suiteOf(10, "a"),
        "apps/nextjs/e2e/b.spec.ts": suiteOf(10, "b"),
        "apps/nextjs/e2e/lib/helpers.ts": "export const x = 1;\n",
        "README.md": "seed\n",
      },
      "seed the suite",
    );
    git(repo, "rm", "-r", "-q", "apps/nextjs/e2e");
    git(repo, "commit", "-q", "-m", "feat: (drop the browser suite)");
    const after = git(repo, "rev-parse", "HEAD");
    expect([...(guttedFilesBetween(repo, before, after) ?? [])].sort()).toEqual([
      "apps/nextjs/e2e/a.spec.ts",
      "apps/nextjs/e2e/b.spec.ts",
      "apps/nextjs/e2e/lib/helpers.ts",
    ]);
  });

  it("reports a rename at the ORIGINAL path — this pins `--no-renames`", () => {
    // Moving a spec out of the workspace the gate watches is a removal from
    // that workspace. `--no-renames` is what turns the rename into a delete +
    // an add, so the ORIGINAL path is named. With rename detection on, git
    // emits one `R` record and this comes back empty — which is why the flag
    // is a contract and not a tuning knob.
    const before = commit({ "apps/nextjs/e2e/a.spec.ts": suiteOf(30) }, "seed");
    mkdirSync(path.join(repo, "scratch"), { recursive: true });
    git(repo, "mv", "apps/nextjs/e2e/a.spec.ts", "scratch/a.spec.ts");
    git(repo, "commit", "-q", "-m", "chore: (move it out of the workspace)");
    const after = git(repo, "rev-parse", "HEAD");
    expect(guttedFilesBetween(repo, before, after)).toEqual([
      "apps/nextjs/e2e/a.spec.ts",
    ]);
  });
});

describe("guttedFilesBetween — the three false alarms of 2026-08-06", () => {
  // Three finished tickets were stopped `stopped:check-disagreement` overnight
  // by this predicate. Two of them (below) were the gate being wrong about what
  // the diff did; the third (#850) was the gate being right and the TICKET
  // having already authorised it — that one is pinned in
  // `../checkwriter/proof-demand.test.ts`, where the issue body lives.

  it("#820: a rename INSIDE the workspace is a move, not a removal", () => {
    // The real diff: `staging-rls.integration.test.ts` became
    // `staging-rls-query-shape.test.ts` (78% similar) in the same
    // `__tests__/` directory, and a brand-new 196-line suite was added beside
    // it. `--no-renames` splits that into a delete + an add, so the OLD path
    // prints `0<TAB>N<TAB>path` and read as gutted coverage. Nothing was lost:
    // the suite is still there under a better name.
    const dir = "packages/api/src/services/widgets/__tests__";
    const before = commit(
      { [`${dir}/staging-rls.integration.test.ts`]: suiteOf(60, "rls") },
      "seed the rls suite",
    );
    git(
      repo,
      "mv",
      `${dir}/staging-rls.integration.test.ts`,
      `${dir}/staging-rls-query-shape.test.ts`,
    );
    // Same shape as the real ticket: the moved suite is also edited, and a new
    // suite lands beside it.
    writeFileSync(
      path.join(repo, dir, "staging-rls-query-shape.test.ts"),
      suiteOf(60, "rls").replace(/case/g, "query shape"),
    );
    writeFileSync(
      path.join(repo, dir, "staging-rls-policy.test.ts"),
      suiteOf(50, "policy"),
    );
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "test: split the rls suite by concern");
    const after = git(repo, "rev-parse", "HEAD");

    expect(guttedFilesBetween(repo, before, after)).toEqual([]);
  });

  it("#860: a 2-line pure deletion from a still-substantial file is not gutting", () => {
    // The real diff: 140 lines became 138 — exactly the two lines the ticket
    // asked to be removed. numstat prints `0<TAB>2<TAB>path`, and an
    // `added === 0 && deleted > 0` predicate calls that destroyed coverage.
    // The file still holds 98% of itself and every case it ever had but one.
    const p =
      "packages/api/src/services/deal-intake/__tests__/detect-existing-deal.integration.test.ts";
    const full = suiteOf(34, "existing deal");
    const before = commit({ [p]: full }, "seed the intake suite");
    const trimmed = full
      .split("\n")
      .filter((l) => !l.includes("existing deal 7 "))
      .join("\n");
    const after = commit({ [p]: trimmed }, "test: drop the stale assertion");

    // Prove the instrument before believing the verdict: numstat must really
    // be printing a pure deletion here, or this test proves nothing.
    expect(
      git(repo, "diff", "--numstat", "--no-renames", before, after, "--", p),
    ).toMatch(/^0\t\d+\t/);

    expect(guttedFilesBetween(repo, before, after)).toEqual([]);
  });
});

describe("guttedFilesBetween — a real gutting still trips, both new bands", () => {
  it("a rename that lands OUTSIDE the workspace is still a removal", () => {
    // The property `--no-renames` was chosen for, and the one the rename pass
    // must not undo: moving a spec out of the watched workspace removes it
    // from that workspace, whatever git calls the operation.
    const before = commit({ "apps/nextjs/e2e/a.spec.ts": suiteOf(30) }, "seed");
    mkdirSync(path.join(repo, "scratch"), { recursive: true });
    git(repo, "mv", "apps/nextjs/e2e/a.spec.ts", "scratch/a.spec.ts");
    git(repo, "commit", "-q", "-m", "chore: (move it out of the workspace)");
    const after = git(repo, "rev-parse", "HEAD");
    expect(guttedFilesBetween(repo, before, after)).toEqual([
      "apps/nextjs/e2e/a.spec.ts",
    ]);
  });

  it("a rename that stops the file BEING a test is still a removal", () => {
    // The obvious evasion of a rename exemption: `git mv suite.test.ts
    // suite.test.ts.bak` is 100% similar and in the same directory, and vitest
    // never loads the result again.
    const before = commit(
      { "packages/api/src/__tests__/isolation.test.ts": suiteOf(80) },
      "seed",
    );
    git(
      repo,
      "mv",
      "packages/api/src/__tests__/isolation.test.ts",
      "packages/api/src/isolation.test.ts.bak",
    );
    git(repo, "commit", "-q", "-m", "chore: (park the suite)");
    const after = git(repo, "rev-parse", "HEAD");
    expect(guttedFilesBetween(repo, before, after)).toEqual([
      "packages/api/src/__tests__/isolation.test.ts",
    ]);
  });

  it("a rename that GUTS the suite past half is still a removal", () => {
    // The evasion the rename exemption looks like it should allow, and the
    // measurement that says how it is actually stopped. `git mv` the suite
    // within `apps/**`, keep the destination a spec, and drop half the cases:
    // both PATH conditions in `renamedNotRemoved` are satisfied.
    //
    // git never offers the pair. `estimate_similarity` refuses any rename whose
    // size delta exceeds `(1 - minimum_score)` of the larger side, so at the
    // pinned 50% a destination at or below half the source is not a rename at
    // all — it is a delete plus an add, and set A answers it. Asserted below
    // rather than assumed, because the whole exemption rests on it.
    const from = "apps/nextjs/e2e/checkout.spec.ts";
    const to = "apps/nextjs/e2e/checkout-flow.spec.ts";
    const full = suiteOf(200, "checkout");
    const before = commit({ [from]: full }, "seed the checkout suite");
    const lines = full.split("\n");
    const kept = `${lines.slice(0, Math.floor(lines.length * 0.45)).join("\n")}\n`;
    git(repo, "rm", "-q", from);
    mkdirSync(path.join(repo, path.dirname(to)), { recursive: true });
    writeFileSync(path.join(repo, to), kept);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "test: (rename and halve the suite)");
    const after = git(repo, "rev-parse", "HEAD");

    // Prove the instrument before believing the verdict: git must genuinely be
    // declining to call this a rename at the threshold the module pins.
    expect(
      git(
        repo,
        "diff",
        "--diff-filter=R",
        "--find-renames=50%",
        "--name-status",
        before,
        after,
      ),
    ).toBe("");

    expect(guttedFilesBetween(repo, before, after)).toEqual([from]);
  });

  it("a rename git DOES detect keeps most of its bytes — the reachable band", () => {
    // The other side of the same measurement, and the honest limit of the
    // exemption. A rename detected at the pinned 50% has a destination above
    // half the source's bytes, so no size threshold this module can carry
    // reaches it (raising one past 0.5 quarantines a legitimate suite split —
    // see `renamedNotRemoved`). This one is exonerated, and about a third of
    // its cases are gone. Pinned so the residue is a documented decision rather
    // than a surprise for whoever reads the exemption next.
    const dir = "packages/api/src/__tests__";
    const full = suiteOf(200);
    const before = commit({ [`${dir}/isolation.test.ts`]: full }, "seed");
    const lines = full.split("\n");
    const kept = `${lines.slice(0, Math.floor(lines.length * 0.65)).join("\n")}\n`;
    git(repo, "rm", "-q", `${dir}/isolation.test.ts`);
    mkdirSync(path.join(repo, dir), { recursive: true });
    writeFileSync(path.join(repo, dir, "tenant-isolation.test.ts"), kept);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "test: narrow the isolation suite");
    const after = git(repo, "rev-parse", "HEAD");

    expect(
      git(
        repo,
        "diff",
        "--diff-filter=R",
        "--find-renames=50%",
        "--name-status",
        before,
        after,
      ),
    ).toMatch(/^R0[5-9]\d\t/);

    expect(guttedFilesBetween(repo, before, after)).toEqual([]);
  });

  it("a pure deletion that takes MOST of the file is still a removal", () => {
    // The band the pure-deletion pass keeps for itself. Nothing is added, so
    // the collapse pass's 0.25 would let a file that kept a third of itself
    // through; "removed lines, added none" holds that band down to a half.
    const p = "packages/api/src/__tests__/isolation.test.ts";
    const full = suiteOf(200);
    const before = commit({ [p]: full }, "seed");
    const lines = full.split("\n");
    const kept = `${lines.slice(0, Math.floor(lines.length * 0.35)).join("\n")}\n`;
    const after = commit({ [p]: kept }, "feat: (strip most of the suite)");
    expect(
      git(repo, "diff", "--numstat", "--no-renames", before, after, "--", p),
    ).toMatch(/^0\t\d+\t/);
    expect(guttedFilesBetween(repo, before, after)).toEqual([p]);
  });

  it("a suite deleted down to a single case is still a removal", () => {
    const p = "apps/nextjs/e2e/a.spec.ts";
    const before = commit({ [p]: suiteOf(200) }, "seed");
    const after = commit(
      { [p]: `it("noop", () => {});\n` },
      "feat: (gut the suite)",
    );
    expect(guttedFilesBetween(repo, before, after)).toEqual([p]);
  });
});

describe("guttedFilesBetween — healthy work must NOT be stopped", () => {
  it("does not report an ordinary edit", () => {
    const before = commit({ "apps/nextjs/e2e/a.spec.ts": suiteOf(40) }, "seed");
    const after = commit(
      { "apps/nextjs/e2e/a.spec.ts": suiteOf(40).replace("case 3", "case 3 (fixed)") },
      "repair a case",
    );
    expect(guttedFilesBetween(repo, before, after)).toEqual([]);
  });

  it("does not report a boilerplate-dedupe refactor that KEEPS the suite", () => {
    // Modelled on a real commit in this repo — f9f3f096, "119 browser tests
    // stopped skipping themselves and now run": `+5 -79` on a 20 KB spec,
    // where coverage strictly INCREASED. A hunk-ratio rule (`added <
    // deleted / 2`) fires on this at 0.06 and quarantines a healthy ticket.
    // The size question does not, because most of the suite is still there.
    const boilerplate = Array.from(
      { length: 79 },
      (_, i) => `  // per-file auth probe copy ${i}`,
    ).join("\n");
    const before = commit(
      { "apps/nextjs/e2e/a.spec.ts": `${boilerplate}\n${suiteOf(60)}` },
      "seed",
    );
    const after = commit(
      {
        "apps/nextjs/e2e/a.spec.ts": `import { ADMIN_PASSWORD } from "./lib/suite-auth";\n${suiteOf(60)}`,
      },
      "refactor: hoist the shared probe",
    );
    expect(guttedFilesBetween(repo, before, after)).toEqual([]);
  });

  it("does not report a newly added file", () => {
    const before = commit({ "README.md": "seed\n" }, "seed");
    const after = commit(
      { "apps/nextjs/e2e/new.spec.ts": suiteOf(10) },
      "add a spec",
    );
    expect(guttedFilesBetween(repo, before, after)).toEqual([]);
  });

  it("does not report a binary asset that merely CHANGED", () => {
    // A PNG that shrinks is not a removed test, and the file this gate feeds
    // filters to test paths anyway — but a binary MODIFY must not be dragged
    // in just because numstat cannot count its lines.
    writeFileSync(
      path.join(repo, "logo.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, ...new Array(4000).fill(0x41)]),
    );
    const before = commit({ "README.md": "seed\n" }, "seed");
    writeFileSync(
      path.join(repo, "logo.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, ...new Array(3800).fill(0x42)]),
    );
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "chore: recompress the logo");
    const after = git(repo, "rev-parse", "HEAD");
    expect(guttedFilesBetween(repo, before, after)).toEqual([]);
  });
});

describe("the gate that consumes this — does it actually FIRE?", () => {
  // `guttedFilesBetween` returning a path proves only half of anything. The
  // ship gate calls `removedTestFiles(changedFiles, guttedFiles)`, which
  // INTERSECTS the removal set with the changed-file set from `parseNumstat`
  // over the same base pair. If a binary-marked delete were missing from
  // EITHER side the intersection would be empty and the ticket would ship —
  // so the composition is what has to be proven, exactly as `main.mts` wires
  // it (`changedFiles: shipDiff.changedFiles`, `guttedFiles:
  // guttedFilesBetween(repoRoot, shipBase, postSha)`).

  it("quarantines the full `.gitattributes binary` + `git rm` attack", () => {
    const before = commit(
      {
        "apps/nextjs/e2e/deals.spec.ts": suiteOf(60, "deal"),
        "packages/api/src/__tests__/isolation.test.ts": suiteOf(80),
      },
      "seed the suites",
    );
    // Commit 1 of the attack: a ROOT file, which raises no proof demand.
    commit({ ".gitattributes": "*.spec.ts binary\n" }, "chore: tidy attributes");
    // Commit 2: remove the browser suite.
    git(repo, "rm", "-q", "apps/nextjs/e2e/deals.spec.ts");
    git(repo, "commit", "-q", "-m", "feat: (ship the feature)");
    const after = git(repo, "rev-parse", "HEAD");

    const changed = reviewDiffStats(repo, before, after).changedFiles;
    // The intersection's other half: numstat must still LIST the file even
    // though it refuses to count its lines. This is the assertion that would
    // have caught a fix that only touched the removal set.
    expect(changed).toContain("apps/nextjs/e2e/deals.spec.ts");

    expect(
      removedTestFiles(changed, guttedFilesBetween(repo, before, after)),
    ).toEqual(["apps/nextjs/e2e/deals.spec.ts"]);
  });

  it("quarantines a suite gutted to a stub", () => {
    const before = commit(
      { "packages/api/src/__tests__/isolation.test.ts": suiteOf(200) },
      "seed",
    );
    const after = commit(
      {
        "packages/api/src/__tests__/isolation.test.ts": `it("noop", () => {});\n`,
        "packages/api/src/router/deals.ts": "export const deals = 1;\n",
      },
      "feat: (ship the feature)",
    );
    expect(
      removedTestFiles(
        reviewDiffStats(repo, before, after).changedFiles,
        guttedFilesBetween(repo, before, after),
      ),
    ).toEqual(["packages/api/src/__tests__/isolation.test.ts"]);
  });

  it("lets an honest ticket that only ADDS coverage through", () => {
    // The positive control for the two above: the same wiring, a healthy
    // diff, no quarantine. Without it a gate that fired on everything would
    // read as working.
    const before = commit(
      { "packages/api/src/router/deals.ts": "export const deals = 1;\n" },
      "seed",
    );
    const after = commit(
      {
        "packages/api/src/router/deals.ts": "export const deals = 2;\n",
        "packages/api/src/__tests__/deals.test.ts": suiteOf(12),
      },
      "feat: deals, with a test",
    );
    expect(
      removedTestFiles(
        reviewDiffStats(repo, before, after).changedFiles,
        guttedFilesBetween(repo, before, after),
      ),
    ).toEqual([]);
  });
});

describe("guttedFilesBetween — the failure directions, unchanged", () => {
  it("identical or blank refs are an ANSWER of [], not a failure", () => {
    const sha = commit({ "README.md": "seed\n" }, "seed");
    expect(guttedFilesBetween(repo, sha, sha)).toEqual([]);
    expect(guttedFilesBetween(repo, "", sha)).toEqual([]);
    expect(guttedFilesBetween(repo, sha, "")).toEqual([]);
  });

  it("FAILS CLOSED: an unaskable git returns null, never an empty list", () => {
    commit({ "README.md": "seed\n" }, "seed");
    expect(
      guttedFilesBetween(repo, "nonexistent-ref-a", "nonexistent-ref-b"),
    ).toBeNull();
    expect(
      guttedFilesBetween(path.join(repo, "not-a-repo"), "HEAD~1", "HEAD"),
    ).toBeNull();
  });

  it("the CHANGED-FILE half fails closed too — an unaskable git is null, never {0, []}", () => {
    // The hole this pins. The ship-time proof gate is fed
    // `reviewDiffStats(...).changedFiles`, and `reviewDiffStats` is
    // deliberately fail-quiet: a git error and a genuinely empty diff both come
    // back `{0, []}`. An empty changed-file list makes `requiredProofForDiff`
    // answer `none`, which EVERY marker satisfies — so a git hiccup at the ship
    // funnel waived the whole gate, exactly the all-clear-from-silence shape
    // `guttedFilesBetween` above refuses to produce. Worse, the gate's own doc
    // justified carrying on past a `null` removal set on the ground that "a
    // deleted test is still a changed file and still raises a demand", which is
    // only true while the changed-file list is trustworthy.
    commit({ "README.md": "seed\n" }, "seed");
    expect(
      diffStatsBetween(repo, "nonexistent-ref-a", "nonexistent-ref-b"),
    ).toBeNull();
    expect(
      diffStatsBetween(path.join(repo, "not-a-repo"), "HEAD~1", "HEAD"),
    ).toBeNull();
  });

  it("identical or blank refs are an ANSWER of {0, []} from the changed-file half too", () => {
    const sha = commit({ "README.md": "seed\n" }, "seed");
    const empty = { changedLines: 0, changedFiles: [] };
    expect(diffStatsBetween(repo, sha, sha)).toEqual(empty);
    expect(diffStatsBetween(repo, "", sha)).toEqual(empty);
    expect(diffStatsBetween(repo, sha, "")).toEqual(empty);
  });

  it("measures a real diff — the positive control the two nulls above are only meaningful against", () => {
    // Prove the instrument before believing its silence: without this, a
    // `diffStatsBetween` that returned null for EVERYTHING would pass the
    // fail-closed assertions and tell us nothing.
    const before = commit({ "README.md": "seed\n" }, "seed");
    const after = commit(
      { "packages/api/src/router/deals.ts": "export const deals = 1;\n" },
      "feat: a router",
    );
    expect(diffStatsBetween(repo, before, after)).toEqual({
      changedLines: 1,
      changedFiles: ["packages/api/src/router/deals.ts"],
    });
  });

  it("reviewDiffStats stays FAIL-QUIET over the identical failure — the escalation sizer must not start stopping tickets", () => {
    // The other half of the split, and the reason it is a split rather than a
    // change to `reviewDiffStats` itself. Its caller decides whether to
    // ESCALATE the reviewer to a bigger model; there, a git hiccup answering
    // "do not escalate" is the cheap status quo and is correct. Only the proof
    // gate needs the unknowable answer.
    commit({ "README.md": "seed\n" }, "seed");
    expect(reviewDiffStats(repo, "nonexistent-ref-a", "nonexistent-ref-b"))
      .toEqual({ changedLines: 0, changedFiles: [] });
  });

  it("FAILS CLOSED when only the SIZE half is unaskable", () => {
    // A tree that `git diff` can reach but `git ls-tree` cannot is not
    // reachable through the public entry point, so the composition is proven
    // at its own seam in `coverage-removal.test.ts`. What is pinned here is
    // that a partial answer never escapes: the shrink half is asked only when
    // there are candidates, and when it is asked and fails the whole answer
    // is null — never the removals it happened to find first.
    const before = commit(
      { "apps/nextjs/e2e/a.spec.ts": suiteOf(30) },
      "seed",
    );
    const after = commit({ "apps/nextjs/e2e/a.spec.ts": "" }, "empty it");
    // Sanity: with git healthy this is a real answer, so the null above is
    // attributable to the broken git and not to this shape of diff.
    expect(guttedFilesBetween(repo, before, after)).not.toBeNull();
  });
});
