# Daedalus Image - Issues to Fix

## UID/GID Ownership
- Old LSIO deployment uses UID 911, new image uses UID 1000
- Root runs without DAC_OVERRIDE capability, so cannot access files owned by UID 911
- Need to decide: hardcode UID 911 for backward compat, make UID configurable at runtime, or chown at startup
- Consider not hardcoding UID/GID at all (anti-pattern) and handling ownership dynamically

## Init Script (ConfigMap in home-ops)
- File existence checks (`[[ -f ... ]]`) run as root (without DAC_OVERRIDE) while file operations run as `su-exec abc` — causes false negatives on checks
- `ssh-keygen` hangs waiting for interactive overwrite prompt when key already exists on PVC
- `cat` of `.pub` file fails with Permission denied when root lacks DAC_OVERRIDE
- Consider running entire init script as the app user instead of root

## Security Context
- Container runs as root (sshd requirement) but drops ALL capabilities
- Added back: CHOWN, SETUID, SETGID, NET_BIND_SERVICE
- May also need DAC_OVERRIDE for root to function properly, defeating purpose of dropping ALL
- Evaluate whether there's a better approach (e.g., rootless sshd, separate sshd container)

## Companion Web UI
- Untested — container crashed before companion could start
- Need to verify bun server starts correctly and serves the web UI on port 3456
- Need to verify WebSocket connections work through nginx ingress with oauth2-proxy

## General
- Image builds successfully in CI (verified)
- All tools present: claude, bun, kubectl, helm, go, git, node
- Need end-to-end testing once ownership/permission issues are resolved
