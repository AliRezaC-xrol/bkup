#!/usr/bin/env bash
# =============================================================
# bkup — local Telegram Bot API server setup (ONE command)
# After this, bkup sends backups up to 2GB as ONE single file —
# no splitting, ever (the public api.telegram.org caps at 50MB).
# You need api_id + api_hash from https://my.telegram.org
# (API development tools) — free, one minute.
# =============================================================
set -euo pipefail
APP_DIR="${BKUP_APP_DIR:-/opt/bkup}"
G=$'\033[1;32m'; Y=$'\033[1;33m'; C=$'\033[1;36m'; R=$'\033[1;31m'; N=$'\033[0m'
ok(){ echo -e "${G}$*${N}"; }
info(){ echo -e "${C}$*${N}"; }
fail(){ echo -e "${R}$*${N}"; }

[ "$(id -u)" = "0" ] || { fail "run as root"; exit 1; }

# swap (the compile needs RAM headroom)
if [ -z "$(swapon --noheadings 2>/dev/null)" ]; then
  info "creating 2G swap for the build…"
  fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q "^/swapfile" /etc/fstab 2>/dev/null || echo "/swapfile none swap sw 0 0" >> /etc/fstab
fi

API_ID="${API_ID:-}"; API_HASH="${API_HASH:-}"
[ -z "$API_ID" ] && read -rp "api_id (from my.telegram.org): " API_ID
[ -z "$API_HASH" ] && read -rp "api_hash: " API_HASH
[[ "$API_ID" =~ ^[0-9]+$ ]] && [ ${#API_HASH} -ge 32 ] || { fail "invalid api_id/api_hash"; exit 1; }

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null 2>&1 || true
apt-get install -y -qq git cmake g++ make libssl-dev zlib1g-dev >/dev/null 2>&1 || true

mkdir -p /var/lib/telegram-bot-api
RUN_ARGS="--api-id=${API_ID} --api-hash=${API_HASH} --local --http-port=8081 --dir=/var/lib/telegram-bot-api --temp-dir=/var/lib/telegram-bot-api/tmp"

install_via_docker() {
  command -v docker >/dev/null 2>&1 || return 1
  docker info >/dev/null 2>&1 || return 1
  info "==> Docker detected — pulling the prebuilt telegram-bot-api image (fast)…"
  docker rm -f telegram-bot-api >/dev/null 2>&1 || true
  docker run -d --name telegram-bot-api --restart=always \
    -v /var/lib/telegram-bot-api:/var/lib/telegram-bot-api \
    -p 127.0.0.1:8081:8081 \
    aiogram/telegram-bot-api:latest $RUN_ARGS >/dev/null 2>&1 || return 1
  return 0
}

install_from_source() {
  info "==> compiling telegram-bot-api from source (one-time, 10–30 min)…"
  rm -rf /tmp/tba
  # td/ is a git SUBMODULE — without --recurse-submodules CMake dies with
  # "…/td does not contain a CMakeLists.txt" (exactly the bug users hit)
  git clone --depth 1 --recurse-submodules --shallow-submodules -j2 \
      https://github.com/tdlib/telegram-bot-api.git /tmp/tba
  mkdir -p /tmp/tba/build
  cd /tmp/tba/build
  JOBS="$(nproc)"; [ "$JOBS" -gt 2 ] && JOBS=2   # stay within small-VPS RAM
  info "==> configuring…"
  if ! cmake -DCMAKE_BUILD_TYPE=Release .. > cmake.log 2>&1; then
    fail "CMake failed — last lines:"; tail -25 cmake.log; exit 1
  fi
  info "==> compiling with ${JOBS} jobs — this takes a while, do not close the terminal…"
  if ! make -j"$JOBS" > make.log 2>&1; then
    fail "compile failed — last lines:"; tail -25 make.log; exit 1
  fi
  install -m755 bin/telegram-bot-api /usr/local/bin/telegram-bot-api
  rm -rf /tmp/tba
  ok "telegram-bot-api installed"
}

if install_via_docker; then
  ok "telegram-bot-api container is up"
else
  install_from_source
  cat > /etc/systemd/system/telegram-bot-api.service <<EOF
[Unit]
Description=Telegram Bot API server (local — single-file uploads up to 2GB)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/telegram-bot-api ${RUN_ARGS}
Restart=always
RestartSec=5
CPUAccounting=true
CPUQuota=50%
MemoryAccounting=true

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now telegram-bot-api
fi

info "waiting for the local server…"
UP=0; for i in $(seq 1 30); do sleep 2; curl -sf -o /dev/null "http://127.0.0.1:8081" && { UP=1; break; }; done
[ "$UP" = "1" ] || { fail "server did not come up — check: journalctl -u telegram-bot-api -n 30"; exit 1; }
ok "local Bot API server is up on 127.0.0.1:8081"

# point bkup at it (direct config write, same DB the panel uses)
if [ -d "$APP_DIR" ]; then
  DB_URL=$(grep -E '^DATABASE_URL=' "$APP_DIR/.env" 2>/dev/null | cut -d= -f2- || echo "file:$APP_DIR/db/custom.db")
  DATABASE_URL="$DB_URL" node "$APP_DIR/scripts/cli/set-api-base.mjs" "http://127.0.0.1:8081" \
    && ok "bkup now uploads through the local server (single-file up to 2GB)" \
    || info "set it manually in the web panel: Telegram settings -> API base = http://127.0.0.1:8081"
  systemctl restart bkup 2>/dev/null || true
fi
ok "DONE — backups up to 2GB are delivered as ONE file, no splitting"
