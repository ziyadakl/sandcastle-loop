/**
 * Tests for the prompt-restore guard.
 *
 * Two halves are covered. The pure half decides whether a restored tree still
 * carries this project's local hardening (a wrong `expectedMarkers` number is
 * invisible in production — the guard simply stops proving anything — and it is
 * exactly what drifts when somebody edits a prompt). The IO half — `dirtyFiles`
 * over a real `git diff`, the discarded-upstream-diff CAPTURE, and the
 * `git checkout HEAD --` RESTORE that once silently reverted a worker's prompt
 * edits — is exercised against a throwaway git repo (issue #1135, LOW 3), since
 * "the diff was captured before it was discarded" is the one property a wrong
 * run corrupts silently.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MARKER,
  PROMPT_FILES,
  auditMarkerCounts,
  captureDiscardedDiff,
  countOccurrences,
  dirtyFiles,
  restoreFromHead,
} from "./restore-prompts.mts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("countOccurrences", () => {
  it("counts every occurrence, not just the first", () => {
    expect(countOccurrences("a-X-b-X-c-X", "X")).toBe(3);
  });

  it("returns zero when the needle is absent", () => {
    expect(countOccurrences("nothing here", MARKER)).toBe(0);
  });

  it("counts non-overlapping matches only", () => {
    expect(countOccurrences("aaaa", "aa")).toBe(2);
  });
});

describe("auditMarkerCounts", () => {
  const files = [
    { path: "a.md", expectedMarkers: 1 },
    { path: "b.md", expectedMarkers: 5 },
  ] as const;

  it("passes when every file carries exactly what it declared", () => {
    const audit = auditMarkerCounts(
      new Map([
        ["a.md", 1],
        ["b.md", 5],
      ]),
      files,
    );
    expect(audit.missing).toEqual([]);
    expect(audit.surplus).toEqual([]);
  });

  it("FAILS a file that lost some of its markers but kept one", () => {
    // The whole reason for a per-file count. Under the old "at least one" rule
    // this tree passed with four of five local hardening blocks gone.
    const audit = auditMarkerCounts(
      new Map([
        ["a.md", 1],
        ["b.md", 1],
      ]),
      files,
    );
    expect(audit.missing).toEqual([{ file: "b.md", expected: 5, found: 1 }]);
    expect(audit.surplus).toEqual([]);
  });

  it("treats a file that is not there at all as zero markers", () => {
    const audit = auditMarkerCounts(new Map([["b.md", 5]]), files);
    expect(audit.missing).toEqual([{ file: "a.md", expected: 1, found: 0 }]);
  });

  it("reports a surplus WITHOUT failing", () => {
    // Somebody added hardening and did not raise the table. That is a message,
    // never an exit 1: this script is the owner's recovery tool.
    const audit = auditMarkerCounts(
      new Map([
        ["a.md", 2],
        ["b.md", 5],
      ]),
      files,
    );
    expect(audit.missing).toEqual([]);
    expect(audit.surplus).toEqual([{ file: "a.md", expected: 1, found: 2 }]);
  });
});

describe("the PROMPT_FILES table against the real prompt files", () => {
  it.each(PROMPT_FILES.map((f) => [f.path, f.expectedMarkers] as const))(
    "%s carries exactly %i MUST-KEEP marker(s)",
    (rel, expected) => {
      const source = readFileSync(join(REPO_ROOT, rel), "utf8");
      expect(countOccurrences(source, MARKER)).toBe(expected);
    },
  );

  it("audits the real tree clean", () => {
    const found = new Map(
      PROMPT_FILES.map((f) => [
        f.path,
        countOccurrences(readFileSync(join(REPO_ROOT, f.path), "utf8"), MARKER),
      ]),
    );
    const audit = auditMarkerCounts(found);
    expect(audit.missing).toEqual([]);
    expect(audit.surplus).toEqual([]);
  });

  it("covers the local-only check-writer prompt (issue #1118), and no longer the deleted judge prompt (spec #1334)", () => {
    const paths = PROMPT_FILES.map((f) => f.path);
    expect(paths).toContain(".sandcastle/check-writer-prompt.md");
    expect(paths).not.toContain(".sandcastle/judge-prompt.md");
  });
});

describe("the IO half — capture then restore, against a real repo (issue #1135)", () => {
  let repo: string;
  // A stand-in prompt path; the IO functions take the path list as an argument,
  // so the test never depends on the real `.sandcastle/*` prompt files.
  const PROMPT = ".sandcastle/review-prompt.md";
  const COMMITTED = `# review prompt\n\n<!-- ${MARKER} -->\nlocal hardening\n`;
  const g = (...args: string[]): string =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "sc-restore-prompts-io-"));
    g("init", "-q", "-b", "main");
    g("config", "user.email", "test@test");
    g("config", "user.name", "test");
    writeFileSync(join(repo, ".gitignore"), ".sandcastle/logs/\n");
    const abs = join(repo, PROMPT);
    execFileSync("mkdir", ["-p", dirname(abs)]);
    writeFileSync(abs, COMMITTED);
    g("add", "-A");
    g("commit", "-q", "-m", "seed the committed prompt");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("dirtyFiles lists only the prompt the worktree actually changed", () => {
    expect(dirtyFiles(repo, [PROMPT])).toEqual([]);
    // Simulate `/sandcastle-update` overwriting the file with upstream content
    // that strips the local hardening.
    writeFileSync(join(repo, PROMPT), "# review prompt\n\nupstream, no marker\n");
    expect(dirtyFiles(repo, [PROMPT])).toEqual([PROMPT]);
  });

  it("captures the discarded upstream diff to logs BEFORE the restore throws it away", () => {
    const upstream = "# review prompt\n\nupstream, no marker\n";
    writeFileSync(join(repo, PROMPT), upstream);
    const dirty = dirtyFiles(repo, [PROMPT]);

    const diffPath = captureDiscardedDiff(repo, dirty, "2026-08-25T12:00:00.000Z");

    // The capture landed in .sandcastle/logs/ with a stamped name, and it holds
    // the upstream content the restore is about to discard.
    expect(diffPath).toContain(
      join(".sandcastle", "logs", "upstream-prompt-changes-2026-08-25T12-00-00-000Z.diff"),
    );
    const captured = readFileSync(diffPath, "utf8");
    expect(captured).toContain("upstream, no marker");
    expect(captured).toContain(`a/${PROMPT}`);
    // The logs directory holds exactly the one capture we made.
    const logs = readdirSync(join(repo, ".sandcastle", "logs"));
    expect(logs).toHaveLength(1);
  });

  it("restoreFromHead puts the committed local-hardened copy back on disk", () => {
    writeFileSync(join(repo, PROMPT), "# review prompt\n\nupstream, no marker\n");
    const dirty = dirtyFiles(repo, [PROMPT]);
    // Capture first — the real sequence — so the property under test is that
    // restore reverts the worktree, not that it also lost the capture.
    captureDiscardedDiff(repo, dirty, "2026-08-25T12:00:00.000Z");

    restoreFromHead(repo, dirty);

    expect(readFileSync(join(repo, PROMPT), "utf8")).toBe(COMMITTED);
    // And the tree is clean again — nothing left dirty for the marker verify.
    expect(dirtyFiles(repo, [PROMPT])).toEqual([]);
  });
});
