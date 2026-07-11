# syntax=docker/dockerfile:1

# renovate: datasource=github-releases depName=democratize-technology/vikunja-mcp
ARG VIKUNJA_MCP_VERSION=v0.2.0

# renovate: datasource=github-releases depName=sparfenyuk/mcp-proxy
ARG MCP_PROXY_VERSION=v0.12.0

# renovate: datasource=docker depName=node versioning=docker
ARG NODE_VERSION=24

# renovate: datasource=docker depName=python versioning=docker
ARG PYTHON_VERSION=3.14

# renovate: datasource=docker depName=alpine
ARG ALPINE_VERSION=3.21

# ============================================================================
# Node builder stage (compiles the vikunja-mcp TypeScript server)
# ============================================================================
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS node-builder

ARG VIKUNJA_MCP_VERSION

RUN --mount=type=cache,target=/var/cache/apk \
    apk add --no-cache git

WORKDIR /build

# Fetch the exact pinned upstream tag. vikunja-mcp is published to npm, but we
# build from the git tag for an auditable, reproducible dist/. All runtime deps
# are pure-JS (@modelcontextprotocol/sdk, dotenv, node-fetch, node-vikunja,
# uuid) — no native modules — so no build toolchain (build-base/python) is
# required beyond git.
RUN git clone https://github.com/democratize-technology/vikunja-mcp.git . && \
    git checkout "${VIKUNJA_MCP_VERSION}"

# Install all deps (lockfile present), compile TS to dist/ (npm run build = tsc),
# then prune dev deps so only production node_modules ship to runtime.
RUN --mount=type=cache,target=/root/.npm \
    npm ci && \
    npm run build && \
    npm prune --omit=dev

# ============================================================================
# Python builder stage (installs mcp-proxy)
# ============================================================================
FROM python:${PYTHON_VERSION}-alpine${ALPINE_VERSION} AS py-builder

ARG MCP_PROXY_VERSION

# Copy uv from official image
COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

WORKDIR /build

ENV UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_PYTHON_DOWNLOADS=never \
    UV_PYTHON=/usr/local/bin/python

RUN --mount=type=cache,target=/root/.cache/uv \
    uv venv /app/.venv && \
    uv pip install --python=/app/.venv/bin/python "mcp-proxy==${MCP_PROXY_VERSION#v}"

# ============================================================================
# Runtime stage
# ============================================================================
FROM python:${PYTHON_VERSION}-alpine${ALPINE_VERSION} AS runtime

ARG BUILD_DATE
ARG VCS_REF
ARG VIKUNJA_MCP_VERSION
ARG MCP_PROXY_VERSION
LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${VIKUNJA_MCP_VERSION}" \
      org.opencontainers.image.source="https://github.com/sharkusmanch/containers" \
      org.opencontainers.image.upstream="https://github.com/democratize-technology/vikunja-mcp" \
      org.opencontainers.image.title="vikunja-mcp-sse" \
      org.opencontainers.image.description="Vikunja task-manager MCP server with SSE transport for Kubernetes"

# nodejs runs the compiled stdio server; python provides mcp-proxy
RUN --mount=type=cache,target=/var/cache/apk \
    apk add --no-cache nodejs

# Create non-root user
RUN addgroup -g 10000 appgroup && \
    adduser -u 10000 -G appgroup -s /bin/false -D appuser

WORKDIR /app

# Copy mcp-proxy venv from python builder
COPY --from=py-builder --chown=appuser:appgroup /app/.venv /app/.venv

# Copy the compiled server + production node_modules from the node builder
COPY --from=node-builder --chown=appuser:appgroup /build/dist /app/dist
COPY --from=node-builder --chown=appuser:appgroup /build/node_modules /app/node_modules
COPY --from=node-builder --chown=appuser:appgroup /build/package.json /app/package.json

ENV VIRTUAL_ENV=/app/.venv \
    PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    NODE_ENV=production

USER appuser

EXPOSE 8080

# Wrap the stdio vikunja-mcp server with mcp-proxy SSE transport.
# --pass-environment forwards VIKUNJA_URL and VIKUNJA_API_TOKEN to the spawned
# node subprocess. SSE is served at /sse, health at /status.
ENTRYPOINT ["mcp-proxy", "--host", "0.0.0.0", "--port", "8080", "--pass-environment", "--", "node", "/app/dist/index.js"]
