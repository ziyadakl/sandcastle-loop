const MARKER_RE = /<!-- variant:([a-z0-9-]+) -->([\s\S]*?)<!-- \/variant:\1 -->/g;

export function assembleVariant(
  baseText: string,
  overrides: Map<string, string>,
): string {
  return baseText.replace(MARKER_RE, (match, name: string, body: string) => {
    if (!overrides.has(name)) return match;
    return `<!-- variant:${name} -->${overrides.get(name)}<!-- /variant:${name} -->`;
  });
}

export function findMarkerNames(baseText: string): Set<string> {
  const names = new Set<string>();
  for (const m of baseText.matchAll(MARKER_RE)) {
    names.add(m[1]);
  }
  return names;
}
