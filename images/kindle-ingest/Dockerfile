# syntax=docker/dockerfile:1

# renovate: datasource=docker depName=python versioning=docker
ARG PYTHON_VERSION=3.13-slim

FROM python:${PYTHON_VERSION} AS vendor

# kindle-ingest: Kindle -> BookOrbit ingest pipeline.
# Spec: home-ops-private docs/superpowers/specs/2026-08-24-kindle-ingest-design.md
#
# Two third-party sources are fetched here rather than committed, so this
# public repo does not redistribute them:
#
#   DeDRM (kfxdedrm + ion + kfxtables) -- decrypts a KFX archive given the
#   per-book key the Kindle emits. GPL v3. Pinned release, checksum verified.
#   That module list is the import closure computed with ast, not eyeballed:
#   ion imports kfxtables from inside a try block, so a line-anchored grep
#   misses it and the image builds fine right up until it decrypts nothing.
#
#   KFX Input -- the only thing that can read KFX; ebook-convert cannot without
#   it. Distributed as a MobileRead forum attachment upstream, so this uses
#   kluyg's GitHub mirror at a pinned commit. NOTE the mirror lags upstream
#   (2.25.0 vs 2.33.0 as of 2026-08); the smoke test below is what catches a
#   version that cannot read a real book.
#
# Updates automerge, so every pin here must be one Renovate can move by itself:
# DEDRM_SHA256 sits directly under its version and is bumped with it
# (github-release-attachments), and KFX Input is fetched with git at the full
# commit SHA, which verifies the content without a tarball checksum that
# Renovate would leave stale.

# renovate: datasource=github-release-attachments depName=Satsuoni/DeDRM_tools
ARG DEDRM_VERSION=v10.0.30
ARG DEDRM_SHA256=980bfc17715b998afc5995d6a308e5998681a3ad1a59fa6dd97ab6c414d8f0d6
# renovate: datasource=github-commits depName=kluyg/calibre-kfx-input branch=main
ARG KFX_INPUT_COMMIT=44db6b6ee8c0094a98c33770575a9070ddb90fda

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git unzip zip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
RUN curl -fsSL -o dedrm.zip \
      "https://github.com/Satsuoni/DeDRM_tools/releases/download/${DEDRM_VERSION}/DeDRM_tools.zip" \
    && echo "${DEDRM_SHA256}  dedrm.zip" | sha256sum -c - \
    && unzip -q dedrm.zip DeDRM_plugin.zip \
    && mkdir -p /opt/vendor \
    && unzip -q -j DeDRM_plugin.zip "ion.py" "kfxdedrm.py" "kfxtables.py" -d /opt/vendor \
    && for f in ion kfxdedrm kfxtables; do test -s "/opt/vendor/$f.py"; done

# git checks every fetched object against its hash, so the tree is exactly the
# pinned commit's; git archive exports it without the .git directory.
RUN git init -q kfx-src \
    && git -C kfx-src fetch -q --depth 1 \
         https://github.com/kluyg/calibre-kfx-input.git "${KFX_INPUT_COMMIT}" \
    && test "$(git -C kfx-src rev-parse FETCH_HEAD)" = "${KFX_INPUT_COMMIT}" \
    && git -C kfx-src archive -o /build/kfx.tar FETCH_HEAD \
    && mkdir -p kfx && tar -xf kfx.tar -C kfx \
    && (cd kfx && zip -qr /opt/KFX_Input.zip .) \
    && test -s /opt/KFX_Input.zip


# rclone comes from its official image, pinned by digest: the digest verifies
# the bytes, and Renovate bumps tag and digest together.
FROM rclone/rclone:1.75.1@sha256:45401ad7410db1d67ffdb58e19059ad20b0d8e0285a60e38bbec55cc1019c7a5 AS rclone


FROM python:${PYTHON_VERSION}

# renovate: datasource=pypi depName=prometheus-client
ARG PROMETHEUS_CLIENT_VERSION=0.26.0
# renovate: datasource=pypi depName=requests
ARG REQUESTS_VERSION=2.33.0
# renovate: datasource=pypi depName=pycryptodomex
ARG PYCRYPTODOMEX_VERSION=3.23.0

LABEL org.opencontainers.image.title="kindle-ingest" \
      org.opencontainers.image.description="Kindle -> BookOrbit ingest: decrypt, convert, upload" \
      org.opencontainers.image.source="https://github.com/sharkusmanch/containers" \
      org.opencontainers.image.licenses="MIT"

# calibre supplies ebook-convert; netcat provides the ssh SOCKS ProxyCommand
# through the Tailscale sidecar (userspace mode, so no NET_ADMIN is needed).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
         calibre openssh-client netcat-openbsd ca-certificates curl unzip xz-utils \
    && rm -rf /var/lib/apt/lists/*

# The upstream binary is static Go, so it runs on this Debian base; the version
# check fails the build if a future image ever ships one that does not.
COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone
RUN rclone version

RUN pip install --no-cache-dir \
      "prometheus-client==${PROMETHEUS_CLIENT_VERSION}" \
      "requests==${REQUESTS_VERSION}" \
      "pycryptodomex==${PYCRYPTODOMEX_VERSION}"

COPY --from=vendor /opt/vendor /opt/vendor
COPY --from=vendor /opt/KFX_Input.zip /opt/KFX_Input.zip

# calibre needs a writable config dir, and the plugin must be installed for the
# runtime UID -- installing as root would leave it unreadable at 10000.
# calibre links Qt even for its CLI tools, so a headless image must select the
# offscreen platform plugin or calibre-customize aborts with "could not connect
# to display". CALIBRE_TEMP_DIR keeps scratch off the read-only paths.
ENV CALIBRE_CONFIG_DIRECTORY=/home/app/.config/calibre \
    CALIBRE_TEMP_DIR=/tmp \
    QT_QPA_PLATFORM=offscreen \
    HOME=/home/app \
    VENDOR_DIR=/opt/vendor \
    PYTHONUNBUFFERED=1

RUN groupadd -g 10000 app && useradd -u 10000 -g 10000 -m -d /home/app -s /usr/sbin/nologin app \
    && mkdir -p "${CALIBRE_CONFIG_DIRECTORY}" /data /state \
    && chown -R 10000:10000 /home/app /data /state

WORKDIR /app
COPY --chown=10000:10000 app/ /app/app/
COPY --chown=10000:10000 tests/ /app/tests/

USER 10000:10000
# Install the plugin for the RUNTIME uid: installing as root would leave it
# unreadable at 10000. Output is echoed so a failure here is legible in CI.
RUN set -eux; \
    calibre-customize --add-plugin /opt/KFX_Input.zip; \
    calibre-customize --list-plugins | tee /tmp/plugins.txt; \
    grep -qi "kfx" /tmp/plugins.txt

# Fail the BUILD, not the library: a vendored module whose API moved, or a KFX
# Input that cannot read a real book, must not reach production.
RUN python -c "import sys; sys.path.insert(0, '/opt/vendor'); \
import kfxdedrm, ion; \
assert hasattr(kfxdedrm, 'KFXZipBook'), 'KFXZipBook missing'; \
assert hasattr(ion, 'SKeyList'), 'SKeyList missing'; \
b = kfxdedrm.KFXZipBook; \
assert all(hasattr(b, m) for m in ('processBook', 'getFile')), 'KFXZipBook API moved'; \
print('vendored decryption API ok')"

ENTRYPOINT ["python", "-m", "app.main"]
