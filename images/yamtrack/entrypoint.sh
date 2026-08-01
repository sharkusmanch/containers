#!/bin/sh

set -e

# Upstream's entrypoint additionally runs groupmod/usermod/chown to remap `abc`
# to $PUID/$PGID. That is baked into the image at build time here, so this drops
# straight to migrate + supervisord and needs no root.

python manage.py migrate --noinput

exec supervisord -c /etc/supervisord.conf
