# lgogdownloader

Unofficial GOG.com downloader for Linux. Download your GOG game library from the command line.

## Upstream

- **Repository:** [Sude-/lgogdownloader](https://github.com/Sude-/lgogdownloader)
- **Tracking:** GitHub releases via Renovate

## Why Build From Source?

The upstream repo doesn't provide official Docker images. We build our own to:

1. Provide a containerized version of the tool
2. Apply consistent security practices across all images
3. Use an up-to-date Alpine base image
4. Ensure non-root execution and minimal attack surface

## Modifications

None - this is a vanilla build of the upstream source with security hardening.

## Volumes

| Path | Description |
|------|-------------|
| `/home/appuser/.config/lgogdownloader` | Configuration and authentication cookies |
| `/games` | Downloaded game files |

## Usage

LGOGDownloader is a CLI tool. Use it interactively or pass commands directly.

### Initial Login

First, authenticate with your GOG.com account:

```bash
docker run -it --rm \
  -v lgog-config:/home/appuser/.config/lgogdownloader \
  ghcr.io/sharkusmanch/docker-images/lgogdownloader:latest \
  --login
```

### List Your Games

```bash
docker run --rm \
  -v lgog-config:/home/appuser/.config/lgogdownloader \
  ghcr.io/sharkusmanch/docker-images/lgogdownloader:latest \
  --list
```

### Download Games

```bash
docker run --rm \
  -v lgog-config:/home/appuser/.config/lgogdownloader \
  -v /path/to/games:/games \
  ghcr.io/sharkusmanch/docker-images/lgogdownloader:latest \
  --download --game "game_name" --directory /games
```

### Docker Compose Example

```yaml
services:
  lgogdownloader:
    image: ghcr.io/sharkusmanch/docker-images/lgogdownloader:latest
    volumes:
      - lgog-config:/home/appuser/.config/lgogdownloader
      - ./games:/games
    # Override entrypoint for interactive login
    # command: ["--login"]

volumes:
  lgog-config:
```

### Kubernetes Job Example

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: lgogdownloader
spec:
  template:
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 10000
        runAsGroup: 10000
      containers:
        - name: lgogdownloader
          image: ghcr.io/sharkusmanch/docker-images/lgogdownloader:latest
          args: ["--list"]
          securityContext:
            readOnlyRootFilesystem: true
            allowPrivilegeEscalation: false
            capabilities:
              drop:
                - ALL
          volumeMounts:
            - name: config
              mountPath: /home/appuser/.config/lgogdownloader
            - name: games
              mountPath: /games
      restartPolicy: Never
      volumes:
        - name: config
          persistentVolumeClaim:
            claimName: lgog-config
        - name: games
          persistentVolumeClaim:
            claimName: lgog-games
```

## Common Commands

| Command | Description |
|---------|-------------|
| `--help` | Show help (default) |
| `--login` | Interactive login to GOG.com |
| `--list` | List games in your library |
| `--download` | Download games |
| `--game <name>` | Specify game to download |
| `--directory <path>` | Set download directory |
| `--platform <n>` | Platform filter (1=Windows, 2=Mac, 4=Linux) |
| `--include <type>` | Include installers, extras, patches, etc. |

See [upstream documentation](https://github.com/Sude-/lgogdownloader#usage) for full command reference.
