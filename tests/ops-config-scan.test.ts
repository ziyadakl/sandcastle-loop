/**
 * Tests for `scanOpsConfig` — the pure deploy-config blind-spot scanner.
 *
 * The sandbox can build and test code but cannot verify out-of-repo deploy
 * config: it never provisions a cron scheduler and never sees the deploy
 * target's secrets. This scanner reads a run's diff and surfaces exactly those
 * two blind spots so a human owner can provision them:
 *   - cron ROUTES that ship in-repo but whose SCHEDULING lives elsewhere, and
 *   - NEW required env vars the code newly reads that must exist as secrets.
 *
 * Seam under test: `scanOpsConfig({ changedFiles, patch })` — a pure function
 * over an already-computed diff (the CLI wrapper owns the git I/O).
 */
import { describe, it, expect } from "vitest";
import { scanOpsConfig } from "../.sandcastle/lib/ops-config/scan.js";

describe("scanOpsConfig", () => {
  it("surfaces an added cron route handler from changedFiles", () => {
    const result = scanOpsConfig({
      changedFiles: ["apps/web/app/api/cron/drain/route.ts"],
      patch: "",
    });
    expect(result.cronRoutes).toContain("apps/web/app/api/cron/drain/route.ts");
  });

  it("surfaces a newly-read required env var from an added patch line", () => {
    const patch = [
      "diff --git a/apps/web/lib/intake.ts b/apps/web/lib/intake.ts",
      "--- a/apps/web/lib/intake.ts",
      "+++ b/apps/web/lib/intake.ts",
      "@@ -1,3 +1,4 @@",
      " export function intake() {",
      "+  const key = process.env.INTAKE_API_KEY;",
      "   return key;",
      " }",
    ].join("\n");
    const result = scanOpsConfig({
      changedFiles: ["apps/web/lib/intake.ts"],
      patch,
    });
    expect(result.newRequiredEnvVars).toContain("INTAKE_API_KEY");
  });

  it("surfaces a cron path added to vercel.json's crons array", () => {
    const patch = [
      "diff --git a/vercel.json b/vercel.json",
      "--- a/vercel.json",
      "+++ b/vercel.json",
      "@@ -1,3 +1,9 @@",
      " {",
      '+  "crons": [',
      '+    { "path": "/api/cron/drain", "schedule": "0 * * * *" }',
      "+  ],",
      '   "version": 2',
      " }",
    ].join("\n");
    const result = scanOpsConfig({
      changedFiles: ["vercel.json"],
      patch,
    });
    expect(result.cronRoutes).toContain("/api/cron/drain");
  });

  it("does not treat a non-vercel file's \"path\" entry as a Vercel cron", () => {
    // vercel.json changed too, but the `"path": "/api/..."` lives in a route
    // table — it must NOT be scoped in as a cron (the whole-patch over-match bug).
    const patch = [
      "diff --git a/vercel.json b/vercel.json",
      "--- a/vercel.json",
      "+++ b/vercel.json",
      "@@ -1,2 +1,3 @@",
      " {",
      '+  "version": 2',
      " }",
      "diff --git a/apps/web/routes.ts b/apps/web/routes.ts",
      "--- a/apps/web/routes.ts",
      "+++ b/apps/web/routes.ts",
      "@@ -1,2 +1,3 @@",
      " export const routes = [",
      '+  { "path": "/api/users", handler },',
      " ];",
    ].join("\n");
    const result = scanOpsConfig({
      changedFiles: ["vercel.json", "apps/web/routes.ts"],
      patch,
    });
    expect(result.cronRoutes).toEqual([]);
  });

  it("detects a non-/api vercel cron path", () => {
    const patch = [
      "diff --git a/vercel.json b/vercel.json",
      "--- a/vercel.json",
      "+++ b/vercel.json",
      "@@ -1,3 +1,6 @@",
      " {",
      '+  "crons": [{ "path": "/jobs/nightly", "schedule": "0 0 * * *" }]',
      " }",
    ].join("\n");
    const result = scanOpsConfig({ changedFiles: ["vercel.json"], patch });
    expect(result.cronRoutes).toContain("/jobs/nightly");
  });

  it("returns empty arrays for an unrelated diff", () => {
    const patch = [
      "diff --git a/apps/web/lib/util.ts b/apps/web/lib/util.ts",
      "--- a/apps/web/lib/util.ts",
      "+++ b/apps/web/lib/util.ts",
      "@@ -1,2 +1,3 @@",
      " export function util() {",
      "+  return 42;",
      " }",
    ].join("\n");
    const result = scanOpsConfig({
      changedFiles: ["apps/web/lib/util.ts"],
      patch,
    });
    expect(result.cronRoutes).toEqual([]);
    expect(result.newRequiredEnvVars).toEqual([]);
  });

  it("de-dupes an env var read twice, preserving first-seen order", () => {
    const patch = [
      "+  const a = process.env.SHARED_TOKEN;",
      "+  const b = env.OTHER_VAR;",
      "+  const c = process.env.SHARED_TOKEN;",
    ].join("\n");
    const result = scanOpsConfig({ changedFiles: [], patch });
    expect(result.newRequiredEnvVars).toEqual(["SHARED_TOKEN", "OTHER_VAR"]);
  });

  it("does not mis-flag identifiers that merely end in `env` or nested `.env` accessors", () => {
    const patch = [
      "+  const a = parsedEnv.API_KEY;", // identifier ending in `env`
      "+  const b = ctx.env.MODE;", // nested accessor
      "+  const c = import.meta.env.VITE_THING;", // Vite build constant
    ].join("\n");
    const result = scanOpsConfig({ changedFiles: [], patch });
    expect(result.newRequiredEnvVars).toEqual([]);
  });

  it("does not flag a test file under an api/cron path as a deployable route", () => {
    const result = scanOpsConfig({
      changedFiles: [
        "apps/web/app/api/cron/drain/route.test.ts",
        "apps/web/app/api/cron/__tests__/drain.ts",
      ],
      patch: "",
    });
    expect(result.cronRoutes).toEqual([]);
  });

  it("detects a cron entry in a monorepo (non-root) vercel.json", () => {
    const patch = [
      "diff --git a/apps/web/vercel.json b/apps/web/vercel.json",
      "--- a/apps/web/vercel.json",
      "+++ b/apps/web/vercel.json",
      "@@ -1,3 +1,6 @@",
      " {",
      '+  "crons": [',
      '+    { "path": "/api/cron/sweep", "schedule": "0 * * * *" }',
      "+  ],",
      " }",
    ].join("\n");
    const result = scanOpsConfig({
      changedFiles: ["apps/web/vercel.json"],
      patch,
    });
    expect(result.cronRoutes).toContain("/api/cron/sweep");
  });
});
