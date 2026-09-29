# syntax=docker/dockerfile:1

# Curated toolbox version — bump manually when the tool set changes.
# NOTE: the build workflow tags the image from the FIRST `^ARG.*_VERSION=` line in
# this file, so this must stay above DEBIAN_VERSION.
ARG CHDMAN_VERSION=1.0.0

# Debian, not Alpine: chdman ships in `mame-tools`, which Alpine only carries in
# edge/testing. Debian stable's mame-tools tracks the release's security updates.
# renovate: datasource=docker depName=debian
ARG DEBIAN_VERSION=13.7-slim

# ============================================================================
# Runtime stage (single stage: apt installs runtime packages only, no build deps)
# ============================================================================
FROM debian:${DEBIAN_VERSION} AS runtime

ARG BUILD_DATE
ARG VCS_REF
ARG CHDMAN_VERSION

LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${CHDMAN_VERSION}" \
      org.opencontainers.image.source="https://github.com/sharkusmanch/containers" \
      org.opencontainers.image.upstream="https://github.com/mamedev/mame" \
      org.opencontainers.image.title="chdman" \
      org.opencontainers.image.description="MAME chdman + unzip for converting disc images (cue/bin, gdi, iso) to CHD"

# mame-tools: chdman. unzip: Redump/Minerva ship each disc as a zip.
RUN apt-get update \
    && apt-get install -y --no-install-recommends mame-tools unzip \
    && rm -rf /var/lib/apt/lists/* \
    # chdman exits non-zero when printing usage; assert the binary runs at all.
    && { chdman 2>&1 || true; } | grep -q "chdman" \
    && groupadd -g 10000 appgroup \
    && useradd -u 10000 -g appgroup -s /usr/sbin/nologin -M appuser

# Callers that write into a media library override the UID (e.g. runAsUser 1000).
USER 10000

ENTRYPOINT ["chdman"]
