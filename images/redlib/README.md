# redlib

Private front-end for Reddit. No JavaScript, no ads, no tracking.

## Upstream

- **Repository**: [redlib-org/redlib](https://github.com/redlib-org/redlib)
- **Version**: v0.40.0 + [PR #603](https://github.com/redlib-org/redlib/pull/603)
  (GraphQL comments), built from `fxmfxmfx/redlib@6cd8366`. Pinned by hand, not by Renovate.

## Why PR #603? (temporary)

Since 2026-10-20 Reddit answers the comments JSON endpoints with `403` for logged-out
tokens, on every redlib instance. So with the v0.40.0 release, listings and RSS work but
every post page fails with "Failed to parse page JSON data". PR #603 fetches the post from
`/by_id` and its comments through the Android app's persisted GraphQL operation
(`PostComments` on `gql-fed.reddit.com`) with the same anonymous token: one request per
page, up to 200 comments at 10 levels, with "More comments" / "More replies" links for the
rest. It is two commits on top of upstream main `ba116c1` (v0.40.0 plus a CI change) and
adds no dependencies.

The commit is pinned without a renovate comment on purpose. This repo automerges every
update, and new commits on a third-party fork branch should be reviewed first.

**Revert** to the upstream release binary (the Dockerfile at `342913f`) once an upstream
release loads comment threads.

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
docker run -p 8080:8080 ghcr.io/sharkusmanch/containers/redlib:v0.40.0-gql.6cd8366
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

- Source is upstream v0.40.0 plus PR #603, built with upstream's own `Dockerfile.alpine`
  builder (`rust-musl-cross`, static musl)
- Current Alpine runtime (upstream's image is on Alpine 3.19) with only `ca-certificates`
- Non-root user `10000:10000` with a numeric UID (upstream uses a named user)
- `linux/amd64` only (see `.platforms`)

## Egress

v0.40.0 resolves `www.reddit.com` through `dualstack.reddit.map.fastly.net`,
keeping `www.reddit.com` as the TLS SNI and Host. FQDN egress allowlists need that
name as well as the Reddit hosts. PR #603 also calls `gql-fed.reddit.com` (resolved
directly, no alias).

## Known Issues

- **Comment threads depend on Reddit's GraphQL API** (PR #603). The persisted operation
  hash comes from the Android app; Reddit can retire it or refuse it to anonymous tokens,
  as it did with the comments JSON endpoints on 2026-10-20.
- Reddit may still rate-limit or block by IP, traffic pattern or fingerprint. This
  is an ongoing cat-and-mouse game.
