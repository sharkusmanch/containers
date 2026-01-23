# actual-mcp

MCP (Model Context Protocol) server for [Actual Budget](https://actualbudget.org/).

## Upstream

- **Repository:** [s-stefanov/actual-mcp](https://github.com/s-stefanov/actual-mcp)
- **Tracking:** GitHub releases via Renovate

## Why Build From Source?

The upstream repo provides a Dockerfile, but we build our own to:

1. Apply consistent security practices across all images
2. Control the build process and dependencies
3. Ensure non-root execution and minimal attack surface

## Modifications

None - this is a vanilla build of the upstream source with security hardening.

## Configuration

| Environment Variable | Description | Required |
|---------------------|-------------|----------|
| `ACTUAL_SERVER_URL` | URL of your Actual Budget server | Yes |
| `ACTUAL_PASSWORD` | Password for Actual Budget | Yes |
| `ACTUAL_BUDGET_ID` | Budget ID to connect to | Yes |

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
        fsGroup: 10000
      containers:
        - name: actual-mcp
          image: ghcr.io/sharkusmanch/docker-images/actual-mcp:latest
          securityContext:
            readOnlyRootFilesystem: true
            allowPrivilegeEscalation: false
            capabilities:
              drop:
                - ALL
          env:
            - name: ACTUAL_SERVER_URL
              value: "https://actual.example.com"
            - name: ACTUAL_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: actual-credentials
                  key: password
            - name: ACTUAL_BUDGET_ID
              value: "your-budget-id"
          ports:
            - containerPort: 3000
```

## Ports

- `3000` - HTTP server
