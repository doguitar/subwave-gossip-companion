#!/bin/sh
set -eu

mkdir -p "${GOSSIP_BASE_DIR}/data" "${GOSSIP_BASE_DIR}/logs"
if [ ! -s "${GOSSIP_BASE_DIR}/prompt.md" ]; then
  cp /app/prompt.md "${GOSSIP_BASE_DIR}/prompt.md"
fi
if [ ! -s "${GOSSIP_BASE_DIR}/gossip-types.json" ]; then
  cp /app/gossip-types.json "${GOSSIP_BASE_DIR}/gossip-types.json"
fi

exec "$@"
