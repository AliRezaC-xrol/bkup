#!/usr/bin/env bash
# =============================================================
# bkup — in-place updater (NO reinstall needed). New releases reach every
# existing install via this script (web panel button or CLI menu item 7).
#   bash scripts/update.sh          → interactive-ish, human output
#   bash scripts/update.sh --web    → quiet-ish, for web-panel triggered updates
#
# ONE SOURCE OF TRUTH: the LATEST GitHub RELEASE.
# Resolves the newest published release, downloads exactly that tag,
# VERIFIES the code version matches it and only then updates in place.
# If the latest release cannot be resolved/verified it aborts with the
# running version untouched — it will NEVER "update" to a stale copy.
#
# Preserves: database (db/custom.db), backups, .env, .cli-secret
# =============================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WEB_MODE=0
[ "${1:-}" = "--web" ] && WEB_MODE=1

STATE_DIR="$APP_DIR/data"
STANDALONE_DATA="$APP_DIR/.next/standalone/data"
STATE_FILE="$STATE_DIR/update-state.json"
LOG_FILE="$STATE_DIR/update.log"
REPO="${GITHUB_REPO:-AliRezaC-xrol/bkup}"

say() { if [ "$WEB_MODE" = "1" ]; then echo "$*"; else echo -e "$*"; fi; }

write_state() {
  # web app reads $cwd/data → standalone cwd; write both spots
  for d in "$STATE_DIR" "$STANDALONE_DATA"; do
    mkdir -p "$d" 2>/dev/null
    python3 - "$d/update-state.json" "$1" "$2" "$3" <<'PY' 2>/dev/null || echo "$4" > "$d/update-state.json"
import json, sys, time
path, state, from_v, to_v = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
try:
    data = json.load(open(path))
except Exception:
    data = {}
data.update({"state": state, "startedAt": data.get("startedAt", int(time.time()*1000)), "fromVersion": from_v, "toVersion": to_v})
if state != "running":
    data["finishedAt"] = int(time.time()*1000)
json.dump(data, open(path, "w"), indent=2)
PY
  done
}

FROM_V="${ABX_FROM_VERSION:-$(python3 -c "import json;print(json.load(open('$APP_DIR/package.json'))['version'])" 2>/dev/null || echo '?')}"

mkdir -p "$STATE_DIR"
cd "$APP_DIR" || exit 1

# token: env var first, then the one stored by the installer
TOKEN="${GITHUB_TOKEN:-}"
[ -z "$TOKEN" ] && [ -f "$APP_DIR/.github-token" ] && TOKEN="$(tr -d '[:space:]' < "$APP_DIR/.github-token")"
AUTH=(); [ -n "$TOKEN" ] && AUTH=(-H "Authorization: Bearer $TOKEN")

say "==> [1/6] Resolving the latest release on GitHub…"

TAG="$(curl -sf "${AUTH[@]}" --max-time 15 --retry 2 \
        "https://api.github.com/repos/${REPO}/releases/latest" \
        | grep -o '"tag_name": *"[^"]*"' | head -1 | cut -d'"' -f4)" || TAG=""
if [ -z "$TAG" ]; then
  write_state error "$FROM_V" "" "cannot determine latest release"
  say "✗ could not determine the LATEST release from GitHub (network / token?) — running version left untouched"
  exit 1
fi

if [ "v$FROM_V" = "$TAG" ]; then
  write_state done "$FROM_V" "$FROM_V"
  say "✔ Already on the latest release ($TAG)"
  exit 0
fi

say "    installed: v$FROM_V   latest release: $TAG   → updating"

# download exactly the latest release and verify it before touching anything
rm -rf /tmp/abx-update /tmp/abx-update.tar.gz
mkdir -p /tmp/abx-update
curl -fL "${AUTH[@]}" --max-time 300 --retry 2 \
    "https://github.com/${REPO}/archive/refs/tags/${TAG}.tar.gz" \
    -o /tmp/abx-update.tar.gz >/dev/null 2>&1 \
  || curl -fL "${AUTH[@]}" --max-time 300 --retry 2 \
    "https://api.github.com/repos/${REPO}/tarball/${TAG}" \
    -o /tmp/abx-update.tar.gz >/dev/null 2>&1

if [ -s /tmp/abx-update.tar.gz ] && tar -xzf /tmp/abx-update.tar.gz -C /tmp/abx-update 2>/dev/null; then
  SRC="$(find /tmp/abx-update -maxdepth 1 -mindepth 1 -type d | head -1)"
else
  SRC=""
fi
if [ -z "$SRC" ]; then
  rm -rf /tmp/abx-update /tmp/abx-update.tar.gz
  write_state error "$FROM_V" "" "download of ${TAG} failed"
  say "✗ could not download release ${TAG} — running version left untouched"
  exit 1
fi

GOT="$(grep -o '"version": *"[^"]*"' "$SRC/package.json" 2>/dev/null | head -1 | cut -d'"' -f4)"
if [ "$GOT" != "${TAG#v}" ]; then
  rm -rf /tmp/abx-update /tmp/abx-update.tar.gz
  write_state error "$FROM_V" "" "version mismatch: got v${GOT:-unknown}, expected ${TAG}"
  say "✗ version mismatch (downloaded v${GOT:-unknown} ≠ release ${TAG}) — running version left untouched"
  exit 1
fi

# copy code over the install, never touching runtime data
for item in src prisma public scripts docs docker .github \
            package.json bun.lock package-lock.json tsconfig.json next.config.ts \
            tailwind.config.ts postcss.config.mjs eslint.config.mjs components.json \
            cli.sh install.sh README.md README.fa.md CHANGELOG.md .env.example .gitignore .dockerignore Dockerfile docker-compose.yml; do
  if [ -e "$SRC/$item" ]; then cp -a "$SRC/$item" "$APP_DIR/" 2>/dev/null; fi
done
rm -rf /tmp/abx-update /tmp/abx-update.tar.gz

NEW_VERSION="$(grep -o '"version": *"[^"]*"' "$APP_DIR/package.json" | head -1 | cut -d'"' -f4)"
if [ "$NEW_VERSION" != "${TAG#v}" ]; then
  write_state error "$FROM_V" "" "post-copy verification failed"
  say "✗ post-copy verification failed (disk has v${NEW_VERSION:-unknown}) — running version left untouched"
  exit 1
fi

say "==> [2/6] Code updated → v$NEW_VERSION  ${WEB_MODE:+(release $TAG)}"

say "==> [3/6] Installing dependencies + generating Prisma client…"
bash "$SCRIPT_DIR/build-native.sh" || {
  write_state error "$FROM_V" "" "build failed"
  say "✗ build failed — previous version is still running"; exit 1
}

say "==> [4/6] Applying database migrations (data preserved)…"
DB_URL=$(grep -E '^DATABASE_URL=' "$APP_DIR/.env" 2>/dev/null | cut -d= -f2- || true)
if [ -z "$DB_URL" ]; then
  DB_URL="file:$APP_DIR/db/custom.db"
  mkdir -p "$APP_DIR/db"
fi
if command -v bun >/dev/null 2>&1; then
  DATABASE_URL="$DB_URL" bunx prisma db push --skip-generate 2>&1 | tail -2
else
  DATABASE_URL="$DB_URL" npx prisma db push --skip-generate 2>&1 | tail -2
fi

say "==> [5/6] Restarting service…"
SVC=""
if command -v systemctl >/dev/null 2>&1; then
  if systemctl list-unit-files 2>/dev/null | grep -q '^bkup.service'; then
    SVC="bkup"
  elif systemctl list-unit-files 2>/dev/null | grep -q '^autobackup-xui.service'; then
    # one-time migration: legacy autobackup-xui unit → bkup unit (same settings)
    say "    migrating service: autobackup-xui → bkup"
    sed 's/autobackup-xui/bkup/g' /etc/systemd/system/autobackup-xui.service > /etc/systemd/system/bkup.service 2>/dev/null
    systemctl daemon-reload >/dev/null 2>&1
    systemctl disable --now autobackup-xui >/dev/null 2>&1
    rm -f /etc/systemd/system/autobackup-xui.service
    systemctl daemon-reload >/dev/null 2>&1
    SVC="bkup"
  fi
fi
if [ -n "$SVC" ]; then
  systemctl enable "$SVC" >/dev/null 2>&1
  systemctl restart "$SVC" && say "    systemctl restart ${SVC}: OK"
else
  say "    (no systemd unit found — restart your process manually if needed)"
fi
# keep the CLI symlink fresh
ln -sf "$APP_DIR/cli.sh" /usr/local/bin/bkup 2>/dev/null
chmod +x "$APP_DIR/cli.sh" 2>/dev/null

say "==> [6/6] Health check…"
PORT=$(grep -E '^PORT=' "$APP_DIR/.env" 2>/dev/null | cut -d= -f2- || echo 3000)
OK=0
for i in $(seq 1 30); do
  sleep 2
  if curl -sf -o /dev/null "http://127.0.0.1:${PORT}/api/auth/state"; then OK=1; break; fi
done

if [ "$OK" = "1" ]; then
  write_state done "$FROM_V" "$NEW_VERSION"
  say "✔ Update complete: v$FROM_V → v$NEW_VERSION  (latest release ✓ — service is healthy)"
  exit 0
else
  write_state error "$FROM_V" "$NEW_VERSION" "health check failed"
  say "⚠ Update applied but health check failed — check: journalctl -u ${SVC:-bkup} -n 50"
  exit 1
fi
