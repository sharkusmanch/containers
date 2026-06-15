# loseit-mcp-sse

[loseit-mcp](https://github.com/atfinke/loseit-mcp) MCP server exposed over SSE transport for use in Kubernetes. Wraps the upstream stdio MCP server with [mcp-proxy](https://github.com/sparfenyuk/mcp-proxy).

The upstream server is an unofficial, read-only MCP server that exposes Lose It calorie-tracking and nutrition data (daily calorie summary, weekly history, food log entries) via the reverse-engineered Lose It web GWT-RPC API.

## Upstream

- **Repository**: [atfinke/loseit-mcp](https://github.com/atfinke/loseit-mcp)
- **Version**: pinned to commit `f302e8f` on `main` (Renovate tracks `main`)

The upstream project is `private: true` and not published to npm, so the image is built from the pinned GitHub source.

## Usage

```bash
docker run -p 8080:8080 \
  -e LOSEIT_EMAIL=you@example.com \
  -e LOSEIT_PASSWORD=your-password \
  ghcr.io/sharkusmanch/containers/loseit-mcp-sse:latest
```

The SSE endpoint is served on port `8080`.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LOSEIT_EMAIL` | Yes | Lose It account email |
| `LOSEIT_PASSWORD` | Yes | Lose It account password |
| `LOSEIT_TIMEZONE` | No | IANA timezone for date math (default `America/Chicago`) |
| `LOSEIT_SESSION_PATH` | No | Path to the cached session JSON (default `~/.loseit-mcp/session.json`). Point at a writable mount when running with a read-only root filesystem. |
| `LOSEIT_REQUEST_TIMEOUT_MS` | No | Upstream request timeout (default `15000`) |
| `LOSEIT_GWT_POLICY_HASH` | No | Override for the Lose It web build GWT policy hash (has a hardcoded default; only needed if Lose It ships a new web build) |
| `LOSEIT_GWT_PERMUTATION` | No | Override for the Lose It web build GWT permutation (hardcoded default) |

## Volumes

| Path | Description |
|------|-------------|
| `~/.loseit-mcp/` (or `LOSEIT_SESSION_PATH`'s directory) | Cached authenticated-session JSON. Non-essential — the server re-authenticates if it is missing, so an ephemeral mount is fine. |

## Modifications from Upstream

- Built from the pinned GitHub source (`private: true`, not on npm) so the running code matches a reviewed revision.
- stdio transport wrapped with `mcp-proxy` to expose SSE on `0.0.0.0:8080`.
- Multi-stage build: Node Alpine compiles `dist/` and prunes dev deps; the runtime is a Python Alpine image (for mcp-proxy) with the `nodejs` package added to run the server.
- Runs as non-root (UID/GID 10000).

> **Security note:** This server authenticates to Lose It with a personal username/password and exposes that account's diet/nutrition data to the MCP client. It targets an unofficial, reverse-engineered API that can break without notice. Keep the credentials in a secret store and restrict who can reach the SSE endpoint.
