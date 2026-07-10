import { describe, it, expect } from "vitest";
import { buildCopyToWorktree } from "../.sandcastle/main.mjs";

// The loop copies a fixed set of paths into each per-iteration worktree/container
// alongside the git checkout. `node_modules` is always copied (gitignored but
// needed). `pnpm-workspace.yaml` is copied ONLY when it exists at the repo root,
// because pnpm 11 stores its `allowBuilds` build-script approval there and the
// worktree receives only tracked files — a gitignored approval would otherwise
// be invisible in-sandbox and re-trigger ERR_PNPM_IGNORED_BUILDS every iteration.
// The existence guard keeps npm/yarn/pnpm-10 projects (no such file) unaffected.
describe("buildCopyToWorktree", () => {
  it("always copies node_modules", () => {
    expect(buildCopyToWorktree("/repo", () => false)).toEqual(["node_modules"]);
  });

  it("also copies pnpm-workspace.yaml when present at the repo root", () => {
    const seen: string[] = [];
    const result = buildCopyToWorktree("/repo", (p) => {
      seen.push(p);
      return p.endsWith("pnpm-workspace.yaml");
    });
    expect(result).toEqual(["node_modules", "pnpm-workspace.yaml"]);
    // it checks the repo-root location, not some other path
    expect(seen.some((p) => p.endsWith("/repo/pnpm-workspace.yaml"))).toBe(true);
  });

  it("omits pnpm-workspace.yaml when the project has none (npm/yarn/pnpm-10)", () => {
    expect(buildCopyToWorktree("/repo", () => false)).not.toContain(
      "pnpm-workspace.yaml",
    );
  });
});
