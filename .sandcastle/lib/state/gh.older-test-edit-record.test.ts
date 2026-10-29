/**
 * #1271 — the three GitHub writers of the sibling-check repair road:
 *
 *  - `applyOlderTestEditRecord` writes the amendment record onto the OLDER
 *    ticket's body (and adds no label — this is a record, not a stop);
 *  - `markShippedWithOlderTestEdit` puts the one visible label onto the
 *    ticket that was BUILT, at the ship moment;
 *  - `ensureShippedWithOlderTestEditLabelExists` creates that label at
 *    run start, because `--add-label` ERRORS on a label the repo lacks and
 *    its caller swallows that error best-effort.
 *
 * `runGh` is injected throughout, so these run with no real `gh` process.
 */
import { describe, expect, it, vi } from "vitest";

import {
  LABEL_SHIPPED_WITH_OLDER_TEST_EDIT,
  SHIPPED_WITH_OLDER_TEST_EDIT_LABEL_DEFINITION,
  STATUS_LABELS,
  applyOlderTestEditRecord,
  ensureShippedWithOlderTestEditLabelExists,
  markShippedWithOlderTestEdit,
} from "./gh.js";
import { olderTestEditMarkers } from "./older-test-edit-record.js";

describe("applyOlderTestEditRecord — the record on the OLDER ticket's body", () => {
  it("fetches the body, appends the section, writes it back with --body (not --comment)", async () => {
    const calls: string[][] = [];
    const runGh = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "issue" && args[1] === "view") {
        return { stdout: "Original ticket description.\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const result = await applyOlderTestEditRecord(
      1058,
      1235,
      "## An older check here was amended by the loop",
      { runGh },
    );

    expect(result).toBe("applied");
    // The fetch and the write both target the SIBLING, never the amender.
    expect(calls.every((c) => !c.includes("1235"))).toBe(true);
    const editCall = calls.find((c) => c[0] === "issue" && c[1] === "edit");
    expect(editCall).toBeDefined();
    expect(editCall![2]).toBe("1058");
    expect(editCall).toContain("--body");
    expect(editCall).not.toContain("--comment");
    const bodyIdx = editCall!.indexOf("--body") + 1;
    expect(editCall![bodyIdx]).toContain("Original ticket description.");
    expect(editCall![bodyIdx]).toContain(
      "## An older check here was amended by the loop",
    );

    expect(calls.some((c) => c[0] === "issue" && c[1] === "comment")).toBe(false);
  });

  it("adds NO label to the sibling — its ticket is not being reopened or held", async () => {
    const calls: string[][] = [];
    const runGh = vi.fn(async (args: string[]) => {
      calls.push(args);
      return { stdout: "", stderr: "" };
    });
    await applyOlderTestEditRecord(1058, 1235, "section text", { runGh });
    expect(calls.flat()).not.toContain("--add-label");
  });

  it("leaves the rest of the body byte-identical outside the new section", async () => {
    const originalBody =
      "# Cross-Team relist guard\n\nSome human-written acceptance criteria.\n\n- one\n- two";
    let storedBody = originalBody;
    const runGh = vi.fn(async (args: string[]) => {
      if (args[0] === "issue" && args[1] === "view") {
        return { stdout: `${storedBody}\n`, stderr: "" };
      }
      if (args[0] === "issue" && args[1] === "edit") {
        storedBody = args[args.indexOf("--body") + 1]!;
      }
      return { stdout: "", stderr: "" };
    });

    await applyOlderTestEditRecord(1058, 1235, "the amendment content", {
      runGh,
    });

    const { start, end } = olderTestEditMarkers(1235);
    expect(storedBody).toBe(
      `${originalBody}\n\n${start}\nthe amendment content\n${end}`,
    );
  });

  it("the SAME amender twice returns already-present and makes no second write", async () => {
    // The durable, cross-run half of the one-shot latch: a ticket rebuilt
    // after a restart must not stack a second identical section onto the
    // sibling's body.
    let storedBody = "Human-written ticket text.";
    let editCalls = 0;
    const runGh = vi.fn(async (args: string[]) => {
      if (args[0] === "issue" && args[1] === "view") {
        return { stdout: `${storedBody}\n`, stderr: "" };
      }
      if (args[0] === "issue" && args[1] === "edit") {
        editCalls += 1;
        storedBody = args[args.indexOf("--body") + 1]!;
      }
      return { stdout: "", stderr: "" };
    });

    expect(
      await applyOlderTestEditRecord(1058, 1235, "first content", { runGh }),
    ).toBe("applied");
    expect(editCalls).toBe(1);

    const bodyAfterFirst = storedBody;
    expect(
      await applyOlderTestEditRecord(1058, 1235, "second content", { runGh }),
    ).toBe("already-present");
    expect(editCalls).toBe(1);
    expect(storedBody).toBe(bodyAfterFirst);
    expect(storedBody).not.toContain("second content");
  });

  it("a DIFFERENT amender gets its own section — one older ticket can be amended twice", async () => {
    // The whole reason the markers carry the amending issue's number. Under a
    // single fixed marker pair the second amender would either overwrite the
    // first's record or, behind the latch above, never write at all.
    let storedBody = "Human-written ticket text.";
    const runGh = vi.fn(async (args: string[]) => {
      if (args[0] === "issue" && args[1] === "view") {
        return { stdout: `${storedBody}\n`, stderr: "" };
      }
      if (args[0] === "issue" && args[1] === "edit") {
        storedBody = args[args.indexOf("--body") + 1]!;
      }
      return { stdout: "", stderr: "" };
    });

    expect(
      await applyOlderTestEditRecord(1058, 1235, "amended by 1235", { runGh }),
    ).toBe("applied");
    expect(
      await applyOlderTestEditRecord(1058, 1299, "amended by 1299", { runGh }),
    ).toBe("applied");

    expect(storedBody).toContain("amended by 1235");
    expect(storedBody).toContain("amended by 1299");
    expect(storedBody).toContain(olderTestEditMarkers(1235).start);
    expect(storedBody).toContain(olderTestEditMarkers(1299).start);
    expect(storedBody).toContain("Human-written ticket text.");
  });

  it("rejects an invalid sibling issue number without calling gh at all", async () => {
    const runGh = vi.fn();
    await expect(
      applyOlderTestEditRecord(0, 1235, "x", { runGh }),
    ).rejects.toThrow(/invalid issueNum/);
    expect(runGh).not.toHaveBeenCalled();
  });

  it("rejects an invalid amender number without calling gh at all", async () => {
    // The amender's number is not decoration: it goes into the marker pair,
    // so a garbage value would mint a marker nothing can ever match again and
    // the latch would re-append on every run.
    const runGh = vi.fn();
    await expect(
      applyOlderTestEditRecord(1058, -3, "x", { runGh }),
    ).rejects.toThrow(/invalid amendedByIssue/);
    expect(runGh).not.toHaveBeenCalled();
  });

  it("lets a gh failure propagate — the ship funnel owns the best-effort swallow", async () => {
    const runGh = vi.fn(async () => {
      throw new Error("HTTP 503");
    });
    await expect(
      applyOlderTestEditRecord(1058, 1235, "x", { runGh }),
    ).rejects.toThrow("HTTP 503");
  });
});

describe("markShippedWithOlderTestEdit — one additive label, at the ship moment", () => {
  it("adds exactly the label and writes nothing else", async () => {
    const calls: string[][] = [];
    const runGh = vi.fn(async (args: string[]) => {
      calls.push(args);
      return { stdout: "", stderr: "" };
    });
    await markShippedWithOlderTestEdit(1235, { runGh });

    expect(calls).toEqual([
      [
        "issue",
        "edit",
        "1235",
        "--add-label",
        LABEL_SHIPPED_WITH_OLDER_TEST_EDIT,
      ],
    ]);
    // No body write: the record went onto the SIBLING's body, and this
    // ticket's own body has nothing to gain from a re-fetch-and-rewrite.
    expect(calls.flat()).not.toContain("--body");
  });

  it("is NOT a status label — so it survives every later wildcard transition", async () => {
    // `transitionLabel(n, "*", X)` strips only `STATUS_LABELS`, so this rides
    // through `in-progress` → `merged-to-staging` → `shipped-local` → `done`
    // untouched. In that list it would be stripped by the very next
    // transition and the owner would never see it.
    expect(STATUS_LABELS).not.toContain(
      LABEL_SHIPPED_WITH_OLDER_TEST_EDIT,
    );
  });

  it("rejects an invalid issue number without calling gh at all", async () => {
    const runGh = vi.fn();
    await expect(
      markShippedWithOlderTestEdit(-1, { runGh }),
    ).rejects.toThrow(/invalid issueNum/);
    expect(runGh).not.toHaveBeenCalled();
  });

  it("lets a gh failure propagate — the ship funnel owns the best-effort swallow", async () => {
    const runGh = vi.fn(async () => {
      throw new Error("HTTP 502");
    });
    await expect(
      markShippedWithOlderTestEdit(5, { runGh }),
    ).rejects.toThrow("HTTP 502");
  });
});

describe("ensureShippedWithOlderTestEditLabelExists", () => {
  it("creates the label idempotently, the way every other loop label is created", async () => {
    const calls: string[][] = [];
    const runGh = vi.fn(async (args: string[]) => {
      calls.push(args);
      return { stdout: "", stderr: "" };
    });
    await ensureShippedWithOlderTestEditLabelExists({ runGh });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 3)).toEqual([
      "label",
      "create",
      LABEL_SHIPPED_WITH_OLDER_TEST_EDIT,
    ]);
    // `--force` is what makes a second run cheap instead of a 422.
    expect(calls[0]).toContain("--force");
    expect(calls[0]).toContain(
      SHIPPED_WITH_OLDER_TEST_EDIT_LABEL_DEFINITION.description,
    );
  });

  it("a failure is reported and never thrown — a label problem must not kill the run", async () => {
    const runGh = vi.fn(async () => {
      throw new Error("HTTP 422");
    });
    const failed: string[] = [];
    await expect(
      ensureShippedWithOlderTestEditLabelExists({
        runGh,
        onError: (name) => failed.push(name),
      }),
    ).resolves.toBeUndefined();
    expect(failed).toEqual([LABEL_SHIPPED_WITH_OLDER_TEST_EDIT]);
  });

  it("the description fits GitHub's 100-character cap, which `gh label create` rejects above", () => {
    const def = SHIPPED_WITH_OLDER_TEST_EDIT_LABEL_DEFINITION;
    expect(def.description.length).toBeLessThanOrEqual(100);
    expect(def.color).toMatch(/^[0-9A-Fa-f]{6}$/);
  });
});
