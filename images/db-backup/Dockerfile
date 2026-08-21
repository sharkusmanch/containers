# syntax=docker/dockerfile:1

# Curated toolbox version — bump manually when the tool set or client majors change
# NOTE: the build workflow tags the image from the FIRST `^ARG.*_VERSION=` line in
# this file, so this must stay above ALPINE_VERSION.
ARG DBBACKUP_VERSION=1.1.0

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
      org.opencontainers.image.description="Database dump toolbox: PostgreSQL/MariaDB/MongoDB clients + curl/jq, baked at build time"

# Baked at build time — replaces the backup CronJob's per-run `apk add`.
# pg_dump's major must be >= every server major it dumps: bump
# postgresql18-client to postgresql<N>-client when a cluster Postgres app
# moves past major 18.
# mongodb-tools (mongodump/mongorestore) comes from the Alpine COMMUNITY repo,
# which the official alpine image enables by default — unlike the other three,
# which are in main. Database Tools 100.x supports server 4.4-8.x, so it is not
# version-coupled to the cluster's MongoDB the way pg_dump is to Postgres.
RUN --mount=type=cache,target=/var/cache/apk \
    apk add --no-cache postgresql18-client mariadb-client mongodb-tools curl jq

RUN addgroup -g 10000 appgroup && \
    adduser -u 10000 -G appgroup -s /bin/false -D appuser

USER appuser

ENTRYPOINT ["/bin/sh"]
