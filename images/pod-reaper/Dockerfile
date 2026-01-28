# syntax=docker/dockerfile:1

# renovate: datasource=github-tags depName=target/pod-reaper
ARG POD_REAPER_VERSION=2.14.0

# renovate: datasource=docker depName=golang
ARG GO_VERSION=1.24

# renovate: datasource=docker depName=alpine
ARG ALPINE_VERSION=3.23

# ============================================================================
# Builder stage
# ============================================================================
FROM golang:${GO_VERSION}-alpine${ALPINE_VERSION} AS builder

ARG POD_REAPER_VERSION

WORKDIR /build

# Clone and build
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    apk add --no-cache git && \
    git clone --depth 1 --branch ${POD_REAPER_VERSION} https://github.com/target/pod-reaper.git . && \
    CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /pod-reaper -a ./reaper

# ============================================================================
# Runtime stage
# ============================================================================
FROM alpine:${ALPINE_VERSION} AS runtime

# Labels
ARG BUILD_DATE
ARG VCS_REF
ARG POD_REAPER_VERSION
LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${POD_REAPER_VERSION}" \
      org.opencontainers.image.source="https://github.com/sharkusmanch/containers" \
      org.opencontainers.image.upstream="https://github.com/target/pod-reaper" \
      org.opencontainers.image.title="pod-reaper" \
      org.opencontainers.image.description="Rule-based Kubernetes pod cleanup controller for reaping zombie pods"

# Create non-root user
RUN addgroup -g 10000 appgroup && \
    adduser -u 10000 -G appgroup -s /bin/false -D appuser

# Copy binary from builder
COPY --from=builder /pod-reaper /usr/local/bin/pod-reaper

USER appuser

ENTRYPOINT ["pod-reaper"]
