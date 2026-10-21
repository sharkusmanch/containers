# syntax=docker/dockerfile:1

# Pinned to a commit of the xbox-wishlist-tools source (pure-Python). Pin only commits whose CI
# passed in that repo; bump this by hand.
ARG XWC_COMMIT=86bc1719ce733b1952aa24699e9f2c61bab2a058

# renovate: datasource=docker depName=python versioning=docker
ARG PYTHON_VERSION=3.14

# renovate: datasource=docker depName=alpine
ARG ALPINE_VERSION=3.24

# ============================================================================
# Builder stage
# ============================================================================
FROM python:${PYTHON_VERSION}-alpine${ALPINE_VERSION} AS builder

ARG XWC_COMMIT

# Copy uv from official image
COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

WORKDIR /build

# Pure-Python dependency (tzdata) - no compiler/build deps needed.

# Download and extract source
RUN wget -qO- "https://github.com/sharkusmanch/xbox-wishlist-tools/archive/${XWC_COMMIT}.tar.gz" \
    | tar xz --strip-components=1

# Install dependencies with caching
ENV UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_PYTHON_DOWNLOADS=never

RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --target /app/deps -r requirements.txt

# ============================================================================
# Runtime stage
# ============================================================================
FROM python:${PYTHON_VERSION}-alpine${ALPINE_VERSION} AS runtime

# Labels
ARG BUILD_DATE
ARG VCS_REF
ARG XWC_COMMIT
LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${XWC_COMMIT}" \
      org.opencontainers.image.source="https://github.com/sharkusmanch/containers" \
      org.opencontainers.image.upstream="https://github.com/sharkusmanch/xbox-wishlist-tools" \
      org.opencontainers.image.title="xbox-wishlist-calendar" \
      org.opencontainers.image.description="Xbox wishlist release-time artifacts (wishlist.json + text lists + ICS)"

# Create non-root user
RUN addgroup -g 10000 appgroup && \
    adduser -u 10000 -G appgroup -s /bin/false -D appuser && \
    mkdir -p /app /output && \
    chown -R appuser:appgroup /app /output

WORKDIR /

# Copy application source and dependencies from builder
COPY --from=builder --chown=appuser:appgroup /build /app
COPY --from=builder --chown=appuser:appgroup /app/deps /app/deps

ENV PYTHONPATH=/app/deps \
    PYTHONUNBUFFERED=1

USER appuser

VOLUME ["/output"]

ENTRYPOINT ["python", "/app/xwc.py"]
CMD ["--help"]
