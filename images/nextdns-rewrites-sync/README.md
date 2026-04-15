# nextdns-rewrites-sync

Reconciles Tailscale device FQDNs + static ConfigMap entries into NextDNS profile rewrites via the NextDNS REST API.

## Upstream

- **Repository**: Original (this repo)
- **Version**: 1.0.0

## Features

- Staged apply — POST new entries before DELETE stale (no gap on partial failure)
- 20%-deletion circuit breaker — guards against an empty Tailscale API response causing mass deletion
- Rate-limited API calls to avoid first-run burst throttling
- API key redacted from all log lines
- Multi-profile reconcile — one run reconciles all profile IDs in `NEXTDNS_PROFILE_IDS`

## Usage

```bash
docker run --rm \
  -e NEXTDNS_API_KEY=... \
  -e NEXTDNS_PROFILE_IDS=abcdef,123456 \
  -e TAILSCALE_CLIENT_ID=... \
  -e TAILSCALE_CLIENT_SECRET=... \
  -v /path/to/rewrites.yaml:/etc/static/rewrites.yaml:ro \
  ghcr.io/sharkusmanch/docker-images/nextdns-rewrites-sync:latest
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXTDNS_API_KEY` | Yes | NextDNS account API key (`https://my.nextdns.io/account`) |
| `NEXTDNS_PROFILE_IDS` | Yes | Comma-separated profile IDs to reconcile (e.g. `abcdef,123456`) |
| `TAILSCALE_CLIENT_ID` | Yes | Tailscale OAuth client id |
| `TAILSCALE_CLIENT_SECRET` | Yes | Tailscale OAuth client secret |
| `STATIC_REWRITES_PATH` | No | YAML file of `{name, content}` entries (default `/etc/static/rewrites.yaml`) |
| `TAILNET` | No | Tailscale tailnet (default `-` = default tailnet) |
| `CIRCUIT_BREAKER_THRESHOLD` | No | Max delete ratio per run (default `0.20`) |
| `RATE_LIMIT_DELAY` | No | Seconds between API writes (default `0.2`) |
| `DRY_RUN` | No | Compute plan but skip all writes (default unset) |

## Static rewrites file format

```yaml
- name: bedrockconnect.example.com
  content: 192.168.11.210
- name: homeassistant.example.com
  content: 192.168.11.200
```

## Volumes

- `/etc/static/rewrites.yaml` — optional read-only static-rewrites file

## Local testing

```bash
pip install -r requirements.txt pytest
pytest -v
DRY_RUN=1 python sync.py
```
