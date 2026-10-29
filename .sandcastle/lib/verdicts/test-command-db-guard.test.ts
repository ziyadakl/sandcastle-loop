import { describe, expect, it } from "vitest";

import {
  FORBIDDEN_TEST_DB_ENV_VARS,
  findTestDatabaseUrlOverride,
} from "./test-command-db-guard.js";

describe("findTestDatabaseUrlOverride", () => {
  it("rejects the exact #1015 override command", () => {
    // Verbatim from issue #1025's reproduction of the 2026-08-11 run.
    const cmd =
      'env POSTGRES_URL="$PG_URL" DATABASE_URL="$PG_URL" pnpm --filter @acme/nextjs e2e -- some.spec.ts';
    const hit = findTestDatabaseUrlOverride(cmd);
    expect(hit).not.toBeNull();
    // POSTGRES_URL is the first assignment, so it is the one reported.
    expect(hit?.varName).toBe("POSTGRES_URL");
    expect(hit?.assignment).toBe('POSTGRES_URL="$PG_URL"');
  });

  it("catches a bare (no `env`) POSTGRES_URL assignment", () => {
    const hit = findTestDatabaseUrlOverride('POSTGRES_URL=postgres://x pnpm e2e');
    expect(hit?.varName).toBe("POSTGRES_URL");
  });

  it("catches a DATABASE_URL override even when POSTGRES_URL is absent", () => {
    const hit = findTestDatabaseUrlOverride(
      "env DATABASE_URL='postgres://p:p@localhost/postgres' pnpm test",
    );
    expect(hit?.varName).toBe("DATABASE_URL");
  });

  it("catches an `export` form", () => {
    const hit = findTestDatabaseUrlOverride("export POSTGRES_URL=postgres://x; pnpm e2e");
    expect(hit?.varName).toBe("POSTGRES_URL");
  });

  it("catches an override that appears mid-command after a separator", () => {
    const hit = findTestDatabaseUrlOverride(
      "cd apps/nextjs && POSTGRES_URL=postgres://x pnpm e2e",
    );
    expect(hit?.varName).toBe("POSTGRES_URL");
  });

  it("allows the clean host-exported command (nothing set)", () => {
    expect(
      findTestDatabaseUrlOverride("pnpm --filter @acme/nextjs e2e -- some.spec.ts"),
    ).toBeNull();
  });

  it("does NOT fire on a different variable whose name merely ends in a forbidden one", () => {
    expect(
      findTestDatabaseUrlOverride("MY_POSTGRES_URL=x pnpm e2e"),
    ).toBeNull();
    expect(
      findTestDatabaseUrlOverride("APP_DATABASE_URL=x pnpm e2e"),
    ).toBeNull();
  });

  it("does NOT fire when the forbidden name only appears as a value, not a target", () => {
    // `--db POSTGRES_URL` names the variable but assigns nothing.
    expect(
      findTestDatabaseUrlOverride("pnpm e2e --note POSTGRES_URL"),
    ).toBeNull();
  });

  it("returns null on empty / nullish input", () => {
    expect(findTestDatabaseUrlOverride(null)).toBeNull();
    expect(findTestDatabaseUrlOverride(undefined)).toBeNull();
    expect(findTestDatabaseUrlOverride("")).toBeNull();
  });

  it("keeps the two forbidden names as the documented contract", () => {
    expect([...FORBIDDEN_TEST_DB_ENV_VARS].sort()).toEqual([
      "DATABASE_URL",
      "POSTGRES_URL",
    ]);
  });
});
