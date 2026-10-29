/**
 * Vitest config for `.sandcastle/`.
 *
 * WHY THIS FILE EXISTS: without it, `pnpm exec vitest run .sandcastle/` globs
 * from the REPO root and treats the positional as a filename-substring filter.
 * `.sandcastle/worktrees/` holds full repo checkouts (multi-GB) that contain
 * STALE DUPLICATE copies of `main.test.mts` / `push.test.mts` plus a slice of
 * the repo's own test files — so the old invocation ran the duplicates and
 * would attribute phantom failures to whoever last edited `main.mts`.
 *
 * Run it with `pnpm sandcastle:test` (= `vitest run --root .sandcastle`).
 *
 * NOTE: `import.meta.dirname` — NOT `__dirname`. `.sandcastle/package.json` is
 * `{"type":"module"}`, so CJS globals are not defined here.
 */
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: import.meta.dirname,
    // Installs project.example.json as the active project config for every
    // test; tests about the DEFAULTS reset it themselves.
    setupFiles: ["./__fixtures__/example-project-config.ts"],
    // worktrees/ = sub-worktree checkouts (stale duplicate tests + repo tests)
    // logs/      = run logs, never tests
    // variants/  = inert profile templates copied over the active set
    exclude: [...configDefaults.exclude, "worktrees/**", "logs/**", "variants/**"],
    /**
     * Vitest's default per-test budget is 5 seconds. This suite's slowest
     * tests — the `runMain` circuit-breaker and `finishRun` cases in
     * `main.test.mts` — measure 1.6 to 2.6 seconds on an idle machine, so the
     * default leaves under 2x headroom. A machine doing anything else at the
     * same time closes that gap, and the test fails for being slow rather
     * than for being wrong.
     *
     * That is not theoretical for this repo: pull request #1129 had to give
     * three scanning tests their own raised budget for exactly this reason,
     * and on 2026-08-19 one whole-suite run failed once and never reproduced
     * across 18 later runs, including one under deliberate CPU load.
     *
     * **A false failure here is worse than a slow one.** This suite is the
     * only gate on the code that drives the unattended overnight run. A test
     * that fails for being slow teaches whoever reads it to re-run instead of
     * to look, which is how a real failure gets waved through.
     *
     * 20 seconds gives roughly 8x headroom over the slowest test. The cost is
     * that a genuinely hung test now takes 20 seconds to be declared dead
     * rather than 5 — about 15 seconds added to a ~75-second suite, and only
     * when something is actually broken.
     *
     * This does NOT touch `lib/harness/timeout-budget-contract.test.ts`. That
     * contract scans the app and package configs, which are what the harness
     * grades a ticket against. This file is the loop's own suite and is
     * deliberately outside it.
     */
    testTimeout: 20_000,
  },
});
