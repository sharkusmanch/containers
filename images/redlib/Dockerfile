# syntax=docker/dockerfile:1

# Upstream redlib's official static release binary (x86_64 musl). See README.md.
#
# This image used to build chowder/redlib PR #509 (hyper-tls/OpenSSL) to dodge
# Reddit's TLS fingerprinting. From 2026-10-20 Reddit answered every request from
# that build with 403 "blocked by network security" -- listings included -- while
# byte-identical requests from curl on the same IP still got 200. Upstream v0.40.0
# replaced the HTTP client with wreq, which emulates a real browser's TLS
# fingerprint, and works from the same IP. So the fork is no longer needed.

# The release tarball and its checksum are bumped together by Renovate.
# renovate: datasource=github-release-attachments depName=redlib-org/redlib
ARG REDLIB_VERSION=v0.40.0
ARG REDLIB_SHA256=1eb009a0f5079183bdd8f47832f491b9fc87c4e50214ff145371357f58934c7e

# renovate: datasource=docker depName=alpine
ARG ALPINE_VERSION=3.24

# ============================================================================
# Builder stage: fetch and verify the release binary
# ============================================================================
FROM alpine:${ALPINE_VERSION} AS builder

ARG REDLIB_VERSION
ARG REDLIB_SHA256

RUN apk add --no-cache curl

WORKDIR /build
RUN set -eux; \
    curl -fsSL -o redlib.tar.gz \
      "https://github.com/redlib-org/redlib/releases/download/${REDLIB_VERSION}/redlib-x86_64-unknown-linux-musl.tar.gz"; \
    echo "${REDLIB_SHA256}  redlib.tar.gz" | sha256sum -c -; \
    tar -xzf redlib.tar.gz redlib; \
    chmod 0755 redlib

# ============================================================================
# Runtime stage
# ============================================================================
FROM alpine:${ALPINE_VERSION} AS runtime

# Labels
ARG BUILD_DATE
ARG VCS_REF
ARG REDLIB_VERSION
LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${REDLIB_VERSION}" \
      org.opencontainers.image.source="https://github.com/sharkusmanch/containers" \
      org.opencontainers.image.upstream="https://github.com/redlib-org/redlib" \
      org.opencontainers.image.title="redlib" \
      org.opencontainers.image.description="Private Reddit frontend (upstream release binary)"

# Install runtime dependencies
# - ca-certificates: TLS certificate validation
RUN apk add --no-cache ca-certificates

# Create non-root user
RUN addgroup -g 10000 appgroup && \
    adduser -u 10000 -G appgroup -s /bin/false -D -H appuser

# Copy binary from builder (static-pie: needs no loader or libc at runtime)
COPY --from=builder /build/redlib /usr/local/bin/redlib

# Switch to non-root user
USER appuser

EXPOSE 8080

HEALTHCHECK --interval=1m --timeout=3s --start-period=5s --retries=3 \
    CMD wget --spider -q http://localhost:8080/settings || exit 1

CMD ["redlib"]
