## agent-browser CLI cheat sheet — what you actually call

The CLI shape (verified against vercel-labs/agent-browser v0.27.0):

- `agent-browser open <url>` — navigate (aliases: `goto`, `navigate`)
- `agent-browser snapshot` — print accessibility tree with stable refs
  like `button "Sign In" [ref=e1]`. Use `snapshot -i` for an
  interactive/JSON form.
- `agent-browser click @e1` — click by ref from the most recent snapshot
- `agent-browser fill @e2 "value"` — clear input and type
- `agent-browser type @e2 "value"` — type without clearing first
- `agent-browser get text @e1` — read text content of an element
- `agent-browser is visible @e1` / `is enabled @e1` / `is checked @e1` —
  assertions; exit code 0 = true, non-zero = false
- `agent-browser wait <selector>` — wait for an element
- `agent-browser wait --url "**/dash"` — wait for URL pattern (glob)
- `agent-browser screenshot path.png` — save a screenshot
- `agent-browser back` / `forward` / `reload`
- `agent-browser batch "open ..." "snapshot -i" "screenshot"` — run a
  sequence in one process. Use this for multi-step e2e flows so the
  browser session is reused; otherwise each invocation pays cold-start.

Drive multi-step flows by chaining calls in a shell script under `e2e/`,
using `&&` between steps. The exit code of the last failing assertion
propagates: a single `is visible @e1` returning non-zero fails the whole
script. Save the script's combined stdout+stderr to the iteration log
(see "Required artifacts" above).

**Refs are scoped to the most recent snapshot.** Always emit a fresh
`agent-browser snapshot` in the script before referencing `@eN` after
navigation or DOM-mutating actions; refs from a previous page are stale.

**Sign-in under agent-browser** typically looks like:
`agent-browser open "$BASE_URL/login" && agent-browser snapshot &&
agent-browser fill @ePASSWORD_REF "$TEST_PASSWORD" && agent-browser
click @eSUBMIT_REF && agent-browser wait --url "**/dashboard"` — refs
vary, take a `snapshot` first to discover them.
