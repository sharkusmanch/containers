# envsubst

Environment variable substitution for Go. Supports default values, required variables, and strict mode. More powerful than the gettext `envsubst`.

## Upstream

- **Repository**: [a8m/envsubst](https://github.com/a8m/envsubst)
- **Version**: v1.4.3

## Usage

### Basic substitution

```bash
echo 'Hello $NAME' | docker run -i -e NAME=World ghcr.io/sharkusmanch/envsubst:latest
# Output: Hello World
```

### Default values

```bash
echo '${NAME:-default}' | docker run -i ghcr.io/sharkusmanch/envsubst:latest
# Output: default

echo '${NAME:-default}' | docker run -i -e NAME=World ghcr.io/sharkusmanch/envsubst:latest
# Output: World
```

### Strict mode (fail on undefined)

```bash
echo '$UNDEFINED' | docker run -i ghcr.io/sharkusmanch/envsubst:latest --fail-fast
# Exit code 1, error message
```

### Template a file

```bash
docker run -i -e DB_HOST=localhost -e DB_PORT=5432 \
  ghcr.io/sharkusmanch/envsubst:latest < config.template > config.yaml
```

### Selective substitution

Only substitute specific variables:

```bash
docker run -i -e APP_NAME=myapp \
  ghcr.io/sharkusmanch/envsubst:latest '$APP_NAME' < template.txt
```

### Use as init container (Kubernetes)

```yaml
initContainers:
  - name: template-config
    image: ghcr.io/sharkusmanch/envsubst:latest
    command: ["/bin/sh", "-c"]
    args:
      - envsubst < /templates/config.template > /config/config.yaml
    env:
      - name: DATABASE_URL
        valueFrom:
          secretKeyRef:
            name: db-secret
            key: url
    volumeMounts:
      - name: templates
        mountPath: /templates
      - name: config
        mountPath: /config
```

## Supported Syntax

| Expression | Description |
|------------|-------------|
| `${var}` | Value of `$var` |
| `${var-default}` | If `$var` not set, use `default` |
| `${var:-default}` | If `$var` not set or empty, use `default` |
| `${var+value}` | If `$var` set, use `value`, else empty |
| `${var:+value}` | If `$var` set and non-empty, use `value` |
| `${var?message}` | If `$var` not set, print `message` and exit |
| `${var:?message}` | If `$var` not set or empty, print `message` and exit |
| `${#var}` | Length of `$var` |
| `${var%suffix}` | Remove shortest `suffix` pattern |
| `${var%%suffix}` | Remove longest `suffix` pattern |
| `${var#prefix}` | Remove shortest `prefix` pattern |
| `${var##prefix}` | Remove longest `prefix` pattern |

## Modifications from Upstream

None - built directly from upstream source.
