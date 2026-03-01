# podcast-feed-filter

Stateless HTTP proxy that filters podcast RSS feeds by title pattern while preserving all XML elements including `<enclosure>`, `itunes:*`, and other podcast-specific tags.

Uses lxml to operate on raw XML — items not matching the configured regex are removed, everything else passes through verbatim. Optionally overrides channel title, description, and artwork per feed.

## Upstream

- **Repository**: Custom application (no upstream)

## Usage

```bash
docker run --rm \
  -v ./config.yaml:/config/config.yaml:ro \
  -p 8080:8080 \
  ghcr.io/sharkusmanch/containers/podcast-feed-filter:latest
```

### Configuration

Create a YAML config file:

```yaml
cache_ttl: 300  # seconds to cache upstream feed responses
feeds:
  games-daily:
    source: "https://www.patreon.com/rss/example?auth=TOKEN"
    match: "Kinda Funny Games Daily"
    title: "Kinda Funny Games Daily"       # optional, overrides channel title
    description: "Daily gaming news"       # optional, overrides channel description
    image: "https://example.com/art.jpg"   # optional, overrides channel artwork
  gregway:
    source: "https://www.patreon.com/rss/example?auth=TOKEN"
    match: "- Gregway"
```

Access filtered feeds at `http://localhost:8080/feeds/games-daily`.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CONFIG_PATH` | No | Path to config YAML (default: `/config/config.yaml`) |

## Endpoints

| Path | Description |
|------|-------------|
| `GET /feeds/<name>` | Filtered RSS feed |
| `GET /health` | Health check |
| `GET /` | List available feeds |

## Modifications from Upstream

Custom application — no upstream to compare against.
