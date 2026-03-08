# steam-wishlist-calendar

Generate an ICS calendar file from a Steam wishlist's unreleased game release dates.

## Upstream

- **Repository**: [icue/SteamWishlistCalendar](https://github.com/icue/SteamWishlistCalendar)
- **Version**: Commit-tracked (main branch)

## Usage

```bash
# Show help
docker run --rm ghcr.io/sharkusmanch/steam-wishlist-calendar:latest --help

# Generate calendar for a Steam ID
docker run --rm \
  -v ./output:/output \
  ghcr.io/sharkusmanch/steam-wishlist-calendar:latest \
  -i 76561198012345678
```

## CLI Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `-i`, `--id` | Yes | Steam ID (numeric) |
| `-d`, `--include-dlc` | No | Include DLC in calendar |

## Volumes

| Path | Description |
|------|-------------|
| `/output` | Generated files: `wishlist.ics`, `history.json`, charts |

## Modifications from Upstream

- Containerized with multi-stage Alpine build
- Runs as non-root user (UID 10000)
- Output directory at `/output` via WORKDIR placement
