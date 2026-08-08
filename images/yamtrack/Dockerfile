# syntax=docker/dockerfile:1

# Overlay on the official Yamtrack image that removes the need to run as root.
#
# Upstream's entrypoint.sh remaps the in-image `abc` user to $PUID/$PGID with
# groupmod/usermod and then chowns the data dirs -- a docker-compose convenience
# for matching a host uid, and the ONLY reason the container needs root. It runs
# under `set -e`, so it hard-fails as non-root. supervisord and the nginx program
# are additionally pinned `user=root`.
#
# Nothing in the application actually requires root: nginx listens on 8000
# (unprivileged), writes its pid to /tmp, and gunicorn/celery already drop to
# `abc`. Baking the ownership at build time makes the remap unnecessary, so the
# whole chain can go and the pod satisfies the cluster's enforced restricted PSS
# (runAsNonRoot) with no Kyverno PolicyException.
#
# Single-stage by design: this is a config overlay, not a rebuild -- no build
# dependencies are introduced that would need stripping in a runtime stage.

# renovate: datasource=docker depName=ghcr.io/fuzzygrim/yamtrack
ARG YAMTRACK_VERSION=0.26.1

FROM ghcr.io/fuzzygrim/yamtrack:${YAMTRACK_VERSION} AS runtime

ARG BUILD_DATE
ARG VCS_REF
ARG YAMTRACK_VERSION
LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${YAMTRACK_VERSION}" \
      org.opencontainers.image.source="https://github.com/sharkusmanch/containers" \
      org.opencontainers.image.upstream="https://github.com/FuzzyGrim/Yamtrack" \
      org.opencontainers.image.title="yamtrack" \
      org.opencontainers.image.description="Yamtrack media tracker, rootless"

USER root

# Remap `abc` to the repo-standard 10000:10000 (shadow is present in the upstream
# image), strip the root pins from supervisord and the now-meaningless `user abc;`
# nginx directive, then bake ownership of every path written at runtime.
# Fail the build if upstream changes what this overlay patches. `sed` exits 0 on a
# missed pattern, so without this a stale overlay would silently produce an image
# that only breaks at runtime -- or keep patching something upstream already fixed.
RUN set -e; \
    grep -q 'usermod -o -u' /entrypoint.sh \
      || { echo "STALE OVERLAY: upstream entrypoint no longer does the PUID/PGID remap"; exit 1; }; \
    grep -q '^user=root' /etc/supervisord.conf \
      || { echo "STALE OVERLAY: supervisord.conf no longer pins user=root"; exit 1; }; \
    grep -q '^user abc;' /etc/nginx/nginx.conf \
      || { echo "STALE OVERLAY: nginx.conf no longer sets 'user abc;'"; exit 1; }; \
    ! grep -q '^logfile=\|^pidfile=' /etc/supervisord.conf \
      || { echo "STALE OVERLAY: supervisord.conf now sets logfile/pidfile; injecting would duplicate the key"; exit 1; }

RUN groupmod -o -g 10000 abc \
    && usermod -o -u 10000 abc \
    && sed -i '/^user abc;/d' /etc/nginx/nginx.conf /etc/nginx/nginx.ipv6.conf \
    && sed -i '/^user=/d' /etc/supervisord.conf \
    # supervisord defaults logfile/pidfile to $CWD (= /yamtrack, on the root fs) and
    # aborts at startup if it cannot write them -- which breaks
    # readOnlyRootFilesystem: true. Upstream never hit this: it runs as root on a
    # writable rootfs. Point both somewhere valid instead.
    && sed -i 's|^\[supervisord\]|[supervisord]\nlogfile=/dev/stdout\nlogfile_maxbytes=0\npidfile=/tmp/supervisord.pid|' /etc/supervisord.conf \
    && mkdir -p /yamtrack/db \
    && chown -R 10000:10000 /yamtrack /var/log/nginx /var/lib/nginx \
    # `shadow` is only needed for the build-time remap above; drop the usermod/chage
    # toolkit from the shipped image.
    && apk del shadow

# Entrypoint without the PUID/PGID remap + chown chain.
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Nothing should write .pyc at runtime under a read-only root filesystem. CPython
# swallows the failed write silently, so this only makes the existing behaviour
# explicit (site-packages and app code are already compiled at build time).
ENV PYTHONDONTWRITEBYTECODE=1

USER 10000:10000

EXPOSE 8000

CMD ["/entrypoint.sh"]
