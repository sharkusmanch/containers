# paseo

Headless [Paseo](https://github.com/getpaseo/paseo) daemon — orchestrates coding
agents (Claude Code et al.) on cluster hardware, reachable from a phone/laptop/CLI.
Minimal Alpine image with the paseo daemon (node-pty compiled from source for musl),
Claude Code, the Codex CLI, Muse Code, a Kubernetes/GitOps toolchain (kubectl, helm, flux, kustomize, kubeconform),
image/secrets CLIs (cosign, skopeo, crane, openbao `bao`, sops, age, grype, syft), adb, git, and a
Python/jq/yq toolchain baked in. Single
foreground process (`paseo daemon start --foreground`) under `tini`.

## Upstream

- **Repository**: [getpaseo/paseo](https://github.com/getpaseo/paseo) (`@getpaseo/cli`)
- **Version**: pinned in the Dockerfile (`PASEO_VERSION`); kubectl/helm/cosign/flux/kubeconform/Claude/Codex/Muse also pinned

## Usage

```bash
docker run -d \
  -p 6767:6767 \
  -e PASEO_LISTEN=0.0.0.0:6767 \
  -e PASEO_PASSWORD=changeme \
  -v /path/to/config:/config \
  ghcr.io/sharkusmanch/containers/paseo:latest
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PASEO_LISTEN` | No | Listen address (default `127.0.0.1:6767`; set `0.0.0.0:6767` to expose) |
| `PASEO_PASSWORD` | No | Require a password for all clients (the `/api/health` endpoint stays exempt) |
| `PASEO_HOME` | No | Daemon state dir (default `$HOME/.paseo`) |
| `TZ` | No | Timezone |

## Volumes

| Path | Description |
|------|-------------|
| `/config` | Home dir. `PASEO_HOME` (`.paseo/`) holds config, agent records, relay keypair, logs. Shared agent auth (`~/.claude`, `~/.codex`, `~/.config/muse`) lives here too. |

## Convention exceptions

- **`nodejs`/`npm` in the runtime image** — paseo is a Node app, and launched agents
  build Node projects at runtime; the toolchain is the product.
- **`coreutils` installed** — the `paseo` launcher shebang uses `env -S`, unsupported by
  busybox `env`.
- **node-pty compiled from source** at build time (bundled prebuilds are glibc; this is
  a musl/Alpine image).
- **`tini` as PID 1** — paseo spawns agent CLIs (claude) via node-pty; tini reaps the
  grandchild processes so they don't accumulate as zombies under the daemon.
- **Codex needs Full Access mode** — the Codex CLI is OpenAI's standalone musl package
  in `/opt/codex`. Its `workspace-write`/`read-only` sandboxes use bubblewrap, which
  needs user namespaces, and the default container seccomp profile denies those. So
  under paseo's Default Permissions and Auto-review modes (`workspace-write`), shell
  commands fail here; use Full Access (`danger-full-access`).
- **Muse Code is the bare binary** — paseo's built-in Muse Code provider runs
  `muse serve` from `/usr/local/bin/muse`: Meta's static binary at the pinned
  `MUSE_VERSION`, checked against the release manifest's checksum. Meta's installer only
  lays down a launcher that updates itself hourly, so it isn't used, and the binary has
  no updater of its own. Renovate reads Meta's release channel through the
  `custom.muse-code` datasource in `renovate.json`. The provider passes
  `--disable-sandbox` unless an agent's provider options turn Muse's sandbox on; leave
  it off, since that sandbox is bubblewrap-based and needs the same user namespaces Codex
  lacks here. Contributor mode is forced off with `MUSE_CONTRIBUTOR_MODE=0` in the
  image's `ENV`, and telemetry with `telemetry.enabled: false` in the shared
  `~/.config/muse/settings.json`.
- **No runtime patches** — `/opt/paseo-patches` (a `NODE_OPTIONS` preload holding
  `deflate.cjs` and `lease-hook.mjs`) was removed on 2026-09-22 with paseo 0.9.1. The
  lease patch is obsolete: 0.9.x pings every 10s, so the unchanged 45s lease has a 4.5x
  cushion rather than the 1.8x that iOS timer throttling used to trip. permessage-deflate
  is still off upstream, so if mobile clients start stalling and reconnecting (code 1006)
  on large `session_message` frames, restoring `deflate.cjs` from git history is the fix.
- **amd64 only** (see `.platforms`) — the target cluster is amd64.
