# syntax=docker/dockerfile:1

# renovate: datasource=github-commits depName=rusty4444/changedetection-mcp branch=main
ARG CHANGEDETECTION_MCP_COMMIT=f708f3784c62cb3bee6ef4c53347a4fd460a3702

# renovate: datasource=github-releases depName=sparfenyuk/mcp-proxy
ARG MCP_PROXY_VERSION=v0.12.0

# renovate: datasource=docker depName=python versioning=docker
ARG PYTHON_VERSION=3.13

# renovate: datasource=docker depName=alpine
ARG ALPINE_VERSION=3.21

# ============================================================================
# Builder stage
# ============================================================================
FROM python:${PYTHON_VERSION}-alpine${ALPINE_VERSION} AS builder

ARG CHANGEDETECTION_MCP_COMMIT
ARG MCP_PROXY_VERSION

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
    uv pip install --python=/app/.venv/bin/python . "mcp-proxy==${MCP_PROXY_VERSION#v}"

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
