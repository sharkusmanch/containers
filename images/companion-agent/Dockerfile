# syntax=docker/dockerfile:1

# This directory is the source: there is no upstream. Bump on every change that should ship;
# the build workflow tags the image with the first *_VERSION ARG in this file.
ARG COMPANION_AGENT_VERSION=v0.2.0

# renovate: datasource=docker depName=node
ARG NODE_VERSION=24.22.1

# renovate: datasource=npm depName=@anthropic-ai/claude-code
ARG CLAUDE_VERSION=2.1.309

# companion-agent: answers the game companion's Ask questions with a locked-down `claude -p`.
#
# amd64 only (.platforms): the Claude Code native binary is per-arch and must not be
# QEMU-built for arm64.

# ---------- builder ----------
# Build on the runner's native platform: the output is platform-independent JavaScript.
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS builder
WORKDIR /build
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---------- claude ----------
# Fetch Claude Code with the official installer on the runtime's Debian/glibc base, so the
# installer picks the glibc build and its launcher symlink stays valid when copied across.
FROM node:${NODE_VERSION}-slim AS claude
ARG CLAUDE_VERSION
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
# Install into a fixed HOME and keep the whole tree, so the launcher symlink resolves at
# runtime; each run's HOME is its own directory in the pod's emptyDir HOME.
RUN HOME=/opt/claude bash -c "curl -fsSL https://claude.ai/install.sh | bash -s ${CLAUDE_VERSION}" \
    # The installer has a history of not creating the bin symlink: fail the build rather
    # than ship a stub.
    && test -x "$(readlink -f /opt/claude/.local/bin/claude)" \
    && chmod -R a+rX /opt/claude

# ---------- runtime ----------
FROM node:${NODE_VERSION}-slim AS runtime

ARG BUILD_DATE
ARG VCS_REF
ARG COMPANION_AGENT_VERSION
ARG CLAUDE_VERSION
LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${COMPANION_AGENT_VERSION}" \
      org.opencontainers.image.source="https://github.com/sharkusmanch/containers" \
      org.opencontainers.image.upstream="https://github.com/sharkusmanch/containers" \
      org.opencontainers.image.title="companion-agent" \
      org.opencontainers.image.description="Answers the game companion's Ask questions with a locked-down Claude Code"

# bash and curl for the agent's shell, python3 for the skill plugins' scripts (redlib, vibepollo);
# tini is PID 1 so SIGTERM reaches node and orphans of killed claude runs are reaped.
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates curl python3 tini \
    && rm -rf /var/lib/apt/lists/*

COPY --from=claude /opt/claude /opt/claude
RUN ln -sf /opt/claude/.local/bin/claude /usr/local/bin/claude

# HOME is an emptyDir at deploy; the directories exist here so the image also runs without one.
# /agent/skills/redlib is the default plugin directory (the redlib plugin, mounted read-only); the
# deploy mounts the other skill plugins beside it.
RUN groupadd -g 10000 agent \
    && useradd -u 10000 -g 10000 -d /home/agent -s /usr/sbin/nologin agent \
    && mkdir -p /home/agent /agent/skills/redlib \
    && chown agent:agent /home/agent

WORKDIR /app
# No node_modules: the service has no runtime dependencies. package.json marks the compiled
# output as ES modules; the server reads allowed-tools.json from here at startup.
COPY --from=builder /build/dist ./dist
COPY package.json allowed-tools.json ./
# The default house rules; the deploy mounts its own copy over /agent/project.
COPY project/CLAUDE.md /agent/project/CLAUDE.md

ENV NODE_ENV=production \
    PORT=8080 \
    HOME=/home/agent \
    AGENT_PROJECT_DIR=/agent/project \
    AGENT_SKILLS_DIR=/agent/skills/redlib

USER 10000:10000

# Fail the build, not the pod: the pinned claude must run on this base and the server must load.
RUN set -eux; \
    tmp="$(mktemp -d)"; \
    HOME="$tmp" claude --version | tee /dev/stderr | grep -q "${CLAUDE_VERSION}"; \
    rm -rf "$tmp"; \
    python3 --version; \
    node -e "import('/app/dist/server.js')"

EXPOSE 8080
ENTRYPOINT ["tini", "--", "node", "dist/index.js"]
