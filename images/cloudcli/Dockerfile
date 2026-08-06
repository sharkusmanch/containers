# syntax=docker/dockerfile:1

# CLOUDCLI_VERSION MUST remain the FIRST `*_VERSION` ARG in this file.
# .github/workflows/build.yml derives the published image tag with
#   grep -E '^ARG.*_VERSION=' Dockerfile | head -1 | cut -d= -f2
# so reordering these ARGs silently tags the image with the Node version instead.
# renovate: datasource=npm depName=@cloudcli-ai/cloudcli
ARG CLOUDCLI_VERSION=1.37.0

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
ARG CLAUDE_VERSION=2.1.222

# Powers cloudcli's TaskMaster tab. Its check is a plain PATH lookup —
# spawn('which', ['task-master']) then spawn('task-master', ['--version']) — so the
# binary simply has to be on PATH. (Separately, taskmaster.service.js can also detect a
# `task-master-ai` MCP server declared in ~/.claude.json; that is config on the PVC,
# not an image concern.)
# renovate: datasource=npm depName=task-master-ai
ARG TASKMASTER_VERSION=0.43.1

# ============================================================================
# Builder — global npm installs + loud assertions that no native binding is missing
# ============================================================================
FROM node:${NODE_VERSION} AS builder

ARG CLOUDCLI_VERSION
ARG CLAUDE_VERSION
ARG TASKMASTER_VERSION

# ca-certificates + git: @vscode/ripgrep's postinstall downloads the `rg` binary from
# GitHub Releases over TLS. Do NOT add --ignore-scripts to the install below to "harden"
# it — that flag is what paseo uses to skip its voice-model downloads, but here it would
# silently skip the ripgrep fetch and leave the app's search broken at runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g "@cloudcli-ai/cloudcli@${CLOUDCLI_VERSION}" \
    && npm install -g "@anthropic-ai/claude-code@${CLAUDE_VERSION}" \
    && npm install -g "task-master-ai@${TASKMASTER_VERSION}" \
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
      org.opencontainers.image.description="CloudCLI (claudecodeui) web UI for coding agents, with claude baked in"

# tini: PID 1 reaper. cloudcli spawns interactive shells via node-pty and agent
#   subprocesses via the Claude Agent SDK; without an init they zombie.
# git + openssh-client: the git module, plugin clone, and repo operations. Repos on the
#   shared PVC use git@ SSH remotes — without `ssh`, every fetch/push fails.
# less: git's default pager; procps: `ps` for agents inspecting their own processes.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
         tini git openssh-client ca-certificates curl less procps \
    && rm -rf /var/lib/apt/lists/* \
    # The node image already ships a `node` user at uid/gid 1000. Repoint its HOME at
    # /config, which is the persistent PVC mounted at runtime (paseo convention).
    && usermod -d /config node

COPY --from=builder /usr/local/lib/node_modules /usr/local/lib/node_modules

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
    && ln -sf ../lib/node_modules/task-master-ai/dist/task-master.js /usr/local/bin/task-master \
    && chmod -R a+rX /usr/local/lib/node_modules

# Assert every recreated launcher actually resolves and runs. Without this the image
# builds fine and the app starts healthy, then fails only at request time — the claude
# symlink was wrong once already and no probe could see it, because /health never
# exercises either binary.
RUN test -x "$(readlink -f /usr/local/bin/claude)" \
    && claude --version \
    && test -x "$(readlink -f /usr/local/bin/task-master)" \
    && task-master --version

# claude is root-owned and the container runs as uid 1000, so it cannot self-update.
# PATH appends the mise shims dir so mise-managed tools installed at runtime under the
# /config PVC are reachable in NON-interactive shells too — agents never source ~/.bashrc,
# so `mise activate` never runs and the shims are otherwise invisible. APPENDED, not
# prepended, so baked /usr/local/bin always wins over a stale mise `latest` shim. The dir
# is created lazily by mise and may not exist at build time. Mirrors the paseo image.
ENV HOME=/config \
    DISABLE_AUTOUPDATER=1 \
    PATH="${PATH}:/config/.local/share/mise/shims"

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
