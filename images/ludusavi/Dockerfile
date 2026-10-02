# syntax=docker/dockerfile:1

# Ludusavi's official Linux release binary, for headless CLI use (scheduled
# `ludusavi backup` from a CronJob). See README.md.

# The release tarball and its checksum are bumped together by Renovate.
# renovate: datasource=github-release-attachments depName=mtkennerly/ludusavi
ARG LUDUSAVI_VERSION=v0.31.0
ARG LUDUSAVI_SHA256=7322ff45d41eae7ae064a80d8c9ecccc5b8fb6fc090a603a66369cd4b054068d

# renovate: datasource=docker depName=debian
ARG DEBIAN_VERSION=13.7-slim

# ============================================================================
# Builder stage: fetch and verify the release binary
# ============================================================================
FROM debian:${DEBIAN_VERSION} AS builder

ARG LUDUSAVI_VERSION
ARG LUDUSAVI_SHA256

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl

WORKDIR /build
RUN set -eux; \
    curl -fsSL -o ludusavi.tar.gz \
      "https://github.com/mtkennerly/ludusavi/releases/download/${LUDUSAVI_VERSION}/ludusavi-${LUDUSAVI_VERSION}-linux.tar.gz"; \
    echo "${LUDUSAVI_SHA256}  ludusavi.tar.gz" | sha256sum -c -; \
    tar -xzf ludusavi.tar.gz ludusavi; \
    chmod 0755 ludusavi

# ============================================================================
# Runtime stage
# ============================================================================
FROM debian:${DEBIAN_VERSION} AS runtime

ARG BUILD_DATE
ARG VCS_REF
ARG LUDUSAVI_VERSION

LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${LUDUSAVI_VERSION}" \
      org.opencontainers.image.source="https://github.com/sharkusmanch/containers" \
      org.opencontainers.image.upstream="https://github.com/mtkennerly/ludusavi" \
      org.opencontainers.image.title="ludusavi" \
      org.opencontainers.image.description="Ludusavi game-save backup tool for headless CLI use"

# libgtk-3: the release binary links GTK for its file dialogs even in CLI mode.
# ca-certificates: manifest downloads. python3: post-processing `--api` JSON output.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgtk-3-0t64 ca-certificates python3 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 10000 appgroup \
    && useradd -u 10000 -g appgroup -s /usr/sbin/nologin -M appuser

COPY --from=builder /build/ludusavi /usr/local/bin/ludusavi

# Assert the binary runs (and its shared libraries resolve) in the runtime image.
RUN ludusavi --version

# Callers that back up a share owned by another user override the UID (e.g. runAsUser 1000).
USER 10000

ENTRYPOINT ["ludusavi"]
