# syntax=docker/dockerfile:1

# Pinned to last code change (not Renovate-tracked — repo has frequent automated output commits)
ARG SWC_COMMIT=da6dc6624cf289e53c4ffe070fdbe04f9b3901eb

# renovate: datasource=docker depName=python versioning=docker
ARG PYTHON_VERSION=3.12

# renovate: datasource=docker depName=alpine
ARG ALPINE_VERSION=3.21

# ============================================================================
# Builder stage
# ============================================================================
FROM python:${PYTHON_VERSION}-alpine${ALPINE_VERSION} AS builder

ARG SWC_COMMIT

# Copy uv from official image
COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

WORKDIR /build

# Build dependencies for compiling packages from source (arm64 lacks pre-built wheels)
RUN apk add --no-cache gcc g++ musl-dev freetype-dev libpng-dev pkgconf

# Download and extract source
RUN wget -qO- "https://github.com/icue/SteamWishlistCalendar/archive/${SWC_COMMIT}.tar.gz" \
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
ARG SWC_COMMIT
LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${SWC_COMMIT}" \
      org.opencontainers.image.source="https://github.com/sharkusmanch/containers" \
      org.opencontainers.image.upstream="https://github.com/icue/SteamWishlistCalendar" \
      org.opencontainers.image.title="steam-wishlist-calendar" \
      org.opencontainers.image.description="Generate an ICS calendar from your Steam wishlist release dates"

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

ENTRYPOINT ["python", "/app/swc.py"]
CMD ["--help"]
