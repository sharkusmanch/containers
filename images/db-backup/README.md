# db-backup

Database dump toolbox for backup CronJobs. Bakes the PostgreSQL, MariaDB and
MongoDB client tools (plus `curl` and `jq` for OpenBao raft snapshots) into a
pinned Alpine image, replacing per-run `apk add` in the cluster's `db-backup`
CronJob.
The backup script itself is not in the image — it stays a GitOps-managed
ConfigMap in the cluster repo.

## Upstream

- **Repository**: [Alpine Linux packages](https://pkgs.alpinelinux.org/) — `postgresql18-client`, `mariadb-client`, `mongodb-tools`, `curl`, `jq`
- **Version**: 1.1.0 (curated; tools track the pinned Alpine branch at build time)

## Usage

```bash
# The consuming CronJob mounts its backup script and runs it directly:
docker run --rm -v ./backup.sh:/scripts/backup.sh ghcr.io/sharkusmanch/containers/db-backup:1.1.0 /scripts/backup.sh

# Tools available: pg_dump, pg_restore, psql, mysqldump/mariadb-dump, mysql,
#                  mongodump, mongorestore, mongoexport/mongoimport, bsondump, curl, jq
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| — | — | None consumed by the image; the mounted script defines its own contract |

## Volumes

| Path | Description |
|------|-------------|
| `/scripts` | Backup script mount (ConfigMap in-cluster) |
| `/backup` | Dump destination (NFS in-cluster) |

## Modifications from Upstream

- Original curated toolbox — no single upstream application.
- Runs as non-root `10000:10000`.
- **Version-coupling rule**: `pg_dump` must be ≥ every server major it dumps.
  When a cluster Postgres app moves past major 18, bump `postgresql18-client`
  to `postgresql<N>-client` and bump `DBBACKUP_VERSION`.
- `mongodb-tools` comes from the Alpine **community** repo (the other packages
  are in main); the official Alpine image enables community by default. Unlike
  `pg_dump` it is not version-coupled — Database Tools 100.x supports server
  4.4–8.x, which covers the cluster's MongoDB 7.0.
- The image tag is derived by CI from the **first** `^ARG.*_VERSION=` line in
  the Dockerfile, so `DBBACKUP_VERSION` must stay above `ALPINE_VERSION`.
- No `tzdata` on purpose: the consuming job's filename timestamps have always
  been UTC (bare Alpine ignores IANA `TZ`); adding tzdata would shift filename
  dates by the cluster's UTC offset.
