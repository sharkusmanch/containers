# vikunja-mcp-sse

[Vikunja](https://vikunja.io) task-manager MCP server, wrapped with
[mcp-proxy](https://github.com/sparfenyuk/mcp-proxy) to expose its stdio
transport as SSE for Kubernetes.

The upstream `vikunja-mcp` server speaks **stdio only**; `mcp-proxy` bridges it
to SSE on `:8080` (`/sse`, POST `/messages/`, health `/status`) so it can run as
a long-lived networked service.

## Upstream

- **Repository**: [democratize-technology/vikunja-mcp](https://github.com/democratize-technology/vikunja-mcp)
- **Version**: v0.2.0
- **Proxy**: [sparfenyuk/mcp-proxy](https://github.com/sparfenyuk/mcp-proxy) v0.12.0

## Usage

```bash
docker run -p 8080:8080 \
  -e VIKUNJA_URL=https://vikunja.example.com/api/v1 \
  -e VIKUNJA_API_TOKEN=tk_xxxxxxxx \
  ghcr.io/sharkusmanch/containers/vikunja-mcp-sse:v0.2.0
```

Connect an MCP client to `http://<host>:8080/sse`.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `VIKUNJA_URL` | Yes | Vikunja REST API base URL, **including the `/api/v1` suffix** (e.g. `https://vikunja.example.com/api/v1`). |
| `VIKUNJA_API_TOKEN` | Yes | Vikunja API token (`tk_…`, created in the Vikunja UI → Settings → API Tokens). Covers tasks/projects/labels/teams/webhooks/filters; user-profile and export tools require a JWT and are unavailable with an API token. |

Both are forwarded to the stdio subprocess via `mcp-proxy --pass-environment`.

## Modifications from Upstream

- Built from the upstream git tag (`npm ci && npm run build`), dev deps pruned.
- Wrapped with `mcp-proxy` for SSE transport (upstream ships stdio only).
- Runs as non-root UID/GID 10000.
