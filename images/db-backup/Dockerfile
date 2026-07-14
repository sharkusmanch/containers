# syntax=docker/dockerfile:1

# Curated toolbox version — bump manually when the tool set or client majors change
ARG DBBACKUP_VERSION=1.0.0

# renovate: datasource=docker depName=alpine
ARG ALPINE_VERSION=3.24

# ============================================================================
# Runtime stage
# ============================================================================
FROM alpine:${ALPINE_VERSION} AS runtime

ARG BUILD_DATE
ARG VCS_REF
ARG DBBACKUP_VERSION

LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${DBBACKUP_VERSION}" \
      org.opencontainers.image.source="https://github.com/sharkusmanch/containers" \
      org.opencontainers.image.title="db-backup" \
      org.opencontainers.image.description="Database dump toolbox: PostgreSQL/MariaDB clients + curl/jq, baked at build time"

# Baked at build time — replaces the backup CronJob's per-run `apk add`.
# pg_dump's major must be >= every server major it dumps: bump
# postgresql18-client to postgresql<N>-client when a cluster Postgres app
# moves past major 18.
RUN --mount=type=cache,target=/var/cache/apk \
    apk add --no-cache postgresql18-client mariadb-client curl jq

RUN addgroup -g 10000 appgroup && \
    adduser -u 10000 -G appgroup -s /bin/false -D appuser

USER appuser

ENTRYPOINT ["/bin/sh"]
