# dq8-alchemy-planner

[DQ8 Alchemy Planner](https://github.com/sharkusmanch/dq8-alchemy-planner) is a static web
app that tracks Dragon Quest VIII (PS2) alchemy progress and reads a save file in the
browser. This image serves the site with an unprivileged nginx, built with the default save
address `./save`, so the page fetches the newest save from its own server and imports it
whenever the bytes change.

The same image carries `latest-save`, a small watcher that publishes the newest save from a
PCSX2-style memory-card folder tree for nginx to serve. Run the image twice: once with the
default command (the web server) and once with the command `latest-save` (the watcher), both
mounting the same writable volume at `/run/save`.

## Upstream

- **Repository**: [sharkusmanch/dq8-alchemy-planner](https://github.com/sharkusmanch/dq8-alchemy-planner)
- **Version**: v1.1.0

## Usage

```bash
# Shared volume for the published save
docker volume create dq8-save

# Web server (default command), port 8080
docker run -d --name dq8-web --read-only --tmpfs /tmp \
  -v dq8-save:/run/save:ro -p 8080:8080 \
  ghcr.io/sharkusmanch/containers/dq8-alchemy-planner:v1.1.0

# Watcher: the same image with a different command. SAVE_DIR holds the
# BASLUS-21207dq8_N directories and is mounted read-only.
docker run -d --name dq8-watch --read-only \
  -v dq8-save:/run/save -v /path/to/memcard:/saves:ro -e SAVE_DIR=/saves \
  ghcr.io/sharkusmanch/containers/dq8-alchemy-planner:v1.1.0 latest-save
```

Do not allocate a TTY (`-t`) for the web server: nginx writes its logs to `/dev/stdout` and
`/dev/stderr`, which a root-owned pseudo-terminal does not let UID 10000 open.

Both containers run as UID/GID 10000. The volume at `/run/save` must be writable by that
user for the watcher (in Kubernetes: an `emptyDir` with `fsGroup: 10000`, or equivalent).
Docker's named volumes inherit the image's ownership of `/run/save` the first time they are
used. nginx only reads it, so the web server may mount it read-only. `/tmp` must be writable
for nginx (pid file and temporary directories); everything else can be read-only.

The web server answers:

| Path | Response |
|------|----------|
| `/` and `/index.html` | The app, `Cache-Control: no-cache` |
| `/assets/*` | Hashed build output, `Cache-Control: public, max-age=31536000, immutable` |
| `/save` | `/run/save/latest.bin` as `application/octet-stream`, `Cache-Control: no-store`; 404 while the file does not exist |
| `/healthz` | `200 ok` |

There is no authentication or TLS in the image. Anyone who can reach `/save` can download the
save, so put it behind whatever you use to protect the page (an authenticating reverse proxy,
a private network). Because the save is on the page's own origin, no CORS header is needed.

### Probes

Web server (HTTP probe, or from inside the container):

```bash
wget -q -O /dev/null http://127.0.0.1:8080/healthz
```

Watcher (exec probe): the heartbeat is touched at the end of every pass, so it is newer than a
few intervals while the watcher is alive. This allows 60 seconds with the default 10-second
interval; scale it if you raise `INTERVAL`.

```bash
sh -c 'test $(( $(date +%s) - $(stat -c %Y /run/save/heartbeat) )) -lt 60'
```

## How the watcher picks a save

Each pass lists `SAVE_DIR`. A candidate is a directory named `BASLUS-21207dq8_<number>`
holding a regular file of the same name that is exactly 23,776 bytes. Conflict copies,
temporary files, other names, wrong sizes, symlinks and directories are ignored. The
candidate with the newest file modification time wins (not the directory's); equal times go
to the higher slot number. If its content differs from `latest.bin`, it is copied to a
temporary file in `OUT_DIR`, size-checked and renamed over `latest.bin`, so a reader never
sees a partial file. With no candidate, `latest.bin` is removed; if the listing itself fails
(an unavailable network filesystem, say) nothing is changed. The watcher never writes inside
`SAVE_DIR` and logs one line per change or error, never file contents.

## Environment Variables

Used by the watcher (`latest-save`). The web server needs none.

| Variable | Required | Description |
|----------|----------|-------------|
| `SAVE_DIR` | Yes | Directory that contains the `BASLUS-21207dq8_N` directories. The watcher exits non-zero at start if it is unset or not a directory |
| `OUT_DIR` | No | Where `latest.bin` and `heartbeat` are written. Default `/run/save` |
| `INTERVAL` | No | Seconds between passes. Default `10` |
| `ONCE` | No | `1` runs a single pass and exits (for tests). Default `0` |

## Volumes

| Path | Description |
|------|-------------|
| `/run/save` | Published save (`latest.bin`) and watcher `heartbeat`. Shared by both containers; writable for the watcher |
| `/tmp` | nginx pid file and temporary directories. Must be writable (a `tmpfs` or `emptyDir` is enough) |
| `SAVE_DIR` (your choice) | Watcher input, mounted read-only. Not used by the web server |

## Modifications from Upstream

- Upstream publishes only a static site (GitHub Pages). This image builds the same release
  tag, unchanged, with `VITE_DEFAULT_SAVE_URL=./save`, and serves it with nginx.
- Added `nginx.conf` (unprivileged, port 8080, everything written under `/tmp`) and the
  `latest-save` watcher script, neither of which is part of upstream.
- The image ships no Node toolchain or source: only the built `dist/`.
