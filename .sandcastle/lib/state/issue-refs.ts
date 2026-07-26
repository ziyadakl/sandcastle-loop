/**
 * Canonical `#N` issue-reference extractor.
 *
 * Sweeps a text for every `#N` token, keeps the ones that are valid positive
 * integers, and returns them de-duplicated in FIRST-SEEN order. Callers that
 * need a different ordering (e.g. ascending) sort the result themselves.
 *
 * Shared by `parseBlockedBy` (`main.mts`) and `parseSupersededBy` (`gh.ts`),
 * which both previously hand-rolled this identical sweep — a bespoke duplicate
 * is how the two drift apart. One primitive, two callers.
 */
export function collectIssueRefs(text: string): number[] {
  if (text.length === 0) return [];
  const seen = new Set<number>();
  const out: number[] = [];
  for (const ref of text.matchAll(/#(\d+)/g)) {
    const n = Number(ref[1]);
    if (Number.isInteger(n) && n > 0 && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}
