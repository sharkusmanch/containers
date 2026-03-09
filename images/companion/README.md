# companion

Web UI for managing Claude Code sessions — run multiple agents, inspect tool calls, and gate risky actions from a browser.

## Upstream

- **Repository**: [The-Vibe-Company/companion](https://github.com/The-Vibe-Company/companion)
- **Version**: 0.72.0

## Usage

```bash
docker run -p 3456:3456 ghcr.io/sharkusmanch/containers/companion:0.72.0
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `COMPANION_AUTH_TOKEN` | No | Auth token (auto-generated if not set) |
| `HOME` | No | Override home directory for `.companion/` state |

## Volumes

| Path | Description |
|------|-------------|
| `/home/appuser/.companion` | Auth tokens and session state |

## Modifications from Upstream

- Alpine + Bun instead of Ubuntu (upstream image is ~900MB, this is ~200MB)
- Runs as non-root user (UID 10000)
- Multi-stage build — only ships node_modules, not build tooling
