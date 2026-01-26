# syntax=docker/dockerfile:1

# Tailscale Hosts Sync - Syncs Tailscale device hostnames to a hosts file
# for use with Blocky, Pi-hole, or other DNS servers

# renovate: datasource=docker depName=python
ARG PYTHON_VERSION=3.13

# renovate: datasource=docker depName=alpine
ARG ALPINE_VERSION=3.21

# =============================================================================
# Runtime stage - minimal Python image
# =============================================================================
FROM python:${PYTHON_VERSION}-alpine${ALPINE_VERSION} AS runtime

ARG BUILD_DATE
ARG VCS_REF
ARG VERSION=1.0.0

LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.source="https://github.com/sharkusmanch/docker-images" \
      org.opencontainers.image.title="tailscale-hosts-sync" \
      org.opencontainers.image.description="Sync Tailscale device hostnames to hosts file for DNS servers"

# Install requests (only external dependency)
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-cache-dir requests==2.32.3

# Create non-root user
RUN addgroup -g 10000 appgroup && \
    adduser -u 10000 -G appgroup -s /bin/false -D appuser

# Copy sync script
COPY --chmod=755 sync.py /app/sync.py

# Create output directory
RUN mkdir -p /output && chown appuser:appgroup /output

USER appuser
WORKDIR /app

ENTRYPOINT ["python", "/app/sync.py"]
