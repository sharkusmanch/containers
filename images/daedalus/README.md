# daedalus

Minimal self-owned SSH dev box: a single-process `sshd` on Alpine with a baked
development toolchain (kubectl, helm, flux, kustomize, kubeconform, cosign, skopeo, crane,
openbao `bao`, sops, age, grype, syft, Claude Code, Codex CLI, Muse Code, Go, Node, Python, git, tmux, uv, jq, yq, adb).
Used as a remote/mobile admin entry point into a Kubernetes cluster, exposed
over Tailscale. Replaces a previous LinuxServer.io `openssh-server`-based image
whose runtime package install (before sshd started) caused startup crashloops.

## Upstream

- **Repository**: [OpenSSH](https://www.openssh.com/) (Alpine `openssh-server`)
- **Version**: tracks the Alpine base (currently 3.24); kubectl/helm/cosign/flux/kubeconform/Claude/Codex/Muse pinned (see Dockerfile)

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
| `/config` | Persistent home for user `abc` — SSH keys/host keys, gitconfig, Claude/Codex/Muse state, repos, MCP servers. Must persist across restarts. |

## Modifications from Upstream

- **Single process**: `sshd` is the entrypoint (no s6/init system). A small
  `entrypoint.sh` does fast config-only setup (host keys, `authorized_keys`
  fetch, gitconfig, MCP venv) then `exec`s `sshd -D`.
- **Baked toolchain**: kubectl, helm, cosign, flux, and kubeconform are installed at
  pinned versions at build time (not at runtime); openbao (`bao`), skopeo, crane, kustomize,
  sops, age, grype, syft, plus Go/Node/Python/git/tmux/uv/jq/yq from Alpine.
- **Codex CLI** is OpenAI's standalone musl package in `/opt/codex` (symlinked onto
  PATH). Its `workspace-write`/`read-only` sandboxes use bubblewrap, which needs user
  namespaces, and the default container seccomp profile denies those, so sandboxed
  commands fail here. Run it with `--sandbox danger-full-access`, or set `sandbox_mode`
  to that in `~/.codex/config.toml`.
- **Muse Code** (Meta's `muse`) is the bare static binary from Meta's release channel at
  `/usr/local/bin/muse`, pinned by `MUSE_VERSION` and checked against that release's
  manifest checksum. Meta's installer only lays down a launcher that updates itself
  hourly, so it isn't used; the binary has no updater of its own. Renovate reads the
  channel through the `custom.muse-code` datasource in `renovate.json`.
  `MUSE_CONTRIBUTOR_MODE=0` (sshd `SetEnv` + profile.d) keeps contributor mode, where
  Meta may train on session content, off for every run. Telemetry has no env switch: it
  is off through `telemetry.enabled: false` in the shared `~/.config/muse/settings.json`.
  Sign in once with `muse login` (or set `META_API_KEY`); the login in
  `~/.config/muse/auth.json` is shared with paseo through `/config`. Muse's Linux sandbox
  is bubblewrap-based, which needs the same user namespaces Codex lacks here, so run
  `muse --disable-sandbox` if sandboxed commands fail.
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
