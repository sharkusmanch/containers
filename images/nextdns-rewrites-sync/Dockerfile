# syntax=docker/dockerfile:1

# renovate: datasource=docker depName=python
ARG PYTHON_VERSION=3.13

# renovate: datasource=docker depName=alpine
ARG ALPINE_VERSION=3.21

# =============================================================================
# Runtime stage
# =============================================================================
FROM python:${PYTHON_VERSION}-alpine${ALPINE_VERSION} AS runtime

ARG BUILD_DATE
ARG VCS_REF
ARG VERSION=1.0.0

LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.source="https://github.com/sharkusmanch/docker-images" \
      org.opencontainers.image.title="nextdns-rewrites-sync" \
      org.opencontainers.image.description="Reconcile Tailscale device FQDNs and static entries to NextDNS rewrites API"

COPY requirements.txt /tmp/requirements.txt
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-cache-dir -r /tmp/requirements.txt

RUN addgroup -g 10000 appgroup && \
    adduser -u 10000 -G appgroup -s /bin/false -D appuser

COPY --chmod=755 sync.py /app/sync.py

USER appuser
WORKDIR /app

ENTRYPOINT ["python", "/app/sync.py"]
