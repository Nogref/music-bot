#!/bin/sh
# Starts as root just long enough to make /data writable for PUID:PGID
# (Unraid: 99:100 = nobody:users), then drops privileges and runs the bot.
set -e

PUID="${PUID:-99}"
PGID="${PGID:-100}"
DATA_DIR="${DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R "$PUID:$PGID" "$DATA_DIR" 2>/dev/null || echo "entrypoint: warning: couldn't chown $DATA_DIR to $PUID:$PGID"
  exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups -- "$@"
fi

# Already started as a non-root user (e.g. docker run --user): just run.
exec "$@"
