# hass-mcp

Home Assistant MCP (Model Context Protocol) server for Claude and other LLMs. Enables AI assistants to query and control your smart home.

## Upstream

- **Repository**: [voska/hass-mcp](https://github.com/voska/hass-mcp)
- **Version**: v0.1.1

## Usage

This is an MCP server designed to run with Claude Desktop, Claude Code, or other MCP clients via stdio transport.

```bash
docker run --rm -i \
  -e HA_URL=http://homeassistant.local:8123 \
  -e HA_TOKEN=your_long_lived_access_token \
  ghcr.io/sharkusmanch/hass-mcp:latest
```

### Claude Code Configuration

Add to your MCP settings:

```json
{
  "mcpServers": {
    "hass-mcp": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "-e", "HA_URL=http://homeassistant.local:8123",
        "-e", "HA_TOKEN=your_token",
        "ghcr.io/sharkusmanch/hass-mcp:latest"
      ]
    }
  }
}
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `HA_URL` | Yes | Home Assistant URL (e.g., `http://homeassistant.local:8123`) |
| `HA_TOKEN` | Yes | Long-lived access token from Home Assistant |

## Modifications from Upstream

- Multi-stage build for smaller image size
- Alpine-based instead of Debian (bookworm)
- Runs as non-root user (UID 10000)
- Uses `hass-mcp` CLI entry point instead of `python -m app`
