/**
 * Spec #1334, slice SB: no GitHub key reaches a ticket's sandbox, and every
 * agent still reads its ticket.
 *
 * One sandbox per ticket, shared by every role (check-writer, builder,
 * reviewer, fixer), so the key is removed for the whole sandbox. It used to
 * reach it two ways on docker — the `GH_TOKEN` env var and a bind-mount of
 * the host's `~/.config/gh` login — and on mac-host the agent simply
 * inherited the host's environment and `gh` login. All of them are closed.
 *
 * The prompts used to load the ticket by running `gh issue view` INSIDE the
 * sandbox. With no key that command fails, and because it was piped into
 * `jq` the failure was invisible: the agent got a blank ticket and no error.
 * So the ticket text is now read on the host at claim time and handed to
 * every prompt as `{{ISSUE_SPEC}}`.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { git } from "./__fixtures__/git-repo.js";
import {
  IMPLEMENTER_HARD_CEILING_MESSAGE,
  initRepoWithOrigin,
  makeArgs,
  scriptedRun,
} from "./__fixtures__/scripted-run.mts";
import { agentChildEnv } from "./lib/mac-host-sandbox.js";
import { applyPromptArgs } from "./lib/prompt-args.js";
import { existingAuthMounts } from "./lib/sandbox-provider.js";
import { GITHUB_CREDENTIAL_ENV_KEYS } from "./lib/github-credential-env.js";
import { renderIssueSpec } from "./lib/state/issue-spec.js";
import { buildContainerEnv, runMain } from "./main.mts";

const HERE = import.meta.dirname;

const REAL_TOKEN = "ghp_real-host-token-must-never-cross";

/** Every GitHub credential variable, set to a value that would work. */
const HOST_GITHUB_ENV: Record<string, string> = Object.fromEntries(
  GITHUB_CREDENTIAL_ENV_KEYS.map((k) => [k, REAL_TOKEN]),
);

function promptFileFor(name: string): string {
  if (name.startsWith("check-writer")) return "check-writer-prompt.md";
  if (name.startsWith("implementer") || name.startsWith("fixer")) {
    // The fixer reuses the builder's prompt (spec #1334, SG).
    if (!name.startsWith("fixer-reviewer")) return "implement-prompt.md";
  }
  return "review-prompt.md";
}

/** The dispatches that run in the ticket's own sandbox — the merger and the
 *  post-merge pair are top-level runs on the run branch, with no ticket. */
function perTicket<T extends { name: string }>(prompts: readonly T[]): T[] {
  return prompts.filter((p) => p.name !== "merger" && !p.name.startsWith("post-merge"));
}

describe("every agent reads its ticket from the host, not from GitHub", () => {
  let repo = "";
  let cleanup: () => void = () => undefined;

  beforeEach(() => {
    ({ repo, cleanup } = initRepoWithOrigin("sb-github-key-"));
  });
  afterEach(() => cleanup());

  it("the check-writer, builder, reviewer and fixer prompts all carry the ticket's title, labels and body", async () => {
    const ISSUE = 93501;
    const branch = `agent/issue-${ISSUE}`;
    git(repo, "checkout", "-q", "-b", branch);
    const title = "Team totals count one Agent's $1,000 twice";
    const body = [
      "## What",
      "The Team total shows $2,000 for a single $1,000 deal.",
      "",
      "Call this: teamTotal(teamId)",
      "Called by: the Team dashboard",
      "Expect this: one $1,000 deal totals $1,000",
    ].join("\n");
    const { deps, captured } = scriptedRun({
      issueNumber: ISSUE,
      branch,
      worktreePath: repo,
      answers: { implementer: new Error(IMPLEMENTER_HARD_CEILING_MESSAGE) },
      deps: {
        getIssueSpec: async () => ({
          title,
          body,
          labels: ["ready-for-agent", "type:bug"],
        }),
      },
    });

    const result = await runMain(
      makeArgs({ repoRoot: repo, branch, iterations: 1, recoveryEnabled: true }),
      deps,
    );
    expect(result.shippedIssues).toEqual([ISSUE]);

    const roles = new Set(perTicket(captured.prompts).map((p) => promptFileFor(p.name)));
    expect(roles).toEqual(
      new Set(["check-writer-prompt.md", "implement-prompt.md", "review-prompt.md"]),
    );
    expect(captured.prompts.some((p) => p.name.startsWith("fixer"))).toBe(true);

    for (const p of perTicket(captured.prompts)) {
      const raw = readFileSync(path.join(HERE, promptFileFor(p.name)), "utf8");
      const rendered = applyPromptArgs(raw, { ...p.promptArgs });
      expect(rendered, p.name).toContain(`# ${title}`);
      expect(rendered, p.name).toContain("Labels: ready-for-agent, type:bug");
      expect(rendered, p.name).toContain(body);
      expect(rendered, p.name).not.toMatch(/!`gh /);
    }
  });

  it("a ticket whose text could not be read still names itself, never a blank ticket", async () => {
    const ISSUE = 93502;
    const branch = `agent/issue-${ISSUE}`;
    git(repo, "checkout", "-q", "-b", branch);
    const { deps, captured } = scriptedRun({
      issueNumber: ISSUE,
      title: "Fix the deal total",
      branch,
      worktreePath: repo,
      deps: {
        getIssueSpec: async () => {
          throw new Error("gh boom");
        },
      },
    });

    await runMain(makeArgs({ repoRoot: repo, branch, iterations: 1 }), deps);

    expect(perTicket(captured.prompts).length).toBeGreaterThan(0);
    for (const p of perTicket(captured.prompts)) {
      expect(p.promptArgs.ISSUE_SPEC, p.name).toContain("Fix the deal total");
      expect(p.promptArgs.ISSUE_SPEC, p.name).toMatch(/could not be read/);
    }
  });
});

describe("renderIssueSpec", () => {
  it("renders the same shape the old in-sandbox `gh … | jq` produced", () => {
    expect(
      renderIssueSpec({ title: "A title", labels: ["x", "type:bug"], body: "Body\ntext" }),
    ).toBe("# A title\n\nLabels: x, type:bug\n\nBody\ntext");
    expect(renderIssueSpec({ title: "T", labels: [], body: "" })).toBe("# T\n\nLabels: \n\n");
  });
});

describe("no prompt asks the sandbox to run gh", () => {
  const promptFiles = [
    ...readdirSync(HERE)
      .filter((f) => f.endsWith(".md"))
      .map((f) => path.join(HERE, f)),
    ...readdirSync(path.join(HERE, "variants")).flatMap((v) => {
      const dir = path.join(HERE, "variants", v, "overrides");
      try {
        return readdirSync(dir)
          .filter((f) => f.endsWith(".md"))
          .map((f) => path.join(dir, f));
      } catch {
        return [];
      }
    }),
  ];

  it("the probe sees the prompts it is meant to read", () => {
    expect(promptFiles.some((f) => f.endsWith("implement-prompt.md"))).toBe(true);
  });

  it.each(promptFiles)("%s", (file) => {
    const text = readFileSync(file, "utf8");
    // A `gh` shell block would expand to a blank ticket with no key.
    expect(text).not.toMatch(/!`gh\b/);
    if (text.includes("<issue-spec>")) expect(text).toContain("{{ISSUE_SPEC}}");
  });
});

describe("docker: neither route carries a GitHub key into the sandbox", () => {
  it("the sandbox env drops every GitHub key, from the host env and from the project .env", () => {
    const env = buildContainerEnv(
      { ...HOST_GITHUB_ENV, DATABASE_URL: "postgres://x" },
      {},
      { ...HOST_GITHUB_ENV },
    );
    for (const key of GITHUB_CREDENTIAL_ENV_KEYS) expect(env[key], key).toBeUndefined();
    expect(env.DATABASE_URL).toBe("postgres://x");
    expect(env.SANDCASTLE_PROJECT_DOTENV).toContain("DATABASE_URL");
    expect(JSON.stringify(env)).not.toContain(REAL_TOKEN);
  });

  it("the host's gh login folder is not mounted", () => {
    const mounts = existingAuthMounts(undefined, () => true, "/home/x", () => undefined);
    expect(mounts.length).toBeGreaterThan(0);
    for (const m of mounts) expect(m.hostPath).not.toContain(".config/gh");
  });
});

describe("mac-host: the agent inherits no GitHub key and no gh login", () => {
  it("strips every GitHub key the host env holds, from both sources", () => {
    const child = agentChildEnv(
      { ...HOST_GITHUB_ENV, PATH: "/usr/bin", HOME: "/Users/z" },
      { ...HOST_GITHUB_ENV, DATABASE_URL: "postgres://x" },
    );
    expect(JSON.stringify(child)).not.toContain(REAL_TOKEN);
    expect(child.PATH).toBe("/usr/bin");
    expect(child.DATABASE_URL).toBe("postgres://x");
  });

  it("pins gh to a token that is not a credential, so gh never falls back to the host's stored login", () => {
    const child = agentChildEnv({ HOME: "/Users/z" }, {});
    expect(child.GH_TOKEN).toBeDefined();
    expect(child.GH_TOKEN).not.toBe("");
    expect(child.GH_TOKEN).not.toBe(REAL_TOKEN);
    for (const key of GITHUB_CREDENTIAL_ENV_KEYS.filter((k) => k !== "GH_TOKEN")) {
      expect(child[key], key).toBeUndefined();
    }
  });
});
