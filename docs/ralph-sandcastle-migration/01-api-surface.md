Continuing conversation 615804c3...
Answer:
Based on the sources, the public API surface for Sandcastle’s `run()` and 
`createSandbox().run()` methods is structured as follows:

### **Result Object Content**
The result of a `run()` or `sandbox.run()` call returns a **RunResult** (or 
`SandboxRunResult`) object containing the following fields:
*   **`iterations`**: An array of `IterationResult` objects representing each 
loop the agent performed [1, 2]. Each iteration includes:
    *   **`sessionId`**: The unique ID for the Claude Code session [2].
    *   **`sessionFilePath`**: The absolute path to the captured session JSONL 
file on the host [2].
    *   **`usage`**: A token usage snapshot containing `inputTokens`, 
`outputTokens`, `cacheCreationInputTokens`, and `cacheReadInputTokens` [2, 3].
*   **`completionSignal`**: The specific string from the agent that triggered an
early stop (if any), such as `<promise>COMPLETE</promise>` [1, 2, 4].
*   **`stdout`**: The combined output from the agent across all iterations [1, 
2].
*   **`commits`**: An array of objects containing the SHAs (`{ sha: string }[]`)
of commits created during the run [1, 2].
*   **`branch`**: The name of the branch the agent worked on (provided in the 
top-level `RunResult`) [2].
*   **`logFilePath`**: The path to the auto-generated log file if file-based 
logging was used [1, 2].

### **Output.object() and Structured Outputs**
While the sources do not explicitly document a method named `Output.object()`, 
they describe a **structured output feature** in Claude Code that allows it to 
return JSON following a specific schema [5, 6]. 
*   **Functionality:** This feature is used to extract structured data—such as a
list of tasks or relationships between issues—directly from the agent's response
[5, 7].
*   **Validation:** In this context, structured outputs are used to "get this 
relationship out as data" so a harness can programmatically process it to 
determine which tasks can be run in parallel [5].

### **Lifecycle Hooks**
Sandcastle provides three primary lifecycle hooks to execute custom setup or 
verification logic [8]:
*   **`host.onWorktreeReady`**: Runs on your local machine after files are 
copied to the worktree but before the sandbox starts [8].
*   **`host.onSandboxReady`**: Runs on your local machine once the sandbox 
container is up and running [8].
*   **`sandbox.onSandboxReady`**: Runs **inside the sandbox** (e.g., inside the 
Docker container) once it is up [8]. 

**Note on Execution:** `host.onSandboxReady` and `sandbox.onSandboxReady` run in
parallel, whereas `host.onWorktreeReady` runs sequentially before the sandbox is
created [9]. All hooks must exit with a zero code, or the setup will fail [9].

Resumed conversation: 615804c3-c7d5-4e88-968c-f3a276b25c3a
