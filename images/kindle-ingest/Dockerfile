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
#   DeDRM (ion.py + kfxdedrm.py) -- decrypts a KFX archive given the per-book
#   key the Kindle emits. GPL v3. Pinned release, checksum verified.
#
#   KFX Input -- the only thing that can read KFX; ebook-convert cannot without
#   it. Distributed as a MobileRead forum attachment upstream, so this uses
#   kluyg's GitHub mirror at a pinned commit. NOTE the mirror lags upstream
#   (2.25.0 vs 2.33.0 as of 2026-08); the smoke test below is what catches a
#   version that cannot read a real book.

# renovate: datasource=github-releases depName=Satsuoni/DeDRM_tools
ARG DEDRM_VERSION=v10.0.30
ARG DEDRM_SHA256=980bfc17715b998afc5995d6a308e5998681a3ad1a59fa6dd97ab6c414d8f0d6
# renovate: datasource=github-commits depName=kluyg/calibre-kfx-input branch=main
ARG KFX_INPUT_COMMIT=44db6b6ee8c0

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl unzip zip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
RUN curl -fsSL -o dedrm.zip \
      "https://github.com/Satsuoni/DeDRM_tools/releases/download/${DEDRM_VERSION}/DeDRM_tools.zip" \
    && echo "${DEDRM_SHA256}  dedrm.zip" | sha256sum -c - \
    && unzip -q dedrm.zip DeDRM_plugin.zip \
    && mkdir -p /opt/vendor \
    && unzip -q -j DeDRM_plugin.zip "ion.py" "kfxdedrm.py" -d /opt/vendor \
    && test -s /opt/vendor/ion.py && test -s /opt/vendor/kfxdedrm.py

RUN curl -fsSL -o kfx.tar.gz \
      "https://github.com/kluyg/calibre-kfx-input/archive/${KFX_INPUT_COMMIT}.tar.gz" \
    && mkdir -p kfx && tar xzf kfx.tar.gz -C kfx --strip-components=1 \
    && (cd kfx && zip -qr /opt/KFX_Input.zip .) \
    && test -s /opt/KFX_Input.zip


FROM python:${PYTHON_VERSION}

# renovate: datasource=github-releases depName=rclone/rclone
ARG RCLONE_VERSION=v1.75.0
# renovate: datasource=pypi depName=prometheus-client
ARG PROMETHEUS_CLIENT_VERSION=0.26.0
# renovate: datasource=pypi depName=requests
ARG REQUESTS_VERSION=2.34.2
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
    && rm -rf /var/lib/apt/lists/* \
    && ARCH="$(dpkg --print-architecture)" \
    && case "$ARCH" in amd64) R=amd64 ;; arm64) R=arm64 ;; *) echo "unsupported $ARCH" >&2; exit 1 ;; esac \
    && curl -fsSL -o /tmp/rclone.zip \
         "https://github.com/rclone/rclone/releases/download/${RCLONE_VERSION}/rclone-${RCLONE_VERSION}-linux-${R}.zip" \
    && unzip -qj /tmp/rclone.zip "*/rclone" -d /usr/local/bin \
    && chmod +x /usr/local/bin/rclone && rm -f /tmp/rclone.zip

RUN pip install --no-cache-dir \
      "prometheus-client==${PROMETHEUS_CLIENT_VERSION}" \
      "requests==${REQUESTS_VERSION}" \
      "pycryptodomex==${PYCRYPTODOMEX_VERSION}"

COPY --from=vendor /opt/vendor /opt/vendor
COPY --from=vendor /opt/KFX_Input.zip /opt/KFX_Input.zip

# calibre needs a writable config dir, and the plugin must be installed for the
# runtime UID -- installing as root would leave it unreadable at 10000.
ENV CALIBRE_CONFIG_DIRECTORY=/home/app/.config/calibre \
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
RUN calibre-customize -a /opt/KFX_Input.zip \
    && calibre-customize --list-plugins | grep -q "KFX Input"

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
