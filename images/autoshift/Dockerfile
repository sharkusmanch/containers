# syntax=docker/dockerfile:1

# renovate: datasource=github-releases depName=Fabbi/autoshift
ARG AUTOSHIFT_VERSION=v2.1.4

# renovate: datasource=docker depName=python
ARG PYTHON_VERSION=3.12

# renovate: datasource=docker depName=alpine
ARG ALPINE_VERSION=3.21

# ============================================================================
# Builder stage
# ============================================================================
FROM python:${PYTHON_VERSION}-alpine${ALPINE_VERSION} AS builder

ARG AUTOSHIFT_VERSION

# Copy uv from official image
COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

WORKDIR /build

# Download and extract source
RUN wget -qO- "https://github.com/Fabbi/autoshift/archive/refs/tags/${AUTOSHIFT_VERSION}.tar.gz" \
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
ARG AUTOSHIFT_VERSION
LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${AUTOSHIFT_VERSION}" \
      org.opencontainers.image.source="https://github.com/sharkusmanch/docker-images" \
      org.opencontainers.image.upstream="https://github.com/Fabbi/autoshift" \
      org.opencontainers.image.title="autoshift" \
      org.opencontainers.image.description="Automatic SHiFT code redemption for Borderlands games"

# Create non-root user
RUN addgroup -g 10000 appgroup && \
    adduser -u 10000 -G appgroup -s /bin/false -D appuser && \
    mkdir -p /app /data && \
    chown -R appuser:appgroup /app /data

WORKDIR /app

# Copy application and virtual environment from builder
COPY --from=builder --chown=appuser:appgroup /build /app
COPY --from=builder --chown=appuser:appgroup /app/.venv /app/.venv

ENV VIRTUAL_ENV=/app/.venv \
    PATH="/app/.venv/bin:$PATH" \
    PYTHONPATH=/app \
    PYTHONUNBUFFERED=1

USER appuser

VOLUME ["/data"]

ENTRYPOINT ["python", "-m", "autoshift"]
CMD ["--help"]
