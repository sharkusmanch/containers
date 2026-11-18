# flareproxy

HTTP proxy adapter that forwards requests to FlareSolverr for bypassing Cloudflare and DDoS-GUARD protection.

## Upstream

- **Repository:** [mimnix/FlareProxy](https://github.com/mimnix/FlareProxy)
- **Tracking:** GitHub tags via Renovate

## Why Build From Source?

The upstream repo provides a Dockerfile, but we build our own to:

1. Apply consistent security practices across all images
2. Use an up-to-date Alpine-based Python image
3. Ensure non-root execution and minimal attack surface

## Modifications

None - this is a vanilla build of the upstream source with security hardening.

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `FLARESOLVERR_URL` | (empty) | **Required.** FlareSolverr API endpoint, e.g. `http://flaresolverr:8191/v1` |
| `FLAREPROXY_PORT` | `8080` | Plain HTTP proxy listener |
| `FLAREPROXY_HTTPS_PORT` | `8443` | TLS proxy listener |
| `FLAREPROXY_CERT_NAMES` | `localhost,127.0.0.1,flareproxy` | Names on the TLS listener's certificate |
| `FLAREPROXY_CACHE_TTL` | `300` | Seconds a successful GET response is served from memory; `0` disables the cache |
| `FLAREPROXY_CACHE_MAX_ENTRIES` | `512` | Responses kept in the cache |
| `FLAREPROXY_SESSION` | `true` | Reuse one FlareSolverr browser session per target host |
| `FLAREPROXY_SESSION_IDLE_TTL` | `900` | Seconds before an idle session is destroyed; `0` never destroys it |
| `FLAREPROXY_SESSION_PREFIX` | `flareproxy` | Prefix of the per-host session id |
| `FLARESOLVERR_MAX_TIMEOUT_SEC` | `60` | Solve timeout, sent to FlareSolverr as `maxTimeout` |
| `FLAREPROXY_FLARESOLVERR_TIMEOUT` | solve timeout + 30, at least 90 | HTTP timeout for each call to FlareSolverr |

**Sessions need a single FlareSolverr instance.** A session is a browser inside one
FlareSolverr process. Behind a Service with several FlareSolverr replicas, each call can
land on a different replica: FlareSolverr creates the session wherever a request arrives,
and `sessions.destroy` reaches only one of them, so browsers pile up on the others. Set
`FLAREPROXY_SESSION=false` in that case.

**The cache only drops expired responses when they are read again or crowded out**, so
it can hold `FLAREPROXY_CACHE_MAX_ENTRIES` full pages. Size the memory limit for that, or
set `FLAREPROXY_CACHE_TTL=0`.

## Usage

FlareProxy acts as a transparent HTTP proxy. Configure your applications to use it as their HTTP proxy, and it will automatically route requests through FlareSolverr when needed.

**Request `http://` URLs.** Since v1.0.1 FlareProxy hands FlareSolverr the URL as given
(v1.0.0 rewrote `http` to `https`). Sites that redirect to HTTPS still work, because
FlareSolverr's browser follows the redirect. `https://` URLs go through a CONNECT tunnel
that FlareProxy intercepts with its own CA, generated fresh on every start and served at
`http://<proxy>:8080/__flareproxy/ca.crt`. Every replica and every restart has a
different CA, so clients rarely trust it.

```yaml
# Example k8s deployment
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 65534
        runAsGroup: 65534
      containers:
        - name: flareproxy
          image: ghcr.io/sharkusmanch/containers/flareproxy:latest
          securityContext:
            readOnlyRootFilesystem: true
            allowPrivilegeEscalation: false
            capabilities:
              drop:
                - ALL
          env:
            - name: FLARESOLVERR_URL
              value: "http://flaresolverr:8191/v1"
          ports:
            - containerPort: 8080
          volumeMounts:
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: tmp
          emptyDir:
            medium: Memory
            sizeLimit: 16Mi
```

### Docker Compose Example

```yaml
services:
  flaresolverr:
    image: ghcr.io/flaresolverr/flaresolverr:latest
    ports:
      - "8191:8191"

  flareproxy:
    image: ghcr.io/sharkusmanch/containers/flareproxy:latest
    environment:
      - FLARESOLVERR_URL=http://flaresolverr:8191/v1
    ports:
      - "8080:8080"
    depends_on:
      - flaresolverr

  # Example: changedetection.io using flareproxy
  changedetection:
    image: ghcr.io/dgtlmoon/changedetection.io:latest
    environment:
      - HTTP_PROXY=http://flareproxy:8080
    depends_on:
      - flareproxy
```

### Testing

```bash
# Test the proxy with curl
curl --proxy http://localhost:8080 http://www.example.com
```

## Volumes

| Path | Description |
|------|-------------|
| `/tmp` | Must be writable. FlareProxy writes the CA and leaf certificates it generates at startup here, and fails to start without it. Mount an emptyDir when the root filesystem is read-only. |

## Ports

- `8080` - HTTP proxy server
- `8443` - TLS proxy server

## Requirements

- A running [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr) instance
