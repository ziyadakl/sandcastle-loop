import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readlinkSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// install.sh under test. It derives its own repo root from BASH_SOURCE, so we
// copy it into a throwaway repo per test and run THAT copy — the copy is what
// points it at the fixture, no injected repo-root var needed. This mirrors the
// house idiom in tests/wrapper.test.ts (spawn a bash script from a temp dir).
const here = dirname(fileURLToPath(import.meta.url));
const REAL_INSTALL_SH = join(here, "../skills/install.sh");

/** Run git for TEST SETUP (throws on non-zero). Same shim as checkpoint-resume-e2e.test.ts. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Build a temp repo whose history mirrors the REAL shape that produced the bug:
 * hosts.json committed, then a LATER commit deletes it and adds the example +
 * gitignore. A brand-new clone of this repo therefore has NO hosts.json on disk
 * and the delete sitting in history — exactly the fresh-clone case.
 */
function seedRepo(root: string): void {
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@t.test");
  git(root, "config", "user.name", "Test");

  mkdirSync(join(root, ".sandcastle"), { recursive: true });
  // Commit 1: hosts.json tracked, carrying a machine-specific repoPath.
  writeFileSync(
    join(root, ".sandcastle/hosts.json"),
    JSON.stringify(
      { hosts: [{ name: "hub", transport: "hub", maxConcurrent: 1, repoPath: "/home/deploy/dev/sandcastle-loop" }] },
      null,
      2,
    ) + "\n",
  );
  git(root, "add", "-A");
  git(root, "commit", "-qm", "add hosts.json (tracked)");

  // Commit 2: make it per-machine — delete it, ship the example, ignore it.
  rmSync(join(root, ".sandcastle/hosts.json"));
  writeFileSync(
    join(root, ".sandcastle/hosts.example.json"),
    JSON.stringify({ hosts: [{ name: "local", transport: "local", maxConcurrent: 2 }] }, null, 2) + "\n",
  );
  writeFileSync(join(root, ".sandcastle/.gitignore"), "hosts.json\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "hosts.json is per-machine now");

  // Copy the real install.sh into <root>/skills/ and give it sibling skill dirs
  // to link so the linking loop has real work.
  mkdirSync(join(root, "skills"), { recursive: true });
  writeFileSync(join(root, "skills/install.sh"), readFileSync(REAL_INSTALL_SH, "utf8"));
  for (const s of ["sandcastle-run", "sandcastle-clean"]) {
    mkdirSync(join(root, "skills", s), { recursive: true });
    writeFileSync(join(root, "skills", s, "SKILL.md"), `# ${s}\n`);
  }
}

function runInstall(root: string, dest: string) {
  return spawnSync("bash", [join(root, "skills/install.sh")], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_SKILLS_DIR: dest },
  });
}

describe("skills/install.sh", () => {
  let tmp: string;
  let repo: string;
  let dest: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "sandcastle-install-"));
    repo = join(tmp, "repo");
    dest = join(tmp, "skills-dest"); // stands in for ~/.claude/skills — NEVER the real one
    mkdirSync(repo, { recursive: true });
    seedRepo(repo);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // THE BUG. A fresh clone has no hosts.json and the delete in history. The
  // installer must NOT resurrect another machine's registry — that is the exact
  // per-machine value the whole change set exists to eliminate.
  it("does NOT write hosts.json on a fresh clone", () => {
    const r = runInstall(repo, dest);
    expect(r.status).toBe(0);
    expect(existsSync(join(repo, ".sandcastle/hosts.json"))).toBe(false);
  }, 20000);

  // Guidance instead of a silent no-op, so a human who DID have a registry knows
  // how to get it back.
  it("prints recovery guidance when hosts.json is absent", () => {
    const r = runInstall(repo, dest);
    expect(r.stdout).toMatch(/hosts\.example\.json/);
  }, 20000);

  it("symlinks every sandcastle-* skill into the dest, resolving to the repo copy", () => {
    runInstall(repo, dest);
    for (const s of ["sandcastle-run", "sandcastle-clean"]) {
      const link = join(dest, s);
      expect(existsSync(link)).toBe(true);
      expect(readlinkSync(link)).toBe(join(repo, "skills", s));
    }
  }, 20000);

  it("is idempotent — a second run creates no new backup", () => {
    runInstall(repo, dest);
    const r2 = runInstall(repo, dest);
    expect(r2.status).toBe(0);
    const backups = readdirSync(dest).filter((n) => n.startsWith(".sandcastle-skills-backup-"));
    expect(backups.length).toBe(0);
  }, 20000);

  // An existing real dir at the target is MOVED to a backup, never deleted —
  // the content must survive.
  it("backs up an existing real skill dir instead of deleting it", () => {
    const existing = join(dest, "sandcastle-run");
    mkdirSync(existing, { recursive: true });
    writeFileSync(join(existing, "keepme.txt"), "precious");

    runInstall(repo, dest);

    const backups = readdirSync(dest).filter((n) => n.startsWith(".sandcastle-skills-backup-"));
    expect(backups.length).toBe(1);
    expect(readFileSync(join(dest, backups[0], "sandcastle-run/keepme.txt"), "utf8")).toBe("precious");
  }, 20000);

  // Run from a dir that is NOT a git checkout: the git-history restore line
  // would error if pasted, so it must be suppressed — but the always-valid `cp`
  // guidance must still print, and the script must not crash under `set -e`.
  it("in a non-git dir, prints cp guidance and NOT the git-history line", () => {
    const nogit = join(tmp, "nogit");
    mkdirSync(join(nogit, "skills", "sandcastle-run"), { recursive: true });
    writeFileSync(join(nogit, "skills", "sandcastle-run", "SKILL.md"), "# run\n");
    writeFileSync(join(nogit, "skills", "install.sh"), readFileSync(REAL_INSTALL_SH, "utf8"));

    const r = spawnSync("bash", [join(nogit, "skills/install.sh")], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_SKILLS_DIR: join(tmp, "nogit-dest") },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/hosts\.example\.json/); // cp path still offered
    expect(r.stdout).not.toMatch(/git show/); // history line suppressed
    expect(existsSync(join(nogit, ".sandcastle/hosts.json"))).toBe(false);
  }, 20000);
});
