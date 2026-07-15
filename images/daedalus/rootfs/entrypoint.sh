#!/bin/sh
# daedalus entrypoint — runs entirely as the unprivileged "abc" (uid 1000). Fast
# config-only setup against the persistent /config PVC, then execs sshd. No
# package installs (toolchain is baked), no s6, no privilege drops (already abc),
# single process.
#
# NOT `set -e`: this is the operator's only remote entry. No config-only step
# should ever prevent sshd from starting — sshd itself fails loudly if host keys
# are genuinely missing, and RollingUpdate keeps the old pod serving on failure.

export HOME=/config
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin

echo "=== daedalus entrypoint starting (uid $(id -u)) ==="

# --- SSH host keys (persist on /config so clients don't see key changes) -------
mkdir -p /config/ssh_host_keys
# ed25519 (preferred) + rsa (legacy-client fallback). ecdsa intentionally omitted.
for t in ed25519 rsa; do
  key="/config/ssh_host_keys/ssh_host_${t}_key"
  if [ ! -f "$key" ]; then
    echo ">>> Generating missing ${t} host key..."
    ssh-keygen -t "$t" -f "$key" -N "" -q
  fi
done
chmod 600 /config/ssh_host_keys/*_key 2>/dev/null || true

# --- ~/.ssh + authorized_keys -------------------------------------------------
mkdir -p /config/.ssh && chmod 700 /config/.ssh
[ -f /config/.ssh/authorized_keys ] || { : > /config/.ssh/authorized_keys && chmod 600 /config/.ssh/authorized_keys; }

echo ">>> Refreshing authorized_keys (best-effort)..."
curl -fsSL --max-time 10 https://github.com/sharkusmanch.keys >> /config/.ssh/authorized_keys 2>/dev/null || true
curl -fsSL --max-time 10 https://sshid.io/sharkusmanch    >> /config/.ssh/authorized_keys 2>/dev/null || true
sort -u /config/.ssh/authorized_keys -o /config/.ssh/authorized_keys 2>/dev/null || true
if [ ! -s /config/.ssh/authorized_keys ]; then
  echo ">>> WARNING: /config/.ssh/authorized_keys is EMPTY — key login will be impossible!" >&2
fi

# --- git SSH key (first run only) ---------------------------------------------
if [ ! -f /config/.ssh/id_ed25519_github ]; then
  ssh-keygen -t ed25519 -f /config/.ssh/id_ed25519_github -N "" -C daedalus-git </dev/null
  echo "=============================================="
  echo ">>> Add this public key to GitHub and Forgejo:"
  cat /config/.ssh/id_ed25519_github.pub
  echo "=============================================="
fi

# --- SSH client config for git hosts (first run only) -------------------------
if [ ! -f /config/.ssh/config ]; then
  echo ">>> Creating SSH client config for git hosts..."
  cat > /config/.ssh/config <<'SSHCFG'
Host github.com
  IdentityFile ~/.ssh/id_ed25519_github
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new

Host forgejo.sharkus.xyz
  IdentityFile ~/.ssh/id_ed25519_github
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
SSHCFG
  chmod 600 /config/.ssh/config
fi

# --- git global config (first run only) ---------------------------------------
if [ ! -f /config/.gitconfig ]; then
  echo ">>> Setting up git config..."
  git config --global user.name sharkusmanch
  git config --global user.email sharkusmanch@users.noreply.github.com
  git config --global init.defaultBranch main
fi

# --- wiki-js-mcp venv (if repo present, venv missing) -------------------------
if [ -d /config/mcp/wiki-js-mcp ] && [ ! -d /config/mcp/wiki-js-mcp/venv ]; then
  echo ">>> Setting up wiki-js-mcp virtualenv..."
  ( cd /config/mcp/wiki-js-mcp && python3 -m venv venv && . venv/bin/activate && pip install -r requirements.txt ) || true
fi

# --- register wiki-js MCP with Claude (if not already) ------------------------
if [ -x /usr/local/bin/claude ] && [ -d /config/mcp/wiki-js-mcp ]; then
  if ! grep -q 'wiki-js-mcp' /config/.claude.json 2>/dev/null; then
    echo ">>> Registering wiki-js MCP server..."
    /usr/local/bin/claude mcp add --scope user wikijs /config/mcp/wiki-js-mcp/start-server.sh || true
  fi
fi

echo "=== daedalus entrypoint complete; starting sshd ==="
exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config
