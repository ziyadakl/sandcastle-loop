# Sandcastle sandcastle-loop sandbox image — agent-browser variant.
#
# This variant replaces Playwright with Vercel Labs' agent-browser
# (https://github.com/vercel-labs/agent-browser): a native Rust CLI
# designed for AI agents to drive a browser from the shell. We use it
# because it's lighter than Playwright (single Rust binary, no Node
# wrapper layer), exposes pages via an accessibility-tree snapshot with
# stable element refs (e1, e2, ...) that the agent can target without
# guessing CSS selectors, and ships ARM64-native binaries for Apple
# Silicon hosts.
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

USER 1001
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
# ---------------------------------------------------------------------------
USER root
RUN corepack enable
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack prepare pnpm@10.19.0 --activate

# ---------------------------------------------------------------------------
# agent-browser — Vercel Labs CLI for AI-driven browser automation.
#
# Lighter than Playwright (single Rust binary, no Node wrapper) and
# designed for AI agents: snapshot returns an accessibility tree with
# stable refs (e1, e2, ...) that the agent targets directly, instead of
# inventing CSS selectors. Pinned to a specific version because v0.x is
# pre-1.0 and the snapshot/ref format has changed between minors.
# ---------------------------------------------------------------------------
ARG AGENT_BROWSER_VERSION=0.27.0
RUN npm install -g agent-browser@${AGENT_BROWSER_VERSION}

# `agent-browser install --with-deps` downloads Chrome-for-Testing AND
# pulls the Linux system libs Chrome needs (libnss, libgbm, libdrm,
# libxkbcommon, etc). Doing this at image build time means the per-issue
# sandbox starts with the browser already cached — no first-run delay.
# Run as root so --with-deps can apt-install; switch back afterward.
#
# `apt-get update` is required here because the previous RUN blocks wiped
# /var/lib/apt/lists/*; without a fresh refresh, the apt-install step
# inside `--with-deps` fails with "package not found".
RUN apt-get update \
  && agent-browser install --with-deps \
  && rm -rf /var/lib/apt/lists/*

USER 1001

# Pre-cache the agent-browser Chrome download into the agent user's home
# so each new sandbox starts without a 120 MB download on first invoke.
# (The root install above lands in /root; redo as agent so the cache is
# in /home/agent/.cache/agent-browser where the runtime user finds it.)
RUN agent-browser install

# ---------------------------------------------------------------------------
# Memory caps. agent-browser is single-threaded by default but we still
# bound the Node test-runner process so a stray test harness can't OOM
# the host. NODE_OPTIONS old-space=4096 mirrors the playwright variant.
# ---------------------------------------------------------------------------
ENV NODE_OPTIONS="--max-old-space-size=4096"

# ---------------------------------------------------------------------------
# Sandcastle bind-mounts the worktree at /workspace and overrides cwd, so we
# set WORKDIR here for any commands that run before the bind-mount applies.
# ENTRYPOINT keeps the container alive while the host issues `docker exec`s.
# ---------------------------------------------------------------------------
WORKDIR /workspace

ENTRYPOINT ["sleep", "infinity"]
