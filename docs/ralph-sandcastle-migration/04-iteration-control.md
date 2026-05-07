Answer:
Since Sandcastle does not provide per-iteration lifecycle hooks for its internal
loop, the recommended and idiomatic pattern is to use **`createSandbox()`** to 
initialize a long-lived environment and then manage your own **`while` or `for` 
loop** around multiple **`sandbox.run()`** calls [1]. 

Because a sandbox created via `createSandbox()` persists its container state, 
installed dependencies, and Git worktree between `run()` calls, you can hand the
exact same filesystem state from one agent to another [1, 2].

### Idiomatic Pattern: The "Hand-Rolled" Review Loop
In this pattern, you set each `sandbox.run()` to a single iteration (the 
default) so that control returns to your TypeScript code after each agent 
finishes. This allows you to switch agents (e.g., using a cheaper model for 
implementation and a more expensive model like **Opus** for review) and use 
structured data to decide the loop's fate [1, 3, 4].

```typescript
import { createSandbox, claudeCode, docker, Output } from "@ai-hero/sandcastle";
import { z } from "zod";

// 1. Setup a reusable sandbox
await using sandbox = await createSandbox({
  branch: "fix/auth-bug",
  sandbox: docker(),
});

const ReviewSchema = z.object({
  verdict: z.enum(["PASS", "FAIL"]),
  feedback: z.string()
});

let isComplete = false;
let retryCount = 0;

// 2. Hand-rolled orchestration loop
while (!isComplete && retryCount < 3) {
  // Phase A: Implement (using Sonnet for speed)
  const implResult = await sandbox.run({
    agent: claudeCode("claude-3-5-sonnet-latest"),
    prompt: "Fix the bug in auth.ts. Run tests and commit your changes."
  });

  // Phase B: Review (using Opus for high-effort oversight)
  const reviewResult = await sandbox.run({
    agent: claudeCode("claude-3-opus-20240229"),
    prompt: "Review the recent implementation. Is the bug fixed without 
regressions?",
    output: Output.object({ schema: ReviewSchema }),
    // Use effort: "max" for Opus to ensure deep reasoning [5]
    effort: "max" 
  });

  if (reviewResult.object.verdict === "PASS") {
    isComplete = true;
    console.log("Review passed!");
  } else {
    console.log(`Review failed: ${reviewResult.object.feedback}`);
    retryCount++;
  }
}
```

### Why This is Idiomatic
*   **Persistent Context:** Every commit made by the "Implementer" is 
immediately visible to the "Reviewer" via `git log` or `git diff` because they 
share the same worktree [1, 6].
*   **Agent Swapping:** You can easily use different model providers (e.g., 
`claudeCode()` for one step and `codex()` for another) within the same loop [7, 
8].
*   **Granular Logic:** By using `Output.object()`, your loop logic is driven by
typed data rather than fragile text parsing .
*   **Built-in Precedents:** Sandcastle’s own **`sequential-reviewer`** and 
**`parallel-planner-with-review`** templates are designed around this exact 
concept of chaining multiple runs together to form a factory [4].

### Key Constraints
*   **`maxIterations`**: When running a hand-rolled loop, ensure your 
`sandbox.run()` calls use `maxIterations: 1` (the default) so the agent doesn't 
loop internally and swallow the opportunity for your host-side review logic [9].
*   **Cleanup**: Using the `await using` syntax ensures that if your loop 
crashes or finishes, the sandbox container is closed and the worktree is either 
cleaned up or preserved based on whether changes were committed [2, 10].

Conversation: 615804c3-c7d5-4e88-968c-f3a276b25c3a (turn 1)
