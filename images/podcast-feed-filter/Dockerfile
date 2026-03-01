# syntax=docker/dockerfile:1

# renovate: datasource=docker depName=python
ARG PYTHON_VERSION=3.12

# renovate: datasource=docker depName=alpine
ARG ALPINE_VERSION=3.21

ARG VERSION=1.0.0

# ============================================================================
# Builder stage
# ============================================================================
FROM python:${PYTHON_VERSION}-alpine${ALPINE_VERSION} AS builder

# lxml build dependencies
RUN --mount=type=cache,target=/var/cache/apk \
    apk add --no-cache gcc musl-dev libxml2-dev libxslt-dev

# Copy uv from official image
COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

WORKDIR /build

COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --system --prefix=/deps -r requirements.txt

# ============================================================================
# Runtime stage
# ============================================================================
FROM python:${PYTHON_VERSION}-alpine${ALPINE_VERSION} AS runtime

ARG BUILD_DATE
ARG VCS_REF
ARG VERSION
LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.source="https://github.com/sharkusmanch/containers" \
      org.opencontainers.image.title="podcast-feed-filter" \
      org.opencontainers.image.description="Stateless podcast RSS feed filter preserving enclosures and iTunes tags"

# lxml runtime dependencies
RUN --mount=type=cache,target=/var/cache/apk \
    apk add --no-cache libxml2 libxslt

# Create non-root user
RUN addgroup -g 10000 appgroup && \
    adduser -u 10000 -G appgroup -s /bin/false -D appuser && \
    mkdir -p /app /config && \
    chown -R appuser:appgroup /app /config

WORKDIR /app

# Copy Python dependencies from builder
COPY --from=builder /deps /usr/local

# Copy application
COPY --chown=appuser:appgroup app.py /app/app.py

ENV PYTHONUNBUFFERED=1
ENV CONFIG_PATH=/config/config.yaml

USER appuser

EXPOSE 8080

ENTRYPOINT ["gunicorn", "app:app", "--bind", "0.0.0.0:8080", "--workers", "2", "--timeout", "30"]
