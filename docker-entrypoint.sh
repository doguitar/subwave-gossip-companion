#!/bin/sh
set -eu

mkdir -p "${GOSSIP_BASE_DIR}/data" "${GOSSIP_BASE_DIR}/logs"
cp /app/prompt.md "${GOSSIP_BASE_DIR}/prompt.md.default"
if [ ! -s "${GOSSIP_BASE_DIR}/prompt.md" ]; then
  cp "${GOSSIP_BASE_DIR}/prompt.md.default" "${GOSSIP_BASE_DIR}/prompt.md"
fi
cp /app/review.md "${GOSSIP_BASE_DIR}/review.md.default"
if [ ! -s "${GOSSIP_BASE_DIR}/review.md" ]; then
  cp "${GOSSIP_BASE_DIR}/review.md.default" "${GOSSIP_BASE_DIR}/review.md"
fi
if [ ! -s "${GOSSIP_BASE_DIR}/gossip-types.json" ]; then
  cp /app/gossip-types.json "${GOSSIP_BASE_DIR}/gossip-types.json"
fi

exec "$@"
