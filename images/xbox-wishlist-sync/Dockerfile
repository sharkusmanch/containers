# syntax=docker/dockerfile:1

# Pinned to a commit of the xbox-wishlist-sync source. Pin only commits whose CI passed in that
# repo; Renovate tracks main and opens a PR per new commit.
# renovate: datasource=github-commits depName=sharkusmanch/xbox-wishlist-sync branch=main
ARG WSYNC_COMMIT=7f1157de357cdd7efbc892ae800141f1ec2b73f8

# renovate: datasource=docker depName=python versioning=docker
ARG PYTHON_VERSION=3.15

# renovate: datasource=docker depName=alpine
ARG ALPINE_VERSION=3.24

# ============================================================================
# Builder stage
# ============================================================================
FROM python:${PYTHON_VERSION}-alpine${ALPINE_VERSION} AS builder

ARG WSYNC_COMMIT

# Copy uv from official image
COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

WORKDIR /build

# Download and extract source
RUN wget -qO- "https://github.com/sharkusmanch/xbox-wishlist-sync/archive/${WSYNC_COMMIT}.tar.gz" \
    | tar xz --strip-components=1

# Install the package and its dependencies. The native dependencies (curl_cffi and cffi) publish
# musllinux_1_2 binary wheels (curl_cffi's is abi3, so it covers every recent Python), hence Alpine
# rather than a glibc python-slim base. --only-binary turns a missing wheel into a build error
# instead of a silent source build that would need a compiler.
ENV UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_PYTHON_DOWNLOADS=never

RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --target /app/deps --only-binary curl_cffi --only-binary cffi .

# ============================================================================
# Runtime stage
# ============================================================================
FROM python:${PYTHON_VERSION}-alpine${ALPINE_VERSION} AS runtime

# Labels
ARG BUILD_DATE
ARG VCS_REF
ARG WSYNC_COMMIT
LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${WSYNC_COMMIT}" \
      org.opencontainers.image.source="https://github.com/sharkusmanch/containers" \
      org.opencontainers.image.upstream="https://github.com/sharkusmanch/xbox-wishlist-sync" \
      org.opencontainers.image.title="xbox-wishlist-sync" \
      org.opencontainers.image.description="Mirror an Xbox wishlist one-way onto Deku Deals and TrueAchievements (run as an hourly CronJob)"

# Create non-root user
RUN addgroup -g 10000 appgroup && \
    adduser -u 10000 -G appgroup -s /bin/false -D appuser

WORKDIR /

COPY --from=builder --chown=appuser:appgroup /app/deps /app/deps

# Safe for a read-only root filesystem: no bytecode writes, and HOME points at /tmp (mount an
# emptyDir there; state and config come from the environment and mounted files, not the image).
ENV PYTHONPATH=/app/deps \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOME=/tmp

USER appuser

ENTRYPOINT ["python", "-m", "wsync"]
CMD ["--help"]
