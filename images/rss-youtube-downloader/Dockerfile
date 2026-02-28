# syntax=docker/dockerfile:1

# renovate: datasource=docker depName=python
ARG PYTHON_VERSION=3.12

# renovate: datasource=docker depName=alpine
ARG ALPINE_VERSION=3.21

# renovate: datasource=pypi depName=yt-dlp versioning=loose
ARG YTDLP_VERSION=2026.2.26.233640.dev0

# ============================================================================
# Builder stage
# ============================================================================
FROM python:${PYTHON_VERSION}-alpine${ALPINE_VERSION} AS builder

# Copy uv from official image
COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

WORKDIR /build

# Copy requirements and install dependencies with caching
COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --system --prefix=/deps -r requirements.txt

# ============================================================================
# Runtime stage
# ============================================================================
FROM python:${PYTHON_VERSION}-alpine${ALPINE_VERSION} AS runtime

# Labels
ARG BUILD_DATE
ARG VCS_REF
ARG YTDLP_VERSION
LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${YTDLP_VERSION}" \
      org.opencontainers.image.source="https://github.com/sharkusmanch/containers" \
      org.opencontainers.image.title="rss-youtube-downloader" \
      org.opencontainers.image.description="RSS feed monitor that downloads YouTube videos via yt-dlp"

# Install runtime dependencies: ffmpeg and yt-dlp
RUN --mount=type=cache,target=/var/cache/apk \
    apk add --no-cache ffmpeg

RUN pip install --no-cache-dir yt-dlp==${YTDLP_VERSION}

# Create non-root user
RUN addgroup -g 10000 appgroup && \
    adduser -u 10000 -G appgroup -s /bin/false -D appuser && \
    mkdir -p /app /config /media && \
    chown -R appuser:appgroup /app /config /media

WORKDIR /app

# Copy Python dependencies from builder
COPY --from=builder /deps /usr/local

# Copy application
COPY --chown=appuser:appgroup downloader.py /app/downloader.py

ENV PYTHONUNBUFFERED=1

USER appuser

VOLUME ["/config", "/media"]

ENTRYPOINT ["python", "/app/downloader.py"]
