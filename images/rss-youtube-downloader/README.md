# rss-youtube-downloader

Parses RSS feeds for YouTube URLs and downloads videos via yt-dlp. Videos are routed to different directories based on regex pattern matching against entry titles, with configurable retention and automatic pruning of old downloads.

Designed to run as a Kubernetes CronJob.

## Upstream

- **Repository**: Custom application (no upstream)

## Usage

```bash
docker run --rm \
  -v ./config:/config \
  -v ./media:/media \
  -e PATREON_FEED_URL="https://www.patreon.com/rss/..." \
  ghcr.io/sharkusmanch/containers/rss-youtube-downloader:latest
```

### Configuration

Create a YAML config file at `/config/config.yaml`:

```yaml
feeds:
  - name: "Example Feed"
    url_env: "PATREON_FEED_URL"      # Environment variable containing the RSS URL
    default_path: "/media/unsorted"   # Fallback download directory
    retention_days: 30                # Auto-delete after 30 days (0 = keep forever)
    series:
      - name: "Series A"
        pattern: "(?i)series\\s*a"    # Regex matched against entry titles
        path: "/media/series-a"
      - name: "Series B"
        pattern: "(?i)series\\s*b"
        path: "/media/series-b"
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CONFIG_FILE` | No | Path to config YAML (default: `/config/config.yaml`) |
| `STATE_FILE` | No | Path to state JSON (default: `/config/state.json`) |
| *per-feed* | Yes | Each feed's `url_env` field names an env var holding the RSS feed URL |

## Volumes

| Path | Description |
|------|-------------|
| `/config` | Configuration file and download state |
| `/media` | Downloaded video files |

## Modifications from Upstream

Custom application -- no upstream to compare against.
