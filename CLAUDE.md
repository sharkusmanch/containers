# Claude Code Guidelines

Guidelines for adding and maintaining Docker images in this repository.

## Adding a New Image

1. Create `images/<name>/Dockerfile`
2. Add entry to the images table in `README.md` (alphabetical order)
3. Commit and push to main

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
      org.opencontainers.image.source="https://github.com/sharkusmanch/docker-images" \
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

## Commit Messages

Follow conventional commits:

- `feat(<image>): add Docker image for <Name>` - New image
- `fix(<image>): <description>` - Bug fixes
- `docs: <description>` - Documentation changes
