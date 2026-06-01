# syntax=docker/dockerfile:1

# renovate: datasource=github-releases depName=tssujt/miniflux-mcp
ARG MINIFLUX_MCP_VERSION=v0.1.0

# renovate: datasource=github-releases depName=sparfenyuk/mcp-proxy
ARG MCP_PROXY_VERSION=v0.12.0

# renovate: datasource=docker depName=golang
ARG GOLANG_VERSION=1.25

# renovate: datasource=docker depName=python versioning=docker
ARG PYTHON_VERSION=3.14

# renovate: datasource=docker depName=alpine
ARG ALPINE_VERSION=3.21

# ============================================================================
# Go builder stage (compiles miniflux-mcp binary)
# ============================================================================
FROM golang:${GOLANG_VERSION}-alpine${ALPINE_VERSION} AS go-builder

ARG MINIFLUX_MCP_VERSION

WORKDIR /build

# Download and extract miniflux-mcp source
RUN wget -qO- "https://github.com/tssujt/miniflux-mcp/archive/refs/tags/${MINIFLUX_MCP_VERSION}.tar.gz" \
    | tar xz --strip-components=1

# Build static binary
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /miniflux-mcp .

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
ARG MINIFLUX_MCP_VERSION
ARG MCP_PROXY_VERSION
LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${MINIFLUX_MCP_VERSION}" \
      org.opencontainers.image.source="https://github.com/sharkusmanch/containers" \
      org.opencontainers.image.upstream="https://github.com/tssujt/miniflux-mcp" \
      org.opencontainers.image.title="miniflux-mcp-sse" \
      org.opencontainers.image.description="Miniflux MCP server with SSE transport for Kubernetes"

# Create non-root user
RUN addgroup -g 10000 appgroup && \
    adduser -u 10000 -G appgroup -s /bin/false -D appuser

WORKDIR /app

# Copy mcp-proxy venv from python builder
COPY --from=py-builder --chown=appuser:appgroup /app/.venv /app/.venv

# Copy compiled Go binary
COPY --from=go-builder /miniflux-mcp /usr/local/bin/miniflux-mcp

ENV VIRTUAL_ENV=/app/.venv \
    PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1

USER appuser

EXPOSE 8080

# Wrap stdio miniflux-mcp with mcp-proxy SSE transport
# --pass-environment forwards MINIFLUX_URL and MINIFLUX_API_KEY to miniflux-mcp
ENTRYPOINT ["mcp-proxy", "--host", "0.0.0.0", "--port", "8080", "--pass-environment", "--", "/usr/local/bin/miniflux-mcp"]
