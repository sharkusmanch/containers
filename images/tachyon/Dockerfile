# syntax=docker/dockerfile:1

# Tachyon webmail (a maintained SnappyMail fork), rebuilt to run unprivileged.
# One image, two containers in the pod: php-fpm (tachyon-init + php-fpm84) and
# nginx. See README.md.

# The release tarball and its checksum are bumped together by Renovate.
# renovate: datasource=github-release-attachments depName=kimusan/Tachyon
ARG TACHYON_VERSION=v4.2.5
ARG TACHYON_SHA256=673d6f22355802c96c430a6bfa59b2873747c8ba7aa14f28cd626c456122e213

# Alpine's PHP packages are versioned by name (php84-*). An Alpine bump that
# drops php84 fails the build loudly rather than silently changing PHP.
# renovate: datasource=docker depName=alpine
ARG ALPINE_VERSION=3.24

FROM alpine:${ALPINE_VERSION} AS builder
ARG TACHYON_VERSION
ARG TACHYON_SHA256
RUN --mount=type=cache,target=/var/cache/apk \
    apk add --no-cache curl
WORKDIR /build
RUN set -eux; \
    v="${TACHYON_VERSION#v}"; \
    curl -fsSL -o tachyon.tar.gz \
      "https://github.com/kimusan/Tachyon/releases/download/${TACHYON_VERSION}/tachyon-${v}.tar.gz"; \
    echo "${TACHYON_SHA256}  tachyon.tar.gz" | sha256sum -c -; \
    mkdir /tachyon; \
    tar -xzf tachyon.tar.gz -C /tachyon; \
    # data/ moves to the mounted volume; the rest is Apache-only or docs.
    rm -rf /tachyon/data /tachyon/_include.php /tachyon/README.md /tachyon/.htaccess; \
    test -f "/tachyon/tachyon/v/${v}/static/favicon.ico"; \
    ln -s "tachyon/v/${v}/static/favicon.ico" /tachyon/favicon.ico; \
    # Code is read-only to the runtime user.
    find /tachyon -type d -exec chmod 0555 {} +; \
    find /tachyon -type f -exec chmod 0444 {} +

FROM alpine:${ALPINE_VERSION} AS runtime
ARG BUILD_DATE
ARG VCS_REF
ARG TACHYON_VERSION
LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${TACHYON_VERSION}" \
      org.opencontainers.image.source="https://github.com/sharkusmanch/containers" \
      org.opencontainers.image.upstream="https://github.com/kimusan/Tachyon" \
      org.opencontainers.image.title="tachyon" \
      org.opencontainers.image.description="Tachyon webmail, unprivileged php-fpm + nginx, with gpg for server-side PGP"

# fcgi: cgi-fcgi, for the php container's probe against php-fpm's ping.path.
# gnupg: the gpg/gpg-agent/gpgconf binaries Tachyon drives through proc_open
# for server-side PGP. tini is PID 1 so signals are forwarded and any orphaned
# gpg-agent is reaped whatever the entrypoint runs.
RUN --mount=type=cache,target=/var/cache/apk \
    apk add --no-cache \
      ca-certificates \
      gnupg \
      nginx \
      tini \
      php84 \
      php84-fpm \
      php84-ctype \
      php84-curl \
      php84-dom \
      php84-fileinfo \
      php84-gd \
      php84-iconv \
      php84-intl \
      php84-mbstring \
      php84-opcache \
      php84-openssl \
      php84-pdo_sqlite \
      php84-session \
      php84-simplexml \
      php84-sodium \
      php84-tidy \
      php84-xml \
      php84-xmlreader \
      php84-xmlwriter \
      php84-zip \
      fcgi; \
    addgroup -g 10000 tachyon; \
    adduser -u 10000 -G tachyon -s /bin/false -H -D tachyon; \
    # The distro pool config would also listen; ours is the only pool.
    rm -f /etc/php84/php-fpm.d/www.conf; \
    mkdir -p /var/lib/tachyon /etc/tachyon; \
    chown tachyon:tachyon /var/lib/tachyon; \
    chmod 0700 /var/lib/tachyon

COPY --from=builder /tachyon /tachyon
COPY rootfs/ /

RUN set -eux; \
    chmod 0444 /tachyon/include.php; \
    php-fpm84 -t -y /etc/php84/php-fpm.conf; \
    # Fail the build if Tachyon's own requirement check fails.
    php84 -r 'define("APP_VERSION", "check"); require "/tachyon/tachyon/v/'"${TACHYON_VERSION#v}"'/app/libraries/tachyon_util/integrity.php"; $r = \Tachyon\Util\Integrity::phpExtensions(); if ($r) { fwrite(STDERR, "missing: ".implode(", ", $r)."\n"); exit(1); }'; \
    command -v gpg gpgconf gpg-agent

USER 10000:10000
WORKDIR /tachyon
EXPOSE 8080
VOLUME /var/lib/tachyon

# Default: the PHP container. The nginx container overrides the command with
#   nginx -e stderr -g "daemon off;"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/usr/local/bin/tachyon-init", "php-fpm84", "-F", "-y", "/etc/php84/php-fpm.conf"]
