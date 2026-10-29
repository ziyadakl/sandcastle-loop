/**
 * Tests for the CONTENT-level tsconfig grading-field guard (issue #1135,
 * MEDIUM 1), run against a REAL temp git repo — the same discipline
 * `e2e-script-guard.test.ts` and `protected-path-restore.test.ts` use, since
 * this module reads real git blobs at two shas.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { commitInto, git } from "../../__fixtures__/git-repo.js";
import { tsconfigGradingTampered } from "./tsconfig-guard.js";

let repo: string;
const TS = "apps/nextjs/e2e/checks/tsconfig.json";

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), "sandcastle-tsconfig-guard-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

const cleanTsconfig = `{
  "extends": "@acme/tsconfig/base.json",
  "compilerOptions": {
    "lib": ["ES2022"],
    "paths": {}
  },
  "include": ["./**/*.ts"],
  "exclude": ["node_modules"]
}
`;

describe("tsconfigGradingTampered", () => {
  it("PROVES THE INSTRUMENT: fires when compilerOptions.paths is remapped to a stub", () => {
    const before = commitInto(repo, { [TS]: cleanTsconfig }, "seed");
    const after = commitInto(
      repo,
      {
        [TS]: `{
  "extends": "@acme/tsconfig/base.json",
  "compilerOptions": {
    "lib": ["ES2022"],
    "paths": { "@acme/db": ["./__stubs__/db-that-passes.ts"] }
  },
  "include": ["./**/*.ts"],
  "exclude": ["node_modules"]
}
`,
      },
      "fix: make the check pass\n\nSANDCASTLE-LINT: pass\nSANDCASTLE-TEST: pass",
    );
    expect(tsconfigGradingTampered(repo, before, after, TS)).toBe(true);
  });

  it("fires when `include` is narrowed so the check is no longer collected", () => {
    const before = commitInto(repo, { [TS]: cleanTsconfig }, "seed");
    const after = commitInto(
      repo,
      {
        [TS]: cleanTsconfig.replace('"./**/*.ts"', '"./nothing/*.ts"'),
      },
      "fix",
    );
    expect(tsconfigGradingTampered(repo, before, after, TS)).toBe(true);
  });

  it("fires when `exclude` is widened to swallow the check", () => {
    const before = commitInto(repo, { [TS]: cleanTsconfig }, "seed");
    const after = commitInto(
      repo,
      { [TS]: cleanTsconfig.replace('"node_modules"', '"node_modules", "./checks"') },
      "fix",
    );
    expect(tsconfigGradingTampered(repo, before, after, TS)).toBe(true);
  });

  it("tolerates JSONC comments and does NOT fire when the graded fields are byte-identical", () => {
    const withComments = `{
  // acceptance-check specs run browser-context code, so give them the DOM lib
  "extends": "@acme/tsconfig/base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"], // DOM globals
    "paths": {}
  },
  "include": ["./**/*.ts"],
  "exclude": ["node_modules"]
}
`;
    const before = commitInto(repo, { [TS]: withComments }, "seed");
    const after = commitInto(
      repo,
      {
        // A different, longer comment plus a compilerOptions edit that does NOT
        // touch paths/include/exclude — a legitimate lib change.
        [TS]: `{
  /* rewritten comment block that says something completely different */
  "extends": "@acme/tsconfig/base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "paths": {}
  },
  "include": ["./**/*.ts"],
  "exclude": ["node_modules"]
}
`,
      },
      "chore: bump lib to ES2023",
    );
    expect(tsconfigGradingTampered(repo, before, after, TS)).toBe(false);
  });

  it("ignores key/whitespace reordering inside compilerOptions.paths (canonical compare)", () => {
    const before = commitInto(
      repo,
      {
        [TS]: cleanTsconfig.replace(
          '"paths": {}',
          '"paths": { "@a": ["./a"], "@b": ["./b"] }',
        ),
      },
      "seed",
    );
    const after = commitInto(
      repo,
      {
        [TS]: cleanTsconfig.replace(
          '"paths": {}',
          '"paths": {\n      "@b": ["./b"],\n      "@a": ["./a"]\n    }',
        ),
      },
      "reformat",
    );
    expect(tsconfigGradingTampered(repo, before, after, TS)).toBe(false);
  });

  it("does not fire when a NON-graded field (compilerOptions.lib only) changes", () => {
    const before = commitInto(repo, { [TS]: cleanTsconfig }, "seed");
    const after = commitInto(
      repo,
      { [TS]: cleanTsconfig.replace('"ES2022"', '"ES2023"') },
      "chore",
    );
    expect(tsconfigGradingTampered(repo, before, after, TS)).toBe(false);
  });

  it("tolerates trailing commas (JSONC) without a false positive", () => {
    const trailing = (lib: string): string => `{
  "compilerOptions": {
    "lib": ["${lib}"],
    "paths": {},
  },
  "include": ["./**/*.ts"],
  "exclude": ["node_modules"],
}
`;
    // Both sides carry trailing commas; only the NON-graded `lib` field differs,
    // so the parse must succeed on both and the graded fields must compare
    // equal — no false positive from the trailing commas or the lib bump.
    const before = commitInto(repo, { [TS]: trailing("ES2022") }, "seed");
    const after = commitInto(repo, { [TS]: trailing("ES2023") }, "chore: lib bump");
    expect(tsconfigGradingTampered(repo, before, after, TS)).toBe(false);
  });

  it("fails safe (true) on an unreadable/missing blob on either side", () => {
    const seed = commitInto(repo, { "README.md": "x\n" }, "seed");
    expect(tsconfigGradingTampered(repo, seed, seed, TS)).toBe(true);
    expect(
      tsconfigGradingTampered(repo, "not-a-real-sha", "also-not-real", TS),
    ).toBe(true);
  });

  it("fails safe (true) on unparsable JSON rather than throwing or waving it through", () => {
    const before = commitInto(repo, { [TS]: cleanTsconfig }, "seed");
    const after = commitInto(repo, { [TS]: "{ not valid json at all" }, "oops");
    expect(() => tsconfigGradingTampered(repo, before, after, TS)).not.toThrow();
    expect(tsconfigGradingTampered(repo, before, after, TS)).toBe(true);
  });
});
