Answer:
To extract a typed verdict using Sandcastle's **structured output feature**, you
leverage the ability to force an agent to return JSON following a specific 
schema rather than free-form text [1, 2]. This transforms the agent's output 
into machine-readable data that can be used programmatically in your 
orchestration scripts [1].

### **Working Example**
To implement the `{ verdict: 'ALL_CLEAR' | 'HAS_BLOCKERS' }` extraction, you 
define a **Zod schema** and pass it to the agent via the `output` option in 
`run()` or `sandbox.run()`.

```typescript
import { run, claudeCode, docker, Output } from "@ai-hero/sandcastle";
import { z } from "zod";

// 1. Define your typed schema
const VerdictSchema = z.object({
  verdict: z.enum(['ALL_CLEAR', 'HAS_BLOCKERS']),
  reasoning: z.string().describe("A brief explanation of the verdict")
});

const result = await run({
  agent: claudeCode(),
  sandbox: docker(),
  // 2. Instruct the agent to follow the schema
  prompt: "Review the current build status. Determine if there are any blocking 
issues.",
  // 3. Use Output.object to validate and type the response
  output: Output.object({ schema: VerdictSchema }),
});

// 4. Access the strictly typed data
console.log(result.object.verdict); // 'ALL_CLEAR' or 'HAS_BLOCKERS'
console.log(result.object.reasoning);
```

### **Constraints**
*   **Provider Support**: While the general concept of "Structured Outputs" 
exists across models, Sandcastle's implementation relies on the agent's ability 
to output JSON that matches a schema [2]. 
*   **Prompt Mutex**: If you are using `promptFile`, any `promptArgs` used for 
substitution must be defined in the host-side script, as the structured output 
is generated based on the final expanded prompt [3, 4].
*   **Environment**: The agent must still be running in a valid sandbox (Docker,
Podman, or Vercel) to perform any code exploration required to reach a verdict 
[5, 6].

### **Gotchas and Tips**
*   **Model "Intelligence" Threshold**: For complex logic (like identifying 
"blockers"), using **Opus** is recommended over Sonnet. Lower effort levels can 
lead to the model "acting dumb" or failing to follow strict schema constraints 
[7, 8].
*   **Token Efficiency**: Requesting structured data consumes more tokens 
because the agent often needs to perform internal "chain-of-thought" reasoning 
before emitting the final JSON [2, 9]. 
*   **Prompt Descriptions**: In your Zod schema, using `.describe()` on fields 
is highly effective. It acts as a "micro-prompt" that tells the agent exactly 
what information belongs in that specific JSON key [2].
*   **Implicit Iteration**: If the agent needs to explore the codebase to 
provide the verdict, ensure `maxIterations` is set to more than 1. A single 
iteration may not be enough for the agent to find the information and generate 
the JSON [10].
*   **The "Silent" Stop**: When using structured outputs, the agent often 
completes the task by emitting the JSON. You should still document a 
**completion signal** (like `<promise>COMPLETE</promise>`) in your system prompt
so the orchestrator knows when to stop the loop early if the JSON is part of a 
larger conversation [11, 12].

Conversation: 615804c3-c7d5-4e88-968c-f3a276b25c3a (turn 1)
