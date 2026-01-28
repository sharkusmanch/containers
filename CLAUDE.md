# Claude Code Guidelines

Guidelines for adding and maintaining Docker images in this repository.

## Adding a New Image

1. Create `images/<name>/Dockerfile`
2. Create `images/<name>/README.md` (see README Requirements below)
3. Add entry to the images table in `README.md` (alphabetical order)
4. Commit and push to main

## Dockerfile Requirements

### Structure

All Dockerfiles must follow this structure:

```dockerfile
# syntax=docker/dockerfile:1

# Renovate version tracking comments (see below)
ARG VERSION=...
ARG ALPINE_VERSION=...

# Builder stage
FROM ... AS builder
# Build application

# Runtime stage
FROM ... AS runtime
# Labels, user setup, copy artifacts, entrypoint
```

### Renovate Comments

Include renovate comments for automated version updates:

```dockerfile
# For GitHub releases:
# renovate: datasource=github-releases depName=owner/repo
ARG VERSION=v1.2.3

# For GitHub commits (when tracking a branch):
# renovate: datasource=github-commits depName=owner/repo branch=main
ARG COMMIT=abc123...

# For Docker base images:
# renovate: datasource=docker depName=alpine
ARG ALPINE_VERSION=3.21

# renovate: datasource=docker depName=python
ARG PYTHON_VERSION=3.12
```

### OCI Labels

All images must include standard OCI labels:

```dockerfile
ARG BUILD_DATE
ARG VCS_REF
ARG VERSION
LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.source="https://github.com/sharkusmanch/containers" \
      org.opencontainers.image.upstream="https://github.com/upstream/repo" \
      org.opencontainers.image.title="image-name" \
      org.opencontainers.image.description="Short description"
```

### Security Requirements

- **Multi-stage builds** - Build dependencies must not ship to runtime
- **Non-root user** - Use UID/GID 10000:
  ```dockerfile
  RUN addgroup -g 10000 appgroup && \
      adduser -u 10000 -G appgroup -s /bin/false -D appuser
  USER appuser
  ```
- **Minimal base images** - Prefer Alpine or distroless
- **No secrets in layers** - Use build args for config, never credentials

### Build Caching

Use BuildKit cache mounts for package managers:

```dockerfile
# Cargo (Rust)
RUN --mount=type=cache,target=/build/target \
    --mount=type=cache,target=/usr/local/cargo/registry \
    cargo build --release

# uv (Python)
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --no-dev

# apk (Alpine)
RUN --mount=type=cache,target=/var/cache/apk \
    apk add --no-cache package
```

## README Requirements

Each image must have a `README.md` with the following sections:

```markdown
# <image-name>

Brief description of what the image does.

## Upstream

- **Repository**: [owner/repo](https://github.com/owner/repo)
- **Version**: vX.Y.Z

## Usage

\`\`\`bash
docker run [options] ghcr.io/sharkusmanch/<image-name>:<tag> [command]
\`\`\`

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `VAR_NAME` | Yes/No | What it does |

## Volumes

| Path | Description |
|------|-------------|
| `/data` | Persistent storage |

## Modifications from Upstream

- List any changes from the upstream Dockerfile or build process
- Or state "None - built directly from upstream source"
```

Omit sections that don't apply (e.g., no Volumes section if none are used).

## Commit Messages

Follow conventional commits:

- `feat(<image>): add Docker image for <Name>` - New image
- `fix(<image>): <description>` - Bug fixes
- `docs: <description>` - Documentation changes
