#!/usr/bin/env bash
# =============================================================
#  bkup — installer
#  Auto Backup for 3x-ui + HM Panel + PasarGuard → Telegram
#
#  ONE SOURCE OF TRUTH: the LATEST GitHub RELEASE.
#  The installer resolves the newest published release, downloads
#  exactly that release, VERIFIES the code version matches it and
#  only then installs. If the latest release cannot be resolved or
#  verified, it aborts — it will NEVER install a stale copy.
#
#  Installs: Node 20 (if missing) → latest release → build →
#  systemd service (auto-start on boot) → `bkup` CLI.
#  Re-running it on an existing server UPDATES the code in place
#  and PRESERVES all data, settings and backups.
#
#  Usage:
#    bash <(curl -fsSL https://raw.githubusercontent.com/AliRezaC-xrol/bkup/main/install.sh)
#    (private repo? prefix:  GITHUB_TOKEN=ghp_xxx  and add the same
#     Authorization header to the curl above)
# =============================================================
set -uo pipefail

if [ -t 1 ]; then
  G=$'\033[1;32m'; C=$'\033[1;36m'; Y=$'\033[1;33m'; R=$'\033[1;31m'; B=$'\033[1m'; W=$'\033[1;37m'; D=$'\033[2m'; N=$'\033[0m'
else
  G=""; C=""; Y=""; R=""; B=""; W=""; D=""; N=""
fi

banner() {
  echo -e "${W}"
  cat <<'ART'
  ██████╗ ██╗  ██╗██╗   ██╗██████╗
  ██╔══██╗██║ ██╔╝██║   ██║██╔══██╗
  ██████╔╝█████╔╝ ██║   ██║██████╔╝
  ██╔══██╗██╔═██╗ ██║   ██║██╔═══╝
  ██████╔╝██║  ██╗╚██████╔╝██║
  ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚═╝
ART
  echo -e "${W}     b k u p${N}  ${D}installer${N}"
  echo -e "${D}     Auto Backup for 3x-ui + HM Panel + PasarGuard → Telegram${N}"
  echo ""
}

die() { echo -e "${R}✗ $*${N}"; exit 1; }
info() { echo -e "${C}==>${N} $*"; }
ok()   { echo -e "${G}✔${N} $*"; }

# Root is required for /opt, systemd and /usr/local/bin.
# Containers or rootless installs can opt out: BKUP_SKIP_ROOT_CHECK=1 bash install.sh
if [ "${BKUP_SKIP_ROOT_CHECK:-0}" != "1" ] && [ "${ABX_SKIP_ROOT_CHECK:-0}" != "1" ] && [ "$(id -u)" != "0" ]; then
  die "run as root:  sudo bash install.sh"
fi

banner

REPO_SLUG="${REPO_SLUG:-AliRezaC-xrol/bkup}"
APP_DIR="${APP_DIR:-/opt/bkup}"
SERVICE="bkup"
LEGACY_APP_DIR="/opt/auto-backup-xui"
LEGACY_SERVICE="autobackup-xui"

# Auth headers for GitHub (only needed while the repo is private/flagged)
GH_AUTH=(); [ -n "${GITHUB_TOKEN:-}" ] && GH_AUTH=(-H "Authorization: Bearer ${GITHUB_TOKEN}")

# ── 1. dependencies ─────────────────────────────────────────
info "[1/8] Checking dependencies…"
if ! command -v curl >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq && apt-get install -y -qq curl ca-certificates >/dev/null && ok "curl installed"
  else
    die "curl is required. Install it manually and re-run."
  fi
fi

NODE_MAJOR=0
command -v node >/dev/null 2>&1 && NODE_MAJOR=$(node -v | sed 's/^v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 20 ]; then
  info "Installing Node.js 20.x…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null 2>&1 || die "node install failed"
fi
ok "Node $(node -v)"
PKG_MGR="npm"
command -v bun >/dev/null 2>&1 && PKG_MGR="bun"

# ── migrate legacy installs (auto-backup-xui → bkup) ────────
# Old v2/v3 installs lived at /opt/auto-backup-xui with the
# autobackup-xui service — move everything over, keep all data.
if [ "$APP_DIR" = "/opt/bkup" ] && [ -d "$LEGACY_APP_DIR" ] && [ ! -f "$APP_DIR/package.json" ]; then
  info "Migrating legacy installation (${LEGACY_APP_DIR} → ${APP_DIR})…"
  command -v systemctl >/dev/null 2>&1 && systemctl stop "$LEGACY_SERVICE" >/dev/null 2>&1
  mv "$LEGACY_APP_DIR" "$APP_DIR" 2>/dev/null || cp -a "$LEGACY_APP_DIR" "$APP_DIR"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl disable "$LEGACY_SERVICE" >/dev/null 2>&1
    rm -f "/etc/systemd/system/${LEGACY_SERVICE}.service"
    systemctl daemon-reload >/dev/null 2>&1
  fi
  rm -f /usr/local/bin/autobackup-xui
  ok "legacy install migrated — data, settings and backups are preserved"
fi

# ── 2. source code: ONLY the latest GitHub release ──────────
# Resolve the newest published release → download exactly that tag →
# verify the code version matches the tag → install. Anything else
# (unreachable GitHub, wrong version) aborts with NOTHING changed.
info "[2/8] Resolving the latest release on GitHub…"

latest_tag() {
  local t=""
  for _ in 1 2 3; do
    t="$(curl -sf "${GH_AUTH[@]}" --max-time 15 --retry 2 \
        "https://api.github.com/repos/${REPO_SLUG}/releases/latest" \
        | grep -o '"tag_name": *"[^"]*"' | head -1 | cut -d'"' -f4)" || t=""
    [ -n "$t" ] && break
    sleep 2
  done
  printf '%s' "$t"
}

TAG="$(latest_tag)"
[ -n "$TAG" ] || die "could not determine the LATEST release from GitHub (no internet, rate limit, or a private repo — for a private repo set GITHUB_TOKEN).
    Nothing was changed on your server. Fix access and run again."

info "    latest release: ${C}${TAG}${N}  ${D}(this — and only this — will be installed)${N}"

RELEASE_SRC=""
fetch_release() {
  rm -rf /tmp/bkup-install /tmp/bkup-install.tar.gz
  mkdir -p /tmp/bkup-install
  curl -fL "${GH_AUTH[@]}" --max-time 300 --retry 2 \
      "https://github.com/${REPO_SLUG}/archive/refs/tags/${TAG}.tar.gz" \
      -o /tmp/bkup-install.tar.gz >/dev/null 2>&1 \
    || curl -fL "${GH_AUTH[@]}" --max-time 300 --retry 2 \
      "https://api.github.com/repos/${REPO_SLUG}/tarball/${TAG}" \
      -o /tmp/bkup-install.tar.gz >/dev/null 2>&1 \
    || return 1
  [ -s /tmp/bkup-install.tar.gz ] || return 1
  tar -xzf /tmp/bkup-install.tar.gz -C /tmp/bkup-install 2>/dev/null || return 1
  local src
  src="$(find /tmp/bkup-install -maxdepth 1 -mindepth 1 -type d | head -1)"
  [ -n "$src" ] || return 1
  local got
  got="$(grep -o '"version": *"[^"]*"' "$src/package.json" 2>/dev/null | head -1 | cut -d'"' -f4)"
  if [ "$got" != "${TAG#v}" ]; then
    echo -e "    ${R}version mismatch: downloaded code is v${got:-unknown} but the latest release is ${TAG} — refusing to install${N}"
    return 1
  fi
  RELEASE_SRC="$src"
  return 0
}

fetch_release || die "could not download release ${TAG} from GitHub.
    Nothing was changed on your server. Check connectivity (or GITHUB_TOKEN) and run again."

# code-only refresh list — db, backups, .env, secrets, node_modules
# and .next are NEVER touched on an existing installation
CODE_ITEMS=(src prisma public scripts docs docker .github
            package.json bun.lock package-lock.json tsconfig.json next.config.ts
            tailwind.config.ts postcss.config.mjs eslint.config.mjs components.json
            cli.sh install.sh README.md README.fa.md CHANGELOG.md
            .env.example .gitignore .dockerignore Dockerfile docker-compose.yml)

if [ -f "$APP_DIR/package.json" ]; then
  cd "$APP_DIR" || die "cannot enter ${APP_DIR}"
  for item in "${CODE_ITEMS[@]}"; do
    [ -e "$RELEASE_SRC/$item" ] && cp -a "$RELEASE_SRC/$item" "$APP_DIR/" 2>/dev/null
  done
  ok "existing installation refreshed to ${TAG}  ${D}(data, settings and backups preserved)${N}"
else
  mkdir -p "$APP_DIR" || die "cannot create ${APP_DIR}"
  cp -a "$RELEASE_SRC/." "$APP_DIR/" || die "cannot copy source to ${APP_DIR}"
  ok "source ready: ${TAG}"
fi
rm -rf /tmp/bkup-install /tmp/bkup-install.tar.gz

# final guarantee: the code on disk IS the latest release
INSTALLED_V="$(grep -o '"version": *"[^"]*"' "$APP_DIR/package.json" | head -1 | cut -d'"' -f4)"
[ "$INSTALLED_V" = "${TAG#v}" ] || die "version verification failed (disk has v${INSTALLED_V:-unknown}, latest is ${TAG}) — aborting."
ok "verified: installed code = latest release ${TAG}"

# ── 3. port ─────────────────────────────────────────────────
info "[3/8] Web panel port"
if [ -f "$APP_DIR/.env" ]; then
  OLD_PORT="$(grep -E '^PORT=' "$APP_DIR/.env" | head -1 | cut -d= -f2-)"
  if [ -n "$OLD_PORT" ]; then
    PORT="$OLD_PORT"
    ok "keeping existing port: ${PORT}  ${D}(from the previous installation)${N}"
    SKIP_QUESTIONS=1
  fi
fi
if [ "${SKIP_QUESTIONS:-0}" != "1" ]; then
  echo -e "    ${B}1)${N} Random port   ${D}(recommended)${N}"
  echo -e "    ${B}2)${N} Custom port"
  read -rp "    choose [1/2, default 1]: " pchoice
  if [ "$pchoice" = "2" ]; then
    read -rp "    port [10000-65000]: " PORT
    [[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "invalid port"
  else
    PORT=$(shuf -i 10000-65000 -n 1)
  fi
  ok "port: ${PORT}"
fi

# ── 4. panel password ───────────────────────────────────────
PW_SET=0
if [ -f "$APP_DIR/db/custom.db" ]; then
  # previous installation → keep its password, don't ask again
  PANEL_PW="(unchanged — same as before)"
  PW_SET=1
  ok "keeping existing web panel password"
fi
if [ "$PW_SET" != "1" ]; then
  info "[4/8] Web panel password (protects the panel)"
  echo -e "    ${B}1)${N} I will type it"
  echo -e "    ${B}2)${N} Generate a strong random password"
  read -rp "    choose [1/2, default 1]: " pwchoice
  if [ "$pwchoice" = "2" ]; then
    PANEL_PW="$(head -c 16 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 12)"
  else
    while true; do
      read -rsp "    password (min 4 chars): " PANEL_PW; echo ""
      [ "${#PANEL_PW}" -ge 4 ] && break
      echo -e "    ${Y}too short, try again${N}"
    done
  fi
  ok "password set"
fi

# ── 5. build ────────────────────────────────────────────────
info "[5/8] Installing dependencies & building (2–6 min)…"
cd "$APP_DIR" || die "cannot enter ${APP_DIR}"
mkdir -p db backups data

# ── low-RAM guard: swap so the build and the app are never OOM-killed ──
MEM_MB=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)
if [ "$MEM_MB" -lt 3000 ] && [ -z "$(swapon --noheadings 2>/dev/null)" ]; then
  info "small-RAM server (${MEM_MB}MB) detected — creating 2G swap (prevents OOM build/service kills)"
  fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile && mkswap /swapfile >/dev/null 2>&1 && swapon /swapfile >/dev/null 2>&1 || true
  grep -q "^/swapfile" /etc/fstab 2>/dev/null || echo "/swapfile none swap sw 0 0" >> /etc/fstab
  ok "swap enabled"
fi
if [ "$PKG_MGR" = "bun" ]; then
  bun install --frozen-lockfile >/dev/null 2>&1 || bun install >/dev/null
  bunx prisma generate >/dev/null
  DATABASE_URL="file:$APP_DIR/db/custom.db" bunx prisma db push --skip-generate >/dev/null
  bun run build >/dev/null 2>&1 || die "build failed — run 'bash scripts/build-native.sh' to see the error"
else
  npm install --no-audit --no-fund >/dev/null 2>&1 || die "npm install failed"
  npx prisma generate >/dev/null
  DATABASE_URL="file:$APP_DIR/db/custom.db" npx prisma db push --skip-generate >/dev/null
  npm run build >/dev/null 2>&1 || die "build failed — run 'npm run build' to see the error"
fi
rm -rf .next/standalone/public .next/standalone/.next/static
cp -r public .next/standalone/public
mkdir -p .next/standalone/.next
cp -r .next/static .next/standalone/.next/static
mkdir -p .next/standalone/data
[ -f .next/standalone/server.js ] || die "build output is incomplete (standalone/server.js missing) — run 'npm run build' in $APP_DIR to see the real error"
ok "build complete"

# ── 6. configuration files ──────────────────────────────────
info "[6/8] Writing configuration…"
cat > "$APP_DIR/.env" <<EOF
PORT=${PORT}
DATABASE_URL=file:${APP_DIR}/db/custom.db
BACKUP_DIR=${APP_DIR}/backups
TZ=Asia/Tehran
BKUP_APP_DIR=${APP_DIR}
ABX_APP_DIR=${APP_DIR}
BKUP_ENV_FILE=${APP_DIR}/.env
ABX_ENV_FILE=${APP_DIR}/.env
EOF
chmod 600 "$APP_DIR/.env"
[ -f "$APP_DIR/.cli-secret" ] || (command -v openssl >/dev/null 2>&1 && openssl rand -hex 24 > "$APP_DIR/.cli-secret") || head -c 32 /dev/urandom | md5sum | cut -c1-48 > "$APP_DIR/.cli-secret"
chmod 600 "$APP_DIR/.cli-secret"
# keep the token for future in-place updates (only needed while the repo is private)
if [ -n "${GITHUB_TOKEN:-}" ]; then
  printf '%s' "$GITHUB_TOKEN" > "$APP_DIR/.github-token"
  chmod 600 "$APP_DIR/.github-token"
fi
ok ".env + .cli-secret"

# panel password (direct DB write) — only for fresh installs
if [ "$PW_SET" != "1" ]; then
  DATABASE_URL="file:$APP_DIR/db/custom.db" node "$APP_DIR/scripts/cli/set-password.mjs" "$PANEL_PW" >/dev/null \
    || die "could not set password"
fi

# ── 7. systemd service ──────────────────────────────────────
info "[7/8] Creating systemd service…"
cat > "/etc/systemd/system/${SERVICE}.service" <<EOF
[Unit]
Description=bkup — 3x-ui + HM Panel + PasarGuard full backups → Telegram
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}/.next/standalone
EnvironmentFile=${APP_DIR}/.env
Environment=NODE_ENV=production
Environment=NODE_OPTIONS=--max-old-space-size=768
ExecStart=$(command -v node || echo /usr/bin/node) ${APP_DIR}/.next/standalone/server.js
Restart=always
RestartSec=10

# ── Resource limits: the bot must NEVER hog the server ──
CPUAccounting=true
CPUQuota=25%
MemoryAccounting=true
MemoryHigh=300M
MemoryMax=400M
TasksMax=120
LimitNOFILE=8192
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
StartLimitIntervalSec=300
StartLimitBurst=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload 2>/dev/null
# retire the legacy unit if it still exists
if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q "^${LEGACY_SERVICE}.service"; then
  systemctl disable --now "$LEGACY_SERVICE" >/dev/null 2>&1
  rm -f "/etc/systemd/system/${LEGACY_SERVICE}.service"
  systemctl daemon-reload >/dev/null 2>&1
fi
systemctl enable "$SERVICE" >/dev/null 2>&1
systemctl restart "$SERVICE" 2>/dev/null

ln -sf "$APP_DIR/cli.sh" /usr/local/bin/bkup
chmod +x "$APP_DIR/cli.sh"
ok "service enabled on boot + bkup command installed"

# ── 8. health check ─────────────────────────────────────────
info "[8/8] Starting & health check…"
HEALTH=0
for i in $(seq 1 20); do
  sleep 2
  curl -sf -o /dev/null "http://127.0.0.1:${PORT}/api/auth/state" && { HEALTH=1; break; }
done
[ "$HEALTH" = "1" ] && ok "service is healthy" || echo -e "${Y}⚠ still starting — check: journalctl -u ${SERVICE} -n 30${N}"

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo ""
echo -e "${G}${B}════════════════════════════════════════════════════════${N}"
echo -e "${G}${B}   ✔ bkup installed successfully${N}"
echo -e "${G}${B}════════════════════════════════════════════════════════${N}"
echo ""
echo -e "  ${B}Web panel :${N} ${G}http://${IP}:${PORT}${N}"
echo -e "  ${B}Password  :${N} ${Y}${PANEL_PW}${N}   ${D}(change it from the panel anytime)${N}"
echo -e "  ${B}CLI menu  :${N} ${C}bkup${N}   ${D}← run this anytime on the server${N}"
echo ""
echo -e "  ${B}Version   :${N} v${INSTALLED_V}  ${D}= latest release on GitHub (${TAG}) ✓${N}"
echo ""
echo -e "  ${D}next steps:${N}"
echo -e "   1. open the web panel → Settings → connect 3x-ui AND/OR HM Panel AND/OR PasarGuard"
echo -e "      ${D}(all three are independent — enable any of them, each with its own test button)${N}"
echo -e "   2. add your Telegram bot + run the connection tests"
echo -e "   3. flip the switch → full backups of every enabled panel start flowing to Telegram"
echo -e ""
echo -e "  ${D}new releases are announced automatically in the panel log and your Telegram chat.${N}"
echo ""
