# syntax=docker/dockerfile:1

# renovate: datasource=github-tags depName=mimnix/FlareProxy
ARG FLAREPROXY_VERSION=v1.0.0

# renovate: datasource=docker depName=python
ARG PYTHON_VERSION=3.12

# renovate: datasource=docker depName=alpine
ARG ALPINE_VERSION=3.21

# ============================================================================
# Builder stage
# ============================================================================
FROM python:${PYTHON_VERSION}-alpine${ALPINE_VERSION} AS builder

ARG FLAREPROXY_VERSION

WORKDIR /build

# Install git to clone source
RUN apk add --no-cache git

# Clone specific version from upstream
RUN git clone --branch ${FLAREPROXY_VERSION} --depth 1 \
    https://github.com/mimnix/FlareProxy.git .

# Install dependencies to a local directory for copying
RUN pip install --no-cache-dir --target=/dependencies -r requirements.txt

# ============================================================================
# Runtime stage
# ============================================================================
FROM python:${PYTHON_VERSION}-alpine${ALPINE_VERSION} AS runtime

# Labels
ARG BUILD_DATE
ARG VCS_REF
ARG FLAREPROXY_VERSION
LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${FLAREPROXY_VERSION}" \
      org.opencontainers.image.source="https://github.com/sharkusmanch/docker-images" \
      org.opencontainers.image.upstream="https://github.com/mimnix/FlareProxy" \
      org.opencontainers.image.title="flareproxy" \
      org.opencontainers.image.description="HTTP proxy adapter for FlareSolverr"

# Create non-root user
RUN addgroup -g 10000 appgroup && \
    adduser -u 10000 -G appgroup -s /bin/false -D -H appuser

WORKDIR /app

# Copy dependencies from builder
COPY --from=builder /dependencies /usr/local/lib/python3.12/site-packages

# Copy application
COPY --from=builder --chown=appuser:appgroup /build/flareproxy.py ./

# Switch to non-root user
USER appuser

EXPOSE 8080

# Health check - verify the proxy port is accepting connections
# FlareProxy has no health endpoint, so we check TCP connectivity
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD python -c "import socket; s=socket.socket(); s.settimeout(2); s.connect(('localhost',8080)); s.close()"

ENV FLARESOLVERR_URL=""

ENTRYPOINT ["python", "flareproxy.py"]
