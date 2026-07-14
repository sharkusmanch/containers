# syntax=docker/dockerfile:1

# Self-maintained TwitchDropsMiner image (we build our own permanently — attested,
# digest-pinned, independent of the under-maintained upstream that repeatedly breaks against
# Twitch API changes). Built from the upstream RELEASE tarball (Renovate tracks
# github-releases and opens a bump PR on each new rangermix release) with local backport
# patches applied on top:
#   patches/pr70-... — PR #70: Spade-POST drop-progress fix (Twitch removed the
#                      sendSpadeEvents GraphQL mutation, upstream issue #69)
#   patches/pr62-... — PR #62: per-game GQL crash-resilience (intermittent
#                      PersistedQueryNotFound no longer crashes the miner)
# Maintenance model: on a Renovate bump PR, CI rebuilds from the new release + patches. When
# upstream ships one of these fixes IN A RELEASE, its patch stops applying → the build fails
# loudly → drop that patch. We keep building our own image throughout.
#   Refs: https://github.com/rangermix/TwitchDropsMiner (issue #69, PRs #70/#62)
# RUNTIME NOTE: drop crediting needs beacon.twitch.tv to resolve — blocked by default on
# tracker-blocking DNS (NextDNS); must be allowlisted or the watch-event POST hits 0.0.0.0.

# FIRST `*_VERSION` ARG → build.yml tags the image with the upstream release (e.g. v1.2.4)
# and it drives the source tarball. Renovate bumps this on each new upstream release.
# renovate: datasource=github-releases depName=rangermix/TwitchDropsMiner
ARG UPSTREAM_VERSION=v1.2.4

# Pin to 3.14 to MATCH UPSTREAM (python:3-alpine → 3.14). Load-bearing: the app's aiohttp
# cookies.jar is pickled with Python 3.14's http.cookies, which added the `partitioned`
# cookie attribute — a 3.13 runtime raises CookieError loading it and silently drops the
# saved Twitch session (forces a device-code re-login). Keep >= 3.14.
# renovate: datasource=docker depName=python
ARG PYTHON_VERSION=3.14

# ============================================================================
# Builder — fetch upstream release, apply patches, install app + deps into a prefix
# ============================================================================
FROM python:${PYTHON_VERSION}-alpine AS builder

ARG UPSTREAM_VERSION

# Build toolchain for any dep that falls back to an sdist (C extensions) + patch.
# Builder-stage only — never shipped to runtime.
RUN --mount=type=cache,target=/var/cache/apk \
    apk add --no-cache gcc musl-dev libffi-dev patch

WORKDIR /build
ADD https://github.com/rangermix/TwitchDropsMiner/archive/refs/tags/${UPSTREAM_VERSION}.tar.gz /build/src.tar.gz
RUN tar xzf src.tar.gz --strip-components=1 && rm src.tar.gz

# Apply every local backport patch (see patches/*.patch headers). A patch that fails to
# apply fails the build — that's the intended signal that upstream has shipped the fix and
# the patch should be removed.
COPY patches/ /build/patches/
RUN for p in /build/patches/*.patch; do echo "== applying $p =="; patch -p1 < "$p"; done

# Install the package + its runtime dependencies into /install (copied to runtime).
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-cache-dir --prefix=/install .

# ============================================================================
# Runtime
# ============================================================================
FROM python:${PYTHON_VERSION}-alpine AS runtime

ARG BUILD_DATE
ARG VCS_REF
ARG UPSTREAM_VERSION
LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${UPSTREAM_VERSION}" \
      org.opencontainers.image.source="https://github.com/sharkusmanch/containers" \
      org.opencontainers.image.upstream="https://github.com/rangermix/TwitchDropsMiner" \
      org.opencontainers.image.title="twitch-drops-miner" \
      org.opencontainers.image.description="Self-maintained Twitch Drops Miner (upstream release + PR#70/#62 backport patches)"

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
