# syntax=docker/dockerfile:1

# Vendored reviewed source; bump this first *_VERSION ARG for each shipped change.
ARG POKEMON_RED_MASTERY_COMPANION_VERSION=v0.3.0

# renovate: datasource=docker depName=node
ARG NODE_VERSION=24.22.0

# renovate: datasource=docker depName=alpine
ARG ALPINE_VERSION=3.24

FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS builder
WORKDIR /build
COPY app/package.json app/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund
COPY app/ ./
RUN npm run build

# CI exercises this exact runtime stage with built static files mounted read-only.
# It does not need a second full frontend/image build to test the nginx contract.
FROM alpine:${ALPINE_VERSION} AS runtime-base
ARG BUILD_DATE
ARG VCS_REF
ARG POKEMON_RED_MASTERY_COMPANION_VERSION
LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${POKEMON_RED_MASTERY_COMPANION_VERSION}" \
      org.opencontainers.image.source="https://github.com/sharkusmanch/containers" \
      org.opencontainers.image.upstream="https://github.com/sharkusmanch/containers/tree/main/images/pokemon-red-mastery-companion/app" \
      org.opencontainers.image.title="pokemon-red-mastery-companion" \
      org.opencontainers.image.description="Read-only Pokemon Red mastery guide with a single save and scoped progress feeds"
RUN --mount=type=cache,target=/var/cache/apk \
    apk add --no-cache nginx gettext-envsubst && \
    addgroup -g 10000 appgroup && \
    adduser -u 10000 -G appgroup -s /bin/false -D appuser
COPY nginx.conf.template /etc/nginx/nginx.conf.template
COPY --chmod=0755 entrypoint.sh /usr/local/bin/entrypoint
ENV SAVE_FILE=/saves/red.srm \
    COMPANION_UPSTREAM=127.0.0.1:9999
USER appuser
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/entrypoint"]

FROM runtime-base AS runtime
COPY --from=builder /build/dist /srv/site
COPY app/LICENSE /usr/share/licenses/pokemon-red-mastery-companion/LICENSE
