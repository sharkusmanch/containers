# syntax=docker/dockerfile:1

# renovate: datasource=github-tags depName=mimnix/FlareProxy
ARG FLAREPROXY_VERSION=v1.0.3

# renovate: datasource=docker depName=python versioning=docker
ARG PYTHON_VERSION=3.15

# renovate: datasource=docker depName=alpine
ARG ALPINE_VERSION=3.24

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

# Install dependencies under a /usr/local-shaped prefix. The runtime stage copies
# it over /usr/local, so they land in the site-packages of whichever Python both
# stages share. (A hard-coded lib/python3.X path silently broke the image when
# the base moved off 3.12: the packages were copied where 3.14/3.15 never look.)
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

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
      org.opencontainers.image.source="https://github.com/sharkusmanch/containers" \
      org.opencontainers.image.upstream="https://github.com/mimnix/FlareProxy" \
      org.opencontainers.image.title="flareproxy" \
      org.opencontainers.image.description="HTTP proxy adapter for FlareSolverr"

WORKDIR /app

# Copy dependencies from builder
COPY --from=builder /install /usr/local

# Copy application
COPY --from=builder /build/flareproxy.py ./

# Fail the build, not the pod, if the runtime interpreter cannot import the
# dependencies (the python3.12 path bug above only showed up at runtime).
RUN python -c "import requests, cryptography"

# Run as nobody. Stateless apart from the TLS material FlareProxy generates
# at startup in a temporary directory: with a read-only root filesystem,
# mount a writable /tmp.
USER nobody

EXPOSE 8080 8443

# Health check - verify the proxy port is accepting connections
# FlareProxy has no health endpoint, so we check TCP connectivity
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD python -c "import socket; s=socket.socket(); s.settimeout(2); s.connect(('localhost',8080)); s.close()"

ENV FLARESOLVERR_URL=""

ENTRYPOINT ["python", "flareproxy.py"]
