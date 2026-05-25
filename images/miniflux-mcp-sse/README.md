# miniflux-mcp-sse

Miniflux MCP server with SSE (Server-Sent Events) transport for Kubernetes deployments. Bundles the stdio-based [tssujt/miniflux-mcp](https://github.com/tssujt/miniflux-mcp) Go binary with [sparfenyuk/mcp-proxy](https://github.com/sparfenyuk/mcp-proxy) to expose MCP over HTTP.

## Upstream

- **Repository**: [tssujt/miniflux-mcp](https://github.com/tssujt/miniflux-mcp)
- **Version**: v0.1.0
- **Proxy**: [sparfenyuk/mcp-proxy](https://github.com/sparfenyuk/mcp-proxy) v0.12.0

## Usage

```bash
docker run -d -p 8080:8080 \
  -e MINIFLUX_URL=http://miniflux.local:8080 \
  -e MINIFLUX_API_KEY=your_api_key \
  ghcr.io/sharkusmanch/containers/miniflux-mcp-sse:latest
```

The MCP server will be available at `http://localhost:8080/sse`.

### MCP Client Configuration

```json
{
  "mcpServers": {
    "miniflux": {
      "transport": "sse",
      "url": "http://miniflux-mcp.example.com:8080/sse"
    }
  }
}
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MINIFLUX_URL` | Yes | Miniflux base URL (e.g., `http://miniflux:8080`) |
| `MINIFLUX_API_KEY` | Yes* | API key generated in Miniflux UI under Settings → API Keys |
| `MINIFLUX_USERNAME` | No | Alternative to API key (used with `MINIFLUX_PASSWORD`) |
| `MINIFLUX_PASSWORD` | No | Alternative to API key |

\* API key auth is preferred over username/password.

## Endpoints

| Path | Description |
|------|-------------|
| `/sse` | SSE endpoint for MCP communication |
| `/messages/` | POST endpoint for SSE client messages |
| `/status` | HTTP 200 status/health check |

## Modifications from Upstream

- Bundles [mcp-proxy](https://github.com/sparfenyuk/mcp-proxy) to bridge stdio to SSE
- Multi-stage build (Go builder + Python builder + Alpine runtime)
- Runs as non-root user (UID 10000)
- Exposes port 8080 with SSE transport
