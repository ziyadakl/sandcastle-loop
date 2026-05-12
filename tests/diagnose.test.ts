/**
 * Tests for `.sandcastle/lib/diagnose.ts` — the pre-recovery halt-cause
 * classifier. Asserts each ported v1 cause matches its representative
 * surface forms, that the hint string carries the right fix command, and
 * that prose / unrelated keywords don't false-positive.
 */

import { describe, it, expect } from "vitest";
import { diagnoseHaltCause } from "../.sandcastle/lib/diagnose.js";

describe("diagnoseHaltCause", () => {
  describe("migration-unapplied", () => {
    it("matches bare relation-does-not-exist", () => {
      const r = diagnoseHaltCause(`relation "users" does not exist`);
      expect(r?.cause).toBe("migration-unapplied");
      expect(r?.hint).toContain("pnpm db:migrate");
    });

    it("matches Postgres SQLSTATE 42P01 prefix", () => {
      const r = diagnoseHaltCause(`42P01: relation users does not exist`);
      expect(r?.cause).toBe("migration-unapplied");
      expect(r?.hint).toContain("pnpm db:migrate");
    });

    it("matches Drizzle PostgresError prefix", () => {
      const r = diagnoseHaltCause(
        `PostgresError: relation "posts" does not exist at line 1`,
      );
      expect(r?.cause).toBe("migration-unapplied");
      expect(r?.hint).toContain("pnpm db:migrate");
    });
  });

  describe("deps-missing", () => {
    it("matches CJS-style Cannot find module", () => {
      const r = diagnoseHaltCause(`Error: Cannot find module 'react'`);
      expect(r?.cause).toBe("deps-missing");
      expect(r?.hint).toContain("pnpm install");
    });

    it("matches ESM Cannot find package", () => {
      const r = diagnoseHaltCause(
        `Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'zod'`,
      );
      expect(r?.cause).toBe("deps-missing");
      expect(r?.hint).toContain("pnpm install");
    });

    it("matches standalone ERR_MODULE_NOT_FOUND token", () => {
      const r = diagnoseHaltCause(`stack:\n  ERR_MODULE_NOT_FOUND\n`);
      expect(r?.cause).toBe("deps-missing");
      expect(r?.hint).toContain("pnpm install");
    });
  });

  describe("playwright-not-installed", () => {
    it("matches Executable doesn't exist at chromium", () => {
      const r = diagnoseHaltCause(
        `Executable doesn't exist at /ms-playwright/chromium-1234/chrome-linux/chrome`,
      );
      expect(r?.cause).toBe("playwright-not-installed");
      expect(r?.hint).toContain("playwright install chromium");
    });

    it("matches 'please install playwright' hint", () => {
      const r = diagnoseHaltCause(`please install playwright before running`);
      expect(r?.cause).toBe("playwright-not-installed");
      expect(r?.hint).toContain("playwright install chromium");
    });
  });

  describe("negative cases", () => {
    it("returns null for prose with no match", () => {
      const r = diagnoseHaltCause(
        `The implementer hit a 20-minute idle timeout while waiting on review.`,
      );
      expect(r).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(diagnoseHaltCause("")).toBeNull();
    });

    it("returns null when 'playwright' is mentioned but pattern not satisfied", () => {
      // Mentions playwright in prose; doesn't match either surface phrase.
      const r = diagnoseHaltCause(
        `The playwright test suite reported 3 assertion failures.`,
      );
      expect(r).toBeNull();
    });
  });
});
