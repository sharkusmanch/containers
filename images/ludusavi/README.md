# ludusavi

[Ludusavi](https://github.com/mtkennerly/ludusavi), the game-save backup tool, packaged for
headless CLI use such as a scheduled `ludusavi backup` in a Kubernetes CronJob.

## Upstream

- **Repository**: [mtkennerly/ludusavi](https://github.com/mtkennerly/ludusavi)
- **Version**: v0.31.0

## Usage

```bash
docker run --rm \
  -v ./config:/config -v ./saves:/saves -v ./backup:/backup \
  ghcr.io/sharkusmanch/ludusavi:v0.31.0 \
  --config /config backup --force < /dev/null
```

Close stdin (`< /dev/null`): when stdin is not a terminal the CLI waits to read game names
from it.

`--config` names a directory holding `config.yaml`. Ludusavi also writes its cache and
downloaded manifests there, so it must be writable.

## Volumes

| Path | Description |
|------|-------------|
| config directory (any path, passed with `--config`) | `config.yaml`, plus Ludusavi's cache and downloaded manifests |

Save and backup locations are whatever `config.yaml` points at.

## Modifications from Upstream

- Upstream publishes no container image. This wraps the official Linux release binary
  (checksum-pinned) in Debian slim with GTK 3, which the binary links even in CLI mode.
- Adds `python3` for post-processing the CLI's `--api` JSON output.
- amd64 only: upstream ships no arm64 Linux binary.
- Runs as UID 10000; no GUI or display server is included.
