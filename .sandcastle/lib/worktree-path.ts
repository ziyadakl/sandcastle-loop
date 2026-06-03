/**
 * Repo-relative path where the SDK provisions a per-branch git worktree.
 *
 * MUST stay in sync with `@ai-hero/sandcastle/dist/WorktreeManager.js`
 * (forward slashes become dashes). Both our pre-clean guard in
 * `createSandbox` and `cleanupIssueBranch` derive paths from this helper
 * so the two consumers can't drift from each other or from the SDK.
 */
export function worktreePathFor(branch: string): string {
  return `.sandcastle/worktrees/${branch.replace(/\//g, "-")}`;
}
