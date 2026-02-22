#!/bin/bash
set -e

# Run init script if mounted (ConfigMap from Kubernetes)
if [[ -x /init.d/setup.sh ]]; then
  echo ">>> Running init script..."
  /init.d/setup.sh
fi

# Generate SSH host keys if missing (persisted on PVC)
if [[ ! -f /home/abc/.sshd/ssh_host_ed25519_key ]]; then
  echo ">>> Generating SSH host keys..."
  ssh-keygen -t rsa -b 4096 -f /home/abc/.sshd/ssh_host_rsa_key -N "" -q
  ssh-keygen -t ecdsa -f /home/abc/.sshd/ssh_host_ecdsa_key -N "" -q
  ssh-keygen -t ed25519 -f /home/abc/.sshd/ssh_host_ed25519_key -N "" -q
  chown abc:abc /home/abc/.sshd/ssh_host_*
fi

# Start companion web UI in background
echo ">>> Starting The Companion on port 3456..."
su-exec abc bash -c 'cd /opt/companion && NODE_ENV=production PORT=3456 bun server/index.ts' &

# Start sshd in foreground
echo ">>> Starting sshd on port 2222..."
exec /usr/sbin/sshd -D -e
