# pod-reaper

Rule-based Kubernetes pod cleanup controller. Automatically deletes pods matching configurable criteria such as phase status, duration, or container errors. Used in our cluster to reap zombie pods stuck in `Unknown` state that block Longhorn PVC mounts.

## Upstream

- **Repository**: [target/pod-reaper](https://github.com/target/pod-reaper)
- **Version**: v2.14.0

## Usage

```bash
docker run -e POD_PHASE_STATUSES=Unknown -e SCHEDULE="@every 5m" \
  ghcr.io/sharkusmanch/docker-images/pod-reaper:v2.14.0
```

### Kubernetes Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pod-reaper
spec:
  replicas: 1
  selector:
    matchLabels:
      app: pod-reaper
  template:
    metadata:
      labels:
        app: pod-reaper
    spec:
      serviceAccountName: pod-reaper
      containers:
        - name: pod-reaper
          image: ghcr.io/sharkusmanch/docker-images/pod-reaper:v2.14.0
          env:
            - name: POD_PHASE_STATUSES
              value: "Unknown"
            - name: SCHEDULE
              value: "@every 5m"
            - name: GRACE_PERIOD
              value: "0s"
            - name: POD_SORTING_STRATEGY
              value: "oldest-first"
            - name: LOG_LEVEL
              value: "Info"
          securityContext:
            runAsNonRoot: true
            runAsUser: 10000
            runAsGroup: 10000
            readOnlyRootFilesystem: true
            allowPrivilegeEscalation: false
            capabilities:
              drop:
                - ALL
          resources:
            requests:
              cpu: 5m
              memory: 16Mi
            limits:
              cpu: 50m
              memory: 32Mi
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `POD_PHASE_STATUSES` | Yes* | Comma-separated pod phases to target: `Pending`, `Running`, `Succeeded`, `Failed`, `Unknown` |
| `SCHEDULE` | No | Reap cycle frequency (default: `@every 1m`). Supports cron syntax or `@every` duration |
| `NAMESPACE` | No | Namespace to monitor (default: all namespaces) |
| `GRACE_PERIOD` | No | Duration between SIGTERM and SIGKILL (default: pod's own setting) |
| `POD_SORTING_STRATEGY` | No | Order of deletion: `random`, `oldest-first`, `youngest-first`, `pod-deletion-cost` |
| `MAX_PODS` | No | Max pods to kill per cycle (default: unlimited) |
| `DRY_RUN` | No | Log actions without deleting (default: false) |
| `EVICT` | No | Use Eviction API instead of direct delete (default: false) |
| `LOG_LEVEL` | No | Logging verbosity: `Debug`, `Info`, `Warning`, `Error` (default: `Info`) |
| `CONTAINER_STATUSES` | Yes* | Target pods with containers in specific states (e.g., `ImagePullBackOff,Error`) |
| `MAX_DURATION` | Yes* | Reap pods running longer than this duration |
| `MAX_UNREADY` | Yes* | Reap pods unready longer than this duration |
| `CHAOS_CHANCE` | Yes* | Random deletion probability 0-1 (chaos engineering) |
| `EXCLUDE_LABEL_KEY` | No | Label key to exclude pods from reaping |
| `EXCLUDE_LABEL_VALUES` | No | Comma-separated label values to exclude |
| `REQUIRE_LABEL_KEY` | No | Only reap pods with this label key |
| `REQUIRE_LABEL_VALUES` | No | Comma-separated required label values |

*At least one rule (`POD_PHASE_STATUSES`, `CONTAINER_STATUSES`, `MAX_DURATION`, `MAX_UNREADY`, or `CHAOS_CHANCE`) must be set.

## RBAC

Requires a ServiceAccount with cluster-wide pod list/delete permissions:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: pod-reaper

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: pod-reaper
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["list", "delete"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: pod-reaper
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: pod-reaper
subjects:
  - kind: ServiceAccount
    name: pod-reaper
    namespace: backup-system
```

## Modifications from Upstream

None - built directly from upstream source.
