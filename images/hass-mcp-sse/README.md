# hass-mcp-sse

Home Assistant MCP server with SSE (Server-Sent Events) transport. This is the Kubernetes-deployable variant of [hass-mcp](../hass-mcp/), exposing the MCP server over HTTP instead of stdio.

## Upstream

- **Repository**: [voska/hass-mcp](https://github.com/voska/hass-mcp)
- **Version**: v0.1.1
- **Proxy**: [sparfenyuk/mcp-proxy](https://github.com/sparfenyuk/mcp-proxy) v0.11.0

## Usage

```bash
docker run -d -p 8080:8080 \
  -e HA_URL=http://homeassistant.local:8123 \
  -e HA_TOKEN=your_long_lived_access_token \
  ghcr.io/sharkusmanch/hass-mcp-sse:latest
```

The MCP server will be available at `http://localhost:8080/sse`.

### Kubernetes Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hass-mcp
spec:
  replicas: 1
  selector:
    matchLabels:
      app: hass-mcp
  template:
    metadata:
      labels:
        app: hass-mcp
    spec:
      containers:
      - name: hass-mcp
        image: ghcr.io/sharkusmanch/hass-mcp-sse:latest
        ports:
        - containerPort: 8080
        env:
        - name: HA_URL
          value: "http://home-assistant.home.svc.cluster.local:8123"
        - name: HA_TOKEN
          valueFrom:
            secretKeyRef:
              name: hass-mcp-secret
              key: token
---
apiVersion: v1
kind: Service
metadata:
  name: hass-mcp
spec:
  selector:
    app: hass-mcp
  ports:
  - port: 8080
    targetPort: 8080
```

### MCP Client Configuration

For MCP clients that support SSE transport:

```json
{
  "mcpServers": {
    "hass-mcp": {
      "transport": "sse",
      "url": "http://hass-mcp.example.com:8080/sse"
    }
  }
}
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `HA_URL` | Yes | Home Assistant URL (e.g., `http://homeassistant.local:8123`) |
| `HA_TOKEN` | Yes | Long-lived access token from Home Assistant |

## Endpoints

| Path | Description |
|------|-------------|
| `/sse` | SSE endpoint for MCP communication |

## Differences from hass-mcp

| Feature | hass-mcp | hass-mcp-sse |
|---------|----------|--------------|
| Transport | stdio | SSE (HTTP) |
| Use case | Claude Desktop, local CLI | Kubernetes, web services |
| Port | N/A | 8080 |
| Run mode | `docker run -i --rm` | `docker run -d -p 8080:8080` |

## Modifications from Upstream

- Bundles [mcp-proxy](https://github.com/sparfenyuk/mcp-proxy) to bridge stdio to SSE
- Multi-stage build for smaller image size
- Alpine-based instead of Debian
- Runs as non-root user (UID 10000)
- Exposes port 8080 with SSE transport
