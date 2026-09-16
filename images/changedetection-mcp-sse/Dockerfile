# syntax=docker/dockerfile:1

# renovate: datasource=github-commits depName=rusty4444/changedetection-mcp branch=main
ARG CHANGEDETECTION_MCP_COMMIT=f708f3784c62cb3bee6ef4c53347a4fd460a3702

# renovate: datasource=github-releases depName=sparfenyuk/mcp-proxy
ARG MCP_PROXY_VERSION=v0.12.0

# Held at 1.x ON PURPOSE. mcp-proxy 0.12.0 declares `mcp>=1.17.0` with no upper
# bound, but mcp 2.x dropped `mcp.server.lowlevel.server.request_ctx`, which
# proxy_server.py imports at module scope -- an unpinned build resolves mcp 2.x
# and the entrypoint dies with ImportError before it ever listens (the alpine
# 3.24 rebuild of 2026-09-16 shipped mcp 2.2.0 and crash-looped the pod). Only
# unpin when mcp-proxy ships a release that supports mcp 2.x. Renovate tracks
# 1.x only (allowedVersions in renovate.json); lift that rule when unpinning.
# renovate: datasource=pypi depName=mcp
ARG MCP_SDK_VERSION=1.30.0

# renovate: datasource=docker depName=python versioning=docker
ARG PYTHON_VERSION=3.13

# renovate: datasource=docker depName=alpine
ARG ALPINE_VERSION=3.24

# ============================================================================
# Builder stage
# ============================================================================
FROM python:${PYTHON_VERSION}-alpine${ALPINE_VERSION} AS builder

ARG CHANGEDETECTION_MCP_COMMIT
ARG MCP_PROXY_VERSION
ARG MCP_SDK_VERSION

# Copy uv from official image
COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

# git needed to fetch the pinned upstream source
RUN --mount=type=cache,target=/var/cache/apk \
    apk add git

WORKDIR /build

# Fetch the exact reviewed upstream revision (built from source, not PyPI)
RUN git clone https://github.com/rusty4444/changedetection-mcp.git . && \
    git checkout "${CHANGEDETECTION_MCP_COMMIT}"

ENV UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_PYTHON_DOWNLOADS=never

# Build a self-contained venv with the MCP server + mcp-proxy bridge
RUN --mount=type=cache,target=/root/.cache/uv \
    uv venv /app/.venv && \
    uv pip install --python=/app/.venv/bin/python . \
      "mcp-proxy==${MCP_PROXY_VERSION#v}" "mcp==${MCP_SDK_VERSION}"

# Fail the build, not the deploy: mcp-proxy imports mcp internals at startup
# (see MCP_SDK_VERSION above), so an incompatible SDK bump surfaces here as an
# ImportError instead of a crash-looping pod after it automerges.
RUN /app/.venv/bin/mcp-proxy --help > /dev/null

# ============================================================================
# Runtime stage
# ============================================================================
FROM python:${PYTHON_VERSION}-alpine${ALPINE_VERSION} AS runtime

# Labels
ARG BUILD_DATE
ARG VCS_REF
ARG CHANGEDETECTION_MCP_COMMIT
ARG MCP_PROXY_VERSION
LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${CHANGEDETECTION_MCP_COMMIT}" \
      org.opencontainers.image.source="https://github.com/sharkusmanch/containers" \
      org.opencontainers.image.upstream="https://github.com/rusty4444/changedetection-mcp" \
      org.opencontainers.image.title="changedetection-mcp-sse" \
      org.opencontainers.image.description="ChangeDetection.io MCP server with SSE transport for Kubernetes"

# Create non-root user
RUN addgroup -g 10000 appgroup && \
    adduser -u 10000 -G appgroup -s /bin/false -D appuser

WORKDIR /app

# Copy the prebuilt virtual environment from the builder
COPY --from=builder --chown=appuser:appgroup /app/.venv /app/.venv

ENV VIRTUAL_ENV=/app/.venv \
    PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1

USER appuser

EXPOSE 8080

# Use mcp-proxy to wrap the changedetection-mcp stdio server as SSE.
# --pass-environment forwards CHANGEDETECTION_BASE_URL / CHANGEDETECTION_API_KEY
# (and CHANGEDETECTION_MCP_ACTION_LIMIT_PER_WATCH) to the server.
ENTRYPOINT ["mcp-proxy", "--host", "0.0.0.0", "--port", "8080", "--pass-environment", "--", "changedetection-mcp"]
