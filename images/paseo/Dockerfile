# syntax=docker/dockerfile:1

# renovate: datasource=npm depName=@getpaseo/cli
ARG PASEO_VERSION=0.1.110

# renovate: datasource=docker depName=alpine
ARG ALPINE_VERSION=3.24

# renovate: datasource=npm depName=@anthropic-ai/claude-code
ARG CLAUDE_VERSION=2.1.212

# renovate: datasource=github-releases depName=kubernetes/kubernetes
ARG KUBECTL_VERSION=v1.36.2

# renovate: datasource=github-releases depName=helm/helm
ARG HELM_VERSION=v4.2.3

# renovate: datasource=github-releases depName=sigstore/cosign
ARG COSIGN_VERSION=v3.1.2

# renovate: datasource=github-releases depName=fluxcd/flux2
ARG FLUX_VERSION=v2.9.2

# renovate: datasource=github-releases depName=yannh/kubeconform
ARG KUBECONFORM_VERSION=v0.8.0

# ============================================================================
# Builder — install paseo, compile node-pty from source (musl), fetch toolchain
# ============================================================================
FROM alpine:${ALPINE_VERSION} AS builder

ARG PASEO_VERSION
ARG CLAUDE_VERSION
ARG KUBECTL_VERSION
ARG HELM_VERSION
ARG COSIGN_VERSION
ARG FLUX_VERSION
ARG KUBECONFORM_VERSION

# g++/make/python3/libuv-dev are node-gyp's toolchain for compiling node-pty.
RUN apk add --no-cache nodejs npm python3 make g++ libuv-dev curl bash tar

# Paseo CLI. --ignore-scripts skips lifecycle scripts (onnxruntime-node/sherpa try
# to download glibc binaries; voice is intentionally unbuilt and degrades gracefully).
RUN npm install -g --ignore-scripts @getpaseo/cli@${PASEO_VERSION}

# node-pty: the bundled prebuilds are glibc and will NOT load on musl. Delete them
# and compile from source so build/Release/pty.node links against ld-musl. Fail the
# build loudly if the compiled addon is missing.
RUN PTY_DIR="$(find /usr/local/lib/node_modules -type d -name node-pty | head -1)" \
    && cd "$PTY_DIR" \
    && rm -rf prebuilds \
    && node-gyp rebuild \
    && test -f build/Release/pty.node

# kubectl (single binary)
RUN curl -fsSL -o /usr/local/bin/kubectl \
      "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl" \
    && chmod +x /usr/local/bin/kubectl

# helm (tarball -> extract the binary)
RUN curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-amd64.tar.gz" \
      | tar -xz -C /tmp \
    && install -m 0755 /tmp/linux-amd64/helm /usr/local/bin/helm

# cosign — verify image signatures/attestations (single static binary; baked on the real
# PATH, matching daedalus — replaces the off-PATH mise copy the /new-app security scan used).
RUN curl -fsSL -o /usr/local/bin/cosign \
      "https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/cosign-linux-amd64" \
    && chmod +x /usr/local/bin/cosign

# flux CLI — real `flux reconcile/build/diff` for the GitOps flow. The release tag is
# vX.Y.Z but the asset filename drops the leading v (${FLUX_VERSION#v}); extract just `flux`.
RUN curl -fsSL "https://github.com/fluxcd/flux2/releases/download/${FLUX_VERSION}/flux_${FLUX_VERSION#v}_linux_amd64.tar.gz" \
      | tar -xz -C /tmp flux \
    && install -m 0755 /tmp/flux /usr/local/bin/flux

# kubeconform — CRD-schema validation of rendered manifests before commit.
RUN curl -fsSL "https://github.com/yannh/kubeconform/releases/download/${KUBECONFORM_VERSION}/kubeconform-linux-amd64.tar.gz" \
      | tar -xz -C /tmp kubeconform \
    && install -m 0755 /tmp/kubeconform /usr/local/bin/kubeconform

# Claude Code — native musl binary into a fixed HOME; bake the whole tree so the
# launcher symlink resolves. The installer has a history of not creating the bin
# symlink — assert it resolves to a real executable.
RUN HOME=/opt/claude bash -c "curl -fsSL https://claude.ai/install.sh | bash -s ${CLAUDE_VERSION}" \
    && test -x "$(readlink -f /opt/claude/.local/bin/claude)" \
    && chmod -R a+rX /opt/claude

# ============================================================================
# Runtime — minimal Alpine + paseo daemon (single foreground process under tini)
# ============================================================================
FROM alpine:${ALPINE_VERSION} AS runtime

ARG BUILD_DATE
ARG VCS_REF
ARG PASEO_VERSION
LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${PASEO_VERSION}" \
      org.opencontainers.image.source="https://github.com/sharkusmanch/containers" \
      org.opencontainers.image.upstream="https://github.com/getpaseo/paseo" \
      org.opencontainers.image.title="paseo" \
      org.opencontainers.image.description="Headless Paseo agent-orchestration daemon (claude + kubectl/helm/flux/kustomize/kubeconform/cosign GitOps toolchain baked)"

# coreutils: paseo launcher shebang uses `env -S` (busybox env can't parse it).
# libuv: node-pty runtime lib. libstdc++/libgcc: node + claude native binaries.
# tini: PID-1 init so claude subprocesses (spawned via node-pty) are reaped, not zombied.
# nodejs/npm: paseo runs on node, and launched agents build node projects at runtime.
# openssh-client: repos use git@ SSH remotes — without `ssh`, every git fetch/push fails
#   ("cannot run ssh: No such file or directory"). github-cli (`gh`): paseo's GitHub PR
#   self-heal poll + agent `gh` usage.
# python3/py3-pip/py3-virtualenv/uv: agents build & run Python projects (dev parity with
#   daedalus). jq + yq-go (`yq` binary): JSON/YAML processing for agents and kubectl output.
# GitOps/secrets/image CLIs for the /new-app deploy flow (all Alpine community, on real
#   PATH): openbao(->`bao`)/sops/age read+seed OpenBao KV & SOPS secrets; crane/skopeo
#   inspect candidate image manifests (amd64) + config (user/ports); kustomize renders
#   overlays for kubeconform; grype/syft do image CVE scan + SBOM.
RUN apk add --no-cache \
      nodejs npm coreutils libuv libstdc++ libgcc tini \
      git openssh-client github-cli ca-certificates bash curl tzdata \
      python3 py3-pip py3-virtualenv uv jq yq-go \
      openbao crane skopeo kustomize sops age grype syft \
    # Non-root dev user; HOME is the persistent /config PVC (mounted at runtime).
    && adduser -D -u 1000 -h /config paseo

# Baked paseo (global node_modules) and toolchain.
COPY --from=builder /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=builder /usr/local/bin/kubectl     /usr/local/bin/kubectl
COPY --from=builder /usr/local/bin/helm        /usr/local/bin/helm
COPY --from=builder /usr/local/bin/cosign      /usr/local/bin/cosign
COPY --from=builder /usr/local/bin/flux        /usr/local/bin/flux
COPY --from=builder /usr/local/bin/kubeconform /usr/local/bin/kubeconform
COPY --from=builder /opt/claude                /opt/claude
# Recreate the launcher symlinks (do NOT COPY the npm bin symlink — COPY dereferences
# it into a plain file, breaking the launcher's `import '../dist/index.js'` relative
# resolution; Node must follow the symlink to the package's real bin/ to find dist/).
RUN ln -sf ../lib/node_modules/@getpaseo/cli/bin/paseo /usr/local/bin/paseo \
    && ln -sf /opt/claude/.local/bin/claude /usr/local/bin/claude

# Entrypoint seeds a default config.json (voice off) then execs the daemon.
COPY rootfs/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# claude is root-owned in /opt/claude and runs as uid 1000 → cannot self-update.
# PATH: append the mise shims dir so mise-managed tools (installed at runtime under the
# /config PVC) are reachable in NON-interactive shells too (Claude/agents don't source
# ~/.bashrc, so `mise activate` never runs). APPENDED so baked /usr/local/bin wins over any
# stale mise `latest` shim; the dir is created lazily by mise and may not exist at build.
ENV DISABLE_AUTOUPDATER=1 \
    HOME=/config \
    PATH="${PATH}:/config/.local/share/mise/shims"

USER 1000

EXPOSE 6767

# tini as PID 1 reaps zombies (claude is spawned via node-pty); the entrypoint seeds
# config then execs `paseo daemon start --foreground --no-relay` as the main process.
ENTRYPOINT ["/sbin/tini", "--", "/entrypoint.sh"]
