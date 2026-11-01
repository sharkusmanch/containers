# xbox-wishlist-sync

Mirrors an Xbox wishlist, one way, onto a Deku Deals wishlist and a TrueAchievements wishlist. Built to run
as an hourly Kubernetes CronJob; the Xbox wishlist is never written.

## Upstream

- **Repository**: [sharkusmanch/xbox-wishlist-sync](https://github.com/sharkusmanch/xbox-wishlist-sync)
- **Version**: Pinned by commit (`WSYNC_COMMIT`); only commits whose upstream CI passed are pinned, and Renovate
  tracks `main`

## Usage

```bash
# Show help
docker run --rm ghcr.io/sharkusmanch/containers/xbox-wishlist-sync:latest --help

# Plan only (the default): feed, state and overrides are mounted, credentials come from the environment
docker run --rm \
  --env-file ./wsync.env \
  -v ./feed:/feed:ro -v ./state:/state -v ./config:/config:ro \
  ghcr.io/sharkusmanch/containers/xbox-wishlist-sync:latest --dry-run

# Apply changes
docker run --rm --env-file ./wsync.env \
  -v ./feed:/feed:ro -v ./state:/state -v ./config:/config:ro \
  ghcr.io/sharkusmanch/containers/xbox-wishlist-sync:latest --apply
```

The entrypoint is `python -m wsync`; arguments are `[--only deku|ta] [--dry-run | --apply] [--no-report]
[--accept-feed-count N]`. The image runs fine with a read-only root filesystem (`HOME=/tmp`, no bytecode
writes); mount a writable volume at `/state`.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DEKU_EMAIL`, `DEKU_PASSWORD`, `DEKU_WISHLIST_ID` | Yes | Deku Deals account |
| `TA_GAMERTAG`, `TA_PASSWORD`, `FLARESOLVERR_URL` | Yes | TrueAchievements account and a FlareSolverr v3 `/v1` endpoint |
| `DRY_RUN` | No | `false` applies changes; anything else (including unset) plans only |
| `WSYNC_FEED` | No | Feed file (default `/feed/wishlist.json`) |
| `WSYNC_STATE` | No | State file (default `/state/state.json`) |
| `WSYNC_OVERRIDES` | No | Manual match overrides (default `/config/overrides.json`) |
| `WSYNC_FEED_MAX_AGE_HOURS` | No | Oldest feed accepted (default 6) |
| `WSYNC_ACCEPT_FEED_COUNT` | No | Shrink-guard recovery |
| `VIKUNJA_URL`, `VIKUNJA_TOKEN`, `APPRISE_URL` | No | Task reporting and notifications |

See the upstream README for the full behaviour.

## Volumes

| Path | Description |
|------|-------------|
| `/feed` | Xbox wishlist JSON feed (read-only) |
| `/state` | State and session files |
| `/config` | `overrides.json` (read-only) |

## Modifications from Upstream

- Containerized with a multi-stage Alpine build; `curl_cffi` and `cffi` come from musllinux binary wheels, so
  there is no build toolchain
- Runs as non-root user (UID/GID 10000)
- `HOME=/tmp` and `PYTHONDONTWRITEBYTECODE=1` so the root filesystem can be read-only
