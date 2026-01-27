# syntax=docker/dockerfile:1

# renovate: datasource=github-releases depName=s-stefanov/actual-mcp
ARG ACTUAL_MCP_VERSION=v1.7.0

# renovate: datasource=docker depName=node
ARG NODE_VERSION=24

# ============================================================================
# Builder stage
# ============================================================================
FROM node:${NODE_VERSION}-alpine AS builder

ARG ACTUAL_MCP_VERSION

WORKDIR /build

# Install git to clone source
RUN apk add --no-cache git

# Clone specific version from upstream
RUN git clone --branch ${ACTUAL_MCP_VERSION} --depth 1 \
    https://github.com/s-stefanov/actual-mcp.git .

# Install dependencies and build
RUN --mount=type=cache,target=/root/.npm \
    npm ci && \
    npm run build

# Install production dependencies only
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

# ============================================================================
# Runtime stage
# ============================================================================
FROM node:${NODE_VERSION}-alpine AS runtime

# Labels
ARG BUILD_DATE
ARG VCS_REF
ARG ACTUAL_MCP_VERSION
LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${ACTUAL_MCP_VERSION}" \
      org.opencontainers.image.source="https://github.com/sharkusmanch/docker-images" \
      org.opencontainers.image.upstream="https://github.com/s-stefanov/actual-mcp" \
      org.opencontainers.image.title="actual-mcp" \
      org.opencontainers.image.description="MCP server for Actual Budget"

# Create non-root user
RUN addgroup -g 10000 appgroup && \
    adduser -u 10000 -G appgroup -s /bin/false -D appuser

WORKDIR /app

# Copy built application
COPY --from=builder --chown=appuser:appgroup /build/package.json ./
COPY --from=builder --chown=appuser:appgroup /build/build ./build
COPY --from=builder --chown=appuser:appgroup /build/node_modules ./node_modules

# Switch to non-root user
USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))" || exit 1

ENTRYPOINT ["node", "build/index.js"]
