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

| Environment Variable | Description | Required |
|---------------------|-------------|----------|
| `FLARESOLVERR_URL` | URL of your FlareSolverr instance (e.g., `http://flaresolverr:8191/v1`) | Yes |

## Usage

FlareProxy acts as a transparent HTTP proxy. Configure your applications to use it as their HTTP proxy, and it will automatically route requests through FlareSolverr when needed.

**Important:** Use `http://` in your proxy configuration even for HTTPS resources. FlareProxy automatically switches to HTTPS for upstream connections.

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

## Ports

- `8080` - HTTP proxy server

## Requirements

- A running [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr) instance
