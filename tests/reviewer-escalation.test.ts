import { describe, it, expect } from "vitest";
import {
  shouldEscalateReviewer,
  pathMatchesGlob,
  reviewEscalateDiffLinesFromEnv,
  reviewEscalatePathsFromEnv,
  DEFAULT_REVIEW_ESCALATE_DIFF_LINES,
  DEFAULT_REVIEW_ESCALATE_PATHS,
} from "../.sandcastle/lib/review/escalation.js";

const DEFAULTS = {
  diffLineThreshold: DEFAULT_REVIEW_ESCALATE_DIFF_LINES,
  sensitivePathPatterns: DEFAULT_REVIEW_ESCALATE_PATHS,
};

describe("shouldEscalateReviewer", () => {
  it("does NOT escalate a small, ordinary diff (byte-identical default path)", () => {
    expect(
      shouldEscalateReviewer({
        changedLines: 42,
        changedFiles: ["src/components/Button.tsx", "src/lib/util.ts"],
        ...DEFAULTS,
      }),
    ).toBe(false);
  });

  it("escalates when changedLines is at or over the threshold", () => {
    expect(
      shouldEscalateReviewer({
        changedLines: 400,
        changedFiles: ["src/big-refactor.ts"],
        ...DEFAULTS,
      }),
    ).toBe(true);
    expect(
      shouldEscalateReviewer({
        changedLines: 401,
        changedFiles: ["src/big-refactor.ts"],
        ...DEFAULTS,
      }),
    ).toBe(true);
  });

  it("does NOT escalate one line under the threshold with no sensitive path", () => {
    expect(
      shouldEscalateReviewer({
        changedLines: 399,
        changedFiles: ["src/big-refactor.ts"],
        ...DEFAULTS,
      }),
    ).toBe(false);
  });

  it("escalates a small diff that touches a sensitive migration path", () => {
    expect(
      shouldEscalateReviewer({
        changedLines: 12,
        changedFiles: ["packages/db/migrations/0007_add_users.sql"],
        ...DEFAULTS,
      }),
    ).toBe(true);
  });

  it("escalates a small diff that touches a top-level migrations dir", () => {
    expect(
      shouldEscalateReviewer({
        changedLines: 3,
        changedFiles: ["migrations/0001_init.sql"],
        ...DEFAULTS,
      }),
    ).toBe(true);
  });

  it("escalates a small diff touching a nested .sql file via basename match", () => {
    expect(
      shouldEscalateReviewer({
        changedLines: 5,
        changedFiles: ["db/schema.sql"],
        ...DEFAULTS,
      }),
    ).toBe(true);
  });

  it("returns false for an empty/zero change set", () => {
    expect(
      shouldEscalateReviewer({
        changedLines: 0,
        changedFiles: [],
        ...DEFAULTS,
      }),
    ).toBe(false);
  });

  it("a zero/negative threshold disables the line rule (no always-on escalation)", () => {
    expect(
      shouldEscalateReviewer({
        changedLines: 0,
        changedFiles: ["src/app.ts"],
        diffLineThreshold: 0,
        sensitivePathPatterns: DEFAULT_REVIEW_ESCALATE_PATHS,
      }),
    ).toBe(false);
  });

  it("with no sensitive patterns, only the line threshold can escalate", () => {
    expect(
      shouldEscalateReviewer({
        changedLines: 8,
        changedFiles: ["packages/db/migrations/0007.sql"],
        diffLineThreshold: DEFAULT_REVIEW_ESCALATE_DIFF_LINES,
        sensitivePathPatterns: [],
      }),
    ).toBe(false);
  });
});

describe("pathMatchesGlob", () => {
  it("matches a **/x/** dir glob at any depth including top level", () => {
    expect(pathMatchesGlob("a/b/migrations/c.sql", "**/migrations/**")).toBe(true);
    expect(pathMatchesGlob("migrations/c.sql", "**/migrations/**")).toBe(true);
    expect(pathMatchesGlob("src/migrations", "**/migrations/**")).toBe(true);
  });

  it("does not match an unrelated path", () => {
    expect(pathMatchesGlob("src/components/Button.tsx", "**/migrations/**")).toBe(false);
    expect(pathMatchesGlob("src/notes.md", "*.sql")).toBe(false);
  });

  it("*.sql matches a top-level and (via basename) a nested .sql file", () => {
    expect(pathMatchesGlob("schema.sql", "*.sql")).toBe(true);
    expect(pathMatchesGlob("db/schema.sql", "*.sql")).toBe(true);
  });

  it("* does not cross a path separator", () => {
    expect(pathMatchesGlob("a/b.ts", "*.ts")).toBe(true); // basename fallback
    expect(pathMatchesGlob("a/b.ts", "a/*.ts")).toBe(true);
    expect(pathMatchesGlob("a/b/c.ts", "a/*.ts")).toBe(false);
  });
});

describe("reviewEscalateDiffLinesFromEnv", () => {
  it("defaults to 400 when unset or blank", () => {
    expect(reviewEscalateDiffLinesFromEnv(() => undefined)).toBe(400);
    expect(reviewEscalateDiffLinesFromEnv(() => "   ")).toBe(400);
  });

  it("honors a positive integer", () => {
    expect(
      reviewEscalateDiffLinesFromEnv((k) =>
        k === "SANDCASTLE_REVIEW_ESCALATE_DIFF_LINES" ? "150" : undefined,
      ),
    ).toBe(150);
  });

  it("falls back to the default on non-integer / non-positive values", () => {
    expect(reviewEscalateDiffLinesFromEnv(() => "abc")).toBe(400);
    expect(reviewEscalateDiffLinesFromEnv(() => "0")).toBe(400);
    expect(reviewEscalateDiffLinesFromEnv(() => "-5")).toBe(400);
    expect(reviewEscalateDiffLinesFromEnv(() => "12.5")).toBe(400);
  });
});

describe("reviewEscalatePathsFromEnv", () => {
  it("defaults to the migration globs when unset or blank", () => {
    expect(reviewEscalatePathsFromEnv(() => undefined)).toEqual([
      "**/migrations/**",
      "*.sql",
    ]);
    expect(reviewEscalatePathsFromEnv(() => "  ")).toEqual([
      "**/migrations/**",
      "*.sql",
    ]);
  });

  it("parses a comma-separated list, trimming and dropping empties", () => {
    expect(
      reviewEscalatePathsFromEnv((k) =>
        k === "SANDCASTLE_REVIEW_ESCALATE_PATHS"
          ? " **/auth/** , *.env ,, "
          : undefined,
      ),
    ).toEqual(["**/auth/**", "*.env"]);
  });
});
