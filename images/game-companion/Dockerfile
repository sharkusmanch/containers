# syntax=docker/dockerfile:1

# This directory is the source: there is no upstream. Bump on every change that should ship;
# the build workflow tags the image with the first *_VERSION ARG in this file.
ARG GAME_COMPANION_VERSION=v0.5.0

# renovate: datasource=docker depName=node
ARG NODE_VERSION=24.21.0

# ---------- builder ----------
# Build on the runner's native platform: the output is platform-independent JavaScript.
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS builder
WORKDIR /build
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
COPY web-static ./web-static
RUN npm run build

# ---------- runtime ----------
FROM node:${NODE_VERSION}-alpine AS runtime

ARG BUILD_DATE
ARG VCS_REF
ARG GAME_COMPANION_VERSION
LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${GAME_COMPANION_VERSION}" \
      org.opencontainers.image.source="https://github.com/sharkusmanch/containers" \
      org.opencontainers.image.upstream="https://github.com/sharkusmanch/containers" \
      org.opencontainers.image.title="game-companion" \
      org.opencontainers.image.description="Second-screen page showing the current game's guide pages and achievement progress"

RUN addgroup -g 10000 appgroup && \
    adduser -u 10000 -G appgroup -s /bin/false -D appuser

WORKDIR /app
# No node_modules: the service has no runtime dependencies. package.json marks the
# compiled output as ES modules.
COPY --from=builder /build/dist ./dist
COPY package.json ./

ENV NODE_ENV=production \
    PORT=8080 \
    STATIC_DIR=/app/dist/web

USER appuser
EXPOSE 8080

# Exec form: node is PID 1 and receives SIGTERM directly for a clean shutdown.
ENTRYPOINT ["node", "dist/server/index.js"]
