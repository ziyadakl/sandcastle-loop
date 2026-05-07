Answer:
You are correct; **Sandcastle is an orchestration library**, not an end-to-end 
application manager. Its primary purpose is to handle the **sandboxing 
(Docker/Podman/Vercel)**, **branch strategies**, and **agent invocation** [1, 
2]. 

According to the sources, here is a confirmation that the specific features you 
mentioned are not built-in Sandcastle functions and must be handled in your 
user-land TypeScript or via specific prompts:

*   **State Machine in `prd.json`:** Managing the logic of "claiming" a story or
marking it "in_progress" in a JSON file is a **prompt-level convention** or a 
script-side management task [3, 4]. While the sources describe using a 
`prd.json` to keep the agent "on rails," Sandcastle itself does not provide a 
native API to track or mutate these states [3].
*   **GitHub Issue Lifecycle:** Sandcastle provides the **GitHub CLI (`gh`)** 
inside its default Docker image so the agent *can* use it, but the automation of
closing issues or updating labels is not a core library feature [5, 6]. You must
orchestrate these calls (e.g., `gh issue close`) either within the agent's 
prompt or your TypeScript loop [7].
*   **Drizzle Migrations and Rollback:** This is entirely **application-specific
logic** [8]. Sandcastle is agnostic to your database or migration strategy; you 
would need to implement this as part of your `host` or `sandbox` lifecycle hooks
or within the agent's task list [9].
*   **Recovery Ladder (Sonnet → Opus):** While Sandcastle allows you to specify 
a model for each `run()` call, the **logic for retrying with a different model**
upon failure is your responsibility [10]. You must catch the error in your 
TypeScript code and initiate a new `run()` with a more powerful agent like Opus 
[10, 11].
*   **Quarantine Flow:** There is no mention of a "quarantine flow" for 
problematic code in the sources. You would need to implement this by moving 
failed branches to a specific quarantine area or labeling them in your issue 
tracker for human review [12, 13].
*   **Flock-based Protection:** Sandcastle does not handle **single-instance 
protection** or execution locks [1]. If you need to prevent multiple instances 
of your software factory from running simultaneously, you must implement that 
locking mechanism (like `flock`) in your own runner script [14].

In summary, the sources suggest that Sandcastle provides the **isolated 
environment (the "castle")** and the **agent execution engine**, but the **rules
of the "game"**—such as your state machine, recovery logic, and infrastructure 
management—are entirely **user-land responsibilities** [1, 15, 16].

Conversation: 615804c3-c7d5-4e88-968c-f3a276b25c3a (turn 1)
