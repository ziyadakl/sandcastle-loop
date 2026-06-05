/**
 * Source-level portability guards for the `sandcastle-watch` viewer (ADR 0008).
 *
 * Both defects these tests guard against are INVISIBLE in this repo's own
 * environment (React 19.2 + a root `tsconfig.json` with `jsx: react-jsx`), so
 * they shipped and broke consumers on React 19.1.x without a root tsconfig.
 * A runtime test would pass here regardless of whether the fix is present —
 * the template runs the favorable env — so these guards are SOURCE-LEVEL and
 * deliberately assert against the checked-in files, not viewer behavior.
 *
 * Origin: affinity-tracker proposal, fixed there in commit 979a02a0d.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("sandcastle-watch viewer portability", () => {
  it("pins ink below 7 — ink 7 hard-requires React 19.2 (useEffectEvent)", () => {
    // ink@7's use-input.js imports React 19.2's `useEffectEvent`, so a consumer
    // on React 19.1.x crashes at viewer startup with a missing-export SyntaxError.
    // Nothing else catches a bump back to ^7: this repo runs React 19.2 (happy on
    // either ink), and `npm update` stays within the declared 6.x range. The pin
    // is the only guard — keep it asserted.
    const pkg = JSON.parse(
      readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    ) as { devDependencies?: Record<string, string> };
    const spec = pkg.devDependencies?.ink;
    expect(spec, "ink must be a devDependency").toBeTruthy();
    const major = Number.parseInt(String(spec).replace(/^\D*/, ""), 10);
    expect(major).toBeLessThan(7);
    expect(major).toBeGreaterThanOrEqual(6);
  });

  it("imports React by default — classic JSX transform needs it in scope", () => {
    // A consumer with no root tsconfig gets esbuild's CLASSIC `React.createElement`
    // transform (tsx resolves jsx config from cwd, not the entry file's dir), so
    // `render(<App/>)` throws `ReferenceError: React is not defined` unless React
    // is imported by default. The import is transform-agnostic: required under the
    // classic transform, harmless under the automatic one. Without this guard a
    // future "remove unused import" tidy strips it (React reads as unused here,
    // under the automatic transform) and silently re-breaks consumers.
    const src = readFileSync(
      path.join(repoRoot, ".sandcastle/watch/sandcastle-watch.tsx"),
      "utf8",
    );
    expect(src).toMatch(/import\s+React\b[^;]*from\s+["']react["']/);
  });
});
