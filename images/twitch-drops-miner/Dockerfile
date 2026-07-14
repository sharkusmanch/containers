# syntax=docker/dockerfile:1

# TEMPORARY fork build: upstream rangermix/TwitchDropsMiner 1.2.4 + the still-unmerged
# PR #70 (capkz:fix/drops-spade-post-endpoint). Twitch removed the `sendSpadeEvents`
# GraphQL mutation during the 2026 Summer Drops event, which silently froze all drop
# progress (the miner "watches" but earns nothing — upstream issue #69). PR #70 reverts
# watch-event reporting to a direct POST against the Spade endpoint.
#   >>> REMOVE this image and repin the HelmReleases to the official upstream image once
#   >>> PR #70 merges and rangermix cuts a release > 1.2.4. Tracking:
#   >>> https://github.com/rangermix/TwitchDropsMiner/issues/69  (+ PR #70)

# NOTE: APP_VERSION is intentionally the FIRST `*_VERSION` ARG so build.yml tags the
# image `1.2.4-pr70` (its version-extraction greps the first `^ARG.*_VERSION=`).
ARG APP_VERSION=1.2.4-pr70

# renovate: datasource=docker depName=python
ARG PYTHON_VERSION=3.13

# PR #70 head (capkz fork). Pinned by commit — do NOT let Renovate float this; the whole
# image is a stopgap that gets deleted on upstream merge.
ARG SOURCE_REPO=capkz/TwitchDropsMiner
ARG SOURCE_COMMIT=6092705f430d45e23e9646603311cb3e1c49ae64

# ============================================================================
# Builder — fetch PR #70 source, install app + deps into an isolated prefix
# ============================================================================
FROM python:${PYTHON_VERSION}-alpine AS builder

ARG SOURCE_REPO
ARG SOURCE_COMMIT

# Build toolchain for any dep that falls back to an sdist (C extensions). Stays in the
# builder stage only — never shipped to runtime.
RUN --mount=type=cache,target=/var/cache/apk \
    apk add --no-cache gcc musl-dev libffi-dev

WORKDIR /build
ADD https://github.com/${SOURCE_REPO}/archive/${SOURCE_COMMIT}.tar.gz /build/src.tar.gz
RUN tar xzf src.tar.gz --strip-components=1 && rm src.tar.gz

# Install the package + its runtime dependencies into /install (copied to runtime).
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-cache-dir --prefix=/install .

# ============================================================================
# Runtime
# ============================================================================
FROM python:${PYTHON_VERSION}-alpine AS runtime

ARG BUILD_DATE
ARG VCS_REF
ARG APP_VERSION
LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.source="https://github.com/sharkusmanch/containers" \
      org.opencontainers.image.upstream="https://github.com/rangermix/TwitchDropsMiner" \
      org.opencontainers.image.title="twitch-drops-miner" \
      org.opencontainers.image.description="Twitch Drops Miner 1.2.4 + PR#70 drop-progress fix (temporary fork build)"

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8080

# Non-root user (repo standard UID/GID 10000). The consuming pod's securityContext may
# override runAsUser; /app/data and /app/logs are world-writable so any UID + fsGroup works.
RUN addgroup -g 10000 appgroup && \
    adduser -u 10000 -G appgroup -s /bin/false -D appuser

WORKDIR /app

# Python deps from the builder prefix
COPY --from=builder /install /usr/local

# App source tree — the app runs `python main.py` importing the local ./src package
COPY --from=builder /build/main.py /app/main.py
COPY --from=builder /build/pyproject.toml /app/pyproject.toml
COPY --from=builder /build/src /app/src
COPY --from=builder /build/lang /app/lang
COPY --from=builder /build/icons /app/icons
COPY --from=builder /build/web /app/web

RUN mkdir -p /app/data /app/logs && chmod 777 /app/data /app/logs

USER appuser

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/api/status')" || exit 1

CMD ["python", "main.py"]
