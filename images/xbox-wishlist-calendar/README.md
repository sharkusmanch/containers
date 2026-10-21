# xbox-wishlist-calendar

Turn a public Xbox wishlist into release-time artifacts: an ICS calendar (`wishlist.ics`), two plain-text
lists (`successful.txt`, `concrete.txt`) and a JSON dump (`wishlist.json`). Each event sits at the exact
moment the store says the wishlisted edition unlocks.

## Upstream

- **Repository**: [sharkusmanch/xbox-wishlist-tools](https://github.com/sharkusmanch/xbox-wishlist-tools) (MIT)
- **Version**: Pinned by commit (`XWC_COMMIT`); only commits whose upstream CI passed are pinned, and the pin is
  bumped by hand (not Renovate-tracked)

## Usage

```bash
# Show help
docker run --rm ghcr.io/sharkusmanch/containers/xbox-wishlist-calendar:latest --help

# Write the four files to ./output (the wishlist ID or Share link comes from the environment)
docker run --rm \
  -e XBOX_WISHLIST="<wishlist ID or Share link>" \
  -v ./output:/output \
  ghcr.io/sharkusmanch/containers/xbox-wishlist-calendar:latest \
  --output-dir /output --timezone America/Los_Angeles
```

Prefer the environment variable to `--wishlist`: an ID on the command line shows up in process lists.
The wishlist's visibility must be **Public** on xbox.com; the ID is in the link from its Share button.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `XBOX_WISHLIST` | Yes (unless `--wishlist` is given) | Wishlist ID or the Share link |

## CLI Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `--wishlist ID_OR_LINK` | `$XBOX_WISHLIST` | Wishlist ID or Share link |
| `--output-dir DIR` | `output` | Where the four files go (relative paths resolve from `/`, so `output` is `/output`) |
| `--market MARKET` | `US` | Store market for the catalog lookups |
| `--locale LOCALE` | `en-US` | Store language and region |
| `--timezone ZONE` | `UTC` | IANA zone for the times in event descriptions; the events themselves are always UTC |
| `--include-addons` | off | Put add-ons (DLC) on the calendar too |

Exit status: `0` success; `1` the wishlist or the store could not be read, or the files could not be
written (the files already there are left as they were); `2` usage error.

## Volumes

| Path | Description |
|------|-------------|
| `/output` | Generated files: `wishlist.json`, `successful.txt`, `concrete.txt`, `wishlist.ics` |

## Modifications from Upstream

- Containerized with a multi-stage Alpine build (the only runtime dependency, `tzdata`, is pure-Python; no build toolchain)
- Runs as non-root user (UID/GID 10000)
- Working directory is `/`, so the default `--output-dir output` lands in the `/output` volume
