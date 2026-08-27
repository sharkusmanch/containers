# bookorbit-mcp-sse

[bookorbit-mcp](https://github.com/joshstrange/bookorbit-mcp) MCP server exposed over SSE transport for use in Kubernetes. Wraps the upstream stdio MCP server with [mcp-proxy](https://github.com/sparfenyuk/mcp-proxy).

The upstream server is read-only and **navigation-first**: instead of dumping a whole book into the model's context, it exposes a book's chapter list, bounded/paginated chapter text, and in-book keyword search, plus read-only library browsing (series, authors, collections, smart scopes), reading state, statistics and the user's own highlights/notes. Text extraction is EPUB-only.

## Upstream

- **Repository**: [joshstrange/bookorbit-mcp](https://github.com/joshstrange/bookorbit-mcp)
- **Version**: pinned to commit `1fc55ab` on `main` (Renovate tracks `main`)

Upstream publishes no releases, no tags and no npm package, so the image is built from the pinned GitHub source. `npm audit fix` runs after `npm ci` to patch transitive advisories in the MCP SDK's (unused) HTTP-transport dependencies.

## Usage

```bash
docker run -p 8080:8080 \
  -e BOOKORBIT_URL=https://bookorbit.example.com \
  -e BOOKORBIT_USERNAME=you \
  -e BOOKORBIT_PASSWORD=your-password \
  -v bookorbit-cache:/cache \
  ghcr.io/sharkusmanch/containers/bookorbit-mcp-sse:latest
```

The SSE endpoint is served on port `8080`.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BOOKORBIT_URL` | Yes | BookOrbit base URL (trailing slash ok) |
| `BOOKORBIT_USERNAME` | Yes* | BookOrbit username — enables automatic token refresh |
| `BOOKORBIT_PASSWORD` | Yes* | BookOrbit password |
| `BOOKORBIT_TOKEN` | No | Static Bearer token; expires in ~15 min and does **not** auto-refresh (dev only) |
| `CACHE_DIR` | No | Extracted-text cache location (default `/cache` in this image) |

\* Either username+password (recommended) or a static `BOOKORBIT_TOKEN`. BookOrbit issues ~15-minute JWTs and has no long-lived API key, so the server logs in and refreshes on its own.

## Notes

- **Cache**: extracted chapter text is written to `/cache/<bookId>/` (~1.1 MB per full-length novel). It is regenerable — losing it only costs a re-fetch from the BookOrbit reader API on the next read.
- **Single replica**: mcp-proxy holds SSE session state in memory. `GET /sse` establishes the session and every follow-up `POST /messages?session_id=…` must reach the same process, so run exactly one replica.
- **Non-root**: runs as uid/gid `10000`.
- **Read-only**: the upstream tool surface makes no write calls to BookOrbit — only `POST /auth/login` and `POST /auth/refresh`.
