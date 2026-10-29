/**
 * No GitHub credential reaches a ticket's sandbox (spec #1334, slice SB).
 *
 * Every role in a ticket's sandbox — check-writer, builder, reviewer, fixer —
 * shares one environment, and none of them needs GitHub: the host reads the
 * ticket at claim time and hands its text to every prompt as
 * `{{ISSUE_SPEC}}`, and every label, comment and merge is written by the host.
 * An agent holding a key with `repo` scope could instead rewrite its own
 * ticket, push to `main`, or close someone else's issue.
 *
 * The HOST keeps its own `GH_TOKEN` (`lib/state/gh.ts` runs `gh` on the host);
 * these helpers only shape the environment handed to an agent.
 */

/** Every environment variable `gh` (and `git` through `gh auth
 *  git-credential`) reads a GitHub credential from. */
export const GITHUB_CREDENTIAL_ENV_KEYS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
] as const;

/** A copy of `env` with every {@link GITHUB_CREDENTIAL_ENV_KEYS} entry removed. */
export function withoutGithubCredentials<V>(
  env: Readonly<Record<string, V>>,
): Record<string, V> {
  const out: Record<string, V> = { ...env };
  for (const key of GITHUB_CREDENTIAL_ENV_KEYS) delete out[key];
  return out;
}

/**
 * The `GH_TOKEN` a mac-host agent runs with: a fixed string that is NOT a
 * credential, so every `gh` call fails with "Bad credentials".
 *
 * Removing the variable is not enough there. A mac-host agent is a plain
 * child process with the host's `HOME`, and `gh` with no token in its
 * environment falls back to the host's stored login — `hosts.yml`, then the
 * macOS Keychain, and the Keychain lookup runs even when `hosts.yml` is absent
 * (gh's `ActiveToken` → `TokenFromKeyring(host)` with an empty user), so
 * pointing `GH_CONFIG_DIR` at an empty folder would not stop it. An
 * environment token outranks both, so pinning one that cannot authenticate is
 * the one setting that guarantees `gh` never reaches the host's login.
 */
export const NO_GITHUB_ACCESS_TOKEN = "sandcastle-sandbox-has-no-github-access";
