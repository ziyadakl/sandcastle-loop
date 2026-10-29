/**
 * Tests for the neutral glob matcher.
 *
 * The behaviours pinned here are the ones its two callers actually depend on
 * and that a "simplification" would plausibly break: `**` collapsing to zero
 * segments (the reviewer's `**​/migrations/**` must match a top-level
 * `migrations/`), `*` never crossing a `/`, the basename fallback for a
 * pattern with no `/` (telemetry's `*.lock` must exclude a nested lockfile),
 * and regex metacharacters in a pattern staying literal.
 */
import { describe, expect, it } from "vitest";

import { pathMatchesGlob } from "./glob.js";

describe("pathMatchesGlob", () => {
  it("lets `**` span, or skip, directory boundaries", () => {
    expect(pathMatchesGlob("a/b/migrations/c.sql", "**/migrations/**")).toBe(
      true,
    );
    expect(pathMatchesGlob("migrations/c.sql", "**/migrations/**")).toBe(true);
    // Trailing `/**` must also match zero trailing segments.
    expect(pathMatchesGlob("src/migrations", "**/migrations/**")).toBe(true);
  });

  it("does not match a path outside the pattern", () => {
    expect(pathMatchesGlob("src/components/Button.tsx", "**/migrations/**")).toBe(
      false,
    );
    expect(pathMatchesGlob("src/notes.md", "*.sql")).toBe(false);
  });

  it("falls back to the basename only for a pattern with no `/`", () => {
    // The telemetry excluded-path globs rely on this: `*.lock` must exclude
    // `apps/web/bun.lock`, not just a lockfile at the repo root.
    expect(pathMatchesGlob("bun.lock", "*.lock")).toBe(true);
    expect(pathMatchesGlob("apps/web/bun.lock", "*.lock")).toBe(true);
    // A pattern that DOES contain `/` is anchored — no basename rescue.
    expect(pathMatchesGlob("a/b/c.ts", "a/*.ts")).toBe(false);
    expect(pathMatchesGlob("a/b.ts", "a/*.ts")).toBe(true);
  });

  it("never lets a single `*` cross a `/`", () => {
    expect(pathMatchesGlob("pkg/dist/app.min.js", "*.min.*")).toBe(true);
    expect(pathMatchesGlob("src/a/b.ts", "src/*.ts")).toBe(false);
  });

  it("treats regex metacharacters in the pattern as literal", () => {
    expect(pathMatchesGlob("pnpm-lock.yaml", "pnpm-lock.yaml")).toBe(true);
    // `.` is literal, so it must not match an arbitrary character.
    expect(pathMatchesGlob("pnpm-lockXyaml", "pnpm-lock.yaml")).toBe(false);
    expect(pathMatchesGlob("a+b.ts", "a+b.ts")).toBe(true);
  });
});
