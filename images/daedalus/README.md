# daedalus

SSH dev container with Claude Code, The Companion web UI, and common dev tools baked in.

## Upstream

- **The Companion:** [The-Vibe-Company/companion](https://github.com/The-Vibe-Company/companion) — Web UI for managing Claude Code sessions
- **Claude Code:** [@anthropic-ai/claude-code](https://www.npmjs.com/package/@anthropic-ai/claude-code)

## Why Build From Source?

Replaces the LinuxServer.io openssh-server image + runtime package installs with a purpose-built image that:

- Bakes all dev tools into the image (no slow `apk add` on every restart)
- Drops s6-overlay in favor of a simple entrypoint script
- Includes The Companion web UI for browser-based Claude Code sessions
- Runs sshd + companion in a single container

## Included Tools

| Tool | Source |
|------|--------|
| Claude Code | npm (global install) |
| The Companion | Built from source (vite + bun server) |
| Go | Official golang Alpine image |
| Node.js + npm | Alpine packages |
| Bun | Official oven/bun image |
| kubectl | Static binary from dl.k8s.io |
| Helm | Static binary from get.helm.sh |
| git, make, jq, curl | Alpine packages |

## Configuration

| Environment Variable | Description | Default |
|---------------------|-------------|---------|
| `ANTHROPIC_API_KEY` | API key for Claude Code | Required |
| `TZ` | Timezone | UTC |
| `HOME` | Home directory | `/home/abc` |

## Ports

- `2222` — SSH server (pubkey auth only, no password)
- `3456` — The Companion web UI

## Volumes

| Path | Description |
|------|-------------|
| `/home/abc` | User home directory (SSH keys, config, projects) |
| `/init.d/setup.sh` | Optional init script run at startup |

## User

- **Username:** `abc`
- **UID/GID:** 1000:1000 (for PVC backward compatibility with existing data)
- **Shell:** `/bin/bash`
- **Sudo:** passwordless

## Modifications From Upstream

This is not a direct rebuild of any single upstream project. It combines:

1. **Alpine + openssh-server** as the base (replacing LinuxServer.io s6-overlay)
2. **The Companion** web UI built from source and served by bun
3. **Claude Code** installed globally via npm
4. **Dev tools** (Go, kubectl, helm) from official sources

### SSH Configuration

- Port 2222 (non-privileged)
- `StrictModes no` — required for Longhorn volumes (setgid bit)
- Password auth disabled, pubkey only
- Host keys stored at `/home/abc/.sshd/` (PVC-persisted to avoid host key warnings across rebuilds)
