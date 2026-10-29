/**
 * Guards for the agent's git identity.
 *
 * WHY THIS FILE EXISTS. The owner does not write code. Before
 * `lib/git/identity.ts`, every commit the loop made was authored AND committed
 * under his name and his GitHub-linked email, so `git log`, `git blame` and
 * GitHub's author line all attributed unattended work to him. The regression
 * that reinstates that is silent: no test fails, no check goes red, and nobody
 * notices until months of history are already mis-attributed. These tests are
 * the only thing standing between a refactor and that outcome.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetProjectConfig } from "../project-config.js";
import {
  agentCommitIdentity,
  agentIdentityArgs,
  agentIdentityEnv,
} from "./identity.js";

const made: string[] = [];

function tempRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "identity-"));
  made.push(dir);
  git(dir, "init", "-q", "-b", "main");
  // The impersonation this whole module exists to prevent. Every test below
  // starts from a checkout that WOULD attribute the agent's work to a human.
  git(dir, "config", "user.name", "Alex");
  git(dir, "config", "user.email", "owner@example.com");
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

afterEach(() => {
  while (made.length > 0) {
    rmSync(made.pop()!, { recursive: true, force: true });
  }
});

describe("agent git identity", () => {
  it("never carries an email that could belong to the owner's GitHub account", () => {
    // GitHub links a commit to an account by matching the AUTHOR EMAIL against
    // that account's verified addresses. A `@users.noreply.github.com` address
    // is account-derived by construction, and the owner's own address obviously
    // is. Either one re-links every agent commit to him — the exact failure
    // this module exists to prevent — so both are refused here rather than in
    // review.
    expect(agentCommitIdentity().email).not.toMatch(/users\.noreply\.github\.com$/);
    expect(agentCommitIdentity().name).toMatch(/^Claude\b/);
  });

  it("DEFAULTS to a neutral `Claude <noreply@anthropic.com>` when the project sets no commitIdentity", () => {
    resetProjectConfig();
    expect(agentCommitIdentity()).toEqual({ name: "Claude", email: "noreply@anthropic.com" });
    expect(agentIdentityArgs()).toEqual([
      "-c",
      "user.name=Claude",
      "-c",
      "user.email=noreply@anthropic.com",
    ]);
  });

  it("stamps the agent identity on a commit in a repo configured as the owner", () => {
    // The behavioural guard, not a source-text one: it drives a real `git
    // commit` in a real repo whose config says "Alex", and reads back what
    // git ACTUALLY recorded. A refactor that drops the `-c` splice fails here.
    const repo = tempRepo();
    writeFileSync(path.join(repo, "a.txt"), "hello\n");
    git(repo, "add", "-A");
    git(repo, ...agentIdentityArgs(), "commit", "--no-gpg-sign", "-m", "test");

    expect(git(repo, "log", "-1", "--format=%an")).toBe(agentCommitIdentity().name);
    expect(git(repo, "log", "-1", "--format=%ae")).toBe(agentCommitIdentity().email);
    // Committer as well as author. Only the author line is rendered by most
    // tools, so a half-fix here would look correct and still leave the owner's
    // name on the commit object.
    expect(git(repo, "log", "-1", "--format=%cn")).toBe(agentCommitIdentity().name);
    expect(git(repo, "log", "-1", "--format=%ce")).toBe(agentCommitIdentity().email);
  });

  it("loses to an explicit -c on the same command, so bookkeeping identities still win", () => {
    // `sandcastle-lock` / `sandcastle-status` / `sandcastle-telemetry` commits
    // pass their own `-c user.*`, and `reworkTipIsAmendable` matches on the
    // telemetry committer EMAIL to decide whether it may amend. If the agent
    // identity ever outranked those, that match breaks and the telemetry
    // commit appends forever instead of amending. Pinned here because the
    // precedence is git's, not ours, and nothing else would catch a change.
    const repo = tempRepo();
    writeFileSync(path.join(repo, "a.txt"), "hello\n");
    git(repo, "add", "-A");
    git(
      repo,
      ...agentIdentityArgs(),
      "-c",
      "user.name=sandcastle-telemetry",
      "-c",
      "user.email=telemetry@sandcastle.local",
      "commit",
      "--no-gpg-sign",
      "-m",
      "bookkeeping",
    );
    expect(git(repo, "log", "-1", "--format=%ce")).toBe(
      "telemetry@sandcastle.local",
    );
  });

  it("is outranked BY env vars — which is why they are never set on the orchestrator", () => {
    // The inverse of the test above, and the reason `agentIdentityEnv()` is
    // scoped to the CONTAINER environment only. Exporting these into the
    // orchestrator's own process would clobber every `-c` bookkeeping identity
    // above. This pins the hazard so a future "simplification" that exports
    // them globally goes red here instead of silently in production.
    const repo = tempRepo();
    writeFileSync(path.join(repo, "a.txt"), "hello\n");
    git(repo, "add", "-A");
    execFileSync(
      "git",
      ["-c", "user.email=telemetry@sandcastle.local", "commit", "--no-gpg-sign", "-m", "x"],
      { cwd: repo, stdio: "ignore", env: { ...process.env, ...agentIdentityEnv() } },
    );
    expect(git(repo, "log", "-1", "--format=%ce")).toBe(agentCommitIdentity().email);
  });

  it("pins the identity into a checkout that was configured as the owner", async () => {
    // `ensureAgentGitIdentity` is the belt to `agentIdentityArgs`' braces: it
    // covers git commands nobody in this repo wrote — an interactive session's
    // own `git commit`, and the merge commits the promote / converge /
    // lane-sync paths create.
    const { ensureAgentGitIdentity } = await import("../../main.mts");
    const repo = tempRepo();
    ensureAgentGitIdentity(repo);
    expect(git(repo, "config", "--local", "--get", "user.name")).toBe(
      agentCommitIdentity().name,
    );
    expect(git(repo, "config", "--local", "--get", "user.email")).toBe(
      agentCommitIdentity().email,
    );
    // And it must write LOCAL, not merely satisfy itself that some global
    // value already matches — a repo whose guarantee rests on machine-wide
    // state is one `git config --global` away from attributing the agent's
    // work to the owner again.
    expect(
      git(repo, "config", "--local", "--get-all", "user.name").split("\n"),
    ).toHaveLength(1);
  });

  it("is spliced into every host-side commit site", () => {
    // Source-text pins. These commit sites run on the HOST, outside the agent
    // container, so `agentIdentityEnv()` never reaches them. Two of them are
    // also reachable from `scripts/checkpoint-stop.mts`, a separate process
    // that runs after `main.mts` has been killed and so never passes through
    // `ensureAgentGitIdentity`. Drop the splice and those commits fall back to
    // the machine's identity — the owner's.
    const read = (rel: string): string =>
      execFileSync("cat", [path.join(import.meta.dirname, "..", "..", rel)], {
        encoding: "utf8",
      });
    for (const rel of [
      "lib/state/branch-checkpoint.ts",
      "lib/paths/protected-path-restore.ts",
      "lib/hosts/launch.ts",
    ]) {
      const src = read(rel);
      const commits = (src.match(/"commit"/g) ?? []).length;
      const splices = (src.match(/agentIdentityArgs\(\)/g) ?? []).length;
      expect(
        splices,
        `${rel}: every "commit" call must splice agentIdentityArgs()`,
      ).toBe(commits);
    }
  });

  it("hands the container all four author AND committer variables", () => {
    // A partial env (author only) leaves the committer as whatever the image
    // carries, and the commit object still names someone else.
    expect(agentIdentityEnv()).toEqual({
      GIT_AUTHOR_NAME: agentCommitIdentity().name,
      GIT_COMMITTER_NAME: agentCommitIdentity().name,
      GIT_AUTHOR_EMAIL: agentCommitIdentity().email,
      GIT_COMMITTER_EMAIL: agentCommitIdentity().email,
    });
  });
});
