# syntax=docker/dockerfile:1

# DQ8 Alchemy Planner: a static Vite + Preact site, built from the upstream release tag
# with the save address "./save" baked in, served by an unprivileged nginx. The same image
# also carries `latest-save`, a watcher that publishes the newest save for nginx to serve.
#
# The build workflow tags the image with the first *_VERSION ARG in this file, so the
# upstream version must stay first.

# renovate: datasource=github-releases depName=sharkusmanch/dq8-alchemy-planner
ARG DQ8_ALCHEMY_PLANNER_VERSION=v1.1.2

# renovate: datasource=docker depName=node
ARG NODE_VERSION=24.21.0

# renovate: datasource=docker depName=alpine
ARG ALPINE_VERSION=3.24

# ---------- builder ----------
# Build on the runner's native platform: the output is platform-independent static files.
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS builder
ARG DQ8_ALCHEMY_PLANNER_VERSION

# git fetches the pinned tag (no tarball to checksum).
RUN --mount=type=cache,target=/var/cache/apk \
    apk add --no-cache git

WORKDIR /build
RUN git init -q . && \
    git remote add origin https://github.com/sharkusmanch/dq8-alchemy-planner.git && \
    git fetch -q --depth 1 origin "refs/tags/${DQ8_ALCHEMY_PLANNER_VERSION}" && \
    git checkout -q FETCH_HEAD

# `npm run build` runs tsc before vite, so the dev dependencies are needed here.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

# The default save address is read at build time; the site then fetches ./save on its own origin.
RUN VITE_DEFAULT_SAVE_URL=./save npm run build

# ---------- runtime ----------
FROM alpine:${ALPINE_VERSION} AS runtime

ARG BUILD_DATE
ARG VCS_REF
ARG DQ8_ALCHEMY_PLANNER_VERSION
LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${DQ8_ALCHEMY_PLANNER_VERSION}" \
      org.opencontainers.image.source="https://github.com/sharkusmanch/containers" \
      org.opencontainers.image.upstream="https://github.com/sharkusmanch/dq8-alchemy-planner" \
      org.opencontainers.image.title="dq8-alchemy-planner" \
      org.opencontainers.image.description="DQ8 Alchemy Planner static site on unprivileged nginx, with a watcher that publishes the newest PS2 save"

RUN --mount=type=cache,target=/var/cache/apk \
    apk add --no-cache nginx && \
    addgroup -g 10000 appgroup && \
    adduser -u 10000 -G appgroup -s /bin/false -D appuser && \
    install -d -o 10000 -g 10000 -m 0755 /run/save

COPY --from=builder /build/dist /srv/site
COPY nginx.conf /etc/nginx/nginx.conf
COPY --chmod=0755 latest-save /usr/local/bin/latest-save

# Everything must be readable by UID 10000; nothing but /tmp and /run/save is written.
# The syntax check runs as root because the build's stdout is not openable by appuser;
# it creates nginx's temp directories under /tmp, which are removed again.
RUN chmod -R a+rX /srv/site /etc/nginx/nginx.conf && \
    nginx -t -e /dev/stderr && \
    rm -rf /tmp/*

USER appuser
EXPOSE 8080

# nginx in the foreground (daemon off is in nginx.conf). Run the same image with the
# command `latest-save` for the watcher.
CMD ["nginx", "-e", "/dev/stderr", "-c", "/etc/nginx/nginx.conf"]
