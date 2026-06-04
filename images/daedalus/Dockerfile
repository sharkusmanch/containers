# syntax=docker/dockerfile:1

# renovate: datasource=docker depName=alpine
ARG ALPINE_VERSION=3.23

# renovate: datasource=github-releases depName=kubernetes/kubernetes
ARG KUBECTL_VERSION=v1.36.1

# renovate: datasource=github-releases depName=helm/helm
ARG HELM_VERSION=v4.2.0

# renovate: datasource=npm depName=@anthropic-ai/claude-code
ARG CLAUDE_VERSION=2.1.162

# ============================================================================
# Builder stage — fetch pinned binaries (amd64 only; see images/daedalus/.platforms)
# ============================================================================
FROM alpine:${ALPINE_VERSION} AS builder

ARG KUBECTL_VERSION
ARG HELM_VERSION
ARG CLAUDE_VERSION

RUN apk add --no-cache curl bash tar

RUN mkdir -p /out

# kubectl (single binary)
RUN curl -fsSL -o /out/kubectl \
      "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl" \
    && chmod +x /out/kubectl

# helm (tarball -> extract the binary)
RUN curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-amd64.tar.gz" \
      | tar -xz -C /tmp \
    && install -m 0755 /tmp/linux-amd64/helm /out/helm

# Claude Code — native musl binary. Install into a fixed HOME and bake the whole
# tree so the launcher symlink (bin/claude -> share/claude/versions/<v>) resolves
# at runtime. The install dir is separate from the user's runtime HOME (/config).
RUN HOME=/opt/claude bash -c "curl -fsSL https://claude.ai/install.sh | bash -s ${CLAUDE_VERSION}" \
    # Assert the launcher resolves to a real executable (the installer has a history
    # of not creating the bin symlink — fail the build loudly rather than ship a stub).
    && test -x "$(readlink -f /opt/claude/.local/bin/claude)" \
    && chmod -R a+rX /opt/claude

# ============================================================================
# Runtime stage — minimal Alpine + sshd + dev toolchain (single process: sshd)
# ============================================================================
FROM alpine:${ALPINE_VERSION} AS runtime

ARG BUILD_DATE
ARG VCS_REF
ARG ALPINE_VERSION
LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${ALPINE_VERSION}" \
      org.opencontainers.image.source="https://github.com/sharkusmanch/containers" \
      org.opencontainers.image.upstream="https://www.openssh.com/" \
      org.opencontainers.image.title="daedalus" \
      org.opencontainers.image.description="Minimal self-owned SSH dev box (sshd + baked kubectl/helm/claude toolchain)"

# openssh (server+client; client needed for git-over-ssh), the dev toolchain, and
# the runtime libs the Claude/node binaries need (libstdc++/libgcc).
RUN apk add --no-cache \
      openssh openssh-server openssh-sftp-server openssh-keygen \
      bash curl ca-certificates su-exec tzdata \
      git nodejs npm go make python3 py3-pip py3-virtualenv uv tmux \
      libstdc++ libgcc \
    # Interactive dev user; HOME is the persistent /config PVC (mounted at runtime).
    && adduser -D -u 1000 -s /bin/bash -h /config abc \
    # adduser -D leaves the shadow password "!" (locked). OpenSSH 10 (non-PAM)
    # rejects ALL auth — including pubkey — for !-locked accounts. Set it to "*"
    # (no password, but not "locked") so pubkey login works; password login stays
    # impossible via sshd_config PasswordAuthentication no.
    && sed -i 's/^abc:!:/abc:*:/' /etc/shadow

# Baked toolchain
COPY --from=builder /out/kubectl /usr/local/bin/kubectl
COPY --from=builder /out/helm    /usr/local/bin/helm
COPY --from=builder /opt/claude  /opt/claude
RUN ln -sf /opt/claude/.local/bin/claude /usr/local/bin/claude

# Our sshd config + entrypoint
COPY rootfs/ /
RUN chmod +x /entrypoint.sh

EXPOSE 2222

# Runs as root: sshd needs privsep (user "sshd" + /var/empty, created by apk).
# The entrypoint drops to "abc" (su-exec) for all user-scoped config steps.
ENTRYPOINT ["/entrypoint.sh"]
