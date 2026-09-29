# syntax=docker/dockerfile:1

# Curated toolbox version — bump manually when the tool set changes.
# NOTE: the build workflow tags the image from the FIRST `^ARG.*_VERSION=` line in
# this file, so this must stay above the other *_VERSION ARGs.
ARG CHDMAN_VERSION=1.1.0

# chdman is built from upstream MAME: Debian 13's mame-tools (0.276) leaks memory
# in `createdvd` (~14 MB/s regardless of -np), OOMing on 4.5 GB PS2 ISOs.
# renovate: datasource=github-releases depName=mamedev/mame versioning=regex:^mame(?<major>\d)(?<minor>\d+)$
ARG MAME_VERSION=mame0289

# renovate: datasource=docker depName=debian
ARG DEBIAN_VERSION=13.7-slim

# ============================================================================
# Builder stage: tools-only MAME build, then keep just chdman
# ============================================================================
FROM debian:${DEBIAN_VERSION} AS builder

ARG MAME_VERSION

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential ca-certificates git python3 libsdl2-dev libsdl2-ttf-dev libfontconfig-dev

# git verifies the fetched tree against the tag's commit.
RUN git clone --depth 1 --branch "${MAME_VERSION}" https://github.com/mamedev/mame.git /src

WORKDIR /src
# TOOLS=1 EMULATOR=0 builds chdman and friends without the (huge) emulator.
RUN make -j"$(nproc)" TOOLS=1 EMULATOR=0 NOWERROR=1 PYTHON_EXECUTABLE=python3 \
        NO_X11=1 NO_USE_XINPUT=1 NO_OPENGL=1 USE_QTDEBUG=0 NO_USE_PORTAUDIO=1 NO_USE_PULSEAUDIO=1 \
    && strip chdman \
    && ldd chdman \
    && { ./chdman 2>&1 || true; } | grep -q "MAME Compressed Hunks of Data"

# ============================================================================
# Runtime stage
# ============================================================================
FROM debian:${DEBIAN_VERSION} AS runtime

ARG BUILD_DATE
ARG VCS_REF
ARG CHDMAN_VERSION
ARG MAME_VERSION

LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${CHDMAN_VERSION}" \
      org.opencontainers.image.source="https://github.com/sharkusmanch/containers" \
      org.opencontainers.image.upstream="https://github.com/mamedev/mame" \
      org.opencontainers.image.title="chdman" \
      org.opencontainers.image.description="MAME chdman (${MAME_VERSION}) + unzip for converting disc images (cue/bin, gdi, iso) to CHD"

# unzip: Redump/Minerva ship each disc as a zip.
RUN apt-get update \
    && apt-get install -y --no-install-recommends unzip \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 10000 appgroup \
    && useradd -u 10000 -g appgroup -s /usr/sbin/nologin -M appuser

COPY --from=builder /src/chdman /usr/local/bin/chdman

# chdman exits non-zero when printing usage; assert the binary runs (and its shared
# libraries resolve) in the runtime image.
RUN { chdman 2>&1 || true; } | grep -q "MAME Compressed Hunks of Data"

# Callers that write into a media library override the UID (e.g. runAsUser 1000).
USER 10000

ENTRYPOINT ["chdman"]
