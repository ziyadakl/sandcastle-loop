/**
 * Tests for skill-discipline enforcement.
 *
 * `extractSkillInvocationsFromSession` parses the captured Claude Code
 * session JSONL produced by `@ai-hero/sandcastle`'s orchestrator (exposed
 * as `IterationResult.sessionFilePath`). It returns the ordered list of
 * `Skill()` tool-call invocations so the reviewer prompt has host-computed
 * ground truth rather than self-reported claims from the implementer.
 *
 * The prior implementation relied on the SDK's `onAgentStreamEvent`
 * callback, which is fed by `parseStreamJsonLine` in
 * `node_modules/@ai-hero/sandcastle/dist/AgentProvider.js`. That function
 * hardcodes a `TOOL_ARG_FIELDS` allowlist of `Bash`, `WebSearch`,
 * `WebFetch`, `Agent` — every other `tool_use` block (including `Skill`)
 * is silently dropped before a `tool_call` event ever fires. These tests
 * exercise the JSONL parser end-to-end so we know the skill list reaching
 * the reviewer is real.
 *
 * `filterPlanByTypeLabels` is exercised separately at the bottom of the
 * file (unchanged by the JSONL refactor — kept here for cohesion).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractSkillInvocationsFromSession,
  filterPlanByTypeLabels,
  resolveSessionFilePath,
  parseRequiredSkillsByType,
  validateRequiredSkillsInvoked,
  findLoadableRubrics,
  CritiqueCriticalError,
  critiqueErrorReasonCode,
} from "../.sandcastle/lib/skill-discipline.js";
import {
  runMain,
  type Deps,
  type SandcastleArgs,
  type SandboxRunSpec,
  type TopLevelRunSpec,
  type CreateSandboxSpec,
  type RunHandle,
  type SandboxHandle,
} from "../.sandcastle/main.mjs";

describe("extractSkillInvocationsFromSession", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sandcastle-skill-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writeFixture = (name: string, lines: readonly string[]): string => {
    const p = join(dir, name);
    writeFileSync(p, lines.join("\n"), "utf8");
    return p;
  };

  it("returns [] when sessionFilePath is undefined", () => {
    expect(extractSkillInvocationsFromSession(undefined)).toEqual([]);
  });

  it("returns [] when the file does not exist", () => {
    const ghost = join(dir, "does-not-exist.jsonl");
    expect(extractSkillInvocationsFromSession(ghost)).toEqual([]);
  });

  it("returns [] for an empty file", () => {
    const p = writeFixture("empty.jsonl", []);
    expect(extractSkillInvocationsFromSession(p)).toEqual([]);
  });

  it("returns [] when the file has no Skill tool_use blocks", () => {
    const p = writeFixture("no-skills.jsonl", [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "thinking..." },
            {
              type: "tool_use",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", content: "ok" }] },
      }),
    ]);
    expect(extractSkillInvocationsFromSession(p)).toEqual([]);
  });

  it("extracts a single Skill invocation", () => {
    const p = writeFixture("one-skill.jsonl", [
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg_x",
          content: [
            { type: "text", text: "I'll use the skill." },
            {
              type: "tool_use",
              id: "toolu_x",
              name: "Skill",
              input: { skill: "glass-morphism" },
            },
          ],
        },
      }),
    ]);
    expect(extractSkillInvocationsFromSession(p)).toEqual([
      "glass-morphism",
    ]);
  });

  it("preserves the order of multiple Skill invocations across lines", () => {
    const p = writeFixture("multi-skill.jsonl", [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Skill", input: { skill: "impeccable" } },
          ],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Skill", input: { skill: "layout" } },
          ],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Skill", input: { skill: "polish" } },
          ],
        },
      }),
    ]);
    expect(extractSkillInvocationsFromSession(p)).toEqual([
      "impeccable",
      "layout",
      "polish",
    ]);
  });

  it("returns only Skill names from a mixed tool_use stream, in order", () => {
    const p = writeFixture("mixed.jsonl", [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Bash", input: { command: "pwd" } },
            { type: "tool_use", name: "Skill", input: { skill: "critique" } },
            {
              type: "tool_use",
              name: "Read",
              input: { file_path: "/a/b.ts" },
            },
            { type: "tool_use", name: "Skill", input: { skill: "audit" } },
          ],
        },
      }),
    ]);
    expect(extractSkillInvocationsFromSession(p)).toEqual([
      "critique",
      "audit",
    ]);
  });

  it("skips malformed JSON lines and still extracts Skill names from valid lines", () => {
    const p = writeFixture("malformed.jsonl", [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Skill", input: { skill: "first" } },
          ],
        },
      }),
      "this is not json {{{",
      "{\"type\": \"assistant\", \"message\": {\"content\": [", // truncated
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Skill", input: { skill: "second" } },
          ],
        },
      }),
    ]);
    expect(extractSkillInvocationsFromSession(p)).toEqual([
      "first",
      "second",
    ]);
  });

  it("finds a Skill tool_use at a non-first position in the content array", () => {
    const p = writeFixture("not-first.jsonl", [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "ok" },
            { type: "text", text: "still thinking" },
            { type: "tool_use", name: "Bash", input: { command: "ls" } },
            {
              type: "tool_use",
              name: "Skill",
              input: { skill: "trailing-skill" },
            },
          ],
        },
      }),
    ]);
    expect(extractSkillInvocationsFromSession(p)).toEqual([
      "trailing-skill",
    ]);
  });

  it("ignores non-assistant message types (user/system)", () => {
    const p = writeFixture("non-assistant.jsonl", [
      JSON.stringify({ type: "system", subtype: "init", session_id: "x" }),
      JSON.stringify({
        type: "user",
        message: {
          content: [{ type: "tool_result", content: "irrelevant" }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Skill", input: { skill: "only-one" } },
          ],
        },
      }),
    ]);
    expect(extractSkillInvocationsFromSession(p)).toEqual(["only-one"]);
  });

  it("ignores Skill tool_use blocks with non-string skill input", () => {
    const p = writeFixture("bad-skill-input.jsonl", [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Skill", input: { skill: 42 } },
            { type: "tool_use", name: "Skill", input: {} },
            {
              type: "tool_use",
              name: "Skill",
              input: { skill: "valid-one" },
            },
          ],
        },
      }),
    ]);
    expect(extractSkillInvocationsFromSession(p)).toEqual(["valid-one"]);
  });
});

// Audit Issue 1 (2026-05-30) + container-slug fix (2026-06-05): the SDK only
// populates IterationResult.sessionFilePath when bindMountHandle is wired; on
// the worktree-copy pipeline it's undefined, so the gate must locate the
// session JSONL itself. Claude runs inside the sandbox at a different cwd than
// the host repoRoot, writing its JSONL under the CONTAINER slug
// (e.g. `-home-agent-workspace`), never the host slug
// (e.g. `-home-deploy-dev-affinity-tracker`). Reconstructing a host-cwd path
// can never match → zero skills read → every typed issue silently quarantines.
// Resolution locates the file by its globally-unique session id, scanning the
// project slugs via the SDK's findClaudeSessionOnHost — so the slug name is
// irrelevant and host/container/mac-host are handled uniformly.
describe("resolveSessionFilePath", () => {
  let projectsDir: string;
  beforeEach(() => {
    projectsDir = mkdtempSync(join(tmpdir(), "sandcastle-projects-"));
  });
  afterEach(() => {
    rmSync(projectsDir, { recursive: true, force: true });
  });

  const writeSession = (slug: string, sessionId: string): string => {
    const slugDir = join(projectsDir, slug);
    mkdirSync(slugDir, { recursive: true });
    const p = join(slugDir, `${sessionId}.jsonl`);
    writeFileSync(p, "", "utf8");
    return p;
  };

  it("returns sessionFilePath verbatim when the SDK provided one", async () => {
    const explicit = "/some/sdk/chosen/path.jsonl";
    await expect(
      resolveSessionFilePath(
        { sessionFilePath: explicit, sessionId: "abc-123" },
        projectsDir,
      ),
    ).resolves.toBe(explicit);
  });

  it("treats an empty sessionFilePath as absent and falls back to the by-id scan", async () => {
    const p = writeSession("-home-agent-workspace", "s2");
    await expect(
      resolveSessionFilePath({ sessionFilePath: "", sessionId: "s2" }, projectsDir),
    ).resolves.toBe(p);
  });

  it("finds the JSONL by session id when it was written under the container cwd slug", async () => {
    // The regression: the host repoRoot slug would be
    // `-home-deploy-dev-affinity-tracker`, but Claude wrote under the
    // container slug. By-id resolution finds it regardless of slug.
    const sessionId = "de9814f3-aaaa-bbbb-cccc-000000000000";
    const p = writeSession("-home-agent-workspace", sessionId);
    await expect(
      resolveSessionFilePath({ sessionId }, projectsDir),
    ).resolves.toBe(p);
  });

  it("finds the JSONL under a host worktree slug too (mac-host profile parity)", async () => {
    const p = writeSession("-Users-ziyadakl-Dev-Sandcastle", "abc-123");
    await expect(
      resolveSessionFilePath({ sessionId: "abc-123" }, projectsDir),
    ).resolves.toBe(p);
  });

  it("returns undefined when no session with that id exists under projectsDir", async () => {
    writeSession("-home-agent-workspace", "present-id");
    await expect(
      resolveSessionFilePath({ sessionId: "absent-id" }, projectsDir),
    ).resolves.toBeUndefined();
  });

  it("returns undefined when neither sessionFilePath nor sessionId is available", async () => {
    await expect(resolveSessionFilePath({}, projectsDir)).resolves.toBeUndefined();
    await expect(
      resolveSessionFilePath({ sessionId: "" }, projectsDir),
    ).resolves.toBeUndefined();
  });
});

describe("filterPlanByTypeLabels", () => {
  it("includes tickets that have a type: label", () => {
    const issues = [
      { id: "71", title: "new ui", branch: "agent/issue-71" },
    ];
    const labelLookup = new Map<string, readonly string[]>([
      ["71", ["ready-for-agent", "type:new-component"]],
    ]);
    const r = filterPlanByTypeLabels(issues, labelLookup, true);
    expect(r.kept).toEqual(issues);
    expect(r.excluded).toEqual([]);
  });

  it("excludes tickets missing a type: label when SANDCASTLE.md exists", () => {
    const issues = [
      { id: "72", title: "broken backend", branch: "agent/issue-72" },
    ];
    const labelLookup = new Map<string, readonly string[]>([
      ["72", ["ready-for-agent"]],
    ]);
    const r = filterPlanByTypeLabels(issues, labelLookup, true);
    expect(r.kept).toEqual([]);
    expect(r.excluded).toEqual([
      { id: "72", reason: "missing type: label" },
    ]);
  });

  it("excludes tickets with multiple type: labels (config error)", () => {
    const issues = [
      { id: "73", title: "ambiguous", branch: "agent/issue-73" },
    ];
    const labelLookup = new Map<string, readonly string[]>([
      [
        "73",
        ["ready-for-agent", "type:new-component", "type:backend"],
      ],
    ]);
    const r = filterPlanByTypeLabels(issues, labelLookup, true);
    expect(r.kept).toEqual([]);
    expect(r.excluded).toEqual([
      { id: "73", reason: "multiple type: labels" },
    ]);
  });

  it("does NOT filter when sandcastleMdExists is false (backward compat)", () => {
    const issues = [
      { id: "74", title: "no sandcastle", branch: "agent/issue-74" },
    ];
    const labelLookup = new Map<string, readonly string[]>([
      ["74", ["ready-for-agent"]],
    ]);
    const r = filterPlanByTypeLabels(issues, labelLookup, false);
    expect(r.kept).toEqual(issues);
    expect(r.excluded).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Integration tests for the orchestrator gate
// ---------------------------------------------------------------------------
//
// These exercise the actual `runMain` branch that fetches labels via
// `deps.listIssuesByLabel` and filters the planner's picks before they reach
// `deps.claim`. The unit tests above cover the filter in isolation; the gate
// has its own logic (existsSync(SANDCASTLE.md), the `plan.length > 0` guard,
// the fail-loud throw on listIssuesByLabel failure) that none of them touch
// — which is precisely the surface where the last critical review finding
// (silent zero-issue iteration on gh-auth failure) lived.
//
// The harness is a minimal hand-rolled `Deps` stub. It doesn't try to mirror
// the full mock surface from `tests/main.test.ts` — we only need claim spies,
// a configurable `listIssuesByLabel`, and just-enough run/sandbox stubs to
// let dispatched issues run through to a clean quarantine (HAS_BLOCKERS
// reviewer with retry+recovery off). "Dispatched" is observed via
// `deps.claim` calls — that's the first thing `runMain` does after the gate
// passes (see line 3237 of main.mts).

interface GateRunCall {
  readonly name: string;
  readonly kind: "top-level" | "sandbox";
}

interface GateMockState {
  claims: number[];
  runCalls: GateRunCall[];
  listLabelCalls: string[];
  quarantines: number[];
  releases: { issue: number; reason: string }[];
  logs: string[];
  errors: string[];
}

interface GateDepsBuilder {
  readonly state: GateMockState;
  readonly deps: Deps;
  enqueue(name: string, outcome: GateRunOutcome): void;
}

type GateRunOutcome =
  | {
      readonly stdout: string;
      readonly commits?: readonly { sha: string }[];
      readonly throw?: undefined;
    }
  | { readonly throw: Error };

interface GateBuildOpts {
  /** Stub for `deps.listIssuesByLabel`. Default returns `[]`. */
  readonly listIssuesByLabel?: (
    label: string,
  ) => Promise<readonly { number: number; title: string; labels: readonly string[] }[]>;
}

function buildGateDeps(opts: GateBuildOpts = {}): GateDepsBuilder {
  const state: GateMockState = {
    claims: [],
    runCalls: [],
    listLabelCalls: [],
    quarantines: [],
    releases: [],
    logs: [],
    errors: [],
  };
  const queues = new Map<string, GateRunOutcome[]>();

  const popOutcome = (name: string): GateRunOutcome => {
    const q = queues.get(name);
    if (!q || q.length === 0) {
      throw new Error(
        `gate-mock deps: no queued outcome for run name=${name}`,
      );
    }
    return q.shift()!;
  };

  const handleOutcome = (outcome: GateRunOutcome): RunHandle => {
    if (outcome.throw) throw outcome.throw;
    return { stdout: outcome.stdout, commits: outcome.commits ?? [] };
  };

  const deps: Deps = {
    async run(spec: TopLevelRunSpec): Promise<RunHandle> {
      state.runCalls.push({ name: spec.name, kind: "top-level" });
      return handleOutcome(popOutcome(spec.name));
    },
    async createSandbox(spec: CreateSandboxSpec): Promise<SandboxHandle> {
      const branch = spec.branch;
      const handle: SandboxHandle = {
        branch,
        worktreePath: "/mock/worktree",
        async run(rspec: SandboxRunSpec): Promise<RunHandle> {
          state.runCalls.push({ name: rspec.name, kind: "sandbox" });
          return handleOutcome(popOutcome(rspec.name));
        },
        async close() {
          return {};
        },
      };
      return handle;
    },
    async claim(n) {
      state.claims.push(n);
    },
    async markDone(_n, _summary) {
      // unused — gate tests route every dispatched issue to quarantine.
    },
    async markMergedToStaging(_n) {
      // unused
    },
    async promoteStagingToDone(_ns, _summary) {
      return { failed: [] };
    },
    async quarantine(n, _reason) {
      state.quarantines.push(n);
    },
    async release(n, reason) {
      state.releases.push({ issue: n, reason });
    },
    async comment(_n, _body) {
      // unused
    },
    async listIssuesByLabel(label) {
      state.listLabelCalls.push(label);
      if (!opts.listIssuesByLabel) return [];
      // Real gh filters by label — keep the stub honest so callers like
      // runMain's startup reconciliation (which queries `in-progress`)
      // don't see issues that only carry `ready-for-agent`.
      const all = await opts.listIssuesByLabel(label);
      return all.filter((issue) => issue.labels.includes(label));
    },
    async listOpenIssuesWithBodies() {
      // Issue E: gate tests never reach the blocked-by exit path; default [].
      return [];
    },
    async applyMigrations(_repoRoot, _preSha, _postSha) {
      return { applied: 0, realErrors: [] };
    },
    async validateMigrationJournal(_repoRoot, _preSha, _postSha) {
      return [];
    },
    async checkLintCert(_repoRoot, _preSha, _postSha) {
      // Skill-discipline gate tests don't exercise the lint gate; stay dormant.
      return { status: "dormant" };
    },
    async captureSha(_w) {
      return "sha-x";
    },
    log(line) {
      state.logs.push(line);
    },
    logError(line) {
      state.errors.push(line);
    },
  };

  return {
    state,
    deps,
    enqueue(name, outcome) {
      const q = queues.get(name) ?? [];
      q.push(outcome);
      queues.set(name, q);
    },
  };
}

function gateBaseArgs(over: Partial<SandcastleArgs> = {}): SandcastleArgs {
  return {
    iterations: 1,
    repoRoot: "/repo",
    branch: "feature/work",
    label: "ready-for-agent",
    maxConcurrent: 3,
    imageName: "sandcastle:test",
    plannerModel: "claude-opus-4-8",
    implementerModel: "claude-sonnet-4-6",
    reviewerModel: "claude-haiku-4-5",
    critiqueModel: "claude-haiku-4-5",
    mergerModel: "claude-opus-4-8",
    postMergeReviewerModel: "claude-opus-4-8",
    recoveryModel: "claude-opus-4-8",
    implementerTimeoutSec: 1200,
    reviewerTimeoutSec: 600,
    hardCeilingSec: 3600,
    consecutiveFailureLimit: 99,
    dryRun: false,
    // The whole point: retry/recovery off so an implementer error or a
    // HAS_BLOCKERS reviewer routes straight to quarantine with no further
    // queue plumbing required.
    recoveryEnabled: false,
    retryEnabled: false,
    stagingEnabled: false,
    allowDirtySandcastle: false,
    sandbox: "docker",
    ...over,
  };
}

function gatePlannerStdout(
  issues: { id: string; title: string; branch: string }[],
): string {
  return `<plan>${JSON.stringify({ issues })}</plan>`;
}

/**
 * Queue the per-issue pipeline for an issue that the gate keeps. The pipeline
 * routes to quarantine via HAS_BLOCKERS on the first reviewer pass — no retry,
 * no recovery, no merger required. We only care that `deps.claim(n)` fires;
 * how the pipeline ends is irrelevant to the gate assertions.
 */
function enqueueQuarantinePipeline(b: GateDepsBuilder): void {
  b.enqueue("implementer", {
    stdout:
      "Cannot reach the feature.\n\n<promise>HALT</promise>",
    commits: [{ sha: "wip-checkpoint" }],
  });
  b.enqueue("reviewer", {
    stdout: "Commit body has no certification block.\n\nHAS_BLOCKERS",
  });
}

describe("orchestrator gate — runMain integration", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sandcastle-gate-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writeSandcastleMd = (): void => {
    writeFileSync(
      join(dir, "SANDCASTLE.md"),
      "# Skill discipline\nEnforced.\n",
      "utf8",
    );
  };

  it("no SANDCASTLE.md → all planner-picked issues dispatched, listIssuesByLabel not called", async () => {
    const b = buildGateDeps({
      // If the gate is wrongly entered when SANDCASTLE.md is absent, this
      // throw makes the regression loud (the assertion below also catches
      // it, but the throw turns a silent skip into an immediate failure).
      listIssuesByLabel: async () => {
        throw new Error("gate must not call listIssuesByLabel without SANDCASTLE.md");
      },
    });
    b.enqueue("planner", {
      stdout: gatePlannerStdout([
        { id: "501", title: "alpha", branch: "agent/issue-501" },
        { id: "502", title: "beta", branch: "agent/issue-502" },
      ]),
    });
    enqueueQuarantinePipeline(b);
    enqueueQuarantinePipeline(b);
    // Iteration 2 plans empty → clean exit.
    b.enqueue("planner", { stdout: gatePlannerStdout([]) });

    const result = await runMain(
      gateBaseArgs({ iterations: 2, repoRoot: dir }),
      b.deps,
    );

    expect(result.exitCode).toBe(0);
    // Startup reconciliation always queries `in-progress` to release
    // orphans from a prior killed run; the SANDCASTLE.md gate then
    // queries `ready-for-agent` only when SANDCASTLE.md exists. No
    // SANDCASTLE.md here → only the reconciliation call.
    expect(b.state.listLabelCalls).toEqual(["in-progress"]);
    expect(b.state.claims.sort((a, b) => a - b)).toEqual([501, 502]);
  });

  it("SANDCASTLE.md exists, all picks have type: labels → all dispatched", async () => {
    writeSandcastleMd();
    const b = buildGateDeps({
      listIssuesByLabel: async () => [
        {
          number: 601,
          title: "ui ticket",
          labels: ["ready-for-agent", "type:new-component"],
        },
        {
          number: 602,
          title: "backend ticket",
          labels: ["ready-for-agent", "type:backend"],
        },
      ],
    });
    b.enqueue("planner", {
      stdout: gatePlannerStdout([
        { id: "601", title: "ui ticket", branch: "agent/issue-601" },
        { id: "602", title: "backend ticket", branch: "agent/issue-602" },
      ]),
    });
    enqueueQuarantinePipeline(b);
    enqueueQuarantinePipeline(b);
    b.enqueue("planner", { stdout: gatePlannerStdout([]) });

    const result = await runMain(
      gateBaseArgs({ iterations: 2, repoRoot: dir }),
      b.deps,
    );

    expect(result.exitCode).toBe(0);
    // Startup reconciliation prepends `in-progress`; SANDCASTLE.md gate
    // appends `ready-for-agent`.
    expect(b.state.listLabelCalls).toEqual(["in-progress", "ready-for-agent"]);
    expect(b.state.claims.sort((a, b) => a - b)).toEqual([601, 602]);
  });

  it("SANDCASTLE.md exists, picks missing type: → only labeled dispatched, excluded ones logged with reason", async () => {
    writeSandcastleMd();
    const b = buildGateDeps({
      listIssuesByLabel: async () => [
        {
          number: 701,
          title: "ui ticket",
          labels: ["ready-for-agent", "type:bugfix-ui"],
        },
        {
          number: 702,
          title: "no type label",
          labels: ["ready-for-agent"],
        },
        {
          number: 703,
          title: "backend ticket",
          labels: ["ready-for-agent", "type:backend"],
        },
      ],
    });
    b.enqueue("planner", {
      stdout: gatePlannerStdout([
        { id: "701", title: "ui ticket", branch: "agent/issue-701" },
        { id: "702", title: "no type label", branch: "agent/issue-702" },
        { id: "703", title: "backend ticket", branch: "agent/issue-703" },
      ]),
    });
    // Only #701 and #703 are kept by the gate, so only two pipelines run.
    enqueueQuarantinePipeline(b);
    enqueueQuarantinePipeline(b);
    b.enqueue("planner", { stdout: gatePlannerStdout([]) });

    const result = await runMain(
      gateBaseArgs({ iterations: 2, repoRoot: dir }),
      b.deps,
    );

    expect(result.exitCode).toBe(0);
    // Startup reconciliation prepends `in-progress`; SANDCASTLE.md gate
    // appends `ready-for-agent`.
    expect(b.state.listLabelCalls).toEqual(["in-progress", "ready-for-agent"]);
    expect(b.state.claims.sort((a, b) => a - b)).toEqual([701, 703]);
    expect(b.state.claims).not.toContain(702);
    // The orchestrator logs an explicit `skipping issue #N — <reason>` line
    // for every excluded issue (see runMain around line 3319). A future
    // refactor that drops the log silently would still keep dispatch
    // correct but would harm operator visibility — keep the assertion to
    // anchor the contract.
    expect(
      b.state.logs.some((l) => /skipping issue #702 — missing type: label/.test(l)),
    ).toBe(true);
  });

  it("SANDCASTLE.md exists, listIssuesByLabel throws → fails loud with SKILL_DISCIPLINE_GATE_FAILURE prefix", async () => {
    writeSandcastleMd();
    const b = buildGateDeps({
      listIssuesByLabel: async () => {
        throw new Error("gh auth flaky: token expired");
      },
    });
    b.enqueue("planner", {
      stdout: gatePlannerStdout([
        { id: "801", title: "anything", branch: "agent/issue-801" },
      ]),
    });

    // The throw must escape runMain (no swallowing catch upstream — outer is
    // `try { ... } finally { ... }`, no catch). Anything quieter — a logged
    // warning + early return 0 — is exactly the regression this test guards
    // against.
    await expect(
      runMain(gateBaseArgs({ iterations: 1, repoRoot: dir }), b.deps),
    ).rejects.toThrow(/^SKILL_DISCIPLINE_GATE_FAILURE:/);
    // No claim should have fired: the gate failed before dispatch.
    expect(b.state.claims).toEqual([]);
    // logError must carry the same prefixed message so operators can grep.
    expect(
      b.state.errors.some((e) => /^SKILL_DISCIPLINE_GATE_FAILURE:/.test(e)),
    ).toBe(true);
  });
});

describe("startup reconciliation — releases orphaned in-progress issues", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sandcastle-reconcile-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("two orphaned in-progress issues → both released back to ready-for-agent before iteration 1", async () => {
    // Stub returns orphans only when queried by `in-progress` label (the
    // helper filters via the issue's own labels — see buildGateDeps).
    const b = buildGateDeps({
      listIssuesByLabel: async () => [
        {
          number: 401,
          title: "left in-progress by killed loop",
          labels: ["in-progress"],
        },
        {
          number: 402,
          title: "also orphaned",
          labels: ["in-progress"],
        },
      ],
    });
    // Iteration 1: planner immediately reports empty plan so the run
    // exits cleanly after reconciliation runs.
    b.enqueue("planner", { stdout: gatePlannerStdout([]) });

    const result = await runMain(
      gateBaseArgs({ iterations: 1, repoRoot: dir }),
      b.deps,
    );

    expect(result.exitCode).toBe(0);
    // Both orphans released, with a reason mentioning reconciliation so
    // operators reading the GitHub comment know why their issue bounced.
    expect(b.state.releases.map((r) => r.issue).sort((a, b) => a - b)).toEqual([
      401, 402,
    ]);
    expect(
      b.state.releases.every((r) => /startup-reconcile/.test(r.reason)),
    ).toBe(true);
    // First listIssuesByLabel call is the reconciliation query.
    expect(b.state.listLabelCalls[0]).toBe("in-progress");
  });

  it("no orphans → reconciliation queries `in-progress` but skips releases", async () => {
    const b = buildGateDeps({
      // No issues anywhere — reconciliation finds nothing.
      listIssuesByLabel: async () => [],
    });
    b.enqueue("planner", { stdout: gatePlannerStdout([]) });

    const result = await runMain(
      gateBaseArgs({ iterations: 1, repoRoot: dir }),
      b.deps,
    );

    expect(result.exitCode).toBe(0);
    expect(b.state.releases).toEqual([]);
    expect(b.state.listLabelCalls).toEqual(["in-progress"]);
    // Log line confirming the no-orphans path fired (helps operators
    // tell "reconciliation ran and found nothing" from "reconciliation
    // never ran" in startup logs).
    expect(
      b.state.logs.some((l) =>
        /startup reconciliation: no orphaned in-progress issues/.test(l),
      ),
    ).toBe(true);
  });

  it("listIssuesByLabel throws → startup continues (don't block the loop on a transient gh failure)", async () => {
    const b = buildGateDeps({
      listIssuesByLabel: async () => {
        throw new Error("gh: transient 502");
      },
    });
    b.enqueue("planner", { stdout: gatePlannerStdout([]) });

    const result = await runMain(
      gateBaseArgs({ iterations: 1, repoRoot: dir }),
      b.deps,
    );

    // Exit clean — reconciliation failure should not crash startup. The
    // first iteration's planner call will surface the same gh problem
    // more visibly if it persists.
    expect(result.exitCode).toBe(0);
    expect(b.state.releases).toEqual([]);
    // The skip log carries the underlying error message so an operator
    // grepping startup logs can see why reconciliation didn't run.
    expect(
      b.state.logs.some((l) =>
        /startup reconciliation skipped: listIssuesByLabel failed: gh: transient 502/.test(
          l,
        ),
      ),
    ).toBe(true);
  });
});

describe("sandbox-health stall-streak detector", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sandcastle-stall-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Hard-ceiling message matches main.mts STALL_RE — kept as a constant so
  // a test failure with a near-miss message is obviously about the regex
  // rather than the streak logic.
  const STALL_MSG =
    "hard ceiling: implementer exceeded 1200s wall-clock — SDK idle timer never fired (likely OOM-of-child or trickle-output hang)";

  it("three consecutive all-stall iterations → exits with code 2 + restart-docker message", async () => {
    const b = buildGateDeps({ listIssuesByLabel: async () => [] });
    // Each of the 3 iterations: planner picks one issue, implementer throws
    // a stall-shaped error → catch detects stalled=true → quarantine.
    for (let i = 1; i <= 3; i++) {
      const id = String(900 + i);
      b.enqueue("planner", {
        stdout: gatePlannerStdout([
          { id, title: `stall ${i}`, branch: `agent/issue-${id}` },
        ]),
      });
      b.enqueue("implementer", { throw: new Error(STALL_MSG) });
    }

    // iterations=5 to prove the detector exits BEFORE iterations 4 and 5
    // would have run.
    const result = await runMain(
      gateBaseArgs({ iterations: 5, repoRoot: dir }),
      b.deps,
    );

    expect(result.exitCode).toBe(2);
    expect(result.iterationsRun).toBe(3);
    // Three quarantines (one per iteration) — confirms the pipeline
    // actually reached its quarantine path each time, not some earlier
    // exit.
    expect(b.state.quarantines.sort((a, b) => a - b)).toEqual([901, 902, 903]);
    // The error log carries the canonical "restart docker" wording so an
    // operator scrolling the loop output sees what to do next.
    expect(
      b.state.errors.some(
        (e) =>
          /sandbox-health:\s+3 consecutive iterations stalled/.test(e) &&
          /restart docker/i.test(e),
      ),
    ).toBe(true);
  });

  it("stall iteration then HAS_BLOCKERS iteration → streak resets (HAS_BLOCKERS is not a stall)", async () => {
    const b = buildGateDeps({ listIssuesByLabel: async () => [] });

    // Iter 1: implementer stalls → quarantine, stalled=true → streak=1.
    b.enqueue("planner", {
      stdout: gatePlannerStdout([
        { id: "911", title: "iter 1 stalls", branch: "agent/issue-911" },
      ]),
    });
    b.enqueue("implementer", { throw: new Error(STALL_MSG) });

    // Iter 2: implementer returns HALT, reviewer marks HAS_BLOCKERS → also
    // quarantines, but stalled remains undefined (catch path NOT taken;
    // straight reviewer-rejection path returns stalled-less outcome).
    // Streak should reset to 0.
    b.enqueue("planner", {
      stdout: gatePlannerStdout([
        { id: "912", title: "iter 2 HAS_BLOCKERS", branch: "agent/issue-912" },
      ]),
    });
    enqueueQuarantinePipeline(b);

    // Iter 3: empty plan → clean exit.
    b.enqueue("planner", { stdout: gatePlannerStdout([]) });

    const result = await runMain(
      gateBaseArgs({ iterations: 5, repoRoot: dir }),
      b.deps,
    );

    expect(result.exitCode).toBe(0);
    // No threshold-trip error message — proves the streak didn't reach 3.
    expect(
      b.state.errors.some((e) =>
        /sandbox-health:\s+3 consecutive iterations stalled/.test(e),
      ),
    ).toBe(false);
    // The reset log fires in iteration 2 — proves the detector actually
    // saw iter 1 as a stall, then iter 2 cleared the streak.
    expect(
      b.state.logs.some((l) =>
        /sandbox-health:\s+stall streak reset at 1/.test(l),
      ),
    ).toBe(true);
  });

  it("one all-stall iteration alone → streak=1, loop continues to next iteration (no premature exit)", async () => {
    const b = buildGateDeps({ listIssuesByLabel: async () => [] });

    // Iter 1: stall → streak=1 but BELOW the threshold of 3.
    b.enqueue("planner", {
      stdout: gatePlannerStdout([
        { id: "921", title: "single stall", branch: "agent/issue-921" },
      ]),
    });
    b.enqueue("implementer", { throw: new Error(STALL_MSG) });

    // Iter 2: empty plan → clean exit (no more pipelines to run).
    b.enqueue("planner", { stdout: gatePlannerStdout([]) });

    const result = await runMain(
      gateBaseArgs({ iterations: 5, repoRoot: dir }),
      b.deps,
    );

    // Crucial: exit 0, NOT 2. A single stall must not trip the breaker.
    expect(result.exitCode).toBe(0);
    expect(result.iterationsRun).toBe(2);
    // The streak-increment log confirms the detector ran and counted 1.
    expect(
      b.state.logs.some((l) =>
        /sandbox-health:\s+iteration 1 all-stalled \(streak 1\/3\)/.test(l),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Critique-as-gate library additions (ported from affinity-tracker @31631acb)
// ---------------------------------------------------------------------------

describe("parseRequiredSkillsByType", () => {
  it("extracts skills from a Required: bullet list, dropping descriptive prose after the first token", () => {
    const md = [
      "### type:new-component",
      "",
      "Required:",
      "",
      "- impeccable (load design context — prerequisite for all design skills)",
      "- layout (composition and spacing)",
      "- clarify (microcopy)",
      "",
      "Opt in via `tool:` labels on the ticket:",
      "",
      "- tool:bento → magic-bento",
    ].join("\n");
    const parsed = parseRequiredSkillsByType(md);
    expect(parsed.get("type:new-component")).toEqual([
      "impeccable",
      "layout",
      "clarify",
    ]);
  });

  it("returns [] for Required: (none) (e.g. type:cleanup)", () => {
    const md = [
      "### type:cleanup",
      "",
      "Removing dead code or dev-only data.",
      "Required: (none)",
      "",
      "### type:other",
      "",
      "Required:",
      "",
      "- simplify",
    ].join("\n");
    const parsed = parseRequiredSkillsByType(md);
    expect(parsed.get("type:cleanup")).toEqual([]);
    expect(parsed.get("type:other")).toEqual(["simplify"]);
  });

  it("ignores tool: opt-in bullets so they never leak into the required set", () => {
    const md = [
      "### type:visual-enhance",
      "",
      "Required:",
      "",
      "- impeccable",
      "- polish",
      "",
      "Opt in (pick whichever applies):",
      "",
      "- bolder, quieter, colorize",
      "- tool:audit, tool:critique",
    ].join("\n");
    const parsed = parseRequiredSkillsByType(md);
    // Only the bullets BEFORE the "Opt in" line count as required.
    expect(parsed.get("type:visual-enhance")).toEqual(["impeccable", "polish"]);
  });

  it("matches both 'Required:' and 'Required critique dimensions:' block headers", () => {
    const md = [
      "### type:backend",
      "",
      "Required critique dimensions:",
      "",
      "- simplify",
      "- context7-docs (backend writes the highest density of library calls)",
    ].join("\n");
    const parsed = parseRequiredSkillsByType(md);
    expect(parsed.get("type:backend")).toEqual(["simplify", "context7-docs"]);
  });
});

describe("validateRequiredSkillsInvoked", () => {
  it("returns missing skills preserving required-list order", () => {
    const { missing } = validateRequiredSkillsInvoked(
      ["a", "b", "c", "d"],
      ["b", "d"],
    );
    expect(missing).toEqual(["a", "c"]);
  });

  it("returns empty missing when invoked is a superset and when required is empty", () => {
    expect(
      validateRequiredSkillsInvoked(["a", "b"], ["a", "b", "c"]).missing,
    ).toEqual([]);
    expect(validateRequiredSkillsInvoked([], ["a"]).missing).toEqual([]);
    expect(validateRequiredSkillsInvoked([], []).missing).toEqual([]);
  });
});

describe("findLoadableRubrics (dual-path: project-local then ~/.claude/skills)", () => {
  let repoRoot: string;
  let fakeHome: string;

  const writeSkill = (root: string, name: string) => {
    const dir = join(root, ".claude", "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `# ${name}\n`);
  };

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "flr-repo-"));
    // Isolated tmpdir as homeDir so the dev user's real ~/.claude/skills
    // can never leak positive results into these assertions.
    fakeHome = mkdtempSync(join(tmpdir(), "flr-home-"));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("resolves a rubric present project-local", () => {
    writeSkill(repoRoot, "layout");
    expect(findLoadableRubrics(["layout"], repoRoot, fakeHome)).toEqual([
      "layout",
    ]);
  });

  it("resolves a rubric present only in the home fallback", () => {
    writeSkill(fakeHome, "simplify");
    expect(findLoadableRubrics(["simplify"], repoRoot, fakeHome)).toEqual([
      "simplify",
    ]);
  });

  it("returns only the subset that resolves on either path", () => {
    writeSkill(repoRoot, "layout");
    writeSkill(fakeHome, "simplify");
    expect(
      findLoadableRubrics(
        ["layout", "simplify", "does-not-exist"],
        repoRoot,
        fakeHome,
      ),
    ).toEqual(["layout", "simplify"]);
  });

  it("returns [] when no required rubric resolves anywhere", () => {
    expect(
      findLoadableRubrics(["nope", "also-nope"], repoRoot, fakeHome),
    ).toEqual([]);
  });
});

describe("critiqueErrorReasonCode", () => {
  it("maps noRubricLoaded with highest precedence", () => {
    const err = new CritiqueCriticalError("f", "type:backend", {
      retryExhausted: true,
      criticalAfterRetry: true,
      noRubricLoaded: true,
    });
    expect(critiqueErrorReasonCode(err).reasonCode).toBe(
      "critique-no-rubric-loaded",
    );
  });

  it("maps criticalAfterRetry above retryExhausted", () => {
    const err = new CritiqueCriticalError("f", "type:backend", {
      retryExhausted: true,
      criticalAfterRetry: true,
    });
    expect(critiqueErrorReasonCode(err).reasonCode).toBe(
      "critique-retry-critical",
    );
  });

  it("maps retryExhausted when only that flag is set", () => {
    const err = new CritiqueCriticalError("f", "type:backend", {
      retryExhausted: true,
    });
    expect(critiqueErrorReasonCode(err).reasonCode).toBe(
      "critique-retry-exhausted",
    );
  });

  it("maps a first-pass critical to the default reason code", () => {
    const err = new CritiqueCriticalError("f", "type:backend");
    expect(critiqueErrorReasonCode(err).reasonCode).toBe(
      "critique-critical-fail",
    );
  });
});

describe("CritiqueCriticalError", () => {
  it("carries findings + typeLabel and produces a formatted message", () => {
    const err = new CritiqueCriticalError(
      "## Findings\n\n1. P0 — impeccable — banned pattern",
      "type:new-component",
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("CritiqueCriticalError");
    expect(err.typeLabel).toBe("type:new-component");
    expect(err.findings).toContain("banned pattern");
    expect(err.message).toContain("type:new-component");
    expect(err.message).toContain("CRITICAL_BLOCKERS");
  });
});
