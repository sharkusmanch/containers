# syntax=docker/dockerfile:1

# renovate: datasource=npm depName=the-companion
ARG COMPANION_VERSION=0.72.0

# renovate: datasource=docker depName=oven/bun versioning=docker
ARG BUN_VERSION=1.3

# ============================================================================
# Builder stage
# ============================================================================
FROM oven/bun:${BUN_VERSION}-alpine AS builder

ARG COMPANION_VERSION

WORKDIR /build

RUN bun init -y && \
    bun add the-companion@${COMPANION_VERSION}

# ============================================================================
# Runtime stage
# ============================================================================
FROM oven/bun:${BUN_VERSION}-alpine AS runtime

ARG BUILD_DATE
ARG VCS_REF
ARG COMPANION_VERSION
LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${COMPANION_VERSION}" \
      org.opencontainers.image.source="https://github.com/sharkusmanch/containers" \
      org.opencontainers.image.upstream="https://github.com/The-Vibe-Company/companion" \
      org.opencontainers.image.title="companion" \
      org.opencontainers.image.description="Web UI for managing Claude Code sessions"

# Create non-root user
RUN addgroup -g 10000 appgroup && \
    adduser -u 10000 -G appgroup -s /bin/false -D appuser && \
    mkdir -p /home/appuser/.companion && \
    chown -R appuser:appgroup /home/appuser

WORKDIR /app

COPY --from=builder --chown=appuser:appgroup /build/node_modules /app/node_modules

ENV NODE_PATH=/app/node_modules \
    PATH="/app/node_modules/.bin:$PATH"

USER appuser

EXPOSE 3456

ENTRYPOINT ["companion"]
CMD ["serve", "--port", "3456"]
