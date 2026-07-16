// Multi-host control (workstream B1) — host registry config parser.
//
// Parses the multi-host registry config (intended file: `.sandcastle/hosts.json`,
// seeded with the local Mac + the "hub" VPS). Other workstreams import the
// `HostConfig` shape from here, so it must not drift.

/** A single host the loop may dispatch work to. */
export interface HostConfig {
  /** Unique host label, e.g. "local", "hub". */
  readonly name: string;
  /**
   * "local" means this machine; any other value is an ssh alias (e.g. "hub")
   * used to reach a remote host.
   */
  readonly transport: "local" | string;
  /** Per-host concurrency cap; must be an integer >= 1. */
  readonly maxConcurrent: number;
}

/** Default config used when no hosts file exists: a single local host. */
const LOCAL_DEFAULT: readonly HostConfig[] = [
  { name: "local", transport: "local", maxConcurrent: 2 },
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parse + validate a hosts registry from a raw JSON string.
 *
 * Accepts either a bare array `[...]` or a `{ "hosts": [...] }` wrapper.
 * Throws an `Error` with a specific message on any of: invalid JSON, empty
 * list, missing/blank `name`, duplicate `name`, missing/blank `transport`,
 * `maxConcurrent` not an integer >= 1, or more than one `transport: "local"`
 * host (0 local hosts is allowed).
 */
export function parseHostsConfig(raw: string): HostConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`hosts config is not valid JSON: ${detail}`);
  }

  let list: unknown;
  if (Array.isArray(parsed)) {
    list = parsed;
  } else if (isRecord(parsed) && Array.isArray(parsed.hosts)) {
    list = parsed.hosts;
  } else {
    throw new Error(
      'hosts config must be a JSON array or an object with a "hosts" array',
    );
  }

  const entries = list as unknown[];
  if (entries.length === 0) {
    throw new Error("hosts config is empty: at least one host is required");
  }

  const seenNames = new Set<string>();
  let localCount = 0;
  const configs: HostConfig[] = [];

  entries.forEach((entry, i) => {
    if (!isRecord(entry)) {
      throw new Error(`hosts config entry #${i} must be an object`);
    }

    const { name, transport, maxConcurrent } = entry;

    if (typeof name !== "string" || name.trim() === "") {
      throw new Error(
        `hosts config entry #${i} has a missing or blank "name"`,
      );
    }
    if (seenNames.has(name)) {
      throw new Error(`hosts config has a duplicate name: "${name}"`);
    }
    seenNames.add(name);

    if (typeof transport !== "string" || transport.trim() === "") {
      throw new Error(
        `hosts config entry "${name}" has a missing or blank "transport"`,
      );
    }
    if (transport === "local") localCount++;

    if (
      typeof maxConcurrent !== "number" ||
      !Number.isInteger(maxConcurrent) ||
      maxConcurrent < 1
    ) {
      throw new Error(
        `hosts config entry "${name}" has an invalid "maxConcurrent" ` +
          `(must be an integer >= 1, got ${JSON.stringify(maxConcurrent)})`,
      );
    }

    configs.push({ name, transport, maxConcurrent });
  });

  if (localCount > 1) {
    throw new Error(
      `hosts config has ${localCount} hosts with transport "local"; at most one is allowed`,
    );
  }

  return configs;
}

/**
 * Load + parse the hosts registry from `path`, reading the file via the
 * injected `readFile` (dependency-injected for testability; this module never
 * touches `fs` directly).
 *
 * If `readFile` throws — e.g. the file is missing — this returns a sensible
 * default of a single local host `[{ name: "local", transport: "local",
 * maxConcurrent: 2 }]` instead of failing. A present-but-invalid file still
 * throws (via `parseHostsConfig`).
 */
export function loadHostsConfig(
  path: string,
  readFile: (p: string) => string,
): HostConfig[] {
  let raw: string;
  try {
    raw = readFile(path);
  } catch {
    return LOCAL_DEFAULT.map((h) => ({ ...h }));
  }
  return parseHostsConfig(raw);
}
