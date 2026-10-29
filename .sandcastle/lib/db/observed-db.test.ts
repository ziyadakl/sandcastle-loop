import { describe, expect, it } from "vitest";

import {
  OBSERVED_DB_SENTINEL,
  WrongTestDatabaseError,
  compareObservedDatabase,
  enforceObservedDatabase,
  parseObservedDatabases,
} from "./observed-db.js";

describe("parseObservedDatabases", () => {
  it("pulls the announced database name out of a run's stdout", () => {
    const out = [
      "some playwright preamble",
      `${OBSERVED_DB_SENTINEL}sc_job_agent_issue_1015_1369501_fhgbht`,
      "1 passed (52.1s)",
    ].join("\n");
    expect(parseObservedDatabases(out)).toEqual([
      "sc_job_agent_issue_1015_1369501_fhgbht",
    ]);
  });

  it("de-dupes repeated announcements but keeps first-seen order", () => {
    const out = [
      `${OBSERVED_DB_SENTINEL}postgres`,
      `${OBSERVED_DB_SENTINEL}sc_job_x_1_a`,
      `${OBSERVED_DB_SENTINEL}postgres`,
    ].join("\n");
    expect(parseObservedDatabases(out)).toEqual(["postgres", "sc_job_x_1_a"]);
  });

  it("returns [] when the run announced nothing", () => {
    expect(parseObservedDatabases("1 passed (3s)")).toEqual([]);
    expect(parseObservedDatabases("")).toEqual([]);
    expect(parseObservedDatabases(null)).toEqual([]);
  });
});

describe("compareObservedDatabase", () => {
  const CLONE = "sc_job_agent_issue_1015_1369501_fhgbht";

  it("matches when the only announced db is the expected clone", () => {
    expect(
      compareObservedDatabase({ expected: CLONE, observed: [CLONE] }),
    ).toEqual({ kind: "match", expected: CLONE, observed: [CLONE] });
  });

  it("rejects the #1015 shape: run resolved to plain `postgres`", () => {
    const cmp = compareObservedDatabase({
      expected: CLONE,
      observed: ["postgres"],
    });
    expect(cmp.kind).toBe("mismatch");
    if (cmp.kind === "mismatch") {
      expect(cmp.unexpected).toEqual(["postgres"]);
    }
  });

  it("rejects even when the clone was ALSO touched (both databases seen)", () => {
    const cmp = compareObservedDatabase({
      expected: CLONE,
      observed: [CLONE, "postgres"],
    });
    expect(cmp.kind).toBe("mismatch");
    if (cmp.kind === "mismatch") {
      expect(cmp.unexpected).toEqual(["postgres"]);
    }
  });

  it("reports no-observation when nothing was announced (not a pass)", () => {
    expect(
      compareObservedDatabase({ expected: CLONE, observed: [] }),
    ).toEqual({ kind: "no-observation", expected: CLONE });
  });
});

describe("WrongTestDatabaseError", () => {
  it("flags the shared-database (#1015) case as the dangerous one", () => {
    const err = new WrongTestDatabaseError({
      kind: "mismatch",
      expected: "sc_job_x_1_a",
      unexpected: ["postgres"],
    });
    expect(err.name).toBe("WrongTestDatabaseError");
    expect(err.reasonKind).toBe("mismatch");
    expect(err.message).toContain("WRONG_TEST_DATABASE");
    expect(err.message).toContain("postgres");
    expect(err.message).toContain("sc_job_x_1_a");
    // "postgres" is not a job clone → shared-database warning present.
    expect(err.message).toContain("SHARED database");
  });

  it("omits the shared-database warning when the wrong db is itself a clone", () => {
    const err = new WrongTestDatabaseError({
      kind: "mismatch",
      expected: "sc_job_x_1_a",
      unexpected: ["sc_job_other_2_b"],
    });
    expect(err.message).not.toContain("SHARED database");
  });

  it("has a distinct no-observation shape that fails closed", () => {
    const err = new WrongTestDatabaseError({
      kind: "no-observation",
      expected: "sc_job_x_1_a",
    });
    expect(err.reasonKind).toBe("no-observation");
    expect(err.unexpected).toEqual([]);
    expect(err.message).toContain("failing closed");
    expect(err.message).toContain(OBSERVED_DB_SENTINEL);
  });
});

describe("enforceObservedDatabase", () => {
  const CLONE = "sc_job_x_1_a";

  it("skips when no clone was minted (escape hatch / test double)", () => {
    expect(
      enforceObservedDatabase({
        expected: null,
        observed: ["postgres"],
        checkEmitsObservation: true,
        e2eDefinitelyRan: true,
      }),
    ).toBeNull();
  });

  it("skips a unit check that emits no observation", () => {
    expect(
      enforceObservedDatabase({
        expected: CLONE,
        observed: [],
        checkEmitsObservation: false,
        e2eDefinitelyRan: true,
      }),
    ).toBeNull();
  });

  it("errors on a mismatch regardless of e2eDefinitelyRan", () => {
    const err = enforceObservedDatabase({
      expected: CLONE,
      observed: ["postgres"],
      checkEmitsObservation: true,
      e2eDefinitelyRan: false,
    });
    expect(err?.reasonKind).toBe("mismatch");
  });

  it("FAILS CLOSED on no-observation when an e2e definitely ran (the reviewer's blocker)", () => {
    const err = enforceObservedDatabase({
      expected: CLONE,
      observed: [],
      checkEmitsObservation: true,
      e2eDefinitelyRan: true,
    });
    expect(err).not.toBeNull();
    expect(err?.reasonKind).toBe("no-observation");
  });

  it("stays green on no-observation when no e2e was owed (backend-only)", () => {
    expect(
      enforceObservedDatabase({
        expected: CLONE,
        observed: [],
        checkEmitsObservation: true,
        e2eDefinitelyRan: false,
      }),
    ).toBeNull();
  });

  it("stays green when the only observed db IS the clone", () => {
    expect(
      enforceObservedDatabase({
        expected: CLONE,
        observed: [CLONE],
        checkEmitsObservation: true,
        e2eDefinitelyRan: true,
      }),
    ).toBeNull();
  });
});
