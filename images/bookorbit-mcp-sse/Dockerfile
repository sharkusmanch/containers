# syntax=docker/dockerfile:1

# renovate: datasource=github-commits depName=joshstrange/bookorbit-mcp branch=main
ARG BOOKORBIT_MCP_COMMIT=1fc55abc357e0bbc800f3d3d1cd8ee12dc9f5793

# renovate: datasource=github-releases depName=sparfenyuk/mcp-proxy
ARG MCP_PROXY_VERSION=v0.12.0

# renovate: datasource=docker depName=node versioning=docker
ARG NODE_VERSION=24

# renovate: datasource=docker depName=python versioning=docker
ARG PYTHON_VERSION=3.14

# renovate: datasource=docker depName=alpine
ARG ALPINE_VERSION=3.21

# ============================================================================
# Node builder stage (compiles the bookorbit-mcp TypeScript server)
# ============================================================================
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS node-builder

ARG BOOKORBIT_MCP_COMMIT

RUN --mount=type=cache,target=/var/cache/apk \
    apk add --no-cache git

WORKDIR /build

# Fetch the exact pinned upstream revision. bookorbit-mcp publishes no releases,
# no tags and no npm package, so the image is built from pinned GitHub source.
RUN git clone https://github.com/joshstrange/bookorbit-mcp.git . && \
    git checkout "${BOOKORBIT_MCP_COMMIT}"

# Install from the committed lockfile, then patch transitive advisories before
# compiling. Upstream's July lockfile pins vulnerable hono / fast-uri /
# ip-address, all reached only through @modelcontextprotocol/sdk's HTTP
# transport (unused — this server is stdio-only), but `npm audit fix` clears
# all four with the test suite still green, so ship them patched.
RUN --mount=type=cache,target=/root/.npm \
    npm ci && \
    npm audit fix && \
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
ARG BOOKORBIT_MCP_COMMIT
ARG MCP_PROXY_VERSION
LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${BOOKORBIT_MCP_COMMIT}" \
      org.opencontainers.image.source="https://github.com/sharkusmanch/containers" \
      org.opencontainers.image.upstream="https://github.com/joshstrange/bookorbit-mcp" \
      org.opencontainers.image.title="bookorbit-mcp-sse" \
      org.opencontainers.image.description="BookOrbit ebook-text MCP server with SSE transport for Kubernetes"

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

# Extracted chapter text is cached here (~1.1 MB per novel). Mount a volume to
# persist it; without one the cache rebuilds from the BookOrbit reader API on
# first read after each restart. CACHE_DIR is set explicitly so the app never
# falls back to $HOME/.cache, which is not writable under a read-only rootfs.
RUN mkdir -p /cache && chown appuser:appgroup /cache
VOLUME ["/cache"]

ENV VIRTUAL_ENV=/app/.venv \
    PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    NODE_ENV=production \
    CACHE_DIR=/cache

USER appuser

EXPOSE 8080

# Wrap the stdio bookorbit-mcp server with mcp-proxy SSE transport.
# --pass-environment forwards BOOKORBIT_URL / BOOKORBIT_USERNAME /
# BOOKORBIT_PASSWORD (and CACHE_DIR) to the spawned node subprocess.
ENTRYPOINT ["mcp-proxy", "--host", "0.0.0.0", "--port", "8080", "--pass-environment", "--", "node", "/app/dist/server.js"]
