# mcp-proxy

Bridge between stdio and SSE/HTTP MCP (Model Context Protocol) transports. Allows stdio-based MCP servers to be exposed as HTTP endpoints for use with web services and Kubernetes deployments.

## Upstream

- **Repository**: [sparfenyuk/mcp-proxy](https://github.com/sparfenyuk/mcp-proxy)
- **Version**: v0.11.0

## Usage

### Wrap a stdio MCP server as SSE

```bash
docker run --rm -p 8080:8080 \
  ghcr.io/sharkusmanch/mcp-proxy:latest \
  --host 0.0.0.0 --port 8080 \
  your-mcp-command --arg1 value1
```

The server will be available at `http://localhost:8080/sse`.

### Key Arguments

| Argument | Description |
|----------|-------------|
| `--port` | SSE server port (default: 8080) |
| `--host` | Host to bind (use `0.0.0.0` for containers) |
| `-e, --env` | Pass environment variables to wrapped server |
| `--pass-environment` | Pass all environment variables to wrapped server |
| `--allow-origin` | CORS allowed origins (repeatable) |

### Example: Wrap mcp-server-fetch

```bash
docker run --rm -p 8080:8080 \
  ghcr.io/sharkusmanch/mcp-proxy:latest \
  --host 0.0.0.0 --port 8080 \
  -- uvx mcp-server-fetch
```

## Building Derived Images

Use this as a base image to create SSE variants of stdio MCP servers:

```dockerfile
FROM ghcr.io/sharkusmanch/mcp-proxy:latest AS proxy
FROM your-stdio-mcp-server:latest

# Copy mcp-proxy binary
COPY --from=proxy /app/.venv /app/.venv
ENV PATH="/app/.venv/bin:$PATH"

EXPOSE 8080
ENTRYPOINT ["mcp-proxy", "--host", "0.0.0.0", "--port", "8080", "your-mcp-command"]
```

## Modifications from Upstream

- Alpine-based instead of the upstream's Alpine image (same base, different build)
- Built with uv for faster, reproducible installs
- Runs as non-root user (UID 10000)
