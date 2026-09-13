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
# Fixes in v1.2.0:
#   - Backup package.json before overwriting, restore on build failure
#     so next update can retry (prevents "says updated but panel still old")
#   - Fix /proc/meminfo typo (was /proc/memsay)
#   - Merge .env.example into .env preserving existing values, adding missing keys
#   - Copy package.json into .next/standalone for runtime version fallback
#   - Verify standalone contains new version after build
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
ok()  { say "[OK] $*"; }

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

merge_env() {
  # Merge .env.example into .env: preserve existing values, add missing keys.
  # Also ensure critical keys like BKUP_APP_DIR, ABX_APP_DIR, etc. exist.
  local env_file="$APP_DIR/.env"
  local example_file="$APP_DIR/.env.example"

  # If .env doesn't exist, create from example + defaults
  if [ ! -f "$env_file" ]; then
    if [ -f "$example_file" ]; then
      cp "$example_file" "$env_file"
    else
      touch "$env_file"
    fi
  fi

  # Ensure required keys from install.sh template exist (PORT, DATABASE_URL, etc.)
  # We add them if missing, preserving existing values.
  local port_val
  port_val="$(grep -E '^PORT=' "$env_file" 2>/dev/null | cut -d= -f2- | head -1)"
  if [ -z "$port_val" ]; then
    port_val="3000"
    echo "PORT=$port_val" >> "$env_file"
  fi

  # DATABASE_URL
  if ! grep -qE '^DATABASE_URL=' "$env_file" 2>/dev/null; then
    echo "DATABASE_URL=file:$APP_DIR/db/custom.db" >> "$env_file"
  fi
  # BACKUP_DIR
  if ! grep -qE '^BACKUP_DIR=' "$env_file" 2>/dev/null; then
    echo "BACKUP_DIR=$APP_DIR/backups" >> "$env_file"
  fi
  # TZ
  if ! grep -qE '^TZ=' "$env_file" 2>/dev/null; then
    echo "TZ=Asia/Tehran" >> "$env_file"
  fi
  # BKUP_APP_DIR
  if ! grep -qE '^BKUP_APP_DIR=' "$env_file" 2>/dev/null; then
    echo "BKUP_APP_DIR=$APP_DIR" >> "$env_file"
  fi
  # ABX_APP_DIR (legacy compat)
  if ! grep -qE '^ABX_APP_DIR=' "$env_file" 2>/dev/null; then
    echo "ABX_APP_DIR=$APP_DIR" >> "$env_file"
  fi
  # BKUP_ENV_FILE
  if ! grep -qE '^BKUP_ENV_FILE=' "$env_file" 2>/dev/null; then
    echo "BKUP_ENV_FILE=$APP_DIR/.env" >> "$env_file"
  fi
  # ABX_ENV_FILE
  if ! grep -qE '^ABX_ENV_FILE=' "$env_file" 2>/dev/null; then
    echo "ABX_ENV_FILE=$APP_DIR/.env" >> "$env_file"
  fi

  # Merge keys from .env.example that are not in .env
  if [ -f "$example_file" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      # Skip comments and empty lines
      [[ "$line" =~ ^[[:space:]]*# ]] && continue
      [[ "$line" =~ ^[[:space:]]*$ ]] && continue
      # Extract key (before =)
      key="$(echo "$line" | cut -d= -f1 | tr -d '[:space:]')"
      [ -z "$key" ] && continue
      if ! grep -qE "^${key}=" "$env_file" 2>/dev/null; then
        echo "$line" >> "$env_file"
        say "    + added missing env key: $key (from .env.example)"
      fi
    done < "$example_file"
  fi
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
  say "[FAIL] could not determine the LATEST release from GitHub (network / token?) — running version left untouched"
  exit 1
fi

if [ "v$FROM_V" = "$TAG" ]; then
  write_state done "$FROM_V" "$FROM_V"
  say "[OK] Already on the latest release ($TAG)"
  rm -f /tmp/.bkup-update-notice
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
  say "[FAIL] could not download release ${TAG} — running version left untouched"
  exit 1
fi

GOT="$(grep -o '"version": *"[^"]*"' "$SRC/package.json" 2>/dev/null | head -1 | cut -d'"' -f4)"
if [ "$GOT" != "${TAG#v}" ]; then
  rm -rf /tmp/abx-update /tmp/abx-update.tar.gz
  write_state error "$FROM_V" "" "version mismatch: got v${GOT:-unknown}, expected ${TAG}"
  say "[FAIL] version mismatch (downloaded v${GOT:-unknown} != release ${TAG}) — running version left untouched"
  exit 1
fi

# ── CRITICAL FIX: backup current package.json so we can restore on build failure
# This prevents the bug where package.json is new but standalone is old,
# causing next run to think it's already latest.
PKG_BACKUP="/tmp/bkup-package-backup-${FROM_V}.json"
cp -a "$APP_DIR/package.json" "$PKG_BACKUP" 2>/dev/null || true

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
  # Restore backup if post-copy verification fails
  [ -f "$PKG_BACKUP" ] && cp -a "$PKG_BACKUP" "$APP_DIR/package.json" 2>/dev/null || true
  write_state error "$FROM_V" "" "post-copy verification failed"
  say "[FAIL] post-copy verification failed (disk has v${NEW_VERSION:-unknown}) — running version left untouched"
  exit 1
fi

say "==> [2/6] Code updated → v$NEW_VERSION  ${WEB_MODE:+(release $TAG)}"

# ── .env merge: preserve existing values, add missing keys from new template
say "==> [2.5/6] Merging .env with new template (preserving existing values)…"
merge_env
say "    .env merged — existing values preserved, missing keys added"

# ── low-RAM guard: swap so the build and the app are never OOM-killed ──
MEM_MB=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)
if [ "$MEM_MB" -lt 3000 ] && [ -z "$(swapon --noheadings 2>/dev/null)" ]; then
  say "small-RAM server (${MEM_MB}MB) detected — creating 2G swap (prevents OOM build/service kills)"
  fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile && mkswap /swapfile >/dev/null 2>&1 && swapon /swapfile >/dev/null 2>&1 || true
  grep -q "^/swapfile" /etc/fstab 2>/dev/null || echo "/swapfile none swap sw 0 0" >> /etc/fstab
  ok "swap enabled"
fi

say "==> [3/6] Installing dependencies + generating Prisma client…"
if ! bash "$SCRIPT_DIR/build-native.sh"; then
  # ── CRITICAL FIX: restore package.json on build failure so next update retries
  if [ -f "$PKG_BACKUP" ]; then
    cp -a "$PKG_BACKUP" "$APP_DIR/package.json" 2>/dev/null || true
    say "    ↩ restored package.json to v$FROM_V (build failed, will retry on next update)"
  fi
  write_state error "$FROM_V" "" "build failed"
  say "[FAIL] build failed — previous version is still running (v$FROM_V)"
  say "       Fix the build error and run update again. Package.json restored to v$FROM_V so update will retry."
  rm -f "$PKG_BACKUP"
  exit 1
fi
rm -f "$PKG_BACKUP"

# ── Post-build verification: ensure standalone has correct version
STANDALONE_PKG="$APP_DIR/.next/standalone/package.json"
if [ -f "$STANDALONE_PKG" ]; then
  STANDALONE_V="$(grep -o '"version": *"[^"]*"' "$STANDALONE_PKG" | head -1 | cut -d'"' -f4)"
  if [ "$STANDALONE_V" != "$NEW_VERSION" ]; then
    say "⚠ warning: standalone package.json version ($STANDALONE_V) != expected ($NEW_VERSION), fixing..."
    cp -a "$APP_DIR/package.json" "$STANDALONE_PKG" 2>/dev/null || true
  fi
else
  # build-native.sh should have copied it, but ensure it exists
  cp -a "$APP_DIR/package.json" "$STANDALONE_PKG" 2>/dev/null || true
fi

# Also verify that the built server.js exists and is not stale
if [ ! -f "$APP_DIR/.next/standalone/server.js" ]; then
  write_state error "$FROM_V" "$NEW_VERSION" "build output missing"
  say "[FAIL] build completed but standalone/server.js missing — aborting"
  exit 1
fi

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
  # ensure the running service gets a sane heap (old installs had 256MB — OOM crash loop)
  sed -i 's/max-old-space-size=[0-9]*/max-old-space-size=768/' "/etc/systemd/system/${SVC}.service" 2>/dev/null || true
  systemctl daemon-reload >/dev/null 2>&1
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
  rm -f /tmp/.bkup-update-notice
  say "[OK] Update complete: v$FROM_V -> v$NEW_VERSION (service is healthy — web panel and CLI are now on v$NEW_VERSION)"
  # Final verification: ensure running version matches expected
  RUNNING_V="$(curl -sf "http://127.0.0.1:${PORT}/api/system/info" 2>/dev/null | grep -o '"appVersion": *"[^"]*"' | head -1 | cut -d'"' -f4)"
  if [ -n "$RUNNING_V" ] && [ "$RUNNING_V" != "$NEW_VERSION" ]; then
    say "⚠ warning: API reports v$RUNNING_V but expected v$NEW_VERSION — service may need a second restart"
    if [ -n "$SVC" ]; then
      systemctl restart "$SVC" 2>/dev/null
      sleep 3
    fi
  fi
  exit 0
else
  write_state error "$FROM_V" "$NEW_VERSION" "health check failed"
  say "[WARN] Update applied but health check failed — service logs (last 30 lines):"
  journalctl -u "${SVC:-bkup}" -n 30 --no-pager 2>/dev/null | tail -30 || true
  exit 1
fi
