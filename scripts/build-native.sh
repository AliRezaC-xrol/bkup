#!/usr/bin/env bash
# Build the Next.js app natively and assemble the standalone output.
# Used by install.sh and update.sh — safe to re-run.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PKG_MGR="npm"
command -v bun >/dev/null 2>&1 && PKG_MGR="bun"

echo "==> Installing dependencies ($PKG_MGR)…"
if [ "$PKG_MGR" = "bun" ]; then
  bun install --frozen-lockfile || bun install
  bunx prisma generate
else
  npm install --no-audit --no-fund
  npx prisma generate
fi

echo "==> Building app…"
if [ "$PKG_MGR" = "bun" ]; then
  bun run build
else
  npm run build
fi

echo "==> Assembling standalone output…"
rm -rf .next/standalone/public .next/standalone/.next/static
cp -r public .next/standalone/public
mkdir -p .next/standalone/.next
cp -r .next/static .next/standalone/.next/static
mkdir -p .next/standalone/data

if [ ! -f .next/standalone/server.js ]; then
  echo "✗ build output is incomplete (standalone/server.js missing)" >&2
  exit 1
fi

echo "✔ build complete"
