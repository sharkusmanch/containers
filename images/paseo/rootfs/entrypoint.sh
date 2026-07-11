#!/bin/sh
# paseo entrypoint — seed a default config.json on first boot, then exec the daemon.
#
# NOT `set -e`: no config-seed hiccup should ever stop the daemon from starting. The
# seed only runs when config.json is absent and silently no-ops on any error.
#
# Why seed at all: paseo's built-in defaults background-download local voice models
# (parakeet/kokoro) into PASEO_HOME. Voice is intentionally OFF here, so this config
# disables it. Relay is ON: direct-over-Tailscale stays the primary path, but a phone
# on cellular/CGNAT rides a lossy UDP path where the long-lived WebSocket dies (WS 1006
# reconnect loops); paseo's E2EE relay (NaCl box, blind-forwarded via relay.paseo.sh
# over wss/TCP) is the designed fallback that survives it. PASEO_HOME is on a shared
# PVC, so a baked image file can't supply config.json; we seed it here once.

PASEO_HOME="${PASEO_HOME:-${HOME:-/config}/.paseo}"
cfg="${PASEO_HOME}/config.json"

if [ ! -f "${cfg}" ]; then
  mkdir -p "${PASEO_HOME}" 2>/dev/null || true
  cat > "${cfg}" <<'JSON' 2>/dev/null || true
{
  "version": 1,
  "daemon": { "relay": { "enabled": true, "useTls": true } },
  "features": {
    "dictation": { "enabled": false },
    "voiceMode": { "enabled": false }
  }
}
JSON
fi

# PASEO_LISTEN / PASEO_PASSWORD / PASEO_HOME are read from the environment by paseo.
# --relay-use-tls: wss:// to the default relay endpoint (relay.paseo.sh:443).
exec paseo daemon start --foreground --relay-use-tls
