# syntax=docker/dockerfile:1

# renovate: datasource=docker depName=python versioning=docker
ARG PYTHON_VERSION=3.14-slim

# renovate: datasource=npm depName=@anthropic-ai/claude-code
ARG CLAUDE_VERSION=2.1.280

# librarian: BookOrbit intake service. A Python staging core (intake scan,
# hashing, dossiers, guards, dry-run plans) plus a sandboxed `claude -p` run
# that proposes where each arrival belongs. DRY_RUN only in this release.
#
# amd64 only (images/librarian/.platforms): the Claude Code native binary is
# per-arch and must not be QEMU-built for arm64.

# ============================================================================
# Builder: fetch Claude Code with the official installer. Same Debian/glibc
# base as the runtime, so install.sh picks the glibc build and its launcher
# (bin/claude -> share/claude/versions/<v>) is valid when copied across.
# ============================================================================
FROM python:${PYTHON_VERSION} AS claude

ARG CLAUDE_VERSION

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Install into a fixed HOME and keep the whole tree, so the launcher symlink
# resolves at runtime; the runtime HOME of each run is a per-run emptyDir dir.
RUN HOME=/opt/claude bash -c "curl -fsSL https://claude.ai/install.sh | bash -s ${CLAUDE_VERSION}" \
    # The installer has a history of not creating the bin symlink: fail the
    # build rather than ship a stub.
    && test -x "$(readlink -f /opt/claude/.local/bin/claude)" \
    && chmod -R a+rX /opt/claude


# ============================================================================
# Runtime
# ============================================================================
FROM python:${PYTHON_VERSION}

ARG CLAUDE_VERSION
ARG BUILD_DATE
ARG VCS_REF

# renovate: datasource=pypi depName=requests
ARG REQUESTS_VERSION=2.34.2
# renovate: datasource=pypi depName=prometheus-client
ARG PROMETHEUS_CLIENT_VERSION=0.26.0
# mcp 1.x only: 2.x is a breaking major the shim is not written for.
# renovate: datasource=pypi depName=mcp
ARG MCP_VERSION=1.30.0

LABEL org.opencontainers.image.title="librarian" \
      org.opencontainers.image.description="BookOrbit intake librarian: staging core + sandboxed claude -p (dry-run)" \
      org.opencontainers.image.source="https://github.com/sharkusmanch/containers" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.licenses="MIT"

# ffmpeg supplies ffprobe (audio metadata/chapters for dossiers); tini is PID 1
# so SIGTERM reaches python and the claude/MCP-shim children are reaped.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
      "requests==${REQUESTS_VERSION}" \
      "prometheus-client==${PROMETHEUS_CLIENT_VERSION}" \
      "mcp==${MCP_VERSION}"

COPY --from=claude /opt/claude /opt/claude
RUN ln -sf /opt/claude/.local/bin/claude /usr/local/bin/claude

# No writable HOME: the service itself never needs one, and every claude run
# gets HOME/CLAUDE_CONFIG_DIR under RUNS_ROOT (/tmp/runs, an emptyDir).
RUN groupadd -g 911 app \
    && useradd -u 911 -g 911 -M -d /nonexistent -s /usr/sbin/nologin app

# PYTHONPATH=/app makes `python -m app.main` independent of the pod's
# workingDir; the MCP shim derives the same /app for its own children.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app

WORKDIR /app
COPY app/ /app/app/
COPY tests/ /app/tests/
COPY evals/ /app/evals/
# Bytecode is compiled here because the root filesystem is read-only at runtime.
RUN python -m compileall -q /app/app

USER 911:911

# Fail the BUILD, not the pod: the pinned claude must run on this base, ffprobe
# must exist, the package must import, and the shim's derived PYTHONPATH must
# be the directory that holds the `app` package.
RUN set -eux; \
    tmp="$(mktemp -d)"; \
    HOME="$tmp" claude --version | tee /dev/stderr | grep -q "${CLAUDE_VERSION}"; \
    rm -rf "$tmp"; \
    ffprobe -version >/dev/null; \
    tini --version; \
    python -c "import app.main, app.mcp_shim, app.readalong.job, app.readalong.__main__"; \
    python -c "from app import mcp_shim; p = mcp_shim._PACKAGE_PARENT; assert p == '/app', p; print('shim PYTHONPATH', p)"

EXPOSE 9090
ENTRYPOINT ["tini", "--", "python", "-m", "app.main"]
