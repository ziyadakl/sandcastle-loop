// Multi-host control (workstream B1) — host registry config parser.
//
// Parses the multi-host registry config. The real file, `.sandcastle/hosts.json`,
// is PER-MACHINE and untracked — it holds repoPaths correct for one machine only,
// so there is no seed in the repo; `.sandcastle/hosts.example.json` is what ships
// (REPLACE-ME values, non-functional on purpose). `loadHostsConfig` falls back to
// a single local host when the file is absent, so multi-host stays opt-in. See ADR
// 0022. Other workstreams import the `HostConfig` shape from here, so it must not
// drift.

/** A single host the loop may dispatch work to. */
export interface HostConfig {
  /** Unique host label, e.g. "local", "hub". */
  readonly name: string;
  /**
   * "local" means this machine; any other value is an ssh alias (e.g. "hub")
   * used to reach a remote host.
   *
   * `string & {}` keeps the `"local"` literal alive for autocomplete/intent
   * without collapsing the whole type to bare `string` (which is what plain
   * `"local" | string` would widen to). Use {@link isLocalHost} for the
   * local-vs-ssh decision rather than comparing this field inline.
   */
  readonly transport: "local" | (string & {});
  /** Per-host concurrency cap; must be an integer >= 1. */
  readonly maxConcurrent: number;
  /**
   * Absolute path to the repo checkout ON that host. REQUIRED for remote hosts
   * (transport !== "local"): a non-interactive `ssh <alias>` lands in the login
   * dir, not the checkout, so every remote gate command must `cd` here first
   * (see {@link buildRemoteCommand} in ./launch.ts). Irrelevant for local hosts,
   * which use the local process cwd (the repo root) instead — omitted/ignored.
   */
  readonly repoPath?: string;
}

/**
 * The single canonical local-vs-remote predicate. A host is "local" (this
 * machine, spawn argv directly) iff its transport is exactly `"local"`; any
 * other value is an ssh alias reached over `ssh <alias> -- <argv>`. Keeping
 * this in one place means the launch surface never re-derives the rule inline.
 */
export function isLocalHost(host: HostConfig): boolean {
  return host.transport === "local";
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

    const { name, transport, maxConcurrent, repoPath } = entry;

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

    // repoPath: if present it must be a non-empty string; REQUIRED for remote
    // hosts (transport !== "local"), optional + ignored for the local host.
    if (repoPath !== undefined) {
      if (typeof repoPath !== "string" || repoPath.trim() === "") {
        throw new Error(
          `hosts config entry "${name}" has an invalid "repoPath" ` +
            `(must be a non-empty string if present, got ${JSON.stringify(repoPath)})`,
        );
      }
    }
    const isRemote = transport !== "local";
    if (isRemote && (typeof repoPath !== "string" || repoPath.trim() === "")) {
      throw new Error(
        `host "${name}" is remote (transport "${transport}") but has no repoPath ` +
          `— set the absolute path to the repo checkout on that host`,
      );
    }

    configs.push(
      isRemote
        ? { name, transport, maxConcurrent, repoPath: repoPath as string }
        : { name, transport, maxConcurrent },
    );
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
