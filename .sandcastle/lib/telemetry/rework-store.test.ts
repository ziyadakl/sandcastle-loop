/**
 * Tests for the durable rework store.
 *
 * These run against a REAL file on a real `mkdtempSync` path, like
 * `replay.test.ts` does — the append syscall and the on-disk bytes ARE the unit
 * under test, so mocking the write away would leave the module's whole reason
 * for existing unasserted.
 *
 * Several assertions deliberately read the RAW `JSON.parse` of a line rather
 * than the zod-parsed record. `z.object` makes an absent key and an explicit
 * `null` both surface as `undefined`, so a parsed-side assertion passes even
 * when the writer emitted `null` — only the raw bytes can tell ABSENT from
 * MEASURED-AS-NULL (the same argument as `replay.test.ts:275-292`).
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MAX_CHANGED_FILE_PATHS,
  MAX_SCREEN_CHECK_ATTEMPT_VERDICTS,
} from "../status/schema.js";
import {
  REWORK_SCHEMA_VERSION,
  appendReworkRecord,
  dedupeRecords,
  readReworkRecords,
  reworkStorePath,
  type ReworkRecord,
  type ReworkRecordInput,
} from "./rework-store.js";

/** A complete, valid record — spread and overridden by individual tests. */
function input(over: Partial<ReworkRecordInput> = {}): ReworkRecordInput {
  return {
    issueNumber: 412,
    runId: "run-1",
    hostId: "host-a",
    shippedAtIso: "2026-08-01T12:00:00.000Z",
    shippedSha: "abc1234",
    outcome: "shipped",
    ...over,
  };
}

describe("rework-store", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sandcastle-rework-"));
    path = join(dir, "telemetry", "issues.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** The raw lines on disk, trailing terminator excluded. */
  function lines(): string[] {
    return readFileSync(path, "utf8").split("\n").slice(0, -1);
  }

  /** The raw JSON of line `i`, BEFORE any schema parse. */
  function raw(i = 0): Record<string, unknown> {
    return JSON.parse(lines()[i]!) as Record<string, unknown>;
  }

  describe("reworkStorePath", () => {
    it("resolves under .sandcastle/telemetry, which is NOT gitignored", () => {
      expect(reworkStorePath("/repo")).toBe(
        "/repo/.sandcastle/telemetry/issues.jsonl",
      );
    });
  });

  describe("appending", () => {
    it("creates the directory and writes one newline-terminated line", () => {
      expect(appendReworkRecord(input(), { path })).toBe(true);
      const text = readFileSync(path, "utf8");
      expect(text.endsWith("\n")).toBe(true);
      expect(lines()).toHaveLength(1);
    });

    it("appends, never rewrites: two calls leave two lines in order", () => {
      appendReworkRecord(input({ issueNumber: 1 }), { path });
      appendReworkRecord(input({ issueNumber: 2 }), { path });
      expect(lines()).toHaveLength(2);
      expect(raw(0).issueNumber).toBe(1);
      expect(raw(1).issueNumber).toBe(2);
    });

    it("stamps the schema version so the caller cannot get it wrong", () => {
      appendReworkRecord(input(), { path });
      expect(raw().schemaVersion).toBe(REWORK_SCHEMA_VERSION);
    });

    it("keeps a value containing a literal newline on ONE line", () => {
      // JSON string escaping is what guarantees the one-record-per-line
      // invariant; a producer that interpolated instead would split the record
      // in two and corrupt every later reader.
      appendReworkRecord(input({ runId: "run\n1", hostId: "a\nb" }), { path });
      expect(lines()).toHaveLength(1);
      expect(raw().runId).toBe("run\n1");
    });

    it("drops an unusable record rather than writing a poisoned line", () => {
      const errors: unknown[] = [];
      const ok = appendReworkRecord(input({ issueNumber: -3 }), {
        path,
        onError: (e) => errors.push(e),
      });
      expect(ok).toBe(false);
      expect(errors).toHaveLength(1);
      expect(readReworkRecords({ path }).records).toHaveLength(0);
    });

    it("drops an out-of-enum outcome instead of writing it", () => {
      const ok = appendReworkRecord(
        input({ outcome: "merged" as never }),
        { path },
      );
      expect(ok).toBe(false);
    });

    it("never throws on an unwritable path; it reports and returns false", () => {
      const errors: unknown[] = [];
      chmodSync(dir, 0o500);
      try {
        const ok = appendReworkRecord(input(), {
          path,
          onError: (e) => errors.push(e),
        });
        expect(ok).toBe(false);
        expect(errors).toHaveLength(1);
      } finally {
        chmodSync(dir, 0o700);
      }
    });
  });

  describe("ABSENT is not ZERO", () => {
    it("omits never-measured fields from the written JSON entirely", () => {
      appendReworkRecord(input(), { path });
      const obj = raw();
      for (const key of [
        "changedFilePaths",
        "changedFiles",
        "changedLines",
        "costUsd",
        "wallMs",
        "retries",
        "quarantined",
        "models",
      ]) {
        expect([key, key in obj]).toEqual([key, false]);
      }
    });

    it("writes a MEASURED zero as 0, distinguishably from absent", () => {
      appendReworkRecord(
        input({ changedFiles: 0, changedLines: 0, retries: 0, wallMs: 0 }),
        { path },
      );
      const obj = raw();
      expect(obj.changedFiles).toBe(0);
      expect(obj.changedLines).toBe(0);
      expect(obj.retries).toBe(0);
      expect(obj.wallMs).toBe(0);
    });

    it("writes a measured EMPTY path list as [], distinguishably from absent", () => {
      appendReworkRecord(input({ changedFilePaths: [] }), { path });
      expect(raw().changedFilePaths).toEqual([]);
    });

    it("survives a write/read round trip with the distinction intact", () => {
      appendReworkRecord(input({ issueNumber: 1 }), { path });
      appendReworkRecord(input({ issueNumber: 2, changedFiles: 0 }), { path });
      const { records } = readReworkRecords({ path });
      expect(records[0]!.changedFiles).toBeUndefined();
      expect(records[1]!.changedFiles).toBe(0);
    });
  });

  describe("costUsd is three-state", () => {
    it("omits it when never measured", () => {
      appendReworkRecord(input(), { path });
      expect("costUsd" in raw()).toBe(false);
    });

    it("preserves null — 'measured, every model unpriced', never 0", () => {
      appendReworkRecord(input({ costUsd: null }), { path });
      expect(raw().costUsd).toBeNull();
      expect(readReworkRecords({ path }).records[0]!.costUsd).toBeNull();
    });

    it("preserves a real figure", () => {
      appendReworkRecord(input({ costUsd: 1.25 }), { path });
      expect(readReworkRecords({ path }).records[0]!.costUsd).toBeCloseTo(1.25, 9);
    });
  });

  describe("caps are enforced by SLICING, never by a schema .max()", () => {
    it("stores at most MAX_CHANGED_FILE_PATHS paths and still parses", () => {
      const paths = Array.from({ length: 250 }, (_, i) => `src/f${i}.ts`);
      appendReworkRecord(input({ changedFilePaths: paths, changedFiles: 250 }), {
        path,
      });
      const { records, skipped } = readReworkRecords({ path });
      expect(skipped).toBe(0);
      expect(records[0]!.changedFilePaths).toHaveLength(MAX_CHANGED_FILE_PATHS);
      // The COUNT stays authoritative and uncapped, so
      // `changedFiles > changedFilePaths.length` is the truncation signal.
      expect(records[0]!.changedFiles).toBe(250);
    });
  });

  describe("reading", () => {
    it("returns an empty, non-throwing result when the file does not exist", () => {
      const result = readReworkRecords({ path });
      expect(result.records).toEqual([]);
      expect(result.skipped).toBe(0);
      expect(result.exists).toBe(false);
    });

    it("distinguishes an existing-but-empty file from an absent one", () => {
      appendReworkRecord(input(), { path });
      writeFileSync(path, "");
      const result = readReworkRecords({ path });
      expect(result.exists).toBe(true);
      expect(result.records).toEqual([]);
    });

    it("skips a malformed line, counts it, and keeps the good ones", () => {
      appendReworkRecord(input({ issueNumber: 1 }), { path });
      writeFileSync(path, `${readFileSync(path, "utf8")}{not json\n`, {
        flag: "w",
      });
      appendReworkRecord(input({ issueNumber: 2 }), { path });
      const { records, skipped } = readReworkRecords({ path });
      expect(records.map((r) => r.issueNumber)).toEqual([1, 2]);
      expect(skipped).toBe(1);
    });

    it("skips a torn final line (a crash mid-append) without losing the rest", () => {
      appendReworkRecord(input({ issueNumber: 1 }), { path });
      writeFileSync(path, `${readFileSync(path, "utf8")}{"issueNu`, {
        flag: "w",
      });
      const { records, skipped } = readReworkRecords({ path });
      expect(records.map((r) => r.issueNumber)).toEqual([1]);
      expect(skipped).toBe(1);
    });

    it("skips a well-formed-JSON line that is not a valid record", () => {
      appendReworkRecord(input({ issueNumber: 1 }), { path });
      writeFileSync(
        path,
        `${readFileSync(path, "utf8")}{"schemaVersion":1,"issueNumber":"x"}\n`,
        { flag: "w" },
      );
      const { records, skipped } = readReworkRecords({ path });
      expect(records).toHaveLength(1);
      expect(skipped).toBe(1);
    });

    it("ignores blank lines rather than counting them as damage", () => {
      appendReworkRecord(input(), { path });
      writeFileSync(path, `${readFileSync(path, "utf8")}\n   \n`, { flag: "w" });
      const { records, skipped } = readReworkRecords({ path });
      expect(records).toHaveLength(1);
      expect(skipped).toBe(0);
    });

    it("buckets a FUTURE schema version separately, never as damage", () => {
      // A v2 writer may legitimately rename or reshape fields. Counting its
      // records as malformed would silently discard NEWER data as garbage —
      // the one failure mode a durability store must not have.
      appendReworkRecord(input({ issueNumber: 1 }), { path });
      writeFileSync(
        path,
        `${readFileSync(path, "utf8")}{"schemaVersion":99,"whatever":{"shape":1}}\n`,
        { flag: "w" },
      );
      const { records, skipped, futureVersion } = readReworkRecords({ path });
      expect(records).toHaveLength(1);
      expect(skipped).toBe(0);
      expect(futureVersion).toBe(1);
    });

    it("never throws on a directory where a file was expected", () => {
      const errors: unknown[] = [];
      const result = readReworkRecords({
        path: dir,
        onError: (e) => errors.push(e),
      });
      expect(result.records).toEqual([]);
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe("models (the seed for later auto-tuning)", () => {
    it("round-trips the per-role ladder", () => {
      appendReworkRecord(
        input({
          models: {
            implementer: {
              default: "claude-sonnet-5",
              escalations: ["claude-opus-4-5"],
            },
          },
        }),
        { path },
      );
      const row = readReworkRecords({ path }).records[0]!;
      expect(row.models!.implementer!.default).toBe("claude-sonnet-5");
      expect(row.models!.implementer!.escalations).toEqual(["claude-opus-4-5"]);
    });

    it("drops a malformed role entry without poisoning the record", () => {
      appendReworkRecord(
        input({
          models: {
            implementer: { default: "claude-sonnet-5", escalations: [] },
            reviewer: { default: 7 } as never,
          },
        }),
        { path },
      );
      const { records, skipped } = readReworkRecords({ path });
      expect(skipped).toBe(0);
      expect(Object.keys(records[0]!.models!)).toEqual(["implementer"]);
    });

    it("omits models entirely when nothing usable was supplied", () => {
      appendReworkRecord(input({ models: {} }), { path });
      expect("models" in raw()).toBe(false);
    });
  });

  describe("retries is attempts − 1", () => {
    it("records 1 for an issue that needed a SECOND implementer pass", () => {
      // The headline number this telemetry exists to defend: counting the
      // first pass as a retry would turn 18 first passes into 18 phantom
      // retries and invert the whole signal (`issue-bag.ts:319-329`).
      appendReworkRecord(input({ retries: 1 }), { path });
      expect(readReworkRecords({ path }).records[0]!.retries).toBe(1);
    });
  });
});

describe("dedupeRecords — the reader's other half", () => {
  /** A stored record, straight from the schema's required fields. */
  function stored(over: Partial<ReworkRecord> = {}): ReworkRecord {
    return {
      schemaVersion: REWORK_SCHEMA_VERSION,
      issueNumber: 412,
      runId: "run-1",
      hostId: "host-a",
      shippedAtIso: "2026-08-01T12:00:00.000Z",
      shippedSha: "abc1234",
      outcome: "shipped",
      ...over,
    };
  }

  it("collapses the same issue in the same run to ONE record", () => {
    // The union merge driver takes both sides' lines, so a record legitimately
    // appears twice once two branches carrying it are merged. Left alone it
    // double-weights that issue's files in BOTH halves of the rate.
    const { records, duplicates } = dedupeRecords([
      stored(),
      stored(),
      stored({ issueNumber: 413 }),
    ]);
    expect(records).toHaveLength(2);
    expect(duplicates).toBe(1);
    expect(records.map((r) => r.issueNumber)).toEqual([412, 413]);
  });

  it("keeps the SAME issue from a DIFFERENT run — that is not a duplicate", () => {
    const { records, duplicates } = dedupeRecords([
      stored({ runId: "run-1" }),
      stored({ runId: "run-2" }),
    ]);
    expect(records).toHaveLength(2);
    expect(duplicates).toBe(0);
  });

  it("keeps the LAST occurrence, which is the more instrumented one", () => {
    // Append-only: a later line was written later, so it carries fields (cost,
    // paths, a resolved sha) an earlier copy may not have had.
    const { records } = dedupeRecords([
      stored({ costUsd: undefined }),
      stored({ costUsd: 1.25, changedFilePaths: ["src/a.ts"] }),
    ]);
    expect(records[0]!.costUsd).toBe(1.25);
    expect(records[0]!.changedFilePaths).toEqual(["src/a.ts"]);
  });

  it("cannot confuse two issues whose key parts merely concatenate alike", () => {
    // `1` + `2 run` vs `12` + ` run` — the separator has to keep these apart.
    const { records, duplicates } = dedupeRecords([
      stored({ issueNumber: 1, runId: "2 run" }),
      stored({ issueNumber: 12, runId: "run" }),
    ]);
    expect(records).toHaveLength(2);
    expect(duplicates).toBe(0);
  });

  it("handles an empty input", () => {
    expect(dedupeRecords([])).toEqual({ records: [], duplicates: 0 });
  });

  it("dedupes what the reader actually returns, end to end", () => {
    const dir = mkdtempSync(join(tmpdir(), "sandcastle-rework-dedupe-"));
    const path = join(dir, "telemetry", "issues.jsonl");
    try {
      appendReworkRecord(input(), { path });
      appendReworkRecord(input(), { path });
      const read = readReworkRecords({ path });
      expect(read.records).toHaveLength(2);
      expect(dedupeRecords(read.records).records).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("screenCheck — the OBSERVED half of the record reaches THIS durable file (issue #912, Piece K)", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sandcastle-rework-screencheck-"));
    path = join(dir, "telemetry", "issues.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** The raw JSON of line `i` on disk, BEFORE any schema parse — settles the
   *  Piece L question ("a prompt/check naming a field is not evidence the
   *  field arrives") by reading actual bytes, not the in-memory input. */
  function rawLine(i = 0): Record<string, unknown> {
    return JSON.parse(
      readFileSync(path, "utf8").split("\n").slice(0, -1)[i]!,
    ) as Record<string, unknown>;
  }

  it("a full screenCheck record survives to the raw bytes on disk", () => {
    appendReworkRecord(
      input({
        screenCheck: {
          screen: "/finance/reports?view=team",
          verdict: "match",
          whenIso: "2026-08-04T13:00:00.000Z",
          rerun: false,
          pictureLink: "run-branch/issue-412/finance-reports.png",
          pictureStored: true,
        },
      }),
      { path },
    );
    expect(rawLine().screenCheck).toEqual({
      screen: "/finance/reports?view=team",
      verdict: "match",
      whenIso: "2026-08-04T13:00:00.000Z",
      rerun: false,
      pictureLink: "run-branch/issue-412/finance-reports.png",
      pictureStored: true,
    });
    // Also readable back through the schema-parsed reader, not just raw JSON.
    const { records } = readReworkRecords({ path });
    expect(records[0]!.screenCheck?.verdict).toBe("match");
  });

  it("records the four failure verdicts distinctly on disk — never-settled, claim-mismatch, environment-fault, graded-mismatch", () => {
    const verdictIssueNumber: Record<string, number> = {
      "never-settled": 1,
      "claim-mismatch": 2,
      "graded-mismatch": 3,
      "environment-fault": 4,
    };
    for (const verdict of [
      "never-settled",
      "claim-mismatch",
      "graded-mismatch",
      "environment-fault",
    ] as const) {
      appendReworkRecord(
        input({
          issueNumber: verdictIssueNumber[verdict],
          screenCheck: {
            verdict,
            whenIso: "2026-08-04T13:00:00.000Z",
            rerun: false,
            pictureStored: false,
          },
        }),
        { path },
      );
    }
    const { records } = readReworkRecords({ path });
    const verdicts = records.map((r) => r.screenCheck?.verdict).sort();
    expect(verdicts).toEqual([
      "claim-mismatch",
      "environment-fault",
      "graded-mismatch",
      "never-settled",
    ]);
  });

  it("is absent (not written as a default) for a record with no screen check at all", () => {
    appendReworkRecord(input(), { path });
    expect(rawLine()).not.toHaveProperty("screenCheck");
  });

  it("drops an out-of-enum verdict rather than writing a lie", () => {
    appendReworkRecord(
      input({
        screenCheck: {
          verdict: "sort-of-passed" as never,
          whenIso: "2026-08-04T13:00:00.000Z",
          rerun: false,
          pictureStored: false,
        },
      }),
      { path },
    );
    expect(rawLine()).not.toHaveProperty("screenCheck");
  });

  it("the attempt trail reaches the raw bytes on disk, in attempt order, and reads back", () => {
    appendReworkRecord(
      input({
        screenCheck: {
          verdict: "graded-mismatch",
          whenIso: "2026-08-04T13:00:00.000Z",
          rerun: true,
          pictureStored: false,
          // Attempt 1 proved the figure wrong; attempt 2 proved nothing, and
          // `moreEvidencedVerdict` kept attempt 1. The trail is the only
          // durable record that the two runs disagreed at all.
          attemptVerdicts: ["graded-mismatch", "inconclusive"],
        },
      }),
      { path },
    );
    expect(
      (rawLine().screenCheck as Record<string, unknown>).attemptVerdicts,
    ).toEqual(["graded-mismatch", "inconclusive"]);
    const { records } = readReworkRecords({ path });
    expect(records[0]!.screenCheck?.attemptVerdicts).toEqual([
      "graded-mismatch",
      "inconclusive",
    ]);
  });

  it("drops a malformed trail without dropping the screen-check record around it", () => {
    const trails: unknown[] = [
      "graded-mismatch",
      ["graded-mismatch", "sort-of-passed"],
      ["graded-mismatch", 7],
      [],
      null,
      // Over the cap: DROPPED WHOLE, never sliced down to the cap — a
      // truncated trail reads as a run with fewer attempts.
      new Array<string>(MAX_SCREEN_CHECK_ATTEMPT_VERDICTS + 1).fill("match"),
    ];
    for (const [i, trail] of trails.entries()) {
      const one = join(dir, `trail-${i}.jsonl`);
      appendReworkRecord(
        input({
          screenCheck: {
            verdict: "graded-mismatch",
            whenIso: "2026-08-04T13:00:00.000Z",
            rerun: true,
            pictureStored: false,
            attemptVerdicts: trail as never,
          },
        }),
        { path: one },
      );
      const written = JSON.parse(
        readFileSync(one, "utf8").split("\n")[0]!,
      ) as Record<string, unknown>;
      expect(written.screenCheck).toEqual({
        verdict: "graded-mismatch",
        whenIso: "2026-08-04T13:00:00.000Z",
        rerun: true,
        pictureStored: false,
      });
    }
  });

  it("a record written BEFORE this field existed still loads — absent trail, never invented as []", () => {
    // A line exactly as the pre-attemptVerdicts writer emitted it. Written by
    // hand, not by this module, so the check is against the bytes already
    // sitting in every existing store — not against whatever today's writer
    // happens to produce.
    appendReworkRecord(input({ issueNumber: 1 }), { path });
    writeFileSync(
      path,
      '{"schemaVersion":1,"issueNumber":412,"runId":"run-1","hostId":"host-a",' +
        '"shippedAtIso":"2026-08-01T12:00:00.000Z","shippedSha":"abc1234",' +
        '"quarantined":false,"screenCheck":{"screen":"/finance/reports",' +
        '"verdict":"match","whenIso":"2026-08-04T13:00:00.000Z","rerun":false,' +
        '"pictureStored":true},"outcome":"shipped"}\n',
      { flag: "w" },
    );
    const { records, skipped, futureVersion } = readReworkRecords({ path });
    expect(skipped).toBe(0);
    expect(futureVersion).toBe(0);
    expect(records).toHaveLength(1);
    expect(records[0]!.screenCheck?.verdict).toBe("match");
    expect(records[0]!.screenCheck?.screen).toBe("/finance/reports");
    expect(records[0]!.screenCheck).not.toHaveProperty("attemptVerdicts");
  });

  it("does not corrupt sibling fields when screenCheck is malformed", () => {
    appendReworkRecord(
      input({
        changedFiles: 3,
        screenCheck: { verdict: "match" } as never, // missing whenIso/rerun/pictureStored
      }),
      { path },
    );
    const raw = rawLine();
    expect(raw).not.toHaveProperty("screenCheck");
    expect(raw.changedFiles).toBe(3);
  });
});

describe("implementerCertification — the CLAIMED half of the record also reaches THIS durable file (issue #886)", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sandcastle-rework-certification-"));
    path = join(dir, "telemetry", "issues.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function rawLine(i = 0): Record<string, unknown> {
    return JSON.parse(
      readFileSync(path, "utf8").split("\n").slice(0, -1)[i]!,
    ) as Record<string, unknown>;
  }

  it("a full implementerCertification record survives to the raw bytes on disk", () => {
    appendReworkRecord(
      input({
        implementerCertification: {
          storyType: "feature",
          e2eRequired: true,
          e2eActuallyRan: true,
          testCommandUsed: "pnpm --filter @acme/nextjs e2e -- finance.spec.ts",
          e2eAssertionLine: 'expect(page.locator("...")).toHaveText("$50,032.50")',
          outputNotFiltered: true,
          testReachedFeature: true,
        },
      }),
      { path },
    );
    expect(rawLine().implementerCertification).toEqual({
      storyType: "feature",
      e2eRequired: true,
      e2eActuallyRan: true,
      testCommandUsed: "pnpm --filter @acme/nextjs e2e -- finance.spec.ts",
      e2eAssertionLine: 'expect(page.locator("...")).toHaveText("$50,032.50")',
      outputNotFiltered: true,
      testReachedFeature: true,
    });
    const { records } = readReworkRecords({ path });
    expect(records[0]!.implementerCertification?.e2eActuallyRan).toBe(true);
  });

  it("records null testCommandUsed/e2eAssertionLine as the meaningful sentinel they are, not as absent", () => {
    appendReworkRecord(
      input({
        implementerCertification: {
          e2eRequired: false,
          testCommandUsed: null,
          e2eAssertionLine: null,
        },
      }),
      { path },
    );
    const raw = rawLine();
    expect(raw.implementerCertification).toMatchObject({
      testCommandUsed: null,
      e2eAssertionLine: null,
    });
  });

  it("is absent for a record with no certification at all", () => {
    appendReworkRecord(input(), { path });
    expect(rawLine()).not.toHaveProperty("implementerCertification");
  });

  it("drops a vacuous object (none of the seven fields) rather than writing an empty claim", () => {
    appendReworkRecord(
      input({ implementerCertification: { irrelevant: "x" } as never }),
      { path },
    );
    expect(rawLine()).not.toHaveProperty("implementerCertification");
  });

  it("does not corrupt sibling fields when implementerCertification is malformed", () => {
    appendReworkRecord(
      input({
        changedFiles: 3,
        implementerCertification: "not an object" as never,
      }),
      { path },
    );
    const raw = rawLine();
    expect(raw).not.toHaveProperty("implementerCertification");
    expect(raw.changedFiles).toBe(3);
  });
});

describe("the two halves stay separate on disk, together (issue #912, Piece K)", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sandcastle-rework-two-halves-"));
    path = join(dir, "telemetry", "issues.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("a record carrying BOTH the claimed half and the observed half keeps them as two distinct fields, read back off disk", () => {
    // The exact shape the design doc warns against: the robot CLAIMED it
    // ran an e2e check and it passed, while the harness OBSERVED the real
    // figure did not match. Piece K's whole point is that this
    // disagreement must be visible afterwards, which requires the two
    // halves to survive as separate fields, never merged and never one
    // derived from the other.
    appendReworkRecord(
      input({
        implementerCertification: {
          e2eRequired: true,
          e2eActuallyRan: true,
          testCommandUsed: "pnpm --filter @acme/nextjs e2e -- finance.spec.ts",
        },
        screenCheck: {
          screen: "/finance/reports?view=team",
          verdict: "graded-mismatch",
          whenIso: "2026-08-04T13:00:05.000Z",
          rerun: true,
          pictureStored: true,
          pictureLink: "run-branch/issue-412/finance-reports.png",
        },
      }),
      { path },
    );

    // Read back OFF DISK — a fresh file read and a fresh JSON.parse, never
    // the in-memory input object this test built above.
    const raw = JSON.parse(
      readFileSync(path, "utf8").split("\n")[0]!,
    ) as Record<string, unknown>;

    expect(raw).toHaveProperty("implementerCertification");
    expect(raw).toHaveProperty("screenCheck");
    // Two DISTINCT fields, not one merged blob and not one derived from the
    // other — the claim says the robot believes it ran and passed; the
    // observation says the harness watched it fail. Both survive, intact,
    // disagreeing with each other, which is exactly what makes the
    // disagreement checkable afterwards.
    expect(raw.implementerCertification).toEqual({
      e2eRequired: true,
      e2eActuallyRan: true,
      testCommandUsed: "pnpm --filter @acme/nextjs e2e -- finance.spec.ts",
    });
    expect(raw.screenCheck).toEqual({
      screen: "/finance/reports?view=team",
      verdict: "graded-mismatch",
      whenIso: "2026-08-04T13:00:05.000Z",
      rerun: true,
      pictureStored: true,
      pictureLink: "run-branch/issue-412/finance-reports.png",
    });

    // And through the real, schema-parsed reader too.
    const { records } = readReworkRecords({ path });
    expect(records[0]!.implementerCertification?.e2eActuallyRan).toBe(true);
    expect(records[0]!.screenCheck?.verdict).toBe("graded-mismatch");
  });
});

describe("stopReason — the five ways a ticket stops reach THIS durable file (issue #914, Piece H)", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sandcastle-rework-stopreason-"));
    path = join(dir, "telemetry", "issues.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Raw JSON of line `i`, BEFORE any schema parse — the same discipline
   *  `rawLine` uses above: proves the field arrives on disk, not merely in
   *  the in-memory input object the test built. */
  function rawLine(i = 0): Record<string, unknown> {
    return JSON.parse(
      readFileSync(path, "utf8").split("\n").slice(0, -1)[i]!,
    ) as Record<string, unknown>;
  }

  it("all FIVE stop labels round-trip to disk, and none collapse into another", () => {
    const labels = [
      "stopped:no-failing-check",
      "stopped:already-built",
      "stopped:check-disagreement",
      "stopped:checks-tampered",
      "stopped:could-not-grade",
    ] as const;
    labels.forEach((label, i) => {
      appendReworkRecord(
        input({ issueNumber: 100 + i, stopReason: { label } }),
        { path },
      );
    });
    const { records } = readReworkRecords({ path });
    expect(records).toHaveLength(5);
    const seenLabels = records.map((r) => r.stopReason?.label);
    // Reading back off DISK: five records, five DISTINCT labels — not the
    // in-memory `labels` array, the actual parsed store.
    expect(new Set(seenLabels).size).toBe(5);
    expect(new Set(seenLabels)).toEqual(new Set(labels));
  });

  it("a check-disagreement record carries both sides of the disagreement on disk", () => {
    appendReworkRecord(
      input({
        stopReason: {
          label: "stopped:check-disagreement",
          detail: "checks still failed after the retry ladder",
          disagreement: {
            checkDemanded: "team total = sum(agents)",
            builderProduced: "3 files, 40 lines changed",
            builderAccount: "reviewer certified ALL_CLEAR on critique-retry",
          },
        },
      }),
      { path },
    );
    const raw = rawLine();
    expect(raw.stopReason).toEqual({
      label: "stopped:check-disagreement",
      detail: "checks still failed after the retry ladder",
      disagreement: {
        checkDemanded: "team total = sum(agents)",
        builderProduced: "3 files, 40 lines changed",
        builderAccount: "reviewer certified ALL_CLEAR on critique-retry",
      },
    });
    // No resolution written — nobody inside the loop is allowed to say who
    // was wrong. Proven off the RAW bytes, not the schema default.
    expect(raw.stopReason).not.toHaveProperty("resolution");
    expect(
      (raw.stopReason as { disagreement: object }).disagreement,
    ).not.toHaveProperty("resolution");

    const { records } = readReworkRecords({ path });
    expect(records[0]!.stopReason?.disagreement?.checkDemanded).toBe(
      "team total = sum(agents)",
    );
  });

  it("a verdict smuggled in is dropped on the way to disk — its only home is the ticket", () => {
    // Owner ruling 12 (issue #1117). This file is committed to git, so a
    // verdict here would need a branch and a pull request every time. The
    // rule is enforced by the validator, not by a comment asking nicely.
    appendReworkRecord(
      input({
        stopReason: {
          label: "stopped:check-disagreement",
          disagreement: { resolution: "checks-wrong" },
        },
      } as never),
      { path },
    );
    const { records } = readReworkRecords({ path });
    expect(records[0]!.stopReason?.disagreement).toBeUndefined();
  });

  it("is absent (not written as a default) for a record that did not stop for one of these five reasons", () => {
    appendReworkRecord(input(), { path });
    expect(rawLine()).not.toHaveProperty("stopReason");
  });

  it("drops the whole record on an out-of-enum label rather than writing a lie", () => {
    appendReworkRecord(
      input({ stopReason: { label: "stopped:something-invented" as never } }),
      { path },
    );
    expect(rawLine()).not.toHaveProperty("stopReason");
  });

  it("does not corrupt sibling fields (checksTamperCount) when stopReason is malformed", () => {
    appendReworkRecord(
      input({
        checksTamperCount: 2,
        stopReason: { label: "not-a-real-label" } as never,
      }),
      { path },
    );
    const raw = rawLine();
    expect(raw.checksTamperCount).toBe(2);
    expect(raw).not.toHaveProperty("stopReason");
  });

  it("stopReason and screenCheck are two distinct fields on disk, never merged into one", () => {
    appendReworkRecord(
      input({
        stopReason: { label: "stopped:could-not-grade" },
        screenCheck: {
          verdict: "never-settled",
          whenIso: "2026-08-04T13:00:00.000Z",
          rerun: false,
          pictureStored: false,
        },
      }),
      { path },
    );
    const raw = rawLine();
    expect(raw).toHaveProperty("stopReason");
    expect(raw).toHaveProperty("screenCheck");
    expect(raw.stopReason).not.toEqual(raw.screenCheck);
  });
});
