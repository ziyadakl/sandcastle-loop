import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { pathMatchesGlob } from "../paths/glob.js";
import { checkRelativePathPattern } from "./check-source.js";
import {
  UNIT_CHECK_DIR_SEGMENT,
  UNIT_CHECK_PRODUCT_IMPORT_REQUIREMENT,
  UNIT_CHECKS_ROOT_GLOB,
  buildUnitCheckCommand,
  isSafeUnitCheckPackage,
  isSafeUnitCheckRelativePath,
  missingUnitCheckRequirements,
  resolveUnitCheckPackage,
  unitCheckDirFor,
  unitCheckDirGlobFor,
} from "./unit-check-path.js";

describe("unitCheckDirFor / unitCheckDirGlobFor", () => {
  it("lives under the package's own src/ — the only tree every vitest include covers", () => {
    expect(unitCheckDirFor("packages/api", 848)).toBe(
      "packages/api/src/__checks__/issue-848",
    );
  });

  it("uses __checks__, not __tests__, so check machinery stays greppable", () => {
    expect(UNIT_CHECK_DIR_SEGMENT).toBe("__checks__");
    expect(unitCheckDirFor("packages/db", 1)).toContain("/__checks__/");
    expect(unitCheckDirFor("packages/db", 1)).not.toContain("__tests__");
  });

  it("the glob covers everything under that directory, additively", () => {
    expect(unitCheckDirGlobFor("packages/api", 848)).toBe(
      "packages/api/src/__checks__/issue-848/**",
    );
  });

  it("two different issues never collide on the same directory", () => {
    expect(unitCheckDirFor("packages/api", 1)).not.toBe(
      unitCheckDirFor("packages/api", 2),
    );
  });

  it("two different packages never collide on the same directory", () => {
    expect(unitCheckDirFor("packages/api", 1)).not.toBe(
      unitCheckDirFor("packages/db", 1),
    );
  });
});

describe("UNIT_CHECKS_ROOT_GLOB — one glob for every issue's unit check, anywhere", () => {
  it("PROVES THE INSTRUMENT: it matches a real unit check path", () => {
    expect(
      pathMatchesGlob(
        "packages/api/src/__checks__/issue-848/email-registry.test.ts",
        UNIT_CHECKS_ROOT_GLOB,
      ),
    ).toBe(true);
  });

  it("matches the check directory itself, not only files inside it", () => {
    expect(
      pathMatchesGlob(
        "packages/api/src/__checks__/issue-848",
        UNIT_CHECKS_ROOT_GLOB,
      ),
    ).toBe(true);
  });

  it("matches whatever `unitCheckDirFor` builds, for any package", () => {
    for (const dir of ["packages/api", "packages/os-shell", "packages/db"]) {
      expect(
        pathMatchesGlob(`${unitCheckDirFor(dir, 42)}/x.test.ts`, UNIT_CHECKS_ROOT_GLOB),
      ).toBe(true);
    }
  });

  it("does NOT match ordinary test material in __tests__", () => {
    expect(
      pathMatchesGlob(
        "packages/api/src/__tests__/x.test.ts",
        UNIT_CHECKS_ROOT_GLOB,
      ),
    ).toBe(false);
  });

  it("does NOT match a browser check — that is CHECKS_ROOT's job", () => {
    expect(
      pathMatchesGlob(
        "apps/nextjs/e2e/checks/issue-1/a.spec.ts",
        UNIT_CHECKS_ROOT_GLOB,
      ),
    ).toBe(false);
  });
});

describe("isSafeUnitCheckPackage — packages/* only, never apps/*", () => {
  it("accepts a real package directory", () => {
    expect(isSafeUnitCheckPackage("packages/api")).toBe(true);
    expect(isSafeUnitCheckPackage("packages/os-shell")).toBe(true);
  });

  it("REFUSES apps/* — a unit proof can never satisfy the browser demand an app touch creates", () => {
    expect(isSafeUnitCheckPackage("apps/nextjs")).toBe(false);
    expect(isSafeUnitCheckPackage("apps/expo")).toBe(false);
  });

  it("refuses anything that is not exactly two segments under packages/", () => {
    expect(isSafeUnitCheckPackage("packages")).toBe(false);
    expect(isSafeUnitCheckPackage("packages/")).toBe(false);
    expect(isSafeUnitCheckPackage("packages/api/src")).toBe(false);
    expect(isSafeUnitCheckPackage("tooling/vitest")).toBe(false);
    expect(isSafeUnitCheckPackage(".sandcastle")).toBe(false);
  });

  it("refuses traversal, absolutes and shell metacharacters", () => {
    expect(isSafeUnitCheckPackage("packages/..")).toBe(false);
    expect(isSafeUnitCheckPackage("../packages/api")).toBe(false);
    expect(isSafeUnitCheckPackage("/packages/api")).toBe(false);
    expect(isSafeUnitCheckPackage("packages/api; rm -rf /")).toBe(false);
    expect(isSafeUnitCheckPackage("packages/$(whoami)")).toBe(false);
  });

  it("refuses uppercase — package directories in this repo are lowercase", () => {
    expect(isSafeUnitCheckPackage("packages/API")).toBe(false);
  });

  it("refuses non-string input without throwing", () => {
    expect(isSafeUnitCheckPackage(undefined)).toBe(false);
    expect(isSafeUnitCheckPackage(42)).toBe(false);
    expect(isSafeUnitCheckPackage(null)).toBe(false);
  });
});

describe("isSafeUnitCheckRelativePath — whitelist, not a blacklist", () => {
  it("accepts a plain .test.ts filename", () => {
    expect(isSafeUnitCheckRelativePath("email-registry.test.ts")).toBe(true);
  });

  it("accepts one level of nesting", () => {
    expect(isSafeUnitCheckRelativePath("queue/email-registry.test.ts")).toBe(
      true,
    );
  });

  it("rejects path traversal", () => {
    expect(isSafeUnitCheckRelativePath("../../etc/passwd.test.ts")).toBe(false);
  });

  it("rejects a leading slash (absolute path)", () => {
    expect(isSafeUnitCheckRelativePath("/etc/passwd.test.ts")).toBe(false);
  });

  it("rejects spaces and shell metacharacters", () => {
    expect(isSafeUnitCheckRelativePath("email registry.test.ts")).toBe(false);
    expect(isSafeUnitCheckRelativePath("x.test.ts; rm -rf /")).toBe(false);
    expect(isSafeUnitCheckRelativePath("$(whoami).test.ts")).toBe(false);
    expect(isSafeUnitCheckRelativePath("x.test.ts && echo pwned")).toBe(false);
  });

  it("rejects a browser check's extension — the runner is the whole distinction", () => {
    expect(isSafeUnitCheckRelativePath("email-registry.spec.ts")).toBe(false);
  });

  it("rejects .test.tsx — a component test is a screen's business, not a unit check's", () => {
    expect(isSafeUnitCheckRelativePath("widget.test.tsx")).toBe(false);
  });

  it("rejects a bare name with no extension", () => {
    expect(isSafeUnitCheckRelativePath("email-registry")).toBe(false);
    expect(isSafeUnitCheckRelativePath("email-registry.ts")).toBe(false);
  });

  it("rejects non-string input without throwing", () => {
    expect(isSafeUnitCheckRelativePath(undefined)).toBe(false);
    expect(isSafeUnitCheckRelativePath(42)).toBe(false);
    expect(isSafeUnitCheckRelativePath(null)).toBe(false);
  });
});

describe("checkRelativePathPattern — the one shape both runners' path rules are cut from", () => {
  it("reproduces check-path.ts's browser rule exactly", () => {
    const re = checkRelativePathPattern(".spec.ts");
    expect(re.test("team-cash-flow.spec.ts")).toBe(true);
    expect(re.test("finance/team-cash-flow.spec.ts")).toBe(true);
    expect(re.test("/etc/passwd.spec.ts")).toBe(false);
    expect(re.test("x.spec.ts; rm -rf /")).toBe(false);
    expect(re.test("team-cash-flow.ts")).toBe(false);
  });

  it("the suffix is matched literally — its dots are not wildcards", () => {
    const re = checkRelativePathPattern(".test.ts");
    expect(re.test("xxtestxts")).toBe(false);
  });
});

describe("buildUnitCheckCommand", () => {
  const NONCE = "0123456789abcdef0123456789abcdef";
  const REPORT = `/tmp/sandcastle-check-${NONCE}.json`;

  it("builds the exact string the sandbox will receive", () => {
    expect(
      buildUnitCheckCommand("@acme/api", 848, "email-registry.test.ts", NONCE),
    ).toBe(
      "env CI=1 NO_COLOR=1 FORCE_COLOR=0 pnpm --filter @acme/api run test " +
        "src/__checks__/issue-848/email-registry.test.ts " +
        `--silent=true --reporter=default --reporter=json --outputFile=${REPORT}` +
        `; __sc_rc=$?; node -e "${[
          "const f=require('fs');",
          "let o=null;",
          `try{o=JSON.parse(f.readFileSync('${REPORT}','utf8'))}catch(e){}`,
          "const s=o&&o.stats;",
          "const n=(x)=>Number.isInteger(x)?x:-1;",
          "const p=s?n(s.expected):n(o&&o.numPassedTests);",
          "const q=s?n(s.unexpected):n(o&&o.numFailedTests);",
          "const k=s?n(s.skipped):n(o&&o.numPendingTests);",
          "const y=s?n(s.flaky):0;",
          `process.stdout.write('\\n${NONCE} sandcastle-run-evidence report='+(o?'ok':'missing')+`,
          "' exit=$__sc_rc passed='+p+' failed='+q+' skipped='+k+' flaky='+y+'\\n')",
        ].join("")}"` +
        `; rm -f ${REPORT}` +
        "; exit $__sc_rc",
    );
  });

  it("NEVER contains ` -- ` — pnpm passes it through and vitest ignores it, so the WHOLE package suite would run", () => {
    const cmd = buildUnitCheckCommand(
      "@acme/api",
      848,
      "email-registry.test.ts",
      NONCE,
    );
    expect(cmd).toBeDefined();
    expect(cmd).not.toContain(" -- ");
  });

  it("carries all three colour/watch variables the classifier depends on", () => {
    const cmd = buildUnitCheckCommand("@acme/db", 1, "x.test.ts", NONCE) ?? "";
    expect(cmd).toContain("CI=1");
    expect(cmd).toContain("NO_COLOR=1");
    expect(cmd).toContain("FORCE_COLOR=0");
  });

  it("keeps the DEFAULT reporter beside the json one — the run log still needs a readable failure", () => {
    const cmd = buildUnitCheckCommand("@acme/db", 1, "x.test.ts", NONCE) ?? "";
    expect(cmd).toContain("--reporter=default");
    expect(cmd).toContain("--reporter=json");
  });

  it("silences the check's own console with `--silent=true`, never a bare `--silent`", () => {
    // Defence in depth: it removes the cheapest forgery route outright. The
    // BARE form swallows the next argument — `--silent <path>` throws
    // `Unexpected value "--silent=<path>"` and the run never starts.
    const cmd = buildUnitCheckCommand("@acme/db", 1, "x.test.ts", NONCE) ?? "";
    expect(cmd).toContain("--silent=true");
    expect(cmd).not.toContain("--silent ");
  });

  it("PRESERVES THE RUNNER'S EXIT CODE — `timedOut` inference (exit 124/137) depends on it", () => {
    expect(buildUnitCheckCommand("@acme/db", 1, "x.test.ts", NONCE)).toMatch(
      /; exit \$__sc_rc$/,
    );
  });

  it("writes the report OUTSIDE the worktree — an untracked file there strands the whole run", () => {
    const cmd = buildUnitCheckCommand("@acme/db", 1, "x.test.ts", NONCE) ?? "";
    expect(cmd).toContain(`--outputFile=/tmp/sandcastle-check-${NONCE}.json`);
    expect(cmd).not.toContain("--outputFile=packages/");
  });

  it("returns undefined rather than interpolating an unsafe path", () => {
    expect(
      buildUnitCheckCommand("@acme/api", 848, "../../etc/passwd.test.ts", NONCE),
    ).toBeUndefined();
    expect(
      buildUnitCheckCommand("@acme/api", 848, "x.test.ts; rm -rf /", NONCE),
    ).toBeUndefined();
  });

  it("returns undefined rather than interpolating an unsafe package name", () => {
    expect(
      buildUnitCheckCommand("@acme/api; rm -rf /", 848, "x.test.ts", NONCE),
    ).toBeUndefined();
    expect(
      buildUnitCheckCommand("$(whoami)", 848, "x.test.ts", NONCE),
    ).toBeUndefined();
    expect(
      buildUnitCheckCommand("@acme/api && echo pwned", 848, "x.test.ts", NONCE),
    ).toBeUndefined();
  });

  it("returns undefined rather than interpolating a non-integer issue number", () => {
    expect(
      buildUnitCheckCommand("@acme/api", 1.5, "x.test.ts", NONCE),
    ).toBeUndefined();
    expect(
      buildUnitCheckCommand("@acme/api", -1, "x.test.ts", NONCE),
    ).toBeUndefined();
    expect(
      buildUnitCheckCommand("@acme/api", NaN, "x.test.ts", NONCE),
    ).toBeUndefined();
  });

  it("returns undefined rather than interpolating an unsafe nonce — it reaches a shell, a path AND a RegExp", () => {
    expect(buildUnitCheckCommand("@acme/api", 848, "x.test.ts", "")).toBeUndefined();
    expect(
      buildUnitCheckCommand("@acme/api", 848, "x.test.ts", "; rm -rf /"),
    ).toBeUndefined();
    expect(
      buildUnitCheckCommand("@acme/api", 848, "x.test.ts", "(.*)"),
    ).toBeUndefined();
  });
});

describe("resolveUnitCheckPackage — the HOST's observation, never the agent's claim", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "sandcastle-unit-check-pkg-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writePackage(
    dir: string,
    manifest: unknown,
    opts: { readonly vitestConfig?: string | null } = {},
  ): void {
    const abs = path.join(root, dir);
    mkdirSync(abs, { recursive: true });
    writeFileSync(path.join(abs, "package.json"), JSON.stringify(manifest));
    const cfg = opts.vitestConfig === undefined ? "vitest.config.ts" : opts.vitestConfig;
    if (cfg !== null) {
      writeFileSync(path.join(abs, cfg), "export default {};\n");
    }
  }

  const GOOD = {
    name: "@acme/api",
    scripts: { test: "vitest" },
  };

  it("PROVES THE INSTRUMENT: a well-formed package resolves to its npm name", () => {
    writePackage("packages/api", GOOD);
    expect(resolveUnitCheckPackage(root, "packages/api")).toEqual({
      packageName: "@acme/api",
    });
  });

  it("accepts any of the four vitest config extensions", () => {
    for (const cfg of [
      "vitest.config.ts",
      "vitest.config.mts",
      "vitest.config.js",
      "vitest.config.mjs",
    ]) {
      writePackage(`packages/p-${cfg.length}-${cfg.slice(-3)}`, GOOD, {
        vitestConfig: cfg,
      });
      expect(
        resolveUnitCheckPackage(root, `packages/p-${cfg.length}-${cfg.slice(-3)}`),
      ).toEqual({ packageName: "@acme/api" });
    }
  });

  it("refuses a directory shape the whitelist rejects", () => {
    writePackage("packages/api/src", GOOD);
    expect(resolveUnitCheckPackage(root, "packages/api/src")).toBeUndefined();
  });

  it("refuses apps/nextjs even when it is a perfectly good vitest package", () => {
    writePackage("apps/nextjs", { name: "@acme/nextjs", scripts: { test: "vitest" } });
    expect(resolveUnitCheckPackage(root, "apps/nextjs")).toBeUndefined();
  });

  it("refuses a package with no package.json at all", () => {
    mkdirSync(path.join(root, "packages/ghost"), { recursive: true });
    expect(resolveUnitCheckPackage(root, "packages/ghost")).toBeUndefined();
  });

  it("refuses a package.json that does not parse", () => {
    const abs = path.join(root, "packages/broken");
    mkdirSync(abs, { recursive: true });
    writeFileSync(path.join(abs, "package.json"), "{ not json");
    writeFileSync(path.join(abs, "vitest.config.ts"), "export default {};\n");
    expect(resolveUnitCheckPackage(root, "packages/broken")).toBeUndefined();
  });

  it("refuses a package.json with no `test` script", () => {
    writePackage("packages/notest", { name: "@acme/notest", scripts: { build: "tsc" } });
    expect(resolveUnitCheckPackage(root, "packages/notest")).toBeUndefined();
  });

  it("refuses a package.json whose `test` script is blank", () => {
    writePackage("packages/blank", { name: "@acme/blank", scripts: { test: "  " } });
    expect(resolveUnitCheckPackage(root, "packages/blank")).toBeUndefined();
  });

  it("refuses a package with NO vitest config — packages/email's exact shape", () => {
    writePackage("packages/email", { name: "@acme/email", scripts: { test: "echo none" } }, {
      vitestConfig: null,
    });
    expect(resolveUnitCheckPackage(root, "packages/email")).toBeUndefined();
  });

  it("refuses a name that fails SAFE_PACKAGE_NAME", () => {
    writePackage("packages/evil", { name: "@acme/api; rm -rf /", scripts: { test: "vitest" } });
    expect(resolveUnitCheckPackage(root, "packages/evil")).toBeUndefined();
  });

  it("refuses a manifest whose name is not a string", () => {
    writePackage("packages/unnamed", { name: 42, scripts: { test: "vitest" } });
    expect(resolveUnitCheckPackage(root, "packages/unnamed")).toBeUndefined();
    writePackage("packages/nameless", { scripts: { test: "vitest" } });
    expect(resolveUnitCheckPackage(root, "packages/nameless")).toBeUndefined();
  });

  it("never throws on a nonsense worktree path", () => {
    expect(() =>
      resolveUnitCheckPackage(path.join(root, "nope"), "packages/api"),
    ).not.toThrow();
    expect(
      resolveUnitCheckPackage(path.join(root, "nope"), "packages/api"),
    ).toBeUndefined();
  });
});

describe("missingUnitCheckRequirements — the anti-vacuity scan", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "sandcastle-unit-check-vacuity-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const PKG = "packages/api";
  const ISSUE = 848;
  const CHECK = "email-registry.test.ts";

  function write(body: string): void {
    const dir = path.join(root, unitCheckDirFor(PKG, ISSUE));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, CHECK), body);
  }

  function scan(): readonly string[] {
    return missingUnitCheckRequirements(root, PKG, ISSUE, CHECK);
  }

  it("PROVES THE INSTRUMENT: a relative import that escapes the check dir satisfies it", () => {
    write(
      `import { describe, expect, it } from "vitest";\n` +
        `import { emailRegistry } from "../../../services/email/queue.js";\n` +
        `it("x", () => { expect(emailRegistry).toBeDefined(); });\n`,
    );
    expect(scan()).toEqual([]);
  });

  it("a workspace alias import satisfies it", () => {
    write(
      `import { it } from "vitest";\n` +
        `import { db } from "@acme/db";\n` +
        `it("x", () => { db; });\n`,
    );
    expect(scan()).toEqual([]);
  });

  it("a bare side-effect import of product code satisfies it", () => {
    write(`import "../../../services/email/queue.js";\n`);
    expect(scan()).toEqual([]);
  });

  it("a dynamic import of product code satisfies it", () => {
    write(
      `import { it } from "vitest";\n` +
        `it("x", async () => { await import("../../../services/email/queue.js"); });\n`,
    );
    expect(scan()).toEqual([]);
  });

  it("importing ONLY vitest fails — a check bound to nothing cannot go red then green", () => {
    write(
      `import { describe, expect, it } from "vitest";\n` +
        `it("x", () => { expect(1 + 1).toBe(2); });\n`,
    );
    expect(scan()).toEqual([UNIT_CHECK_PRODUCT_IMPORT_REQUIREMENT]);
  });

  it("importing ONLY a node: builtin fails", () => {
    write(
      `import { readFileSync } from "node:fs";\n` +
        `import { it } from "vitest";\n` +
        `it("x", () => { readFileSync; });\n`,
    );
    expect(scan()).toEqual([UNIT_CHECK_PRODUCT_IMPORT_REQUIREMENT]);
  });

  it("a same-directory ./ import fails — that is the check's own scaffolding", () => {
    write(
      `import { it } from "vitest";\n` +
        `import { fixture } from "./fixture.js";\n` +
        `it("x", () => { fixture; });\n`,
    );
    expect(scan()).toEqual([UNIT_CHECK_PRODUCT_IMPORT_REQUIREMENT]);
  });

  it("a qualifying import inside a // comment does NOT count", () => {
    write(
      `import { it } from "vitest";\n` +
        `// import { queue } from "../../../services/email/queue.js";\n` +
        `it("x", () => { expect(1).toBe(1); });\n`,
    );
    expect(scan()).toEqual([UNIT_CHECK_PRODUCT_IMPORT_REQUIREMENT]);
  });

  it("a qualifying import inside a block comment does NOT count", () => {
    write(
      `import { it } from "vitest";\n` +
        `/* import { queue } from "../../../services/email/queue.js"; */\n` +
        `it("x", () => { expect(1).toBe(1); });\n`,
    );
    expect(scan()).toEqual([UNIT_CHECK_PRODUCT_IMPORT_REQUIREMENT]);
  });

  it("a qualifying import quoted inside a string literal does NOT count", () => {
    write(
      `import { it } from "vitest";\n` +
        `const source = "import { queue } from '../../../services/email/queue.js';";\n` +
        `it("x", () => { expect(source).toBeTruthy(); });\n`,
    );
    expect(scan()).toEqual([UNIT_CHECK_PRODUCT_IMPORT_REQUIREMENT]);
  });

  it("FAILS CLOSED: an unreadable / missing check file reports the requirement unmet", () => {
    expect(
      missingUnitCheckRequirements(root, PKG, ISSUE, "never-written.test.ts"),
    ).toEqual([UNIT_CHECK_PRODUCT_IMPORT_REQUIREMENT]);
  });

  it("FAILS CLOSED: an unsafe package dir or check path is refused without touching disk", () => {
    write(`import { q } from "../../../services/email/queue.js";\n`);
    expect(
      missingUnitCheckRequirements(root, "apps/nextjs", ISSUE, CHECK),
    ).toEqual([UNIT_CHECK_PRODUCT_IMPORT_REQUIREMENT]);
    expect(
      missingUnitCheckRequirements(root, PKG, ISSUE, "../../../../etc/passwd.test.ts"),
    ).toEqual([UNIT_CHECK_PRODUCT_IMPORT_REQUIREMENT]);
  });
});
