#!/usr/bin/env bash
# Runs once when the Codespace is created. It installs dependencies only.
# It never runs migrations against shared databases and never loads real patient/employee data.
set -euo pipefail

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example (development placeholders only)."
fi

npm ci

echo
echo "Setup complete. Next steps:"
echo "  make up        # start PostgreSQL and Redis"
echo "  make migrate   # apply migrations to the local dev database"
echo "  make dev       # run API (:4000) and web (:5173)"
