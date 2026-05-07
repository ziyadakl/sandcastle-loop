# Migration Briefing: Bash Autonomous-Loop to Sandcastle TypeScript Orchestration

## Executive Summary

This document details the transition strategy from a legacy 835-line Bash-based autonomous-loop driver to **Sandcastle**, a programmatic TypeScript library. The existing driver—responsible for the full lifecycle of `story-claim → impl → reviewer → fixer-loop → mark-done → close-issue`—has reached a point of fragility, recently resulting in multiple failed stories due to unreliable free-text parsing. 

The migration moves orchestration into a type-safe environment, leveraging Sandcastle’s sandboxed execution and provider-agnostic architecture. By replacing brittle `grep` commands on agent output with structured `Output.object` and Zod validation, the system moves from "vibe coding" toward rigorous engineering. This plan outlines the specific components that will port to Sandcastle primitives versus those that must remain as user-land TypeScript logic, while enforcing the technical discipline required to maintain system stability.

---

## I. Analysis of the Legacy Bash Driver
The current 835-line Bash script serves as a "Ralph Loop" (an autonomous agent loop) that manages state across GitHub issues.

### Core Workflow Components
*   **The Loop:** Continually executes until the backlog is cleared or a maximum iteration count is reached.
*   **State Management:** Tracks `story-claim`, `mark-done`, and `close-issue` via raw CLI interactions.
*   **Safety Features:** Includes a "recovery ladder" for failed iterations, "migration auto-apply" for schema changes, and a "quarantine" for problematic stories.
*   **The Failure Point:** The driver currently relies on **free-text grep** on agent output to determine success or failure. This led to three broken stories in a single night because the agent's natural language output did not perfectly match the expected regular expressions.

---

## II. Migration Plan: From Bash to Sandcastle

The migration involves decomposing the Bash script and re-implementing it as a Sandcastle-driven TypeScript application. 

### 1. Mapping Primitives vs. User-Land Code
Not every line of the Bash driver belongs inside Sandcastle. Sandcastle is an orchestrator, not a business logic engine.

| Feature / Logic | Migration Target | Sandcastle Primitive / Mechanism |
| :--- | :--- | :--- |
| **Sandbox Isolation** | Port to Sandcastle | `docker()`, `podman()`, or `vercel()` providers. |
| **Git Operations** | Port to Sandcastle | `branchStrategy: { type: "merge-to-head" }` or `{ type: "branch" }`. |
| **Iteration Control** | Port to Sandcastle | `maxIterations` and `completionSignal`. |
| **Session Persistence** | Port to Sandcastle | `captureSessions: true` and `resumeSession: sessionId`. |
| **Story Claiming** | User-Land Logic | Logic using GitHub CLI (`gh issue list --label sandcastle`). |
| **Fixer-Loop** | User-Land Logic | A recursive `while` loop calling `sandbox.run()` with a diagnosis prompt. |
| **Quarantine Logic** | User-Land Logic | Logic to catch errors and apply a `quarantine` label via GitHub API. |
| **Recovery Ladder** | User-Land Logic | TypeScript `try/catch` blocks that escalate from Haiku to Sonnet to Opus models. |

### 2. Implementation Phases

#### Phase A: Scaffolding and Environment
*   Initialize Sandcastle within the repository using `sandcastle init`.
*   Replace the manual Bash environment setup with a custom **Dockerfile** in `.sandcastle/` that pre-installs necessary dependencies (Node 22, GitHub CLI, and Claude Code).
*   Transition from global `.env` variables to the Sandcastle `env` resolver, ensuring the `ANTHROPIC_API_KEY` and `GITHUB_TOKEN` are securely injected into the sandbox.

#### Phase B: The Orchestration Loop
*   Re-implement the main loop using `sandcastle.run()` or `createSandbox()` for long-lived sessions.
*   **Multi-Agent Coordination:** Move the `reviewer` step to a separate `sandbox.run()` call. This allows for an "adversarial review" where a secondary agent (e.g., Opus) reviews the code produced by the implementer (e.g., Sonnet).

#### Phase C: Porting Recovery and Migrations
*   **Migration Auto-Apply:** Use `sandbox.onSandboxReady` hooks to run database migration scripts before the agent begins work.
*   **The Recovery Ladder:** Implement a TypeScript-based back-off strategy. If a run fails or the agent becomes "stuck," the script should automatically increase the `effort` level (e.g., from `low` to `high`) or switch models.

---

## III. The Discipline of Structured Output

The most critical technical requirement of this migration is the total abandonment of `grep` for parsing agent verdicts.

### The Problem: Free-Text Grep
The legacy Bash driver failed because it attempted to parse the agent's thought process or conversational filler. As the source context notes: *"The original bash driver shipped three broken stories tonight because of free-text grep on agent output."*

### The Solution: `Output.object` with Zod
Claude Code and Sandcastle support structured output. The migration must enforce a policy where every load-bearing verdict (e.g., "Is the test passing?", "Is the PR ready to merge?", "Should we quarantine this issue?") is returned as a JSON object.

**Required Discipline:**
1.  **Strict Schema Definition:** Every agent run that requires a decision must be paired with a Zod schema.
2.  **Explicit Prompting:** The prompt must instruct the agent to output its final verdict within specific tags (e.g., `<verdict>...</verdict>`).
3.  **Validation:** The TypeScript driver must use `JSON.parse` and Zod validation on the returned string. If the agent fails to provide the structured object, the iteration must be treated as a failure and triggered for retry (the "fixer-loop").

---

## IV. Key Themes and Actionable Insights

### Key Themes
*   **Deep Modules & Clear Interfaces:** Moving to TypeScript allows the codebase to be structured into "Deep Modules." This hides implementation complexity behind simple interfaces, making it easier for AI agents to navigate the code without "cognitive burnout."
*   **Ralph Loops:** The autonomous nature of the Bash driver is preserved but enhanced. By using a "Canban board" (GitHub Issues) as the state machine, the agent can pick up unblocked tasks, work on vertical slices, and signal completion.
*   **Ubiquitous Language:** The migration should include a `CONTEXT.md` file. This ensures that the agent, the TypeScript orchestrator, and the human maintainer all use the same terminology (e.g., "materialization cascade," "ghost course"), reducing token waste and miscommunication.

### Actionable Insights
*   **Use Vertical Slices:** When breaking down stories for the agent, do not split them by "frontend" or "backend." Ensure each GitHub issue is a "tracer bullet" that cuts through all integration layers to get feedback earlier.
*   **Implement a Triage State Machine:** Use the following labels to manage the agent's queue:
    *   `needs-triage`: Requires human review.
    *   `ready-for-agent`: Fully specified and ready for the Sandcastle loop.
    *   `quarantine`: Failed multiple times; needs human intervention.
*   **Leverage Git Worktrees:** Use Sandcastle’s `createWorktree()` to allow multiple agents to work on different stories in parallel without merge conflicts on the host machine.

---

## V. Important Quotes

> "If you have a garbage codebase then the AI is going to produce garbage within that codebase... The old adage really does apply." — **Matt Pocock** on the necessity of structural integrity.

> "The original bash driver shipped three broken stories tonight because of free-text grep on agent output." — **Internal Context** highlighting the primary motivation for migration to Zod/Structured Output.

> "Everything above this [red line] is what the dev needs to do... The dev then needs to [do] the stuff that comes after Ralph too." — **Matt Pocock** on the human-in-the-loop requirement for autonomous agents.

> "LMS get really stupid as you add more tokens to the context window... produce crappier code as a result." — **Matt Pocock** on the importance of keeping tasks small and focused.