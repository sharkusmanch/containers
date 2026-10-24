# redlib

Private front-end for Reddit. No JavaScript, no ads, no tracking.

## Upstream

- **Repository**: [redlib-org/redlib](https://github.com/redlib-org/redlib)
- **Version**: v0.40.0 (official release binary, tracked by Renovate)

## Why not the hyper-tls fork any more?

Until v0.40.0 this image built [PR #509](https://github.com/redlib-org/redlib/pull/509)
(chowder/redlib `feature/tls-openssl`), which swapped `hyper-rustls` for `hyper-tls`
because Reddit fingerprints and blocks the TLS stacks redlib uses
([#446](https://github.com/redlib-org/redlib/issues/446)).

From 2026-10-20 Reddit blocked that build too. Every listing request got
`403 Forbidden` (the HTML "blocked by network security" page). Requests from curl
on the same IP still got `200`, with redlib's exact headers, path and token, over
HTTP/1.1 without ALPN as hyper-tls sends them. So the TLS fingerprint was the
remaining difference. Upstream v0.40.0 replaced the HTTP client with
[wreq](https://github.com/0x676e67/wreq), which emulates a real browser's TLS
fingerprint, and its listings work from the same IP. The fork was last updated in
December 2025.

## Usage

```bash
docker run -p 8080:8080 ghcr.io/sharkusmanch/containers/redlib:v0.40.0
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `REDLIB_DEFAULT_THEME` | No | Default theme (system/light/dark) |
| `REDLIB_DEFAULT_FRONT_PAGE` | No | Default front page (default/popular/all) |
| `REDLIB_DEFAULT_LAYOUT` | No | Layout (card/clean/compact) |
| `REDLIB_DEFAULT_WIDE` | No | Wide mode (`on`/`off`) |
| `REDLIB_DEFAULT_SHOW_NSFW` | No | Show NSFW content |
| `REDLIB_DEFAULT_BLUR_NSFW` | No | Blur NSFW content |
| `REDLIB_DEFAULT_USE_HLS` | No | Use HLS for video |
| `REDLIB_DEFAULT_HIDE_HLS_NOTIFICATION` | No | Hide HLS notification |
| `REDLIB_DEFAULT_AUTOPLAY_VIDEOS` | No | Autoplay videos |
| `REDLIB_ENABLE_RSS` | No | Serve RSS feeds (`on`/`off`) |
| `REDLIB_SFW_ONLY` | No | SFW only mode (hides NSFW entirely) |
| `REDLIB_BANNER` | No | Custom banner message |
| `REDLIB_ROBOTS_DISABLE_INDEXING` | No | Disable search engine indexing |

Listens on port `8080`.

## Modifications from Upstream

- Same release binary upstream's own image ships, verified against a pinned SHA256
- Current Alpine runtime (upstream's image is on Alpine 3.19) with only `ca-certificates`
- Non-root user `10000:10000` with a numeric UID (upstream uses a named user)
- `linux/amd64` only (see `.platforms`), since the checksum pin covers one asset

## Egress

v0.40.0 resolves `www.reddit.com` through `dualstack.reddit.map.fastly.net`,
keeping `www.reddit.com` as the TLS SNI and Host. FQDN egress allowlists need that
name as well as the Reddit hosts.

## Known Issues

- **Comment threads fail with 403 on every redlib instance** (since 2026-10-20).
  Reddit's edge now refuses the comments endpoints for logged-out tokens, so this
  is a Reddit policy change, not fingerprinting. Upstream's `%2f` path-encoding
  workaround in v0.40.0 was blocked again within a day. Fixes are in progress
  upstream (GraphQL in #603, shreddit HTML in #599).
- Reddit may still rate-limit or block by IP, traffic pattern or fingerprint. This
  is an ongoing cat-and-mouse game.
