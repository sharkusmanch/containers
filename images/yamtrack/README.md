# yamtrack

Rootless overlay on the official [Yamtrack](https://github.com/FuzzyGrim/Yamtrack) image — a
self-hosted media tracker for movies, TV, anime, manga, games, books, comics, and board games.

## Upstream

- **Repository**: [FuzzyGrim/Yamtrack](https://github.com/FuzzyGrim/Yamtrack)
- **Base image**: `ghcr.io/fuzzygrim/yamtrack`
- **Version**: 0.25.3

## Usage

```bash
docker run -p 8000:8000 ghcr.io/sharkusmanch/containers/yamtrack:0.25.3
```

Runs as UID/GID `10000:10000`. Mounted volumes must be writable by that id (in Kubernetes,
set `fsGroup: 10000`).

## Environment Variables

Identical to upstream, **except** `PUID`/`PGID`, which are ignored (see below). Key ones:

| Variable | Required | Description |
|----------|----------|-------------|
| `SECRET` | Yes | Django `SECRET_KEY` — upstream ships a public hardcoded default |
| `REDIS_URL` | Yes | Django cache backend *and* Celery broker |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | No | PostgreSQL; falls back to SQLite when `DB_HOST` is unset |
| `URLS` | No | Public base URL, e.g. `https://yamtrack.example.com` |
| `SOCIALACCOUNT_PROVIDERS` | No | JSON blob configuring OIDC via django-allauth |

## Volumes

| Path | Description |
|------|-------------|
| `/yamtrack/db` | Django `BASE_DIR/db` — created unconditionally, holds `db.sqlite3` in SQLite mode |
| `/tmp` | `gunicorn.ctl` control socket, `nginx.pid` |
| `/var/lib/nginx` | nginx client body buffering (`client_max_body_size 20M`) |
| `/var/log/nginx` | must be writable; log output itself goes to stdout/stderr |

The last three can be `emptyDir`, which makes `readOnlyRootFilesystem: true` viable.

## Modifications from Upstream

Config-only overlay — the application itself is not rebuilt.

- **Replaced `entrypoint.sh`**: dropped the `groupmod`/`usermod` PUID/PGID remap and the
  subsequent `chown` chain. These run under `set -e` and are what force the container to
  start as root. Ownership is baked at build time instead. `manage.py migrate --noinput`
  and the `exec supervisord` handoff are unchanged.
- **Remapped `abc` to 10000:10000** (repo convention) and pre-chowned `/yamtrack`,
  `/var/log/nginx`, `/var/lib/nginx`; pre-created `/yamtrack/db`.
- **Stripped `user=` from `/etc/supervisord.conf`**, which pinned supervisord and the nginx
  program to root.
- **Set supervisord's `logfile`/`pidfile`.** Upstream sets neither, so supervisord falls back
  to `$CWD/supervisord.log` and `$CWD/supervisord.pid` — and `WORKDIR` is `/yamtrack`, on the
  root filesystem. It aborts at startup if it cannot write them, which breaks
  `readOnlyRootFilesystem: true`. Now `logfile=/dev/stdout`, `logfile_maxbytes=0`,
  `pidfile=/tmp/supervisord.pid`.
- **`apk del shadow`** — `usermod`/`groupmod` are only needed for the build-time remap.
- **`PYTHONDONTWRITEBYTECODE=1`** — makes the already-true no-runtime-`.pyc` case explicit.
- **Removed the `user abc;` directive** from `nginx.conf` and `nginx.ipv6.conf` — only
  meaningful when the nginx master runs as root, and a warning otherwise.
- **`USER 10000:10000`**.

Nothing in the app needs root: nginx listens on 8000 (unprivileged) with `pid /tmp/nginx.pid`,
and gunicorn/celery were already dropped to `abc` upstream. The result satisfies the cluster's
enforced restricted Pod Security Standards (`runAsNonRoot`) with no Kyverno PolicyException.

`PUID`/`PGID` are inert — set the pod's `runAsUser`/`fsGroup` instead.
