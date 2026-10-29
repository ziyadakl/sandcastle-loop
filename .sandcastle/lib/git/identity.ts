/**
 * The one git identity every commit this agent writes is stamped with.
 *
 * WHY THIS EXISTS. Before this module, `buildGitEnv` in `main.mts` read
 * `user.name`/`user.email` straight off the host, so every commit the loop
 * made — code the owner never wrote, in a run he was asleep for — was authored
 * AND committed under his own name and his GitHub-linked email. He does not
 * write code. `git log`, `git blame` and GitHub's author line all told him he
 * did, and there was no way to tell his work from the agent's.
 *
 * WHY THE NAME READS THE WAY IT DOES. The owner is the one who asked for the
 * work; the agent is the one who typed it. A name like
 * `Claude (on behalf of <owner>)` says both in the one field git actually
 * renders. The author is unambiguously the agent, and the person who
 * commissioned it is still visible without the history claiming they wrote a
 * line of it. The name and email come from `commitIdentity` in
 * `.sandcastle/project.json` (default `Claude <noreply@anthropic.com>`).
 *
 * WHY THIS EMAIL. GitHub attributes a commit to an account by matching the
 * author email against that account's verified addresses. `noreply@anthropic.com`
 * is attached to no GitHub account, so GitHub renders an unlinked
 * the configured name rather than linking the commit to the owner.
 * It also matches the `Co-Authored-By` trailer this repo already writes.
 *
 * NOT THE BOOKKEEPING IDENTITIES. The loop's own housekeeping commits keep
 * their own names — `sandcastle-lock`, `sandcastle-status`,
 * `sandcastle-telemetry` — because code matches on them (see
 * `reworkTipIsAmendable`, which compares the committer email). Those are
 * applied with `-c user.email=…`, which OUTRANKS repo config, so they are
 * unaffected by anything here.
 */

import { getProjectConfig } from "../project-config.js";

/**
 * Author + committer identity on every commit this agent writes. The email
 * must NOT be an address attached to the owner's GitHub account, or GitHub
 * links the commit back to them and the whole point is lost.
 */
export function agentCommitIdentity(): { readonly name: string; readonly email: string } {
  return getProjectConfig().commitIdentity;
}

/**
 * `-c user.name=… -c user.email=…`, ready to splice in front of a `git`
 * subcommand.
 *
 * Prefer this at every commit site over relying on the repo's config. Config
 * is ambient state: a read-only checkout, a `config.lock` collision, or a
 * fresh clone whose first action is a stop/checkpoint all leave it unset, and
 * the commit then silently falls through to the machine's identity — the
 * owner's — which is the exact failure this module exists to prevent. `-c` is
 * carried by the command itself, so it cannot be missing.
 */
export function agentIdentityArgs(): string[] {
  return [
    "-c",
    `user.name=${agentCommitIdentity().name}`,
    "-c",
    `user.email=${agentCommitIdentity().email}`,
  ];
}

/**
 * The same identity as environment variables, for commits made INSIDE the
 * agent container where no repo config of ours is reachable.
 *
 * Env vars OUTRANK `-c user.name`, so this must never be applied to the
 * orchestrator's own process — it would clobber the bookkeeping identities
 * above. It is scoped to the container environment only.
 */
export function agentIdentityEnv(): Record<string, string> {
  const { name, email } = agentCommitIdentity();
  return {
    GIT_AUTHOR_NAME: name,
    GIT_COMMITTER_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_EMAIL: email,
  };
}
