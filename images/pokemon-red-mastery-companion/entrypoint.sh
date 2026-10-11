#!/bin/sh
set -eu
export LC_ALL=C
SAVE_FILE=${SAVE_FILE:-/saves/red.srm}
COMPANION_UPSTREAM=${COMPANION_UPSTREAM:-127.0.0.1:9999}
fail() { echo "Invalid $1" >&2; exit 1; }
# Keep quoted nginx paths literal, including spaces. Reject control characters,
# quotes, backslashes, variables and directive delimiters before substitution.
case "$SAVE_FILE" in /*) ;; *) fail SAVE_FILE ;; esac
[ "$SAVE_FILE" = "$(printf '%s' "$SAVE_FILE" | tr -cd 'A-Za-z0-9_./ ()+,-')" ] || fail SAVE_FILE
[ "$COMPANION_UPSTREAM" = "$(printf '%s' "$COMPANION_UPSTREAM" | tr -cd 'A-Za-z0-9.:-')" ] || fail COMPANION_UPSTREAM
printf '%s' "$COMPANION_UPSTREAM" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9.-]*:[1-9][0-9]{0,4}$' || fail COMPANION_UPSTREAM
[ "${COMPANION_UPSTREAM##*:}" -le 65535 ] || fail COMPANION_UPSTREAM
export SAVE_FILE COMPANION_UPSTREAM
# Restrict envsubst to these two trusted settings; nginx's $uri and
# $request_method must survive unchanged even if similarly named env vars exist.
envsubst '${SAVE_FILE} ${COMPANION_UPSTREAM}' < /etc/nginx/nginx.conf.template > /tmp/nginx.conf
exec nginx -e /dev/stderr -c /tmp/nginx.conf "$@"
