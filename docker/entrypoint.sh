#!/bin/sh
set -e

DATA_DIR=/app/data
DB_FILE="$DATA_DIR/prod.db"

# First boot: create the database from the baked-in template
if [ ! -f "$DB_FILE" ]; then
  echo "[entrypoint] initializing database at $DB_FILE"
  cp /app/prisma/template.db "$DB_FILE"
fi

echo "[entrypoint] starting bkup on port ${PORT:-3000}"
exec bun /app/server.js
