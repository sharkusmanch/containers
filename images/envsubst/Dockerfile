# syntax=docker/dockerfile:1

# renovate: datasource=github-releases depName=a8m/envsubst
ARG VERSION=v1.4.3

# renovate: datasource=docker depName=golang
ARG GO_VERSION=1.23

# renovate: datasource=docker depName=alpine
ARG ALPINE_VERSION=3.21

# ============================================================================
# Builder stage
# ============================================================================
FROM golang:${GO_VERSION}-alpine${ALPINE_VERSION} AS builder

ARG VERSION

WORKDIR /build

# Clone and build
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    apk add --no-cache git && \
    git clone --depth 1 --branch ${VERSION} https://github.com/a8m/envsubst.git . && \
    CGO_ENABLED=0 go build -ldflags="-s -w" -o /envsubst ./cmd/envsubst

# ============================================================================
# Runtime stage
# ============================================================================
FROM alpine:${ALPINE_VERSION} AS runtime

# Labels
ARG BUILD_DATE
ARG VCS_REF
ARG VERSION
LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.source="https://github.com/sharkusmanch/docker-images" \
      org.opencontainers.image.upstream="https://github.com/a8m/envsubst" \
      org.opencontainers.image.title="envsubst" \
      org.opencontainers.image.description="Environment variable substitution with default values and strict mode"

# Create non-root user
RUN addgroup -g 10000 appgroup && \
    adduser -u 10000 -G appgroup -s /bin/false -D appuser

# Copy binary from builder
COPY --from=builder /envsubst /usr/local/bin/envsubst

USER appuser

ENTRYPOINT ["envsubst"]
