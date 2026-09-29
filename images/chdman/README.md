# chdman

MAME's `chdman` plus `unzip`, for converting disc images (`.cue`/`.bin`, `.gdi`, `.iso`) to
CHD. Used by the `retro-games` Claude skill, which runs it as a short-lived Kubernetes Job that
mounts the torrent and ROM library NFS exports and converts Redump discs server-side before
RomM imports them.

## Upstream

- **Repository**: [mamedev/mame](https://github.com/mamedev/mame)
- **Version**: mame0289 (built from source, tools only)

## Usage

```bash
docker run --rm -v "$PWD:/data" ghcr.io/sharkusmanch/containers/chdman:latest \
  createcd -i "/data/Game (USA).cue" -o "/data/Game (USA).chd"

# DVD-based systems (PS2 ISOs)
docker run --rm -v "$PWD:/data" ghcr.io/sharkusmanch/containers/chdman:latest \
  createdvd -i "/data/Game (USA).iso" -o "/data/Game (USA).chd"
```

The entrypoint is `chdman`; override it (`--entrypoint sh`) to unzip first. Runs as UID 10000
by default; override the UID when writing into a library owned by another user.

## Modifications from Upstream

- Only `chdman` is built (`TOOLS=1 EMULATOR=0`) and copied into a Debian slim runtime with `unzip`.
- Built from source rather than Debian's `mame-tools` package: Debian 13's chdman 0.276 leaks
  memory in `createdvd` (~14 MB/s, independent of `-np`) and was OOMKilled converting 4.5 GB
  PS2 ISOs.
