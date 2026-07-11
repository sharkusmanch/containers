# paseo

Headless [Paseo](https://github.com/getpaseo/paseo) daemon — orchestrates coding
agents (Claude Code et al.) on cluster hardware, reachable from a phone/laptop/CLI.
Minimal Alpine image with the paseo daemon (node-pty compiled from source for musl),
Claude Code, a Kubernetes/GitOps toolchain (kubectl, helm, flux, kustomize, kubeconform),
image/secrets CLIs (cosign, skopeo, crane, openbao `bao`, sops, age, grype, syft), git, and a
Python/jq/yq toolchain baked in. Single
foreground process (`paseo daemon start --foreground`) under `tini`.

## Upstream

- **Repository**: [getpaseo/paseo](https://github.com/getpaseo/paseo) (`@getpaseo/cli`)
- **Version**: pinned in the Dockerfile (`PASEO_VERSION`); kubectl/helm/cosign/flux/kubeconform/Claude also pinned

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
| `/config` | Home dir. `PASEO_HOME` (`.paseo/`) holds config, agent records, relay keypair, logs. Shared agent auth (`~/.claude`) lives here too. |

## Convention exceptions

- **`nodejs`/`npm` in the runtime image** — paseo is a Node app, and launched agents
  build Node projects at runtime; the toolchain is the product.
- **`coreutils` installed** — the `paseo` launcher shebang uses `env -S`, unsupported by
  busybox `env`.
- **node-pty compiled from source** at build time (bundled prebuilds are glibc; this is
  a musl/Alpine image).
- **`tini` as PID 1** — paseo spawns agent CLIs (claude) via node-pty; tini reaps the
  grandchild processes so they don't accumulate as zombies under the daemon.
- **amd64 only** (see `.platforms`) — the target cluster is amd64.
