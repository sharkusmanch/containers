# syntax=docker/dockerfile:1

# renovate: datasource=github-releases depName=Sude-/lgogdownloader
ARG LGOGDOWNLOADER_VERSION=v3.18

# renovate: datasource=docker depName=alpine
ARG ALPINE_VERSION=3.21

# ============================================================================
# Builder stage
# ============================================================================
FROM alpine:${ALPINE_VERSION} AS builder

ARG LGOGDOWNLOADER_VERSION

WORKDIR /build

# Install build dependencies
RUN apk add --no-cache \
    build-base \
    cmake \
    ninja \
    curl \
    curl-dev \
    boost-dev \
    jsoncpp-dev \
    tinyxml2-dev \
    rhash-dev \
    tidyhtml-dev \
    zlib-dev

# Download and extract source (strip leading 'v' from version)
RUN VERSION_NUM=${LGOGDOWNLOADER_VERSION#v} && \
    curl -fsSL "https://github.com/Sude-/lgogdownloader/releases/download/v${VERSION_NUM}/lgogdownloader-${VERSION_NUM}.tar.gz" \
    | tar xz --strip-components=1

# Build
RUN cmake -B build -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX=/usr \
    -DUSE_QT_GUI=OFF \
    && cmake --build build \
    && DESTDIR=/install cmake --install build

# ============================================================================
# Runtime stage
# ============================================================================
FROM alpine:${ALPINE_VERSION} AS runtime

# Labels
ARG BUILD_DATE
ARG VCS_REF
ARG LGOGDOWNLOADER_VERSION
LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${LGOGDOWNLOADER_VERSION}" \
      org.opencontainers.image.source="https://github.com/sharkusmanch/docker-images" \
      org.opencontainers.image.upstream="https://github.com/Sude-/lgogdownloader" \
      org.opencontainers.image.title="lgogdownloader" \
      org.opencontainers.image.description="Unofficial GOG.com downloader for Linux"

# Install runtime dependencies
RUN apk add --no-cache \
    libcurl \
    boost1.84-regex \
    boost1.84-date_time \
    boost1.84-system \
    boost1.84-filesystem \
    boost1.84-program_options \
    boost1.84-iostreams \
    jsoncpp \
    tinyxml2 \
    rhash-libs \
    tidyhtml-libs \
    zlib \
    ca-certificates

# Create non-root user with consistent UID/GID
RUN addgroup -g 10000 appgroup && \
    adduser -u 10000 -G appgroup -s /bin/false -D appuser && \
    mkdir -p /home/appuser/.config/lgogdownloader /games && \
    chown -R appuser:appgroup /home/appuser /games

# Copy binary from builder
COPY --from=builder /install/usr/bin/lgogdownloader /usr/bin/lgogdownloader

USER appuser
WORKDIR /home/appuser

VOLUME ["/home/appuser/.config/lgogdownloader", "/games"]

ENTRYPOINT ["lgogdownloader"]
CMD ["--help"]
