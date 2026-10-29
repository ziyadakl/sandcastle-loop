const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

// Mirrors the SDK's substitutePromptArgs contract for the keys this repo
// uses: same placeholder regex, fail-loud on unmatched key. Does NOT inject
// SOURCE_BRANCH/TARGET_BRANCH built-ins or preprocess !`...` shell blocks —
// see FOLLOW_UPS.md. No prompt carries a `gh` block any more — the ticket
// text arrives host-filled as {{ISSUE_SPEC}} (spec #1334, SB) — so a mac-host
// agent sees the same ticket text a docker agent does.
export function applyPromptArgs(
  prompt: string,
  args: Record<string, string>,
): string {
  return prompt.replace(PLACEHOLDER_PATTERN, (_match, key: string) => {
    if (!(key in args)) {
      throw new Error(
        `Prompt argument "{{${key}}}" has no matching value in promptArgs`,
      );
    }
    return args[key];
  });
}
