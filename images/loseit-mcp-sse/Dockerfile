# syntax=docker/dockerfile:1

# renovate: datasource=github-commits depName=atfinke/loseit-mcp branch=main
ARG LOSEIT_MCP_COMMIT=f302e8fb7d0011043c2dae37c7131842b6d9d067

# renovate: datasource=github-releases depName=sparfenyuk/mcp-proxy
ARG MCP_PROXY_VERSION=v0.12.0

# renovate: datasource=docker depName=node versioning=docker
ARG NODE_VERSION=24

# renovate: datasource=docker depName=python versioning=docker
ARG PYTHON_VERSION=3.13

# renovate: datasource=docker depName=alpine
ARG ALPINE_VERSION=3.21

# ============================================================================
# Node builder stage (compiles the loseit-mcp TypeScript server)
# ============================================================================
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS node-builder

ARG LOSEIT_MCP_COMMIT

RUN --mount=type=cache,target=/var/cache/apk \
    apk add --no-cache git

WORKDIR /build

# Fetch the exact pinned upstream revision (loseit-mcp is private:true and not
# published to npm, so it must be built from source).
RUN git clone https://github.com/atfinke/loseit-mcp.git . && \
    git checkout "${LOSEIT_MCP_COMMIT}"

# Install all deps (lockfile present) and compile to dist/, then prune the dev
# deps so only the production node_modules ship to runtime.
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
ARG LOSEIT_MCP_COMMIT
ARG MCP_PROXY_VERSION
LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${LOSEIT_MCP_COMMIT}" \
      org.opencontainers.image.source="https://github.com/sharkusmanch/containers" \
      org.opencontainers.image.upstream="https://github.com/atfinke/loseit-mcp" \
      org.opencontainers.image.title="loseit-mcp-sse" \
      org.opencontainers.image.description="Lose It calorie-tracking MCP server with SSE transport for Kubernetes"

# nodejs needed to run the compiled stdio server; python provides mcp-proxy
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

# Wrap the stdio loseit-mcp server with mcp-proxy SSE transport.
# --pass-environment forwards LOSEIT_EMAIL / LOSEIT_PASSWORD (and the optional
# LOSEIT_* tuning/override vars) to the spawned node subprocess.
ENTRYPOINT ["mcp-proxy", "--host", "0.0.0.0", "--port", "8080", "--pass-environment", "--", "node", "/app/dist/index.js"]
