# autoshift

Automatic SHiFT code redemption for Borderlands games. Fetches available codes and redeems them to your account on a schedule.

## Upstream

- **Repository**: [Fabbi/autoshift](https://github.com/Fabbi/autoshift)
- **Version**: v2.1.4

## Usage

```bash
# Show help
docker run --rm ghcr.io/sharkusmanch/autoshift:latest --help

# Run scheduled redemption for Borderlands 3 on Steam
docker run -d \
  -v autoshift-data:/data \
  -e STEAM_USERNAME=your_username \
  -e STEAM_PASSWORD=your_password \
  ghcr.io/sharkusmanch/autoshift:latest \
  schedule --bl3 steam
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `STEAM_USERNAME` | No | Steam account username |
| `STEAM_PASSWORD` | No | Steam account password |
| `EPIC_USERNAME` | No | Epic Games account username |
| `EPIC_PASSWORD` | No | Epic Games account password |

See [upstream documentation](https://github.com/Fabbi/autoshift#configuration) for full configuration options.

## Volumes

| Path | Description |
|------|-------------|
| `/data` | Database and session storage |

## Modifications from Upstream

- Multi-stage build for smaller image size
- Alpine-based instead of Debian
- Runs as non-root user (UID 10000)
