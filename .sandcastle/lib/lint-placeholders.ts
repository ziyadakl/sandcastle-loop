/**
 * Pre-launch lint that catches `{{IDENT}}` placeholders in prompt files that
 * have no corresponding key in any `promptArgs:` literal in `main.mts`.
 *
 * Why this exists: the SDK's `PromptArgumentSubstitution` throws at
 * iteration 1 with `Prompt argument {{X}} has no matching value in
 * promptArgs` when an orphan slips through. Audit Issue 4 (2026-05-30):
 * `{{CRITIQUE_FEEDBACK}}` shipped to affinity-tracker without a matching
 * key and crashed the entire one-shot pivot mid-experiment. Cheap regex
 * lint catches this pre-launch.
 *
 * Lint direction is one-way: every prompt placeholder must appear as a
 * key somewhere in main.mts. The reverse (every promptArgs key consumed
 * by some prompt) is not checked — extra keys are benign.
 */

/**
 * Extract the unique `{{IDENT}}` tokens from a prompt-style file.
 * IDENTs are uppercase letters/digits/underscores starting with a letter.
 * Tokens that fail that shape are ignored (lowercase, embedded spaces,
 * etc.) — those aren't substituted by the SDK and aren't lint-worthy.
 * Returns a sorted unique array for determinism in test assertions.
 */
export function extractPlaceholders(content: string): readonly string[] {
  const out = new Set<string>();
  const re = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;
  for (const m of content.matchAll(re)) {
    out.add(m[1]);
  }
  return Array.from(out).sort();
}

/**
 * Find the index of the `}` that matches the `{` at `openPos`, ignoring
 * string-literal and comment contents would be ideal but the lint runs
 * on hand-written TypeScript that doesn't put `{` inside strings near
 * `promptArgs:` — we keep this simple and balanced-brace-only. Returns
 * -1 if the literal isn't closed (file truncated or paren-mismatched).
 */
function findMatchingBrace(source: string, openPos: number): number {
  let depth = 0;
  for (let i = openPos; i < source.length; i++) {
    const c = source[i];
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Extract every key found inside any `promptArgs: { ... }` object literal
 * in the source. Keys must be ALL_CAPS_WITH_UNDERSCORES and appear at the
 * start of a property (`KEY:` after `{`, `,`, or newline). Returns a
 * sorted unique array.
 *
 * Pass-through call sites like `promptArgs: opts.promptArgs` are
 * silently skipped (no `{` follows) — they always forward keys from a
 * literal elsewhere in the same file, so the union across all literals
 * still covers them.
 */
export function extractPromptArgKeys(mainSource: string): readonly string[] {
  const keys = new Set<string>();
  const startRe = /promptArgs:\s*\{/g;
  for (const m of mainSource.matchAll(startRe)) {
    const startIdx = m.index;
    if (startIdx === undefined) continue;
    const openPos = startIdx + m[0].length - 1;
    const closePos = findMatchingBrace(mainSource, openPos);
    if (closePos === -1) continue;
    const body = mainSource.slice(openPos + 1, closePos);
    const keyRe = /(?:^|[,{\n])\s*([A-Z][A-Z0-9_]*)\s*:/g;
    for (const km of body.matchAll(keyRe)) {
      keys.add(km[1]);
    }
  }
  return Array.from(keys).sort();
}

export interface OrphanPlaceholder {
  readonly file: string;
  readonly placeholder: string;
}

/**
 * Cross-check every prompt's placeholders against the union of all
 * promptArgs keys. Returns the orphans (placeholders that have no
 * matching key anywhere), sorted by file then placeholder for stable
 * lint output.
 */
export function findOrphanPlaceholders(
  promptFiles: ReadonlyMap<string, string>,
  mainSource: string,
): readonly OrphanPlaceholder[] {
  const knownKeys = new Set(extractPromptArgKeys(mainSource));
  const orphans: OrphanPlaceholder[] = [];
  for (const [file, content] of promptFiles) {
    for (const placeholder of extractPlaceholders(content)) {
      if (!knownKeys.has(placeholder)) {
        orphans.push({ file, placeholder });
      }
    }
  }
  orphans.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.placeholder < b.placeholder ? -1 : a.placeholder > b.placeholder ? 1 : 0;
  });
  return orphans;
}
