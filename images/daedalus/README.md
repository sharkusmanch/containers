# daedalus

Minimal self-owned SSH dev box: a single-process `sshd` on Alpine with a baked
development toolchain (kubectl, helm, Claude Code, Go, Node, Python, git, tmux,
uv, jq, yq). Used as a remote/mobile admin entry point into a Kubernetes cluster, exposed
over Tailscale. Replaces a previous LinuxServer.io `openssh-server`-based image
whose runtime package install (before sshd started) caused startup crashloops.

## Upstream

- **Repository**: [OpenSSH](https://www.openssh.com/) (Alpine `openssh-server`)
- **Version**: tracks the Alpine base (currently 3.23); kubectl/helm/Claude pinned (see Dockerfile)

## Usage

```bash
docker run -d \
  -p 2222:2222 \
  -v /path/to/config:/config \
  ghcr.io/sharkusmanch/containers/daedalus:latest
```

SSH in with a key listed at `https://github.com/sharkusmanch.keys`:

```bash
ssh -p 2222 abc@<host>
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TZ` | No | Timezone (e.g. `America/Los_Angeles`) |

## Volumes

| Path | Description |
|------|-------------|
| `/config` | Persistent home for user `abc` — SSH keys/host keys, gitconfig, Claude state, repos, MCP servers. Must persist across restarts. |

## Modifications from Upstream

- **Single process**: `sshd` is the entrypoint (no s6/init system). A small
  `entrypoint.sh` does fast config-only setup (host keys, `authorized_keys`
  fetch, gitconfig, MCP venv) then `exec`s `sshd -D`.
- **Baked toolchain**: kubectl, helm, and Claude Code are installed at pinned
  versions at build time (not at runtime); Go/Node/Python/git/tmux/uv/jq/yq from Alpine.
- **Host keys persist** under `/config/ssh_host_keys` to avoid client
  "host key changed" warnings across container recreates.

## Convention exceptions

This image intentionally deviates from this repo's defaults:

- **Runs `sshd` as root** (not UID 10000). OpenSSH needs root for privilege
  separation; the entrypoint drops to the unprivileged `abc` user (`su-exec`)
  for all user-scoped steps. (Truly-rootless sshd is impractical on OpenSSH 10.x.)
- **Build tools ship in the runtime image** (`go`, `make`, …) — this is a
  development box, so the toolchain is the product, not just a build dependency.
- **amd64 only** (see `.platforms`) — the target cluster is amd64.
