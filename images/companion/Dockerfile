# syntax=docker/dockerfile:1

# renovate: datasource=npm depName=the-companion
ARG COMPANION_VERSION=0.75.0

# renovate: datasource=npm depName=@anthropic-ai/claude-code
ARG CLAUDE_CODE_VERSION=2.1.73

# renovate: datasource=docker depName=oven/bun versioning=docker
ARG BUN_VERSION=1.3

# ============================================================================
# Builder stage
# ============================================================================
FROM oven/bun:${BUN_VERSION}-alpine AS builder

ARG COMPANION_VERSION
ARG CLAUDE_CODE_VERSION

WORKDIR /build

RUN bun init -y && \
    bun add the-companion@${COMPANION_VERSION} @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

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
      org.opencontainers.image.description="Web UI for managing Claude Code sessions with Claude Code CLI"

# Install runtime dependencies for Claude Code
RUN apk add --no-cache bash curl git openssh-client && \
    ln -s /app/node_modules/.bin/claude /usr/local/bin/claude

# Create non-root user with bash shell (needed for Claude Code)
RUN addgroup -g 10000 appgroup && \
    adduser -u 10000 -G appgroup -s /bin/bash -D appuser && \
    mkdir -p /home/appuser/.local/bin && \
    chown -R appuser:appgroup /home/appuser

WORKDIR /app

COPY --from=builder --chown=appuser:appgroup /build/node_modules /app/node_modules

USER appuser

ENV NODE_PATH=/app/node_modules \
    PATH="/home/appuser/.local/bin:/app/node_modules/.bin:$PATH"

EXPOSE 3456

ENTRYPOINT ["companion"]
CMD ["serve", "--port", "3456"]
