#!/bin/sh
set -eu

mkdir -p /data/public /data/database

# Seed SQLite once from the image if volume is empty.
if [ ! -f /data/database/database.sqlite ] && [ -f /app/core/database/database.sqlite ]; then
  cp /app/core/database/database.sqlite /data/database/database.sqlite
  echo "Seeded /data/database/database.sqlite from image"
fi

# Prefer volume paths when present.
export DB_PATH="${DB_PATH:-/data/database/database.sqlite}"
export PUBLIC_DIR="${PUBLIC_DIR:-/data/public}"
export INTERACTIONS_PATH="${INTERACTIONS_PATH:-/data/storefront_interactions.json}"
export HOST="${HOST:-0.0.0.0}"
export APP_ROOT="${APP_ROOT:-/app}"

# If volume public is empty but image has public, use image as fallback.
if [ ! -d "$PUBLIC_DIR/images" ] && [ -d /app/core/public/images ]; then
  export PUBLIC_DIR=/app/core/public
  echo "Using image public dir fallback: $PUBLIC_DIR"
fi

echo "DB_PATH=$DB_PATH"
echo "PUBLIC_DIR=$PUBLIC_DIR"
exec python tools/local_api_server.py
