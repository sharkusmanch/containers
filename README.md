# docker-images

Self-built Docker images from source. Trust but verify.

## Why?

Instead of blindly trusting Docker Hub images, this repo builds images directly from upstream source code. Every build is:

- **Auditable** - You can inspect the Dockerfile and see exactly what's included
- **Reproducible** - Pinned versions and build args tracked in git
- **Secure** - Follows security best practices (see below)
- **Current** - Renovate auto-merges upstream updates

## Images

| Image | Description | Upstream |
|-------|-------------|----------|
| [actual-mcp](./images/actual-mcp/) | MCP server for Actual Budget | [s-stefanov/actual-mcp](https://github.com/s-stefanov/actual-mcp) |
| [autoshift](./images/autoshift/) | Automatic SHiFT code redemption for Borderlands | [Fabbi/autoshift](https://github.com/Fabbi/autoshift) |
| [envsubst](./images/envsubst/) | Environment variable substitution with defaults | [a8m/envsubst](https://github.com/a8m/envsubst) |
| [flareproxy](./images/flareproxy/) | HTTP proxy adapter for FlareSolverr | [mimnix/FlareProxy](https://github.com/mimnix/FlareProxy) |
| [hass-mcp](./images/hass-mcp/) | Home Assistant MCP server for Claude/LLMs (stdio) | [voska/hass-mcp](https://github.com/voska/hass-mcp) |
| [hass-mcp-sse](./images/hass-mcp-sse/) | Home Assistant MCP server with SSE transport (k8s) | [voska/hass-mcp](https://github.com/voska/hass-mcp) |
| [lgogdownloader](./images/lgogdownloader/) | Unofficial GOG.com downloader | [Sude-/lgogdownloader](https://github.com/Sude-/lgogdownloader) |
| [mcp-proxy](./images/mcp-proxy/) | Bridge stdio MCP servers to SSE/HTTP transport | [sparfenyuk/mcp-proxy](https://github.com/sparfenyuk/mcp-proxy) |
| [redlib](./images/redlib/) | Private Reddit frontend | [redlib-org/redlib](https://github.com/redlib-org/redlib) (PR #509) |
| [tailscale-hosts-sync](./images/tailscale-hosts-sync/) | Sync Tailscale devices to hosts file for DNS | Original |

## Security Practices

All images follow these security standards:

### Build-time

- **Multi-stage builds** - Build dependencies don't ship to runtime
- **Pinned base images** - Versions tracked, updated via Renovate
- **Minimal final images** - Alpine or distroless where possible
- **No secrets in layers** - Build args for config, not credentials

### Runtime

- **Non-root user** - Explicit UID/GID (10000:10000)
- **No shell where possible** - Reduces attack surface
- **Health checks** - Built-in liveness probes
- **OCI labels** - Source repo, commit SHA, build date (see below)

### Deployment (for your k8s manifests)

Recommended security context:

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 10000
  runAsGroup: 10000
  readOnlyRootFilesystem: true
  allowPrivilegeEscalation: false
  capabilities:
    drop:
      - ALL
```

## OCI Labels

All images include [OCI standard labels](https://github.com/opencontainers/image-spec/blob/main/annotations.md) for traceability. These are recognized by container registries (GHCR, Docker Hub, Quay), security scanners, and tooling.

| Label | Purpose |
|-------|---------|
| `org.opencontainers.image.created` | Build timestamp |
| `org.opencontainers.image.revision` | Git commit SHA of this repo |
| `org.opencontainers.image.version` | Upstream version or commit |
| `org.opencontainers.image.source` | URL to this repo |
| `org.opencontainers.image.upstream` | URL to upstream source |
| `org.opencontainers.image.title` | Image name |
| `org.opencontainers.image.description` | Short description |

Inspect labels with:

```bash
docker inspect ghcr.io/sharkusmanch/docker-images/redlib:latest \
  --format '{{json .Config.Labels}}' | jq
```

## Versioning Strategy

**This repo:**
- Renovate auto-merges base image updates and upstream version bumps
- Images pushed to `ghcr.io/sharkusmanch/docker-images/<name>:<tag>`
- Tags mirror upstream versions where possible, or use commit SHA for unmerged PRs

**Your deployment:**
- Pin to specific tags in your k8s manifests
- Use a separate Renovate config to control rollout

## Adding a New Image

1. Create `images/<name>/Dockerfile`
2. Create `images/<name>/README.md` documenting upstream source and any modifications
3. Add Renovate comments for version tracking
4. Submit PR - workflow will build and push on merge

## Local Building

```bash
# Build a specific image
docker build -t myimage images/actual-mcp/

# Build with specific version
docker build --build-arg VERSION=v1.2.3 -t myimage images/actual-mcp/
```
