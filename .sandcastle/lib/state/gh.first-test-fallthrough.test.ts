/**
 * #1198 A — the two GitHub writes the first-test fall-through owns.
 *
 * `applyFirstTestFallThroughReport` puts the diagnosis on the issue BODY with
 * NO stop label; `markShippedWithoutFirstTest` adds the one label, at the ship
 * moment, and touches nothing else. `runGh` is injected so these run with no
 * real `gh` process.
 */
import { describe, expect, it, vi } from "vitest";

import {
  FIRST_TEST_FALLTHROUGH_SECTION_END,
  FIRST_TEST_FALLTHROUGH_SECTION_START,
} from "./first-test-fallthrough.js";
import {
  applyFirstTestFallThroughReport,
  ensureShippedWithoutFirstTestLabelExists,
  LABEL_SHIPPED_WITHOUT_FIRST_TEST,
  markShippedWithoutFirstTest,
  SHIPPED_WITHOUT_FIRST_TEST_LABEL_DEFINITION,
  STATUS_LABELS,
} from "./gh.js";

const NOW = new Date("2026-09-02T09:00:00.000Z");

describe("applyFirstTestFallThroughReport — a body write, never a stop", () => {
  it("fetches the body, appends the marked section, writes it back with --body (not --comment)", async () => {
    const calls: string[][] = [];
    const runGh = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "issue" && args[1] === "view") {
        return { stdout: "Original ticket description.\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const result = await applyFirstTestFallThroughReport(
      42,
      { reason: "no-failing-check", detail: "the check agrees with everything" },
      { runGh, now: NOW },
    );

    expect(result).toBe("applied");
    const editCall = calls.find((c) => c[0] === "issue" && c[1] === "edit");
    expect(editCall).toBeDefined();
    expect(editCall).toContain("--body");
    expect(editCall).not.toContain("--comment");
    const body = editCall![editCall!.indexOf("--body") + 1]!;
    expect(body).toContain("Original ticket description.");
    expect(body).toContain("the check agrees with everything");
    expect(body).toContain(FIRST_TEST_FALLTHROUGH_SECTION_START);
    expect(body).toContain(FIRST_TEST_FALLTHROUGH_SECTION_END);
    expect(calls.some((c) => c[0] === "issue" && c[1] === "comment")).toBe(
      false,
    );
  });

  it("adds NO label at all — the ticket is being BUILT, not held", async () => {
    // THE POINT OF THE WHOLE TICKET. A `stopped:*` label here is what every
    // triage query, the planner's `Blocked-by:` reasoning and the run report
    // read as "this one is parked" — on a ticket that is about to have a
    // builder dispatched on it.
    const calls: string[][] = [];
    const runGh = vi.fn(async (args: string[]) => {
      calls.push(args);
      return { stdout: "", stderr: "" };
    });
    await applyFirstTestFallThroughReport(
      1,
      { reason: "run-fault", detail: "the sandbox never answered" },
      { runGh, now: NOW },
    );
    expect(calls.flat()).not.toContain("--add-label");
    expect(calls.flat()).not.toContain("--remove-label");
  });

  it("leaves the rest of the body byte-identical outside the new section", async () => {
    const originalBody =
      "# Ticket title\n\nSome human-written acceptance criteria.\n\n- one\n- two";
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

    await applyFirstTestFallThroughReport(
      7,
      { reason: "no-failing-check", detail: "it went green on day one" },
      { runGh, now: NOW },
    );

    expect(storedBody.startsWith(`${originalBody}\n\n`)).toBe(true);
    expect(storedBody.endsWith(FIRST_TEST_FALLTHROUGH_SECTION_END)).toBe(true);
  });

  it("REWRITES on a changed diagnosis — the latest reason is the true one", async () => {
    // Not a one-shot latch: this is a DIAGNOSIS, so a ticket that fell
    // through on a wedged sandbox last night and on a check that could not
    // fail tonight must say `no-failing-check`, not keep a stale sentence
    // about a sandbox that has since been fixed.
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

    const first = await applyFirstTestFallThroughReport(
      7,
      { reason: "run-fault", detail: "the database was unreachable" },
      { runGh, now: NOW },
    );
    expect(first).toBe("applied");
    expect(editCalls).toBe(1);

    const second = await applyFirstTestFallThroughReport(
      7,
      { reason: "no-failing-check", detail: "the check agrees with everything" },
      { runGh, now: NOW },
    );
    expect(second).toBe("applied");
    expect(editCalls).toBe(2);
    expect(storedBody).toContain("the check agrees with everything");
    expect(storedBody).not.toContain("the database was unreachable");
    // Exactly ONE section on the body — the second write replaced the first
    // in place rather than appending a second copy.
    expect(storedBody.split(FIRST_TEST_FALLTHROUGH_SECTION_START)).toHaveLength(
      2,
    );
    // And the human half is untouched by either write.
    expect(storedBody).toContain("Human-written ticket text.");
  });

  it("an IDENTICAL diagnosis returns already-present and makes no second write", async () => {
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

    const f = { reason: "no-failing-check" as const, detail: "same words" };
    await applyFirstTestFallThroughReport(7, f, { runGh, now: NOW });
    expect(editCalls).toBe(1);
    const after = storedBody;

    const second = await applyFirstTestFallThroughReport(7, f, {
      runGh,
      now: NOW,
    });
    expect(second).toBe("already-present");
    expect(editCalls).toBe(1);
    expect(storedBody).toBe(after);
  });

  it("rejects an invalid issue number without calling gh at all", async () => {
    const runGh = vi.fn();
    await expect(
      applyFirstTestFallThroughReport(
        0,
        { reason: "no-failing-check", detail: "x" },
        { runGh },
      ),
    ).rejects.toThrow(/invalid issueNum/);
    expect(runGh).not.toHaveBeenCalled();
  });

  it("lets a gh failure propagate — the caller owns the best-effort swallow", async () => {
    // `buildAnywayWithoutFirstTest` catches this and logs. It must NOT be
    // swallowed here: a writer that silently reports success is a writer
    // nobody can tell apart from one that worked.
    const runGh = vi.fn(async () => {
      throw new Error("HTTP 503");
    });
    await expect(
      applyFirstTestFallThroughReport(
        9,
        { reason: "run-fault", detail: "x" },
        { runGh },
      ),
    ).rejects.toThrow("HTTP 503");
  });
});

describe("markShippedWithoutFirstTest — one additive label, at the ship moment", () => {
  it("adds exactly the label and writes nothing else", async () => {
    const calls: string[][] = [];
    const runGh = vi.fn(async (args: string[]) => {
      calls.push(args);
      return { stdout: "", stderr: "" };
    });
    await markShippedWithoutFirstTest(1234, { runGh });

    expect(calls).toEqual([
      [
        "issue",
        "edit",
        "1234",
        "--add-label",
        LABEL_SHIPPED_WITHOUT_FIRST_TEST,
      ],
    ]);
    // No body write: the diagnosis went on the body hours earlier, and
    // re-fetching a ticket someone may be editing by hand to say something it
    // already says is a clobber risk taken for nothing.
    expect(calls.flat()).not.toContain("--body");
  });

  it("is NOT a status label — so it survives every later wildcard transition", async () => {
    // The property the whole "apply it once, at ship" design rests on.
    // `transitionLabel(n, "*", X)` strips only `STATUS_LABELS`, so this one
    // rides through `in-progress` → `merged-to-staging` → `shipped-local` →
    // `done` untouched. Were it ever added to that list, the label would be
    // stripped by the very next transition and the owner would never see it.
    expect(STATUS_LABELS).not.toContain(LABEL_SHIPPED_WITHOUT_FIRST_TEST);
  });

  it("rejects an invalid issue number without calling gh at all", async () => {
    const runGh = vi.fn();
    await expect(markShippedWithoutFirstTest(-1, { runGh })).rejects.toThrow(
      /invalid issueNum/,
    );
    expect(runGh).not.toHaveBeenCalled();
  });

  it("lets a gh failure propagate — the ship funnel owns the best-effort swallow", async () => {
    const runGh = vi.fn(async () => {
      throw new Error("HTTP 502");
    });
    await expect(markShippedWithoutFirstTest(5, { runGh })).rejects.toThrow(
      "HTTP 502",
    );
  });
});

describe("ensureShippedWithoutFirstTestLabelExists (#1198 review, S4)", () => {
  // WHY IT EXISTS. `markShippedWithoutFirstTest` shells out to
  // `gh issue edit --add-label`, which ERRORS when the label is not in the
  // repository, and its one caller swallows that best-effort. So on any host
  // where nobody created the label by hand, the single owner-visible signal
  // that a merge carried the weaker proof vanished silently and the merge
  // looked exactly like a fully proven one.
  it("creates the label idempotently, the way the check-reading labels are created", async () => {
    const calls: string[][] = [];
    const runGh = vi.fn(async (args: string[]) => {
      calls.push(args);
      return { stdout: "", stderr: "" };
    });
    await ensureShippedWithoutFirstTestLabelExists({ runGh });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 3)).toEqual([
      "label",
      "create",
      LABEL_SHIPPED_WITHOUT_FIRST_TEST,
    ]);
    // `--force` is what makes a second run cheap instead of a 422.
    expect(calls[0]).toContain("--force");
    expect(calls[0]).toContain(
      SHIPPED_WITHOUT_FIRST_TEST_LABEL_DEFINITION.description,
    );
  });

  it("a failure is reported and never thrown — a label problem must not kill the run", async () => {
    const runGh = vi.fn(async () => {
      throw new Error("HTTP 422");
    });
    const failed: string[] = [];
    await expect(
      ensureShippedWithoutFirstTestLabelExists({
        runGh,
        onError: (name) => failed.push(name),
      }),
    ).resolves.toBeUndefined();
    expect(failed).toEqual([LABEL_SHIPPED_WITHOUT_FIRST_TEST]);
  });

  it("the description fits GitHub's 100-character cap, which `gh label create` rejects above", () => {
    const def = SHIPPED_WITHOUT_FIRST_TEST_LABEL_DEFINITION;
    expect(def.description.length).toBeLessThanOrEqual(100);
    expect(def.color).toMatch(/^[0-9A-Fa-f]{6}$/);
  });
});
