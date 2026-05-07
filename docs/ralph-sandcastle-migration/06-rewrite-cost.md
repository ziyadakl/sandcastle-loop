Answer:
Porting an 835-line Bash autonomous-loop driver to a TypeScript-based Sandcastle
factory is a significant shift from "vibe coding" to "real engineering" [1, 2]. 
Based on the sources, a realistic engineer-hours cost for this port ranges from 
**15 to 30 hours**, depending on how much of the original Bash logic was 
handling edge cases that now require robust TypeScript primitives.

The transition effectively moves you from a simple shell loop (`ralph.sh`) to a 
programmatic orchestration layer capable of infinite parallelization and typed 
feedback [3-5].

### **1. Trivial Wrapping (4–6 Hours)**
This phase covers the "happy path" of getting a basic autonomous loop running 
inside a Sandcastle sandbox.

*   **Initialization & Environment (1 hour):** Running `sandcastle init` 
scaffolds the `.sandcastle` directory and a default `Dockerfile` [6, 7]. You 
will spend time configuring `.sandcastle/.env` with your API keys and GitHub 
tokens [8, 9].
*   **The Persistent Sandbox (2–3 hours):** Converting a sequential Bash loop 
into a `createSandbox()` pattern. This involves wrapping the core implementation
logic in an `await using` block to ensure the container and Git worktree persist
between agent runs [10, 11].
*   **Prompt Porting (1–2 hours):** Moving your Bash-based prompt strings into 
`.sandcastle/prompt.md`. You will replace manual string manipulation with 
Sandcastle's `promptArgs` (e.g., `{{ISSUE_NUMBER}}`) and `!command` expressions 
for dynamic context expansion [12-14].

### **2. Designing New Primitives (12–24 Hours)**
This is where the bulk of the effort lies, as you must rebuild complex 
"user-land" logic in TypeScript that Sandcastle does not provide natively.

*   **State Machine & Issue Lifecycle (4–6 hours):** Sandcastle handles the 
"run," but you must write the TypeScript logic to parse your `prd.json`, claim 
stories, and update statuses [15-17]. You will likely use **`Output.object()` 
with Zod** to extract structured data from agents (like `{ verdict: 'DONE' }`) 
to drive the state machine instead of fragile Bash `grep` calls [Previous turn, 
289].
*   **Recovery Ladder & Error Handling (4–8 hours):** Implementing a "Sonnet → 
Opus" retry logic requires a manual `while` loop with a `try/catch` block 
[Previous turn]. You will need to write the logic that detects a "dumb model" 
failure and triggers a new `sandbox.run()` using a more powerful `agent` 
provider like `claudeCode("claude-3-opus-20240229")` [18, 19].
*   **Infrastructure & Safety (4–6 hours):**
    *   **Migrations & Rollback:** Writing custom logic or lifecycle hooks 
(`host.onWorktreeReady`) to manage Drizzle migrations and detect failures that 
require a DB rollback [20, 21].
    *   **Single-Instance Protection:** Implementing a TypeScript equivalent to 
`flock` or a file-based lock to prevent concurrent factories from clashing on 
the same repository [Previous turn].
    *   **Quarantine Flow:** Designing a "purgatory" branch strategy where 
failed implementations are moved for human review rather than being merged back 
to the feature branch [22, 23].

### **3. Complexity Driver: Parallelization (Optional +10 Hours)**
If your 835-line Bash script already handles parallel tasks, porting this to 
Sandcastle's parallel model—using **Git worktrees** to avoid merge conflicts—is 
a complex "design-new-primitive" task [24-26]. You would need to write a **DAG 
(Directed Acyclic Graph) executor** in TypeScript to determine which issues are 
"unblocked" and can be fired off to separate sandbox instances simultaneously 
[27, 28].

### **Cost Summary Table**

| Component | Category | Estimated Hours |
| :--- | :--- | :--- |
| **Sandcastle Boilerplate** | Trivial Wrapping | 1–2 |
| **Basic Loop Port** | Trivial Wrapping | 3–4 |
| **State Machine & `prd.json`** | Design New Primitives | 4–6 |
| **Recovery Ladder (Sonnet/Opus)**| Design New Primitives | 4–8 |
| **DB Migrations & Safety** | Design New Primitives | 3–4 |
| **Total Estimated Effort** | | **15–24 Hours** |

**Note:** This estimate assumes you are using Sandcastle's built-in templates 
(like `simple-loop` or `sequential-reviewer`) as starting points, which 
significantly reduces the initial "wrapping" time [29].

Conversation: 615804c3-c7d5-4e88-968c-f3a276b25c3a (turn 1)
