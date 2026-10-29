/**
 * Issue #1118 — the pure half of the check reading: the three words, the
 * one-to-one mapping onto the judge's early-pass markers, the rendered
 * block, and reading one back off a ticket.
 *
 * No IO here. `gh.check-reading.test.ts` covers the GitHub-facing half.
 */
import { describe, expect, it } from "vitest";

import {
  CHECK_READING_LABEL_DEFINITIONS,
  CHECK_READING_MEANINGS,
  CHECK_READING_VALUES,
  JUDGE_COVERAGE_MARKERS,
  buildCheckReadingSection,
  checkReadingForMarker,
  checkReadingLabelFor,
  fingerprintCheckSource,
  parseCheckReadingSection,
  tallyCheckReadings,
  upsertCheckReadingSection,
  type CheckReading,
  type CheckReadingRecord,
} from "./check-reading.js";
import { buildVerdictSection, upsertVerdictSection } from "./verdict.js";

const rec = (over: Partial<CheckReadingRecord> = {}): CheckReadingRecord => ({
  reading: "sound",
  whenIso: "2026-08-20T09:00:00.000Z",
  runId: "run-1",
  why: "The check asserts the team total, which is what the ticket asked for.",
  ...over,
});

const bodyWith = (r: CheckReadingRecord): string =>
  upsertCheckReadingSection("Ticket description.", buildCheckReadingSection(r));

describe("the three words, and the markers they come from", () => {
  it("has exactly one reading per judge marker, and no fourth kind", () => {
    expect(CHECK_READING_VALUES).toEqual(["sound", "too-weak", "ticket-unclear"]);
    expect(CHECK_READING_VALUES).toHaveLength(JUDGE_COVERAGE_MARKERS.length);
  });

  it("maps every marker onto a distinct reading, so nothing is counted twice", () => {
    const mapped = JUDGE_COVERAGE_MARKERS.map((m) => checkReadingForMarker(m));
    expect(mapped).toEqual(["sound", "too-weak", "ticket-unclear"]);
    expect(new Set(mapped).size).toBe(JUDGE_COVERAGE_MARKERS.length);
  });

  it("gives every reading a plain-English meaning", () => {
    for (const r of CHECK_READING_VALUES) {
      expect(CHECK_READING_MEANINGS[r].length).toBeGreaterThan(20);
    }
  });
});

describe("the labels", () => {
  it("names one label per reading", () => {
    expect(checkReadingLabelFor("sound")).toBe("check-read:sound");
    expect(CHECK_READING_LABEL_DEFINITIONS.map((d) => d.name)).toEqual(
      CHECK_READING_VALUES.map((r) => checkReadingLabelFor(r)),
    );
  });

  it("holds every description under GitHub's 100-character cap", () => {
    for (const d of CHECK_READING_LABEL_DEFINITIONS) {
      expect(d.description.length).toBeLessThanOrEqual(100);
      expect(d.description.length).toBeGreaterThan(0);
    }
  });
});

describe("buildCheckReadingSection — a person reading the ticket cold", () => {
  it("says what the judge did, when, and what it found", () => {
    const s = buildCheckReadingSection(rec());
    expect(s).toContain("`sound`");
    expect(s).toContain(CHECK_READING_MEANINGS.sound);
    expect(s).toContain("2026-08-20T09:00:00.000Z");
    expect(s).toContain("run-1");
    expect(s).toContain("the team total");
  });

  it("does not congratulate the ticket on a sound check", () => {
    const s = buildCheckReadingSection(rec()).toLowerCase();
    for (const word of ["passed", "well done", "good news", "success", "✅"]) {
      expect(s).not.toContain(word);
    }
  });

  it("says the block is replaced each run and points a disagreement at the verdict", () => {
    const s = buildCheckReadingSection(rec()).toLowerCase();
    expect(s).toContain("replaced");
    expect(s).toContain("verdict");
  });

  it("names the criterion when the judge quoted one", () => {
    const s = buildCheckReadingSection(
      rec({ reading: "too-weak", criterion: "the team total excludes archived deals" }),
    );
    expect(s).toContain("the team total excludes archived deals");
  });

  it("says '(not stated)' rather than leaving a blank where a value is missing", () => {
    const s = buildCheckReadingSection({ reading: "sound", whenIso: "2026-08-20T09:00:00.000Z" });
    expect(s).toContain("(not stated)");
  });
});

describe("upsertCheckReadingSection — coexisting with the other blocks", () => {
  it("leaves a verdict block on the same ticket untouched", () => {
    const withVerdict = upsertVerdictSection(
      "Ticket description.",
      buildVerdictSection({
        verdict: "checks-wrong",
        decidedBy: "human",
        whenIso: "2026-08-19T09:00:00.000Z",
      }),
    );
    const both = upsertCheckReadingSection(withVerdict, buildCheckReadingSection(rec()));
    expect(both).toContain("Ticket description.");
    expect(both).toContain("## Verdict: which side was wrong");
    expect(both).toContain("`checks-wrong`");
    expect(parseCheckReadingSection(both)?.reading).toBe("sound");
  });

  it("replaces its own earlier block rather than stacking a second one", () => {
    const first = bodyWith(rec());
    const second = upsertCheckReadingSection(
      first,
      buildCheckReadingSection(rec({ reading: "too-weak", criterion: "c" })),
    );
    expect(second.match(/sandcastle:check-reading:start/g)).toHaveLength(1);
    expect(parseCheckReadingSection(second)?.reading).toBe("too-weak");
  });
});

describe("parseCheckReadingSection — strict on the word, forgiving elsewhere", () => {
  it("round-trips every reading", () => {
    for (const reading of CHECK_READING_VALUES) {
      const back = parseCheckReadingSection(
        bodyWith(rec({ reading, criterion: reading === "sound" ? undefined : "c" })),
      );
      expect(back?.reading).toBe(reading);
    }
  });

  it("round-trips the decoration alongside the word", () => {
    const back = parseCheckReadingSection(bodyWith(rec({ criterion: "the team total" })));
    expect(back?.whenIso).toBe("2026-08-20T09:00:00.000Z");
    expect(back?.runId).toBe("run-1");
    expect(back?.criterion).toBe("the team total");
    expect(back?.why).toContain("the team total, which is what the ticket asked for");
  });

  it("round-trips the check fingerprint, which is what a resume compares", () => {
    // The fingerprint is the only field anything COMPUTES with. A resumed
    // ticket skips re-reading a check whose bytes match this value, so a
    // fingerprint that does not survive the round trip silently turns the
    // skip off and the resumed-ticket hazard back on.
    const fp = fingerprintCheckSource("some check source");
    const back = parseCheckReadingSection(bodyWith(rec({ checkFingerprint: fp })));
    expect(back?.checkFingerprint).toBe(fp);
  });

  it("reports NO fingerprint — never the placeholder — when none was recorded", () => {
    // A block written before the field existed renders `(not stated)`. Handing
    // that back as a fingerprint would make it a value that could match, and
    // the safe answer is "cannot prove it, read the check again".
    const back = parseCheckReadingSection(bodyWith(rec()));
    expect(back?.checkFingerprint).toBeUndefined();
  });

  it("gives two different check texts two different fingerprints", () => {
    expect(fingerprintCheckSource("a")).not.toBe(fingerprintCheckSource("b"));
    expect(fingerprintCheckSource("a")).toBe(fingerprintCheckSource("a"));
  });

  it("reports NO reading for a body that carries none", () => {
    expect(parseCheckReadingSection("Just a ticket description.")).toBeUndefined();
  });

  it("reports NO reading — never a fourth kind — for an unknown word", () => {
    const mangled = bodyWith(rec()).replace("`sound`", "`quite-good`");
    expect(parseCheckReadingSection(mangled)).toBeUndefined();
  });

  it("still reads the word when the date and run have been rubbed out", () => {
    const body = [
      "<!-- sandcastle:check-reading:start -->",
      "## Check reading",
      "",
      "**Reading:** `too-weak`",
      "<!-- sandcastle:check-reading:end -->",
    ].join("\n");
    const back = parseCheckReadingSection(body);
    expect(back?.reading).toBe("too-weak");
    expect(back?.whenIso).toBe("");
    expect(back?.runId).toBeUndefined();
  });

  it("reports NO reading for a half-deleted block", () => {
    const half = bodyWith(rec()).replace("<!-- sandcastle:check-reading:end -->", "");
    expect(parseCheckReadingSection(half)).toBeUndefined();
  });

  it("does not mistake a verdict block for a check reading", () => {
    const body = upsertVerdictSection(
      "Ticket description.",
      buildVerdictSection({
        verdict: "checks-wrong",
        decidedBy: "judge",
        whenIso: "2026-08-19T09:00:00.000Z",
      }),
    );
    expect(parseCheckReadingSection(body)).toBeUndefined();
  });

  it("keeps a reason that quotes the ticket whole, quote marks and all", () => {
    const why = "The ticket says:\n> the team total excludes archived deals\nand the check asserts it.";
    const back = parseCheckReadingSection(bodyWith(rec({ why })));
    expect(back?.why).toContain("archived deals");
    expect(back?.why).toContain("and the check asserts it.");
  });
});

describe("tallyCheckReadings — a count with a total under it", () => {
  it("counts each reading and totals the checks actually read", () => {
    const bodies = [
      bodyWith(rec({ reading: "sound" })),
      bodyWith(rec({ reading: "sound" })),
      bodyWith(rec({ reading: "too-weak", criterion: "c" })),
      "A ticket with no reading on it.",
    ];
    const t = tallyCheckReadings(bodies);
    expect(t.sound).toBe(2);
    expect(t["too-weak"]).toBe(1);
    expect(t["ticket-unclear"]).toBe(0);
    expect(t.unrecorded).toBe(1);
    expect(t.total).toBe(3);
  });

  it("totals zero, not NaN, over nothing at all", () => {
    const t = tallyCheckReadings([]);
    expect(t.total).toBe(0);
    expect(t.unrecorded).toBe(0);
  });

  it("keeps the total equal to the sum of the three readings", () => {
    const bodies = CHECK_READING_VALUES.map((reading: CheckReading) =>
      bodyWith(rec({ reading, criterion: "c" })),
    );
    const t = tallyCheckReadings(bodies);
    expect(t.total).toBe(t.sound + t["too-weak"] + t["ticket-unclear"]);
    expect(t.total).toBe(3);
  });
});
