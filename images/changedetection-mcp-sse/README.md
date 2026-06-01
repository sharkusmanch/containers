# changedetection-mcp-sse

[ChangeDetection.io](https://github.com/dgtlmoon/changedetection.io) MCP server exposed over SSE transport for use in Kubernetes. Wraps the upstream stdio MCP server with [mcp-proxy](https://github.com/sparfenyuk/mcp-proxy).

## Upstream

- **Repository**: [rusty4444/changedetection-mcp](https://github.com/rusty4444/changedetection-mcp)
- **Version**: pinned to commit `f708f378` on `main` (Renovate tracks `main`)

## Usage

```bash
docker run -p 8080:8080 \
  -e CHANGEDETECTION_BASE_URL=http://changedetection:5000 \
  -e CHANGEDETECTION_API_KEY=your-api-key \
  ghcr.io/sharkusmanch/containers/changedetection-mcp-sse:latest
```

The SSE endpoint is served on port `8080`.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CHANGEDETECTION_BASE_URL` | Yes | Base URL of the ChangeDetection.io instance |
| `CHANGEDETECTION_API_KEY` | Yes | ChangeDetection.io API key (Settings → API) |
| `CHANGEDETECTION_MCP_ACTION_LIMIT_PER_WATCH` | No | Mutating actions allowed per watch after each `get_snapshot_diff` (default `3`, `0` disables) |

## Modifications from Upstream

- Built from the pinned GitHub source (not the PyPI artifact) so the running code matches a reviewed revision.
- stdio transport wrapped with `mcp-proxy` to expose SSE on `0.0.0.0:8080`.
- Runs as non-root (UID/GID 10000) in a multi-stage Alpine image.

> **Security note:** This exposes the full ChangeDetection.io tool surface to the MCP client, including `update_watch` (can repoint a watch at an arbitrary URL the backend then fetches) and `delete_watch` (permanent). Diff output returned to the agent is untrusted third-party web content. Restrict the ChangeDetection.io backend's egress and treat destructive tools accordingly.
