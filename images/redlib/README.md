# redlib

Private front-end for Reddit. No JavaScript, no ads, no tracking.

## Upstream

- **Repository:** [redlib-org/redlib](https://github.com/redlib-org/redlib)
- **Branch:** [PR #509](https://github.com/redlib-org/redlib/pull/509) (feature/tls-openssl)
- **Tracking:** Commit SHA via Renovate

## Why PR #509?

Reddit actively fingerprints and blocks redlib instances based on TLS characteristics. The main branch uses `hyper-rustls`, which has a distinctive TLS fingerprint that Reddit has learned to block.

PR #509 switches to `hyper-tls` (OpenSSL-based), which:
- Has a different TLS fingerprint
- Currently evades Reddit's blocking
- Is reported to work better for private instances

See [Issue #446](https://github.com/redlib-org/redlib/issues/446) for the ongoing cat-and-mouse game with Reddit.

## Modifications

- **TLS backend:** Uses hyper-tls/OpenSSL instead of hyper-rustls (via PR #509)
- **Security hardening:** Non-root user, minimal base image

## Configuration

| Environment Variable | Description | Default |
|---------------------|-------------|----------|
| `REDLIB_DEFAULT_THEME` | Default theme (system/light/dark) | system |
| `REDLIB_DEFAULT_FRONT_PAGE` | Default front page (default/popular/all) | default |
| `REDLIB_DEFAULT_LAYOUT` | Layout (card/clean/compact) | card |
| `REDLIB_DEFAULT_WIDE` | Wide mode | off |
| `REDLIB_DEFAULT_SHOW_NSFW` | Show NSFW content | off |
| `REDLIB_DEFAULT_BLUR_NSFW` | Blur NSFW content | off |
| `REDLIB_DEFAULT_HIDE_HLS_NOTIFICATION` | Hide HLS notification | off |
| `REDLIB_DEFAULT_USE_HLS` | Use HLS for video | off |
| `REDLIB_DEFAULT_AUTOPLAY_VIDEOS` | Autoplay videos | off |
| `REDLIB_SFW_ONLY` | SFW only mode (hides NSFW entirely) | off |
| `REDLIB_BANNER` | Custom banner message | |
| `REDLIB_ROBOTS_DISABLE_INDEXING` | Disable search engine indexing | off |
| `REDLIB_PUSHSHIFT_FRONTEND` | Alternative frontend for removed content | undelete.pullpush.io |

## Usage

```yaml
# Example k8s deployment
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 10000
        runAsGroup: 10000
      containers:
        - name: redlib
          image: ghcr.io/sharkusmanch/containers/redlib:latest
          securityContext:
            readOnlyRootFilesystem: true
            allowPrivilegeEscalation: false
            capabilities:
              drop:
                - ALL
          env:
            - name: REDLIB_DEFAULT_SHOW_NSFW
              value: "on"
          ports:
            - containerPort: 8080
```

## Ports

- `8080` - HTTP server

## Known Issues

- Reddit may still rate limit or block based on IP, traffic patterns, or other fingerprinting
- For high-traffic instances, consider routing through Tor or a VPN
- The TLS evasion is a cat-and-mouse game; future Reddit changes may require different workarounds
