/**
 * Tests for run identity capture.
 *
 * The motivating failure: on the 2026-07-31 run `.last-run-mode` claimed
 * `opus-4.8` while the log proved `budgetModels` actually ran, which made a
 * $297 run incomparable to its successor. So the two things under test here are
 * (a) the ladder resolves each label from the run's own inputs (never from a
 * written-down mode file), and (b) the RESOLVED role map travels with the
 * label, which is what makes a mislabeled profile self-detecting.
 *
 * SCOPE — this file does NOT verify parity with `roleModelsFor`. It asserts
 * against the `models.js` maps directly and never imports `main.mts`, so a
 * precedence change in `roleModelsFor` would leave every test here green while
 * the recorded profile disagreed with the models actually dispatched. That
 * comparison lives in `main.test.mts` ("run-identity profile ladder mirrors
 * roleModelsFor"), which can import `main.mts` without risking a cycle.
 *
 * Everything is param/dep-injected — no filesystem, no timers.
 */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { budgetModels, codexModels, models, opus5Models } from "../../models.js";
import { RunIdentitySchema } from "../status/schema.js";
import { PROMPT_FILES, resolveRunIdentity } from "./run-identity.js";

/** A reader that returns fixed content per basename, `""` for anything else. */
function readerFor(contents: Record<string, string>) {
  return vi.fn((abs: string): string => {
    const base = abs.split("/").pop() ?? abs;
    const hit = contents[base];
    if (hit === undefined) throw new Error(`ENOENT: ${abs}`);
    return hit;
  });
}

const throwingReader = vi.fn((): string => {
  throw new Error("EACCES");
});

const shortSha = (s: string) =>
  createHash("sha256").update(s).digest("hex").slice(0, 12);

describe("resolveRunIdentity — profile precedence ladder", () => {
  it("codex backend wins over budget and opus5", () => {
    expect(
      resolveRunIdentity(
        { backend: "codex", budget: true, opusProfile: "5" },
        { readFile: throwingReader },
      ).profile,
    ).toBe("codex");
  });

  it("budget wins over opus5", () => {
    expect(
      resolveRunIdentity(
        { budget: true, opusProfile: "5" },
        { readFile: throwingReader },
      ).profile,
    ).toBe("budget");
  });

  it("opus5 when neither codex nor budget", () => {
    expect(
      resolveRunIdentity(
        { backend: "claude", opusProfile: "5" },
        { readFile: throwingReader },
      ).profile,
    ).toBe("opus5");
  });

  it("default with no selectors at all", () => {
    expect(resolveRunIdentity({}, { readFile: throwingReader }).profile).toBe(
      "default",
    );
  });

  it("opusProfile 5.5 is the default profile, not opus5", () => {
    expect(
      resolveRunIdentity({ opusProfile: "5.5" }, { readFile: throwingReader })
        .profile,
    ).toBe("default");
  });

  it("budget: false does not select the budget profile", () => {
    expect(
      resolveRunIdentity({ budget: false }, { readFile: throwingReader })
        .profile,
    ).toBe("default");
  });
});

describe("resolveRunIdentity — resolved roleModels", () => {
  const cases = [
    { args: {}, map: models, label: "default" },
    { args: { opusProfile: "5" as const }, map: opus5Models, label: "opus5" },
    { args: { budget: true }, map: budgetModels, label: "budget" },
    { args: { backend: "codex" as const }, map: codexModels, label: "codex" },
  ];

  for (const { args, map, label } of cases) {
    it(`${label} records the real map from models.ts`, () => {
      const id = resolveRunIdentity(args, { readFile: throwingReader });
      expect(id.profile).toBe(label);
      expect(id.roleModels).toEqual(
        Object.fromEntries(
          Object.entries(map).map(([role, cfg]) => [
            role,
            { default: cfg.default, escalations: [...cfg.escalations] },
          ]),
        ),
      );
    });
  }

  it("budget's implementer is the Sonnet-first three-rung ladder", () => {
    const id = resolveRunIdentity({ budget: true }, { readFile: throwingReader });
    expect(id.roleModels.implementer).toEqual({
      default: "claude-sonnet-5",
      escalations: ["claude-sonnet-5", "claude-opus-5-5"],
    });
    // The 07-31 tell: budget is the only profile whose post-merge fixer is
    // Sonnet. If this desyncs from models.ts, the run label lies again.
    expect(id.roleModels.postMergeFixer?.default).toBe("claude-sonnet-5");
  });

  it("returns a deep copy — mutating the result cannot corrupt models.ts", () => {
    const id = resolveRunIdentity({}, { readFile: throwingReader });
    id.roleModels.implementer!.escalations.push("tampered");
    id.roleModels.implementer!.default = "tampered";
    expect(models.implementer.default).toBe("claude-opus-5-5");
    expect(models.implementer.escalations).not.toContain("tampered");
    expect(
      resolveRunIdentity({}, { readFile: throwingReader }).roleModels
        .implementer,
    ).toEqual({
      default: "claude-opus-5-5",
      escalations: ["claude-opus-5-5", "claude-opus-5-5"],
    });
  });
});

describe("resolveRunIdentity — backend and provider passthrough", () => {
  it("records backend and provider when given", () => {
    const id = resolveRunIdentity(
      { backend: "claude", provider: "kimi" },
      { readFile: throwingReader },
    );
    expect(id.backend).toBe("claude");
    expect(id.provider).toBe("kimi");
    // provider is a separate axis: it leaves the model map untouched.
    expect(id.profile).toBe("default");
    expect(id.roleModels.implementer?.default).toBe(models.implementer.default);
  });

  it("omits backend/provider rather than inventing one", () => {
    const id = resolveRunIdentity({}, { readFile: throwingReader });
    expect(id.backend).toBeUndefined();
    expect(id.provider).toBeUndefined();
  });
});

describe("resolveRunIdentity — prompt hashes", () => {
  const allPrompts = (body: string) =>
    Object.fromEntries(PROMPT_FILES.map((f) => [f, body]));

  it("hashes all five prompt files, keyed by bare basename", () => {
    const id = resolveRunIdentity(
      {},
      { readFile: readerFor(allPrompts("hello")), sandcastleDir: "/repo/.sandcastle" },
    );
    expect(Object.keys(id.promptHashes ?? {}).sort()).toEqual(
      [...PROMPT_FILES].sort(),
    );
    // Seven since 2026-09-03: `plan-prompt.md` is gone, because the planner
    // is code (`planDeterministic`, `lib/state/eligible-set.ts`) and a run's
    // cost can no longer be shifted by editing a planner prompt. Six since
    // spec #1334: `critique-prompt.md` is gone, folded into the reviewer. Five
    // since spec #1334 SG: `recovery-prompt.md` is gone — the fixer runs the
    // builder's own `implement-prompt.md`.
    expect(PROMPT_FILES).toHaveLength(5);
    for (const f of PROMPT_FILES) {
      expect(id.promptHashes?.[f]).toBe(shortSha("hello"));
      expect(id.promptHashes?.[f]).toHaveLength(12);
    }
  });

  it("reads from the injected sandcastle dir", () => {
    const reader = readerFor(allPrompts("x"));
    resolveRunIdentity({}, { readFile: reader, sandcastleDir: "/repo/.sandcastle" });
    for (const call of reader.mock.calls) {
      expect(call[0].startsWith("/repo/.sandcastle/")).toBe(true);
    }
  });

  it("is deterministic for identical content and differs on a change", () => {
    const a = resolveRunIdentity({}, { readFile: readerFor(allPrompts("same")) });
    const b = resolveRunIdentity({}, { readFile: readerFor(allPrompts("same")) });
    const c = resolveRunIdentity(
      {},
      { readFile: readerFor({ ...allPrompts("same"), "implement-prompt.md": "edited" }) },
    );
    expect(a.promptHashes).toEqual(b.promptHashes);
    expect(c.promptHashes?.["implement-prompt.md"]).not.toBe(
      a.promptHashes?.["implement-prompt.md"],
    );
    expect(c.promptHashes?.["merge-prompt.md"]).toBe(
      a.promptHashes?.["merge-prompt.md"],
    );
  });

  it("a missing file yields an empty hash, and the key still exists", () => {
    const contents = allPrompts("body");
    delete contents["merge-prompt.md"];
    const id = resolveRunIdentity({}, { readFile: readerFor(contents) });
    expect(id.promptHashes).toHaveProperty("merge-prompt.md", "");
    expect(id.promptHashes?.["review-prompt.md"]).toBe(shortSha("body"));
  });

  it("hashes a Buffer identically to the equivalent string", () => {
    const str = resolveRunIdentity({}, { readFile: readerFor(allPrompts("bufcheck")) });
    const buf = resolveRunIdentity(
      {},
      { readFile: () => Buffer.from("bufcheck", "utf8") },
    );
    expect(buf.promptHashes?.["implement-prompt.md"]).toBe(
      str.promptHashes?.["implement-prompt.md"],
    );
  });
});

describe("resolveRunIdentity — never-throw contract", () => {
  it("a reader that throws on every file still returns a usable identity", () => {
    const reader = vi.fn(() => {
      throw new Error("disk on fire");
    });
    let id!: ReturnType<typeof resolveRunIdentity>;
    expect(() => {
      id = resolveRunIdentity({ budget: true, provider: "glm" }, { readFile: reader });
    }).not.toThrow();
    expect(id.profile).toBe("budget");
    expect(id.roleModels.implementer?.default).toBe("claude-sonnet-5");
    expect(Object.keys(id.promptHashes ?? {}).sort()).toEqual(
      [...PROMPT_FILES].sort(),
    );
    expect(Object.values(id.promptHashes ?? {})).toEqual(
      PROMPT_FILES.map(() => ""),
    );
    expect(RunIdentitySchema.safeParse(id).success).toBe(true);
  });

  it("survives a reader returning a non-string, non-Buffer value", () => {
    const rogue = (() => undefined) as unknown as (abs: string) => string;
    expect(() => resolveRunIdentity({}, { readFile: rogue })).not.toThrow();
  });
});

describe("resolveRunIdentity — schema round-trip", () => {
  const argSets = [
    {},
    { budget: true },
    { opusProfile: "5" as const },
    { backend: "codex" as const },
    { backend: "claude" as const, provider: "kimi" },
  ];

  for (const [i, args] of argSets.entries()) {
    it(`argset ${i} parses against RunIdentitySchema`, () => {
      const parsed = RunIdentitySchema.safeParse(
        resolveRunIdentity(args, { readFile: readerFor({}) }),
      );
      expect(parsed.success).toBe(true);
    });
  }

  it("uses the real filesystem when no reader is injected", () => {
    const id = resolveRunIdentity({});
    expect(RunIdentitySchema.safeParse(id).success).toBe(true);
    // The eight prompts really are on disk next to main.mts.
    for (const f of PROMPT_FILES) {
      expect(id.promptHashes?.[f]).toHaveLength(12);
    }
  });
});
