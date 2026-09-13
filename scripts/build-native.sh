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
# The package.json build script already copies static and public into standalone,
# but we clean and re-copy to ensure correctness after a previous failed build.
rm -rf .next/standalone/public .next/standalone/.next/static
cp -r public .next/standalone/public
mkdir -p .next/standalone/.next
cp -r .next/static .next/standalone/.next/static

# Preserve data directory inside standalone (update-state.json etc.)
mkdir -p .next/standalone/data
if [ -d "$ROOT/data" ]; then
  cp -a "$ROOT/data/." .next/standalone/data/ 2>/dev/null || true
fi

# Critical: copy package.json into standalone so runtime fallback
# src/lib/version.ts can read it even if NEXT_PUBLIC_APP_VERSION is missing.
# This also ensures `process.cwd()/package.json` returns correct version.
if [ -f "$ROOT/package.json" ]; then
  cp -a "$ROOT/package.json" .next/standalone/package.json
fi

# Verify build output
if [ ! -f .next/standalone/server.js ]; then
  echo "✗ build output is incomplete (standalone/server.js missing)" >&2
  exit 1
fi

# Verify that the built bundle contains the expected version
# (NEXT_PUBLIC_APP_VERSION is inlined at build time via next.config.ts)
BUILT_VERSION="$(grep -o '"version": *"[^"]*"' "$ROOT/package.json" | head -1 | cut -d'"' -f4)"
if [ -n "$BUILT_VERSION" ]; then
  STANDALONE_V="$(grep -o '"version": *"[^"]*"' .next/standalone/package.json 2>/dev/null | head -1 | cut -d'"' -f4)"
  if [ "$STANDALONE_V" != "$BUILT_VERSION" ]; then
    echo "⚠ standalone package.json version mismatch: $STANDALONE_V vs $BUILT_VERSION (will still work via inlined env)" >&2
  fi
fi

echo "✔ build complete (v${BUILT_VERSION:-unknown})"
