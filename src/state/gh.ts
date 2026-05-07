/**
 * gh CLI wrappers. Always invoked via execFile (NEVER exec) so that label
 * names, issue bodies, and comment text can't shell-inject. Every argument
 * is a separate argv entry — `gh` receives them verbatim.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const GH_BIN = "gh";
const DEFAULT_TIMEOUT_MS = 30_000;

interface RunResult {
  stdout: string;
  stderr: string;
}

async function runGh(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileP(GH_BIN, args, {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { stdout, stderr };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: string | number;
    };
    const stderr = typeof e.stderr === "string" ? e.stderr : "";
    const stdout = typeof e.stdout === "string" ? e.stdout : "";
    const code = e.code ?? "unknown";
    throw new Error(
      `gh ${args.join(" ")} failed (code=${String(code)}): ${stderr || stdout || e.message}`,
    );
  }
}

/**
 * Move a label on an issue. If `from === "*"`, only adds the new label (no
 * removal). Otherwise removes `from` and adds `to` in the same `gh issue edit`
 * call. Errors propagate — Track C decides whether label drift is fatal.
 */
export async function transitionLabel(
  issueNum: number,
  from: string,
  to: string,
): Promise<void> {
  if (!Number.isInteger(issueNum) || issueNum <= 0) {
    throw new Error(`transitionLabel: invalid issueNum '${issueNum}'`);
  }
  if (!to) {
    throw new Error("transitionLabel: 'to' label must be non-empty");
  }
  const args: string[] = ["issue", "edit", String(issueNum), "--add-label", to];
  if (from !== "*") {
    args.push("--remove-label", from);
  }
  await runGh(args);
}

/**
 * Close a GH issue with an optional comment.
 * `gh issue close <num> [--comment <body>]`.
 */
export async function closeIssue(
  issueNum: number,
  comment?: string,
): Promise<void> {
  if (!Number.isInteger(issueNum) || issueNum <= 0) {
    throw new Error(`closeIssue: invalid issueNum '${issueNum}'`);
  }
  const args: string[] = ["issue", "close", String(issueNum)];
  if (comment !== undefined && comment !== "") {
    args.push("--comment", comment);
  }
  await runGh(args);
}

/**
 * Fetch the body markdown of a GH issue. Used by the loop driver to pre-warm
 * the implementer/reviewer prompt so they never call `gh issue view` themselves.
 */
export async function getIssueBody(issueNum: number): Promise<string> {
  if (!Number.isInteger(issueNum) || issueNum <= 0) {
    throw new Error(`getIssueBody: invalid issueNum '${issueNum}'`);
  }
  const { stdout } = await runGh([
    "issue",
    "view",
    String(issueNum),
    "--json",
    "body",
    "--jq",
    ".body",
  ]);
  return stdout;
}
