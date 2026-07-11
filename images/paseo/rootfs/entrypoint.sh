#!/bin/sh
# paseo entrypoint — seed a default config.json on first boot, then exec the daemon.
#
# NOT `set -e`: no config-seed hiccup should ever stop the daemon from starting. The
# seed only runs when config.json is absent and silently no-ops on any error.
#
# Why seed at all: paseo's built-in defaults (a) keep a relay control-connection to
# paseo.sh open and (b) background-download local voice models (parakeet/kokoro) into
# PASEO_HOME. This deployment is direct-over-Tailscale with voice OFF, so we disable
# both — relay via the --no-relay flag below, voice via this config.json. PASEO_HOME is
# on a shared PVC, so a baked image file can't supply it; we seed it here once.

PASEO_HOME="${PASEO_HOME:-${HOME:-/config}/.paseo}"
cfg="${PASEO_HOME}/config.json"

if [ ! -f "${cfg}" ]; then
  mkdir -p "${PASEO_HOME}" 2>/dev/null || true
  cat > "${cfg}" <<'JSON' 2>/dev/null || true
{
  "version": 1,
  "daemon": { "relay": { "enabled": false } },
  "features": {
    "dictation": { "enabled": false },
    "voiceMode": { "enabled": false }
  }
}
JSON
fi

# PASEO_LISTEN / PASEO_PASSWORD / PASEO_HOME are read from the environment by paseo.
exec paseo daemon start --foreground --no-relay
