# syntax=docker/dockerfile:1

# renovate: datasource=github-releases depName=voska/hass-mcp
ARG HASS_MCP_VERSION=v0.1.1

# renovate: datasource=docker depName=python
ARG PYTHON_VERSION=3.13

# renovate: datasource=docker depName=alpine
ARG ALPINE_VERSION=3.21

# ============================================================================
# Builder stage
# ============================================================================
FROM python:${PYTHON_VERSION}-alpine${ALPINE_VERSION} AS builder

ARG HASS_MCP_VERSION

# Copy uv from official image
COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

WORKDIR /build

# Download and extract source
RUN wget -qO- "https://github.com/voska/hass-mcp/archive/refs/tags/${HASS_MCP_VERSION}.tar.gz" \
    | tar xz --strip-components=1

# Install dependencies with caching
ENV UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/app/.venv

RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --no-dev

# ============================================================================
# Runtime stage
# ============================================================================
FROM python:${PYTHON_VERSION}-alpine${ALPINE_VERSION} AS runtime

# Labels
ARG BUILD_DATE
ARG VCS_REF
ARG HASS_MCP_VERSION
LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${HASS_MCP_VERSION}" \
      org.opencontainers.image.source="https://github.com/sharkusmanch/docker-images" \
      org.opencontainers.image.upstream="https://github.com/voska/hass-mcp" \
      org.opencontainers.image.title="hass-mcp" \
      org.opencontainers.image.description="Home Assistant MCP server for Claude and LLMs"

# Create non-root user
RUN addgroup -g 10000 appgroup && \
    adduser -u 10000 -G appgroup -s /bin/false -D appuser

WORKDIR /app

# Copy application and virtual environment from builder
COPY --from=builder --chown=appuser:appgroup /build /app
COPY --from=builder --chown=appuser:appgroup /app/.venv /app/.venv

ENV VIRTUAL_ENV=/app/.venv \
    PATH="/app/.venv/bin:$PATH" \
    PYTHONPATH=/app \
    PYTHONUNBUFFERED=1

USER appuser

ENTRYPOINT ["hass-mcp"]
