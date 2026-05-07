Answer:
Yes, **Sandcastle** explicitly supports an **implement-then-review-then-fix** 
loop within a single sandbox [1]. Because the sandbox container and its 
associated git worktree stay alive between calls to `run()`, all installed 
dependencies, build artifacts, and—crucially—**git commits accumulate on the 
same branch** [1]. This allows a subsequent "reviewer" or "fixer" agent to see 
the exact state and history left by the "implementer" agent [1, 2].

### **The Implementation Pattern**
To achieve this, you use `createSandbox()` to initialize a long-lived 
environment instead of using the one-shot `run()` function [1]. 

**Exact code pattern:**

```typescript
import { createSandbox, claudeCode, docker } from "@ai-hero/sandcastle";

// 1. Initialize a reusable sandbox on a specific branch
await using sandbox = await createSandbox({
  branch: "feature/afk-task",
  sandbox: docker(),
});

// 2. The Implementation Phase
const implResult = await sandbox.run({
  agent: claudeCode(),
  prompt: "Implement the feature described in issue #123. Ensure you commit your
changes.",
});

// 3. The Review Phase (using a more powerful model like Opus for oversight)
const reviewResult = await sandbox.run({
  agent: claudeCode("claude-3-opus-20240229"),
  prompt: "Review the recent commits on this branch for issue #123. " +
          "If you find bugs or style issues, output 'NEEDS_FIX'. Otherwise, 
output 'COMPLETE'.",
});

// 4. The Fix Phase (Conditional)
if (reviewResult.stdout.includes("NEEDS_FIX")) {
  await sandbox.run({
    agent: claudeCode(),
    prompt: "The reviewer found issues: " + reviewResult.stdout + ". Please fix 
them now.",
  });
}
```

### **Key Technical Details**
*   **Commit Visibility:** Since the second agent runs in the same worktree, it 
can run commands like `git log` or `git diff HEAD~1` to inspect the 
implementation agent's work [1, 3].
*   **Lifecycle Management:** Using the `await using` syntax (as shown above) 
ensures that `sandbox.close()` is called automatically when the block exits [4].
If the agent made commits, Sandcastle will preserve the worktree on disk for 
your final manual QA; if no changes were made, it cleans up the container and 
files [4, 5].
*   **Templates:** Sandcastle includes a built-in template called 
**`sequential-reviewer`** that scaffolds this exact "implement-then-review" 
workflow for you during initialization [6].
*   **Adversarial Review:** You can easily swap the `agent` provider in the 
review step (e.g., using `codex()` or a different Claude model) to create an 
"adversarial" setup where a second AI critiques the first one's logic [2, 3].

Conversation: 615804c3-c7d5-4e88-968c-f3a276b25c3a (turn 1)
