# Sandcastle ralph-loop sandbox image.
#
# This is the per-issue execution container that the orchestrator
# (`.sandcastle/main.mts`) spins up via the `docker()` factory call.
# Mounts (~/.claude, ~/.config/gh, repo at /workspace) are configured
# at runtime — DO NOT bake credentials or repos into the image.
#
# Base: bookworm-slim per the Wave 6.1 spec. We pre-install only the
# CLIs that the agent prompts shell out to (gh, claude, psql, jq, git).

FROM node:22-bookworm-slim

# ---------------------------------------------------------------------------
# System deps — installed as root before user switch.
# ---------------------------------------------------------------------------

# Install core utilities + postgresql-client (for migration auto-apply on the
# host between sandbox runs; the container itself doesn't open psql sessions
# but the agent prompts call psql for verification commands).
#
# build-essential is needed so any native npm modules can compile during
# `npm install` inside the sandbox (drizzle, sharp, etc).
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    bash \
    jq \
    curl \
    ca-certificates \
    postgresql-client \
    build-essential \
    sudo \
  && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# GitHub CLI — installed from the official APT repository (verified via the
# Linux instructions at https://cli.github.com/manual/installation).
# ---------------------------------------------------------------------------
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Non-root agent user (UID/GID 1001 to match the hub deploy user — verified
# via `ssh hub id deploy`). The base node:22-bookworm-slim image ships a
# `node` user at UID 1000; we delete it and create our own at 1001 instead
# of renaming so that the IDs match the host bind-mount semantics exactly.
# ---------------------------------------------------------------------------
RUN userdel -r node 2>/dev/null || true \
  && groupadd -g 1001 agent \
  && useradd -m -u 1001 -g 1001 -s /bin/bash agent \
  && mkdir -p /workspace \
  && chown -R agent:agent /workspace

# Allow agent to install global npm packages without root once we drop down.
RUN mkdir -p /home/agent/.npm-global \
  && chown -R agent:agent /home/agent/.npm-global

USER agent
ENV NPM_CONFIG_PREFIX=/home/agent/.npm-global
ENV PATH="/home/agent/.npm-global/bin:/home/agent/.local/bin:${PATH}"

# ---------------------------------------------------------------------------
# Claude Code CLI — installed via Anthropic's official curl-pipe-sh script.
# Runs as the agent user so the binary lands in $HOME and the CLI's
# `~/.claude/` config directory matches the runtime mount layout.
# ---------------------------------------------------------------------------
RUN curl -fsSL https://claude.ai/install.sh | bash

# ---------------------------------------------------------------------------
# Corepack — Node 16+ ships corepack which provides pnpm/yarn shims.
# Affinity-tracker and similar monorepos use pnpm's workspace:* protocol
# which npm refuses to parse. Enabling corepack means our onSandboxReady
# hook can run `pnpm install` without an extra `npm install -g pnpm` step.
#
# COREPACK_ENABLE_DOWNLOAD_PROMPT=0 silences the interactive "about to
# download pnpm@X" prompt — without this, the merge phase fails non-
# interactively when the target's `package.json` pins a packageManager
# version corepack hasn't seen before.
# ---------------------------------------------------------------------------
USER root
RUN corepack enable
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
USER agent

# ---------------------------------------------------------------------------
# Sandcastle bind-mounts the worktree at /workspace and overrides cwd, so we
# set WORKDIR here for any commands that run before the bind-mount applies.
# ENTRYPOINT keeps the container alive while the host issues `docker exec`s.
# ---------------------------------------------------------------------------
WORKDIR /workspace

ENTRYPOINT ["sleep", "infinity"]
