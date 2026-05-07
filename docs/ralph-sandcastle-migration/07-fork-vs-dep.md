Answer:
Sandcastle is currently a **pre-1.0 project**, with its latest version recorded 
as **v0.5.7** [1]. Because the library is in an experimental phase where the 
"dev branch is always wackier" and "a lot of it changes," users should expect 
**frequent breaking changes** as the project coalesces toward a stable 
architecture [2].

### **Maintenance and Community**
The project is primarily driven by **Matt Pocock**, who created it to fill a gap
in existing sandbox orchestration tools [3]. While GitHub identifies **six 
contributors**, the project is largely centered around Matt's personal workflows
and "Ralph" experiments [1, 3, 4]. 

### **Risks of Forking vs. Installing**
Choosing how to consume Sandcastle involves balancing stability against the 
rapid pace of AI engineering development:

*   **Risks of Installing as a Dependency:**
    *   **Breaking Changes:** Since the project is v0.5.x, updates often include
breaking modifications, such as the recent migration from pnpm to npm or the 
renaming of prompt placeholders like `TASK_ID` to `ISSUE_NUMBER` [1, 5].
    *   **Dependency on One Maintainer:** The project's direction is heavily 
influenced by Matt Pocock’s specific needs for his "software factory," which may
not always align with general-purpose requirements [3, 6].

*   **Risks of Forking:**
    *   **Maintenance Overhead:** Sandcastle is highly active, with nearly **900
commits** and frequent releases [1, 5]. A fork would quickly fall behind 
critical bug fixes and new features, such as the ongoing "research on pluggable 
sandbox providers" [5].
    *   **Complexity of Porting:** Because the library handles low-level 
orchestration between Docker/Podman, Git worktrees, and Claude Code sessions, 
maintaining a fork requires deep understanding of these moving parts [3, 5].

**Recommendation:** For most users, **installing the npm dependency** is the 
preferred path to benefit from rapid improvements and the library's built-in 
templates (like `parallel-planner` or `sequential-reviewer`) [7, 8]. However, 
users are encouraged to "hack around" with the associated **skills** and prompts
to tailor the agentic behavior to their specific codebase without needing to 
fork the core library [9, 10].

Conversation: 615804c3-c7d5-4e88-968c-f3a276b25c3a (turn 1)
