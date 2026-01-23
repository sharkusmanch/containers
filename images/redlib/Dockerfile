# syntax=docker/dockerfile:1

# Using PR #509 (hyper-tls) to evade Reddit rate limiting
# See: https://github.com/redlib-org/redlib/issues/446
# renovate: datasource=github-commits depName=chowder/redlib branch=feature/tls-openssl
ARG REDLIB_COMMIT=42fe41bc4c64690aa91cd1cfecec3bad3438354f

# renovate: datasource=docker depName=rust versioning=docker
ARG RUST_VERSION=1.83

# renovate: datasource=docker depName=alpine
ARG ALPINE_VERSION=3.20

# ============================================================================
# Builder stage
# ============================================================================
FROM rust:${RUST_VERSION}-alpine${ALPINE_VERSION} AS builder

ARG REDLIB_COMMIT

# Install build dependencies
# - musl-dev: C standard library for static linking
# - perl, make: Required for OpenSSL build (vendored)
# - git: Clone source and stamp commit info
RUN apk add --no-cache musl-dev perl make git

WORKDIR /build

# Clone specific commit from PR #509 branch
RUN git clone https://github.com/chowder/redlib.git . && \
    git checkout ${REDLIB_COMMIT}

# Build with caching for faster rebuilds
RUN --mount=type=cache,target=/build/target \
    --mount=type=cache,target=/usr/local/cargo/registry \
    cargo build --release && \
    cp /build/target/release/redlib /redlib

# ============================================================================
# Runtime stage
# ============================================================================
FROM alpine:${ALPINE_VERSION} AS runtime

# Labels
ARG BUILD_DATE
ARG VCS_REF
ARG REDLIB_COMMIT
LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${REDLIB_COMMIT}" \
      org.opencontainers.image.source="https://github.com/sharkusmanch/docker-images" \
      org.opencontainers.image.upstream="https://github.com/redlib-org/redlib" \
      org.opencontainers.image.upstream-ref="https://github.com/redlib-org/redlib/pull/509" \
      org.opencontainers.image.title="redlib" \
      org.opencontainers.image.description="Private Reddit frontend (hyper-tls build)"

# Install runtime dependencies
# - ca-certificates: TLS certificate validation
RUN apk add --no-cache ca-certificates

# Create non-root user
RUN addgroup -g 10000 appgroup && \
    adduser -u 10000 -G appgroup -s /bin/false -D -H appuser

# Copy binary from builder
COPY --from=builder /redlib /usr/local/bin/redlib

# Switch to non-root user
USER appuser

EXPOSE 8080

HEALTHCHECK --interval=1m --timeout=3s --start-period=5s --retries=3 \
    CMD wget --spider -q http://localhost:8080/settings || exit 1

CMD ["redlib"]
