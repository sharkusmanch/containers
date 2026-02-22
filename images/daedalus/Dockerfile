# syntax=docker/dockerfile:1

# === Version tracking (first _VERSION becomes image tag) ===

# renovate: datasource=npm depName=the-companion
ARG COMPANION_VERSION=0.58.2
# renovate: datasource=npm depName=@anthropic-ai/claude-code
ARG CLAUDE_CODE_VERSION=2.1.50
# renovate: datasource=docker depName=alpine versioning=docker
ARG ALPINE_VERSION=3.21
# renovate: datasource=docker depName=oven/bun versioning=docker
ARG BUN_VERSION=1.2
# renovate: datasource=github-releases depName=kubernetes/kubernetes
ARG KUBECTL_VERSION=1.35.1
# renovate: datasource=github-releases depName=helm/helm
ARG HELM_VERSION=4.1.1
# renovate: datasource=docker depName=golang versioning=docker
ARG GO_VERSION=1.24

# ── Go SDK (used as COPY source) ─────────────────────────────────────────────
FROM golang:${GO_VERSION}-alpine AS golang-sdk

# ── Stage 1: Build companion web UI ──────────────────────────────────────────
FROM oven/bun:${BUN_VERSION}-alpine AS companion-builder

ARG COMPANION_VERSION

RUN apk add --no-cache git

WORKDIR /build
RUN git clone --branch the-companion-v${COMPANION_VERSION} --depth 1 \
    https://github.com/The-Vibe-Company/companion.git .

WORKDIR /build/web
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install && bun run build

# Prune dev dependencies
RUN rm -rf node_modules && bun install --production

# ── Stage 2: Download kubectl and helm ───────────────────────────────────────
FROM alpine:${ALPINE_VERSION} AS tools-builder

ARG KUBECTL_VERSION
ARG HELM_VERSION
ARG TARGETARCH

RUN apk add --no-cache curl && \
    curl -fsSL "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl" \
      -o /usr/local/bin/kubectl && \
    chmod +x /usr/local/bin/kubectl && \
    curl -fsSL "https://get.helm.sh/helm-v${HELM_VERSION}-linux-${TARGETARCH}.tar.gz" \
      | tar xz --strip-components=1 -C /usr/local/bin linux-${TARGETARCH}/helm

# ── Stage 3: Runtime ─────────────────────────────────────────────────────────
FROM alpine:${ALPINE_VERSION} AS runtime

ARG BUILD_DATE
ARG VCS_REF
ARG COMPANION_VERSION
ARG CLAUDE_CODE_VERSION

LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${COMPANION_VERSION}" \
      org.opencontainers.image.source="https://github.com/sharkusmanch/containers" \
      org.opencontainers.image.upstream="https://github.com/The-Vibe-Company/companion" \
      org.opencontainers.image.title="daedalus" \
      org.opencontainers.image.description="SSH dev container with Claude Code, The Companion web UI, and dev tools"

# System packages
RUN apk add --no-cache \
    openssh-server bash curl git make jq \
    su-exec sudo nodejs npm

# Go SDK
COPY --from=golang-sdk /usr/local/go /usr/local/go
ENV PATH="/usr/local/go/bin:${PATH}"

# Bun runtime
COPY --from=companion-builder /usr/local/bin/bun /usr/local/bin/bun

# Claude Code CLI
RUN --mount=type=cache,target=/root/.npm \
    npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

# kubectl and helm
COPY --from=tools-builder /usr/local/bin/kubectl /usr/local/bin/kubectl
COPY --from=tools-builder /usr/local/bin/helm /usr/local/bin/helm

# Companion web UI
COPY --from=companion-builder /build/web/bin /opt/companion/bin
COPY --from=companion-builder /build/web/server /opt/companion/server
COPY --from=companion-builder /build/web/dist /opt/companion/dist
COPY --from=companion-builder /build/web/node_modules /opt/companion/node_modules
COPY --from=companion-builder /build/web/package.json /opt/companion/package.json

# User setup (UID/GID 1000 for PVC backward compatibility)
RUN addgroup -g 1000 abc && \
    adduser -u 1000 -G abc -s /bin/bash -D abc && \
    echo "abc ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers && \
    mkdir -p /home/abc/.ssh /home/abc/.sshd && \
    chown -R abc:abc /home/abc

# sshd configuration
RUN cat > /etc/ssh/sshd_config <<'EOF'
Port 2222
StrictModes no
PasswordAuthentication no
PubkeyAuthentication yes
AuthorizedKeysFile .ssh/authorized_keys
HostKey /home/abc/.sshd/ssh_host_rsa_key
HostKey /home/abc/.sshd/ssh_host_ecdsa_key
HostKey /home/abc/.sshd/ssh_host_ed25519_key
Subsystem sftp /usr/lib/ssh/sftp-server
EOF

# PATH for SSH login shells
RUN cat > /etc/profile.d/daedalus.sh <<'EOF'
export PATH="/usr/local/go/bin:/usr/local/bin:$PATH"
export GOPATH="$HOME/go"
export PATH="$GOPATH/bin:$PATH"
EOF

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 2222 3456
ENTRYPOINT ["/entrypoint.sh"]
