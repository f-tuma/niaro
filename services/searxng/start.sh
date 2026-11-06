#!/bin/sh
# The secret only signs SearXNG's own cookies; nobody keeps a session with this
# private instance, so a fresh random one per start is enough when none is set.
set -eu
if [ -z "${SEARXNG_SECRET:-}" ]; then
  SEARXNG_SECRET=$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')
fi
export SEARXNG_SECRET
exec /usr/local/searxng/entrypoint.sh "$@"
