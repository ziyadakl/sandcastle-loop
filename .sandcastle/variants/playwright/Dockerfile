# Sandcastle sandcastle-loop sandbox image — playwright variant.
#
# This variant pins Playwright to 1.56.x to avoid the Chrome-for-Testing
# memory regression introduced in Playwright 1.57+. From 1.57 onwards
# Playwright switched its bundled browser to Chrome-for-Testing, which
# spikes to ~20 GB RAM per browser instance and crashes parallel runs
# inside the sandbox. We also cap Node old-space to keep total memory
# bounded.
#
# This is the per-issue execution container that the orchestrator
# (`.sandcastle/main.mts`) spins up via the `docker()` factory call.
# Mounts (~/.claude, ~/.codex, repo at /workspace; never ~/.config/gh) are configured
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
# Non-root agent user. The UID/GID come from build args that
# `sandcastle docker build-image` fills with the BUILD HOST's own uid/gid
# (defaultUidBuildArgs), so the container user and the bind-mounted
# ~/.claude / ~/.codex always share an owner.
#
# These were hardcoded to 1001 for the retired Hostinger "hub" box. On any
# host with a different uid that silently breaks subscription auth: the 0600
# `.credentials.json` is unreadable inside the container and every agent
# reports "Not logged in". The Netcup VPS deploy user is 1000 — this is not
# hypothetical. Keep them build args; do NOT re-hardcode.
#
# The base node:22-bookworm-slim image ships a `node` user at UID 1000, so we
# delete it first to free either id.
# ---------------------------------------------------------------------------
ARG AGENT_UID=1001
ARG AGENT_GID=1001
RUN userdel -r node 2>/dev/null || true \
  && groupadd -g ${AGENT_GID} agent \
  && useradd -m -u ${AGENT_UID} -g ${AGENT_GID} -s /bin/bash agent \
  && mkdir -p /workspace \
  && chown -R agent:agent /workspace

# Allow agent to install global npm packages without root once we drop down.
RUN mkdir -p /home/agent/.npm-global \
  && chown -R agent:agent /home/agent/.npm-global

USER ${AGENT_UID}:${AGENT_GID}
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
# Monorepos commonly use pnpm's workspace:* protocol
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
# Pre-fetch pnpm so the merger's `pnpm install` hook never needs to download
# at runtime. The 2026-05-08 smoke test showed that even with the prompt
# silenced, the runtime download step itself was failing inside the merger's
# fresh sandbox. Baking the version in eliminates that whole code path.
# Pinned to the version the project's `package.json` packageManager
# field requests; if a future target project pins a different version,
# corepack still falls back to downloading on demand.
RUN corepack prepare pnpm@12.3.4 --activate

# ---------------------------------------------------------------------------
# Playwright — system libraries chromium needs to start (libnss, libdrm,
# libgbm, libfribidi, libharfbuzz, libthai, libdatrie, libgraphite2, etc).
# Without these the agent gets shipped a chromium binary it can't actually
# launch — repeatedly observed during the 2026-05-08 issue #83 smoke where
# the implementer hand-extracted .deb files at runtime to satisfy ldd.
# `playwright install-deps` knows the exact list; using it keeps the image
# in lockstep with whatever playwright version the target project pins.
# ---------------------------------------------------------------------------
# Pinned to ~1.56.0: Playwright 1.57+ switched to Chrome-for-Testing which
# spikes to ~20 GB RAM per browser instance and crashes parallel runs.
RUN npx -y playwright@~1.56.0 install-deps chromium \
  && rm -rf /var/lib/apt/lists/*

USER ${AGENT_UID}:${AGENT_GID}

# Pre-cache the chromium binary into /home/agent/.cache/ms-playwright so each
# new sandbox starts ready instead of downloading ~120 MB on first
# `playwright test`.
# Pinned to ~1.56.0: Playwright 1.57+ switched to Chrome-for-Testing which
# spikes to ~20 GB RAM per browser instance and crashes parallel runs.
RUN npx -y playwright@~1.56.0 install chromium

# ---------------------------------------------------------------------------
# Memory caps for Playwright runs.
# Parallelism is bounded by the target project's own playwright.config.ts
# (this repo pins `workers: 1`); Playwright reads no worker-count env var, so
# setting one here would be inert — do not add one (#1190, the builder
# command-cap fix).
# NODE_OPTIONS old-space=4096 caps the test-runner process itself.
# ---------------------------------------------------------------------------
ENV NODE_OPTIONS="--max-old-space-size=4096"

# ---------------------------------------------------------------------------
# Lint fan-out cap. `apps/nextjs` and `packages/api` each pin their own
# NODE_OPTIONS old-space=4096 inline on their `lint` script, which REPLACES
# the container ENV above — so the cap on this image does not apply to them.
# Verified 2026-08-03: eslint on apps/nextjs genuinely needs ~4 GB (it heap-OOMs
# at both 1536 and 2560), so the heap cannot be lowered. The only safe lever is
# preventing turbo from running several 4 GB eslint processes at once inside a
# single container. Root `pnpm lint` has no --concurrency flag and turbo's
# default fan-out is ~10; three such containers sharing one 8 GB VM is what
# OOM-killed the 2026-08-03 run. Container-only so shared repo scripts are
# untouched. Verified turbo 2.5.8 reads this env var.
# ---------------------------------------------------------------------------
ENV TURBO_CONCURRENCY=1

# ---------------------------------------------------------------------------
# Sandcastle bind-mounts the worktree at /workspace and overrides cwd, so we
# set WORKDIR here for any commands that run before the bind-mount applies.
# ENTRYPOINT keeps the container alive while the host issues `docker exec`s.
# ---------------------------------------------------------------------------
WORKDIR /workspace

ENTRYPOINT ["sleep", "infinity"]
