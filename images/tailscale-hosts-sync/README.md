# tailscale-hosts-sync

Syncs Tailscale device hostnames to a hosts file for DNS servers like Blocky, Pi-hole, or dnsmasq.

Uses OAuth client credentials (which never expire) instead of API keys for "set and forget" operation.

## Usage

```bash
docker run --rm \
  -e TAILSCALE_CLIENT_ID=your-client-id \
  -e TAILSCALE_CLIENT_SECRET=your-client-secret \
  -v /path/to/output:/output \
  ghcr.io/sharkusmanch/containers/tailscale-hosts-sync:1.0.0
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TAILSCALE_CLIENT_ID` | Yes | - | OAuth client ID from Tailscale admin console |
| `TAILSCALE_CLIENT_SECRET` | Yes | - | OAuth client secret |
| `OUTPUT_FILE` | No | `/output/hosts` | Path to write the hosts file |
| `TAILNET` | No | `-` | Tailnet name (use `-` for default) |
| `DOMAIN_SUFFIX` | No | auto-detect | Domain suffix (e.g., `tailnet-name.ts.net`). Auto-detected from API if not set. |
| `STRIP_SUFFIX` | No | `true` | Strip numeric suffixes (-1, -2) from hostnames |
| `USE_FQDN` | No | `true` | Use full MagicDNS name from API (recommended) |

## Volumes

| Path | Description |
|------|-------------|
| `/output` | Directory where hosts file is written |

## OAuth Client Setup

1. Go to [Tailscale Admin Console → Settings → OAuth clients](https://login.tailscale.com/admin/settings/oauth)
2. Click **Generate OAuth client**
3. Add scope: `devices:read`
4. Save the Client ID and Client Secret

OAuth client credentials **never expire** - perfect for automated sync jobs.

## Hostname Suffix Stripping

By default, numeric suffixes like `-1`, `-2` are stripped from hostnames. This handles Tailscale's behavior of adding suffixes when device names conflict (e.g., during Kubernetes pod upgrades).

| Original | Stripped |
|----------|----------|
| `blocky-1` | `blocky` |
| `nginx-proxy-2` | `nginx-proxy` |
| `myserver` | `myserver` |

When multiple devices have the same base name, only the first IP for each hostname is kept (duplicates are skipped).

Set `STRIP_SUFFIX=false` to disable this behavior.

## Output Format

The generated hosts file follows standard `/etc/hosts` format with full MagicDNS FQDNs:

```
# Tailscale hosts - Generated 2024-01-15T10:30:00Z
# Source: Tailscale API (OAuth)
# Domain suffix: tailnet-name.ts.net
# Strip numeric suffixes: True
# Use FQDN from API: True
# Devices: 5

100.64.1.10 macbook.tailnet-name.ts.net
fd7a:115c:a1e0::1 macbook.tailnet-name.ts.net
100.64.1.20 homeserver.tailnet-name.ts.net
fd7a:115c:a1e0::2 homeserver.tailnet-name.ts.net
```

## Kubernetes CronJob Example

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: tailscale-hosts-sync
spec:
  schedule: "*/5 * * * *"
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: sync
              image: ghcr.io/sharkusmanch/containers/tailscale-hosts-sync:1.0.0
              envFrom:
                - secretRef:
                    name: tailscale-oauth
              volumeMounts:
                - name: hosts
                  mountPath: /output
          volumes:
            - name: hosts
              persistentVolumeClaim:
                claimName: tailscale-hosts
          restartPolicy: OnFailure
```

## Use with Blocky DNS

Configure Blocky to fetch hosts from an HTTP server serving this file:

```yaml
hostsFile:
  sources:
    - http://tailscale-hosts-server:8080/hosts
  hostsTTL: 5m
  loading:
    refreshPeriod: 1m
```

## Modifications from Upstream

This is an original image - no upstream source.
