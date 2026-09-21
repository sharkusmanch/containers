# syntax=docker/dockerfile:1

# renovate: datasource=docker depName=python versioning=docker
ARG PYTHON_VERSION=3.11-slim

FROM python:${PYTHON_VERSION}

# readaloud-exporter: turns audiobook<->ebook alignment maps into EPUB 3 books
# with SMIL media overlays and embedded Opus audio (read-along + position sync).
# Python 3.11 and the parser pins in requirements.txt are deliberate: text
# offsets must match the producer of the alignment maps character for character.

ARG BUILD_DATE
ARG VCS_REF
ARG VERSION
LABEL org.opencontainers.image.title="readaloud-exporter" \
      org.opencontainers.image.description="Alignment maps -> EPUB 3 media-overlay (readaloud) books" \
      org.opencontainers.image.source="https://github.com/sharkusmanch/containers" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${VERSION}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && ffmpeg -hide_banner -encoders | grep -q libopus

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt && rm /tmp/requirements.txt

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 HOME=/tmp
WORKDIR /app
COPY app/ /app/app/
COPY tests/ /app/tests/
RUN PYTHONPATH=/app python -m pytest -q /app/tests
USER 1000:1000
ENTRYPOINT ["python", "-m", "app.main"]
