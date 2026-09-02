# syntax=docker/dockerfile:1

# CLOUDCLI_VERSION MUST remain the FIRST `*_VERSION` ARG in this file.
# .github/workflows/build.yml derives the published image tag with
#   grep -E '^ARG.*_VERSION=' Dockerfile | head -1 | cut -d= -f2
# so reordering these ARGs silently tags the image with another tool's version instead.
# renovate: datasource=npm depName=@cloudcli-ai/cloudcli
ARG CLOUDCLI_VERSION=1.37.2

# Debian 13 (trixie) slim, NOT Alpine — deliberate departure from the paseo image.
# cloudcli pulls three native modules (better-sqlite3, node-pty, bcrypt) and all three
# ship *glibc* prebuilds. On musl every one of them must be compiled from source (paseo
# already carries an `rm -rf prebuilds && node-gyp rebuild` dance for node-pty alone).
# On glibc no build toolchain is needed at all, and the package's only postinstall
# (scripts/fix-node-pty.js) is an explicit `process.platform !== 'darwin'` no-op on Linux.
# trixie over bookworm: same glibc and prebuild compatibility, current Debian stable,
# materially smaller backlog of unfixed OS CVEs.
# renovate: datasource=docker depName=node
ARG NODE_VERSION=22-trixie-slim

# renovate: datasource=npm depName=@anthropic-ai/claude-code
ARG CLAUDE_VERSION=2.1.258

# ---------------------------------------------------------------------------
# GitOps / secrets / image toolchain, matching what the paseo image carries so agents
# launched here can do the same cluster work. paseo gets most of these from Alpine
# community packages; Debian has no equivalents for most, so they are fetched as release
# binaries below. amd64 only — images/cloudcli/.platforms pins linux/amd64.
# ---------------------------------------------------------------------------
# renovate: datasource=github-releases depName=kubernetes/kubernetes
ARG KUBECTL_VERSION=v1.37.0
# renovate: datasource=github-releases depName=helm/helm
ARG HELM_VERSION=v4.2.4
# renovate: datasource=github-releases depName=fluxcd/flux2
ARG FLUX_VERSION=v2.9.5
# renovate: datasource=github-releases depName=sigstore/cosign
ARG COSIGN_VERSION=v3.1.3
# renovate: datasource=github-releases depName=yannh/kubeconform
ARG KUBECONFORM_VERSION=v0.8.0
# renovate: datasource=github-releases depName=kubernetes-sigs/kustomize
ARG KUSTOMIZE_VERSION=v5.8.1
# renovate: datasource=github-releases depName=google/go-containerregistry
ARG CRANE_VERSION=v0.22.0
# renovate: datasource=github-releases depName=getsops/sops
ARG SOPS_VERSION=v3.13.3
# renovate: datasource=github-releases depName=anchore/grype
ARG GRYPE_VERSION=v0.118.0
# renovate: datasource=github-releases depName=anchore/syft
ARG SYFT_VERSION=v1.51.1
# renovate: datasource=github-releases depName=mikefarah/yq
ARG YQ_VERSION=v4.53.6
# renovate: datasource=github-releases depName=cli/cli
ARG GH_VERSION=v2.98.0
# renovate: datasource=github-releases depName=openbao/openbao
ARG BAO_VERSION=v2.6.2
# renovate: datasource=github-releases depName=astral-sh/uv
ARG UV_VERSION=0.12.8

# NOTE: task-master-ai (which powers cloudcli's TaskMaster tab) is deliberately NOT baked
# here. It resolves to 685 packages / ~1.3 GB, and depends on @anthropic-ai/claude-code —
# so installing it would pull a SECOND copy of that ~289 MB native binary into an image
# that already ships one. It is installed instead into the shared PVC prefix
# (/config/.npmrc sets prefix=/config/.npm-global, already used for paseo/pnpm), which is
# writable at runtime and shared with daedalus and paseo. That prefix's bin dir is on PATH
# below. cloudcli's check is a plain PATH lookup — spawn('which', ['task-master']) then
# spawn('task-master', ['--version']) — so a PVC install satisfies it.

# ============================================================================
# Builder — global npm installs + loud assertions that no native binding is missing
# ============================================================================
FROM node:${NODE_VERSION} AS builder

ARG CLOUDCLI_VERSION
ARG CLAUDE_VERSION

# ca-certificates + git: @vscode/ripgrep's postinstall downloads the `rg` binary from
# GitHub Releases over TLS. Do NOT add --ignore-scripts to the install below to "harden"
# it — that flag is what paseo uses to skip its voice-model downloads, but here it would
# silently skip the ripgrep fetch and leave the app's search broken at runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g "@cloudcli-ai/cloudcli@${CLOUDCLI_VERSION}" \
    && npm install -g "@anthropic-ai/claude-code@${CLAUDE_VERSION}" \
    && npm cache clean --force

# Assert the glibc prebuilds actually landed. Without this the image builds fine and then
# crashloops at runtime on the first require() of a missing .node binding.
RUN set -eux; \
    for m in better-sqlite3 node-pty bcrypt; do \
      d="$(find /usr/local/lib/node_modules -type d -name "$m" -print -quit)"; \
      test -n "$d" || { echo "FATAL: module $m not installed"; exit 1; }; \
      find "$d" -name '*.node' | grep -q . \
        || { echo "FATAL: no native binding for $m — prebuild missing, would crash at runtime"; exit 1; }; \
    done

# Assert the ripgrep binary downloaded (see the --ignore-scripts note above).
RUN find /usr/local/lib/node_modules -path '*@vscode/ripgrep*' -name 'rg' -type f \
      | grep -q . || { echo "FATAL: ripgrep binary missing — search would be broken"; exit 1; }

# ============================================================================
# Toolchain — fetch every CLI into a single staging dir so runtime is one COPY
# ============================================================================
FROM debian:trixie-slim AS toolchain

ARG KUBECTL_VERSION
ARG HELM_VERSION
ARG FLUX_VERSION
ARG COSIGN_VERSION
ARG KUBECONFORM_VERSION
ARG KUSTOMIZE_VERSION
ARG CRANE_VERSION
ARG SOPS_VERSION
ARG GRYPE_VERSION
ARG SYFT_VERSION
ARG YQ_VERSION
ARG GH_VERSION
ARG BAO_VERSION
ARG UV_VERSION

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl tar \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /tmp/dl
RUN mkdir -p /out/bin

# Several projects publish the tag as vX.Y.Z but name the asset with the leading v
# stripped (${VAR#v}); others keep it. Getting this wrong 404s, so each is spelled out.
RUN set -eux; \
    # kubectl — single binary
    curl -fsSL -o /out/bin/kubectl \
      "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl"; \
    # helm — tarball, binary nested under linux-amd64/
    curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-amd64.tar.gz" \
      | tar -xz -C /tmp/dl && install -m0755 /tmp/dl/linux-amd64/helm /out/bin/helm; \
    # flux — asset drops the leading v
    curl -fsSL "https://github.com/fluxcd/flux2/releases/download/${FLUX_VERSION}/flux_${FLUX_VERSION#v}_linux_amd64.tar.gz" \
      | tar -xz -C /out/bin flux; \
    # cosign — single binary
    curl -fsSL -o /out/bin/cosign \
      "https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/cosign-linux-amd64"; \
    curl -fsSL "https://github.com/yannh/kubeconform/releases/download/${KUBECONFORM_VERSION}/kubeconform-linux-amd64.tar.gz" \
      | tar -xz -C /out/bin kubeconform; \
    # kustomize — the tag itself contains a slash (kustomize/vX.Y.Z), URL-encoded as %2F
    curl -fsSL "https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize%2F${KUSTOMIZE_VERSION}/kustomize_${KUSTOMIZE_VERSION}_linux_amd64.tar.gz" \
      | tar -xz -C /out/bin kustomize; \
    # crane — ships alongside gcrane/krane in one archive; take only crane
    curl -fsSL "https://github.com/google/go-containerregistry/releases/download/${CRANE_VERSION}/go-containerregistry_Linux_x86_64.tar.gz" \
      | tar -xz -C /out/bin crane; \
    curl -fsSL -o /out/bin/sops \
      "https://github.com/getsops/sops/releases/download/${SOPS_VERSION}/sops-${SOPS_VERSION}.linux.amd64"; \
    curl -fsSL "https://github.com/anchore/grype/releases/download/${GRYPE_VERSION}/grype_${GRYPE_VERSION#v}_linux_amd64.tar.gz" \
      | tar -xz -C /out/bin grype; \
    curl -fsSL "https://github.com/anchore/syft/releases/download/${SYFT_VERSION}/syft_${SYFT_VERSION#v}_linux_amd64.tar.gz" \
      | tar -xz -C /out/bin syft; \
    curl -fsSL -o /out/bin/yq \
      "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_amd64"; \
    # gh — binary is nested two levels down
    curl -fsSL "https://github.com/cli/cli/releases/download/${GH_VERSION}/gh_${GH_VERSION#v}_linux_amd64.tar.gz" \
      | tar -xz -C /tmp/dl && install -m0755 "/tmp/dl/gh_${GH_VERSION#v}_linux_amd64/bin/gh" /out/bin/gh; \
    # openbao: the ASSET is named openbao_<ver>_linux_amd64 but the BINARY inside is `bao`
    # (there is no bao_*_Linux_x86_64 asset — that URL 404s; verified against the release).
    curl -fsSL "https://github.com/openbao/openbao/releases/download/${BAO_VERSION}/openbao_${BAO_VERSION#v}_linux_amd64.tar.gz" \
      | tar -xz -C /out/bin bao; \
    # uv tags have NO leading v; archive nests under its own triple-named dir
    curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz" \
      | tar -xz -C /tmp/dl \
    && install -m0755 /tmp/dl/uv-x86_64-unknown-linux-gnu/uv /out/bin/uv \
    && install -m0755 /tmp/dl/uv-x86_64-unknown-linux-gnu/uvx /out/bin/uvx; \
    chmod 0755 /out/bin/*

# Fail the build here rather than shipping a tool that 404'd into a 9-byte HTML file.
RUN set -eux; \
    for b in kubectl helm flux cosign kubeconform kustomize crane sops grype syft yq gh bao uv; do \
      test -s "/out/bin/$b" || { echo "FATAL: /out/bin/$b missing or empty"; exit 1; }; \
      head -c4 "/out/bin/$b" | grep -q ELF \
        || { echo "FATAL: /out/bin/$b is not an ELF binary (bad asset URL?)"; exit 1; }; \
    done

# ============================================================================
# Runtime
# ============================================================================
FROM node:${NODE_VERSION} AS runtime

ARG BUILD_DATE
ARG VCS_REF
ARG CLOUDCLI_VERSION
LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${CLOUDCLI_VERSION}" \
      org.opencontainers.image.source="https://github.com/sharkusmanch/containers" \
      org.opencontainers.image.upstream="https://github.com/siteboon/claudecodeui" \
      org.opencontainers.image.title="cloudcli" \
      org.opencontainers.image.description="CloudCLI (claudecodeui) web UI for coding agents, with claude + the GitOps toolchain baked"

# tini: PID 1 reaper. cloudcli spawns interactive shells via node-pty and agent
#   subprocesses via the Claude Agent SDK; without an init they zombie.
# git + openssh-client: the git module, plugin clone, and repo operations. Repos on the
#   shared PVC use git@ SSH remotes — without `ssh`, every fetch/push fails.
# less: git's default pager; procps: `ps` for agents inspecting their own processes.
# jq/skopeo/age/python3: the Debian-packaged members of the paseo toolchain (the rest
#   arrive as release binaries from the toolchain stage). age pairs with sops for the
#   cluster's SOPS-encrypted secrets.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
         tini git openssh-client ca-certificates curl less procps tzdata \
         jq skopeo age python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    # The node image already ships a `node` user at uid/gid 1000. Repoint its HOME at
    # /config, which is the persistent PVC mounted at runtime (paseo convention).
    && usermod -d /config node

COPY --from=builder /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=toolchain /out/bin/ /usr/local/bin/

# Recreate the launcher symlinks rather than COPYing them from the builder: COPY
# dereferences a symlink into a plain file, which breaks each launcher's relative
# `import '../dist/...'` resolution. Node must follow the link into the real package dir.
#
# claude MUST point at bin/claude.exe — the package's own `bin` mapping. Despite the .exe
# suffix that file is a ~289MB Linux ELF binary placed by the package's postinstall; there
# is no cli.js. The Claude Agent SDK resolves the bare string 'claude' off PATH and rejects
# anything that is not the native binary ("Claude Code native binary not found at claude").
RUN ln -sf ../lib/node_modules/@cloudcli-ai/cloudcli/dist-server/server/modules/cli/cli.js \
           /usr/local/bin/cloudcli \
    && ln -sf ../lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe /usr/local/bin/claude \
    && chmod -R a+rX /usr/local/lib/node_modules

# Assert the launcher and the toolchain actually run. Without this the image builds fine
# and the app starts healthy, then fails only at request time — the claude symlink was
# wrong once already and no probe could see it, because /health never exercises any of
# these binaries.
RUN test -x "$(readlink -f /usr/local/bin/claude)" \
    && claude --version \
    && kubectl version --client=true -o yaml >/dev/null \
    && helm version --short \
    && flux --version \
    && kustomize version \
    && kubeconform -v \
    && cosign version 2>/dev/null | head -1 \
    && crane version \
    && sops --version --disable-version-check \
    && yq --version \
    && gh --version | head -1 \
    && bao version \
    && uv --version \
    && grype version | head -2 \
    && syft version | head -2

# claude is root-owned and the container runs as uid 1000, so it cannot self-update.
# PATH appends the PVC npm prefix and the mise shims dir so tools installed at runtime
# under /config are reachable in NON-interactive shells too — agents never source
# ~/.bashrc, so `mise activate` never runs and the shims are otherwise invisible.
# APPENDED, not prepended, so baked /usr/local/bin always wins over a stale mise `latest`
# shim. Both dirs are created lazily and may not exist at build time. Mirrors paseo.
ENV HOME=/config \
    DISABLE_AUTOUPDATER=1 \
    PATH="${PATH}:/config/.npm-global/bin:/config/.local/share/mise/shims"

USER 1000

EXPOSE 3001

# Start the server module DIRECTLY — never `cloudcli start` and never `npm start`.
# The `cloudcli` bin wrapper fires `void checkForUpdates(true)` via setImmediate, and
# getLatestPackageVersion is a SYNCHRONOUS execSync('npm show @cloudcli-ai/cloudcli
# version'). It runs while the server import is still in flight and blocks the event loop
# for its whole duration — behind a NetworkPolicy with no registry.npmjs.org egress that
# stalls for npm's full retry budget before the port ever opens, silently (the error is
# swallowed with silent=true). Same class as the npm PID-1 update-notifier trap.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/usr/local/lib/node_modules/@cloudcli-ai/cloudcli/dist-server/server/index.js"]
