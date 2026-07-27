/**
 * Unit tests for the bounded-output filter (Ticket 01 — loop-cost).
 *
 * The filter shrinks what the implementer agent SEES from a heavy command
 * (unit tests, lint, build, e2e) to a bounded head + tail + preserved
 * diagnostic lines, so the multi-turn conversation stops re-reading a
 * multi-thousand-line dump every turn (the ~60% cache-read cost driver).
 *
 * Contract exercised here:
 *   - short output passes through byte-for-byte unchanged;
 *   - long output is head+tail-bounded with a "… N lines omitted …" marker;
 *   - failure/error lines from the omitted middle are ALWAYS preserved;
 *   - summary/tally lines from the omitted middle are ALWAYS preserved;
 *   - the CLI entrypoint reads stdin and writes the bounded view to stdout;
 *   - piping a FAILING command through the CLI does NOT mask its exit code
 *     (pipefail pattern) — the reviewer's pass/fail detection must survive.
 */
import { execFileSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import {
  boundOutput,
  HEAD_LINES,
  TAIL_LINES,
} from "../.sandcastle/lib/bound-output.mjs";

const CLI = fileURLToPath(
  new URL("../.sandcastle/lib/bound-output.mjs", import.meta.url),
);

const OMISSION_RE = /…\s*\d+\s+lines omitted/;

function makeLines(n: number, prefix = "line"): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);
}

describe("boundOutput — short output", () => {
  it("passes empty input through unchanged", () => {
    expect(boundOutput("")).toBe("");
  });

  it("passes output at exactly HEAD+TAIL lines through unchanged", () => {
    const text = makeLines(HEAD_LINES + TAIL_LINES).join("\n");
    expect(boundOutput(text)).toBe(text);
    expect(boundOutput(text)).not.toMatch(OMISSION_RE);
  });

  it("preserves a trailing newline on short input", () => {
    const text = "a\nb\nc\n";
    expect(boundOutput(text)).toBe(text);
  });
});

describe("boundOutput — long output is head+tail bounded", () => {
  const total = HEAD_LINES + TAIL_LINES + 500;
  const text = makeLines(total).join("\n");
  const out = boundOutput(text);

  it("emits the omission marker with a line count", () => {
    expect(out).toMatch(OMISSION_RE);
  });

  it("keeps the first HEAD_LINES lines verbatim", () => {
    expect(out).toContain("line 1");
    expect(out).toContain(`line ${HEAD_LINES}`);
  });

  it("keeps the last TAIL_LINES lines verbatim", () => {
    expect(out).toContain(`line ${total}`);
    expect(out).toContain(`line ${total - TAIL_LINES + 1}`);
  });

  it("drops a benign middle line that is neither head, tail, nor diagnostic", () => {
    // line at index ~ HEAD+50 is deep in the omitted middle and benign.
    const midIdx = HEAD_LINES + 50;
    expect(out).not.toContain(`line ${midIdx} `); // trailing space avoids substring collisions
  });

  it("is dramatically smaller than the input", () => {
    expect(out.split("\n").length).toBeLessThan(total / 2);
  });
});

describe("boundOutput — diagnostic lines from the omitted middle survive", () => {
  it("preserves a failure line buried in the middle", () => {
    const lines = makeLines(HEAD_LINES + TAIL_LINES + 400);
    const marker = "FAIL src/widget.test.ts > renders the thing";
    lines[HEAD_LINES + 100] = marker;
    const out = boundOutput(lines.join("\n"));
    expect(out).toContain(marker);
  });

  it("preserves an Error line buried in the middle", () => {
    const lines = makeLines(HEAD_LINES + TAIL_LINES + 400);
    const marker = "  Error: Cannot find module './missing'";
    lines[HEAD_LINES + 120] = marker;
    const out = boundOutput(lines.join("\n"));
    expect(out).toContain(marker);
  });

  it("preserves a ✗-marked line buried in the middle", () => {
    const lines = makeLines(HEAD_LINES + TAIL_LINES + 400);
    const marker = "✗ should compute the total";
    lines[HEAD_LINES + 140] = marker;
    const out = boundOutput(lines.join("\n"));
    expect(out).toContain(marker);
  });

  it("preserves a test-tally summary line buried in the middle", () => {
    const lines = makeLines(HEAD_LINES + TAIL_LINES + 400);
    const marker = "Tests  3 failed | 117 passed (120)";
    lines[HEAD_LINES + 160] = marker;
    const out = boundOutput(lines.join("\n"));
    expect(out).toContain(marker);
  });

  it("does NOT preserve an ordinary passing test line from the middle", () => {
    const lines = makeLines(HEAD_LINES + TAIL_LINES + 400);
    const benign = "✓ renders quietly UNIQUEBENIGN";
    lines[HEAD_LINES + 180] = benign;
    const out = boundOutput(lines.join("\n"));
    expect(out).not.toContain("UNIQUEBENIGN");
  });
});

describe("bound-output CLI", () => {
  it("reads stdin and passes short input through unchanged", () => {
    const input = "hello\nworld\n";
    const out = execFileSync("node", [CLI], { input, encoding: "utf8" });
    expect(out).toBe(input);
  });

  it("bounds long stdin input", () => {
    const input = makeLines(HEAD_LINES + TAIL_LINES + 300).join("\n");
    const out = execFileSync("node", [CLI], { input, encoding: "utf8" });
    expect(out).toMatch(OMISSION_RE);
    expect(out.split("\n").length).toBeLessThan(HEAD_LINES + TAIL_LINES + 50);
  });

  it("exits 0 itself (never clobbers the pipeline's own status)", () => {
    const out = execFileSync("node", [CLI], { input: "x\n", encoding: "utf8" });
    expect(out).toBe("x\n");
  });
});

describe("exit-code preservation (pipefail pattern the prompt recommends)", () => {
  const q = JSON.stringify(CLI);

  it("propagates a FAILING command's exit code through the bound filter", () => {
    let code = 0;
    try {
      execSync(`set -o pipefail; { echo boom; exit 7; } | node ${q}`, {
        shell: "/bin/bash",
        stdio: "pipe",
      });
    } catch (err) {
      code = (err as { status?: number }).status ?? -1;
    }
    expect(code).toBe(7);
  });

  it("propagates a PASSING command's exit code (0) through the bound filter", () => {
    const code = (() => {
      try {
        execSync(`set -o pipefail; { echo ok; exit 0; } | node ${q}`, {
          shell: "/bin/bash",
          stdio: "pipe",
        });
        return 0;
      } catch (err) {
        return (err as { status?: number }).status ?? -1;
      }
    })();
    expect(code).toBe(0);
  });

  it("propagates the command's code through a tee (e2e pattern) too", () => {
    // e2e pattern: <cmd> 2>&1 | tee <fulllog> | <bound-filter>.
    // pipefail makes the pipeline exit non-zero when the FIRST stage fails,
    // and the reviewer still gets the FULL untruncated tee log.
    let code = 0;
    try {
      execSync(
        `set -o pipefail; { echo run; exit 3; } 2>&1 | tee /dev/null | node ${q}`,
        { shell: "/bin/bash", stdio: "pipe" },
      );
    } catch (err) {
      code = (err as { status?: number }).status ?? -1;
    }
    expect(code).toBe(3);
  });
});
