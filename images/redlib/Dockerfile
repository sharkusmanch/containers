# syntax=docker/dockerfile:1

# Upstream redlib v0.40.0 plus PR #603 (GraphQL comments), built from source.
# See README.md.
#
# Since 2026-10-20 Reddit refuses the comments JSON endpoints to logged-out tokens,
# so every post page on the v0.40.0 release fails with 403. PR #603 fetches the post
# from /by_id and its comments through the Android app's persisted GraphQL
# operation (gql-fed.reddit.com), with the same anonymous token. It is two commits
# on top of upstream main ba116c1 and adds no dependencies.
#
# TEMPORARY. Go back to the upstream release binary (git history: 342913f) once a
# release loads comment threads.

# Image tag only. CI tags the image with the first *_VERSION ARG in this file, so
# this has to stay first. No renovate comment: Renovate cannot track it.
ARG REDLIB_VERSION=v0.40.0-gql.6cd8366

# fxmfxmfx/redlib fix/graphql-comments, the head of PR #603 (reviewed 2026-10-25).
# Deliberately not Renovate-tracked: this repo automerges every update, and new
# commits on a third-party fork branch should be reviewed before they ship.
ARG REDLIB_REPO=https://github.com/fxmfxmfx/redlib.git
ARG REDLIB_COMMIT=6cd8366ad12f8faf8a384adc63affef3ecc4e696

# renovate: datasource=docker depName=alpine
ARG ALPINE_VERSION=3.24

# ============================================================================
# Builder stage: upstream's own build (Dockerfile.alpine), amd64 musl only
# ============================================================================
# wreq builds BoringSSL, so it needs cmake, perl and libclang. rust-musl-cross is
# the image upstream's Dockerfile.alpine and release builds use.
FROM ghcr.io/rust-cross/rust-musl-cross:x86_64-musl@sha256:ce75e9174325d4fbb3de85c309e2d7ca29f7500169bc4b5d2c611ff7e86d549a AS builder

ARG REDLIB_REPO
ARG REDLIB_COMMIT

RUN apt-get update \
    && apt-get -y install git cmake perl pkg-config libclang-dev \
    && rm -rf /var/lib/apt/lists/*

RUN rustup target add x86_64-unknown-linux-musl

WORKDIR /redlib

# Fetch exactly the pinned commit; git verifies the content against the SHA.
# build.rs stamps `git rev-parse HEAD` into the binary.
RUN git init -q . && \
    git remote add origin "${REDLIB_REPO}" && \
    git fetch -q --depth 1 origin "${REDLIB_COMMIT}" && \
    git checkout -q FETCH_HEAD && \
    test "$(git rev-parse HEAD)" = "${REDLIB_COMMIT}"

RUN --mount=type=cache,target=/redlib/target \
    --mount=type=cache,target=/root/.cargo/registry \
    cargo build --release --locked --bin redlib --target x86_64-unknown-linux-musl && \
    cp target/x86_64-unknown-linux-musl/release/redlib /redlib-bin

# ============================================================================
# Runtime stage
# ============================================================================
FROM alpine:${ALPINE_VERSION} AS runtime

# Labels
ARG BUILD_DATE
ARG VCS_REF
ARG REDLIB_VERSION
ARG REDLIB_COMMIT
LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${REDLIB_VERSION}" \
      org.opencontainers.image.source="https://github.com/sharkusmanch/containers" \
      org.opencontainers.image.upstream="https://github.com/redlib-org/redlib" \
      org.opencontainers.image.upstream-ref="https://github.com/redlib-org/redlib/pull/603" \
      org.opencontainers.image.upstream-commit="${REDLIB_COMMIT}" \
      org.opencontainers.image.title="redlib" \
      org.opencontainers.image.description="Private Reddit frontend (v0.40.0 + GraphQL comments, PR #603)"

# Install runtime dependencies
# - ca-certificates: TLS certificate validation
RUN apk add --no-cache ca-certificates

# Create non-root user
RUN addgroup -g 10000 appgroup && \
    adduser -u 10000 -G appgroup -s /bin/false -D -H appuser

# Copy binary from builder (static musl: needs no loader or libc at runtime)
COPY --from=builder /redlib-bin /usr/local/bin/redlib

# Switch to non-root user
USER appuser

EXPOSE 8080

HEALTHCHECK --interval=1m --timeout=3s --start-period=5s --retries=3 \
    CMD wget --spider -q http://localhost:8080/settings || exit 1

CMD ["redlib"]
