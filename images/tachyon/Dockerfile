# syntax=docker/dockerfile:1

# Tachyon webmail (a maintained SnappyMail fork), rebuilt to run unprivileged.
# One image, two containers in the pod: php-fpm (tachyon-init + php-fpm84) and
# nginx. See README.md.

# The release tarball and its checksum are bumped together by Renovate.
# renovate: datasource=github-release-attachments depName=kimusan/Tachyon
ARG TACHYON_VERSION=v4.4.2
ARG TACHYON_SHA256=ce9fcb38347930a860ad47a7527929a55f17bab720cbfb2ae14b6cf716ea1e48

# The release signing key (Tachyon Repository <kim@schulz.dk>, ed25519,
# expires 2028-09-04), pinned by fingerprint. The keyring file ships on the
# same release page, so the pin is what makes the signature check meaningful.
ARG TACHYON_SIGNING_KEY=2AF665D52CE22BDEFC606AD1DAD08242CFE59866

# Alpine's PHP packages are versioned by name (php84-*). An Alpine bump that
# drops php84 fails the build loudly rather than silently changing PHP.
# renovate: datasource=docker depName=alpine
ARG ALPINE_VERSION=3.24

FROM alpine:${ALPINE_VERSION} AS builder
ARG TACHYON_VERSION
ARG TACHYON_SHA256
ARG TACHYON_SIGNING_KEY
RUN --mount=type=cache,target=/var/cache/apk \
    apk add --no-cache curl gpg gpg-agent
WORKDIR /build
RUN set -eux -o pipefail; \
    v="${TACHYON_VERSION#v}"; \
    base="https://github.com/kimusan/Tachyon/releases/download/${TACHYON_VERSION}"; \
    curl -fsSL -o tachyon.tar.gz "${base}/tachyon-${v}.tar.gz"; \
    curl -fsSL -o tachyon.tar.gz.asc "${base}/tachyon-${v}.tar.gz.asc"; \
    curl -fsSL -o keyring.asc "${base}/tachyon-archive-keyring.asc"; \
    echo "${TACHYON_SHA256}  tachyon.tar.gz" | sha256sum -c -; \
    export GNUPGHOME="$(mktemp -d)"; \
    gpg --batch --quiet --import keyring.asc; \
    gpg --batch --status-fd 1 --verify tachyon.tar.gz.asc tachyon.tar.gz > verify.status; \
    # GOODSIG: good and not expired/revoked. VALIDSIG's last field is the
    # PRIMARY key fingerprint, which must be the pinned one.
    grep -q '^\[GNUPG:\] GOODSIG ' verify.status; \
    grep -Eq "^\[GNUPG:\] VALIDSIG .* ${TACHYON_SIGNING_KEY}\$" verify.status; \
    gpgconf --kill gpg-agent; \
    rm -rf "${GNUPGHOME}"; \
    mkdir /tachyon; \
    tar -xzf tachyon.tar.gz --no-same-owner -C /tachyon; \
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
# gpg, gpg-agent, gnupg-gpgconf: what Tachyon drives through proc_open for
# server-side PGP (gpgconf kills the agent after every request). Not the gnupg
# metapackage, so no gpgsm or scdaemon; pinentry and keyboxd still arrive as
# package dependencies but are never used (loopback pinentry, pubring.kbx).
# dirmngr, gpg's network helper for keyservers, is also a hard dependency, so
# its binary is deleted.
# tini is PID 1 so signals are forwarded and any orphaned gpg-agent is reaped
# whatever the entrypoint runs.
# PHP: only what Tachyon uses. No gd (thumbnails are off), tidy (its only use is
# commented out upstream), pdo_sqlite (contacts/calendar are off), LDAP, MySQL,
# PostgreSQL, Redis or ImageMagick.
RUN --mount=type=cache,target=/var/cache/apk \
    set -eux; \
    apk add --no-cache \
      ca-certificates \
      gpg \
      gpg-agent \
      gnupg-gpgconf \
      nginx \
      tini \
      php84 \
      php84-fpm \
      php84-ctype \
      php84-curl \
      php84-dom \
      php84-fileinfo \
      php84-iconv \
      php84-intl \
      php84-mbstring \
      php84-opcache \
      php84-openssl \
      php84-session \
      php84-simplexml \
      php84-sodium \
      php84-xml \
      php84-xmlreader \
      php84-xmlwriter \
      php84-zip \
      fcgi; \
    rm -f /usr/bin/dirmngr /usr/bin/dirmngr-client; \
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
    php84 -m | grep -qx sodium; \
    for b in gpg gpgconf gpg-agent nginx tini cgi-fcgi php-fpm84; do command -v "$b"; done; \
    test ! -e /usr/bin/dirmngr; \
    nginx -t -e stderr; \
    # The global gpg-agent.conf must actually stop passphrase caching: a
    # decrypt with the right passphrase followed by one with a wrong
    # passphrase has to FAIL. (With caching the second one succeeds.)
    export GNUPGHOME="$(mktemp -d)"; \
    gpg --batch --pinentry-mode loopback --passphrase ok --quick-gen-key 'ci <ci@example.invalid>' default default never; \
    echo probe | gpg --batch --trust-model always -e -r ci@example.invalid > "$GNUPGHOME/m.gpg"; \
    gpg --batch --pinentry-mode loopback --passphrase ok -d "$GNUPGHOME/m.gpg" | grep -qx probe; \
    if gpg --batch --pinentry-mode loopback --passphrase wrong -d "$GNUPGHOME/m.gpg" >/dev/null 2>&1; then \
      echo "gpg-agent cached the passphrase" >&2; exit 1; \
    fi; \
    gpgconf --kill gpg-agent; \
    rm -rf "$GNUPGHOME"; \
    unset GNUPGHOME

USER 10000:10000
WORKDIR /tachyon
EXPOSE 8080
VOLUME /var/lib/tachyon

# Default: the PHP container. The nginx container overrides the command with
#   nginx -e stderr -g "daemon off;"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/usr/local/bin/tachyon-init", "php-fpm84", "-F", "-y", "/etc/php84/php-fpm.conf"]
