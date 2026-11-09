#!/usr/bin/env bash
# =============================================================
#  bkup — installer
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
#  v1.3.1 — low-disk servers now install correctly:
#    · the installer used to create a blind 2 GB /swapfile on every
#      small-RAM server; on a 4–6 GB disk that ate half the drive and
#      the build then filled what was left (ENOSPC crash, dead server)
#    · swap is now ADAPTIVE: min(1 GB, 90% of RAM, free-disk room) with
#      a hard 600 MB free-disk floor — never more than 1 GB, ever
#    · a disk PRE-FLIGHT check aborts cleanly (nothing written) when the
#      root filesystem is too small, instead of filling it and crashing
#    · a leftover 2 GB swapfile from old installs is reclaimed and the
#      freed space given back to the disk
#    · swap creation cleans up after itself on every failure path
#
#  v1.3.0 — memory-safe backups + custom paths:
#    · single-panel backups no longer crash the service: every archive is
#      STREAMED to disk and uploaded in sliced parts, so a 400MB systemd
#      MemoryMax handles multi-gigabyte backups (the old code buffered whole
#      archives twice in RAM and was OOM-killed — issue #3)
#    · CUSTOM PATHS: back up arbitrary directories on this server (e.g.
#      /opt/myapp) alongside the panel backups, from Settings → Custom paths
#    · all server logs and messages are now English
#
#  v1.2.0 — backup & restore correctness release:
#    · one FULL backup per panel — the panel's own complete backup,
#      taken byte-for-byte and never modified (3x-ui database, HMPanel
#      official archive, PasarGuard full snapshot, Rebecca official export)
#    · the SELECTED BACKUP owns the restore — a 3x-ui backup only ever
#      restores onto 3x-ui, HM onto HM, PG onto PG, RB onto RB; bkup never
#      migrates a backup onto another panel and never rewrites it
#    · restore verifies the panel AND its X-Ray core honestly (no more
#      "restored successfully" while X-Ray is down); certificate files a
#      restored db references are pre-created at their referenced paths
#      (extracted locally from the backup bytes — no sqlite3 on the server)
#    · reassembly labels merged parts with the correct panel for all 4 panels
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
# Download into a temp dir on the SAME filesystem as APP_DIR so a small
# tmpfs on /tmp can never be the bottleneck (the v1.3.1 "474MB free" bug).
# Keep the staging dir NEXT TO APP_DIR (same filesystem, but not inside it):
# an older release's cleanup helper must never be able to delete the source
# we are about to copy. /tmp is only a last resort.
INSTALL_PARENT="$(dirname "$APP_DIR")"
if [ -d "$INSTALL_PARENT" ] && [ -w "$INSTALL_PARENT" ]; then
  BKUP_INSTALL_TMP="$INSTALL_PARENT/.bkup-install-tmp"
else
  BKUP_INSTALL_TMP="/tmp/bkup-install"
fi
fetch_release() {
  rm -rf "$BKUP_INSTALL_TMP" "${BKUP_INSTALL_TMP}.tar.gz"
  mkdir -p "$BKUP_INSTALL_TMP"
  curl -fL "${GH_AUTH[@]}" --max-time 300 --retry 2 \
      "https://github.com/${REPO_SLUG}/archive/refs/tags/${TAG}.tar.gz" \
      -o "${BKUP_INSTALL_TMP}.tar.gz" >/dev/null 2>&1 \
    || curl -fL "${GH_AUTH[@]}" --max-time 300 --retry 2 \
      "https://api.github.com/repos/${REPO_SLUG}/tarball/${TAG}" \
      -o "${BKUP_INSTALL_TMP}.tar.gz" >/dev/null 2>&1 \
    || return 1
  [ -s "${BKUP_INSTALL_TMP}.tar.gz" ] || return 1
  tar -xzf "${BKUP_INSTALL_TMP}.tar.gz" -C "$BKUP_INSTALL_TMP" 2>/dev/null || return 1
  local src
  src="$(find "$BKUP_INSTALL_TMP" -maxdepth 1 -mindepth 1 -type d | head -1)"
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

# ── disk & swap guard (v1.3.1) ───────────────────────────────
# Sourced from the release we just verified. Override the lib's default
# output hook so every message goes through the colored installer UI.
source "$RELEASE_SRC/scripts/lib-dguard.sh" || source ./scripts/lib-dguard.sh
dg_emit() { info "$*"; }

# This installer may be newer than the release tarball it just downloaded.
# Never let an older guard library shadow the fixes below.
dg_avail_mb() {
  local target="$1"
  [ -e "$target" ] || target="$(dirname "$target" 2>/dev/null)"
  [ -e "$target" ] || target="/"
  local out m
  for c in "df -Pm" "df -m" "df -BM"; do
    out="$($c "$target" 2>/dev/null | tail -1)"
    [ -n "$out" ] || continue
    m="$(printf '%s' "$out" | awk '{print $4}')"
    [ -n "$m" ] && [ "$m" -ge 0 ] 2>/dev/null && { printf '%s' "$m"; return 0; }
  done
  m="$(df -k "$target" 2>/dev/null | tail -1 | awk '{print int($4/1024)}')"
  printf '%s' "${m:-0}"
}
dg_free_space() {
  local app="${DG_APP_DIR:-}"
  dg_say "space-cleanup: removing regenerable caches and stale files…"
  rm -rf /tmp/bkup-install /tmp/bkup-install.tar.gz \
         /tmp/abx-update /tmp/abx-update.tar.gz 2>/dev/null || true
  find /tmp -maxdepth 1 -name 'bkup-package-backup-*.json' -delete 2>/dev/null || true
  if [ -n "$app" ] && [ -d "$app" ]; then
    rm -rf "$app/.next/cache" 2>/dev/null || true
    rm -rf "$app/.scripts-new" 2>/dev/null || true
    rm -f "$app/.install.sh.new" "$app/.cli.sh.new" 2>/dev/null || true
  fi
  if command -v npm >/dev/null 2>&1; then npm cache clean --force >/dev/null 2>&1 || true; fi
  if command -v bun >/dev/null 2>&1; then bun pm cache rm >/dev/null 2>&1 || true; fi
  if command -v apt-get >/dev/null 2>&1; then apt-get clean >/dev/null 2>&1 || true; fi
  if command -v dnf >/dev/null 2>&1; then dnf clean all >/dev/null 2>&1 || true; fi
  if command -v journalctl >/dev/null 2>&1; then journalctl --vacuum-size=50M >/dev/null 2>&1 || true; fi
}

# Resolve the pre-built bundle URL WITHOUT depending on a single API call:
# the deterministic release URL is tried first (works even when the GitHub
# API is rate-limited), the API is only a fallback for renamed assets.
resolve_prebuilt_url() {
  local u=""
  if [ -n "${TAG:-}" ]; then
    u="https://github.com/${REPO_SLUG}/releases/download/${TAG}/bkup-standalone.tar.gz"
    if curl -fsIL "${GH_AUTH[@]}" --max-time 15 "$u" >/dev/null 2>&1; then
      printf '%s' "$u"; return 0
    fi
    curl -sf "${GH_AUTH[@]}" --max-time 15 \
      "https://api.github.com/repos/${REPO_SLUG}/releases/latest" 2>/dev/null \
      | grep -o '"browser_download_url": *"[^"]*bkup-standalone[^"]*"' | head -1 | cut -d'"' -f4
  fi
}

# Apply the Prisma schema to the SQLite database. NEVER interactive:
# the old code ran bare `npx prisma ...` with output hidden — on a fresh
# install prisma is not in node_modules, so npx printed a hidden
# "Ok to proceed?" prompt and the installer hung forever (the 20-minute
# "still installing" report). `--yes` + `</dev/null` + timeout fixes that.
db_sync() {
  local dburl="file:$APP_DIR/db/custom.db"
  mkdir -p "$APP_DIR/db"
  if [ -x "$APP_DIR/node_modules/.bin/prisma" ]; then
    DATABASE_URL="$dburl" "$APP_DIR/node_modules/.bin/prisma" \
      db push --skip-generate --accept-data-loss </dev/null >/dev/null 2>&1 && return 0
  fi
  if [ -x "$APP_DIR/.next/standalone/node_modules/.bin/prisma" ]; then
    DATABASE_URL="$dburl" "$APP_DIR/.next/standalone/node_modules/.bin/prisma" \
      db push --skip-generate --accept-data-loss </dev/null >/dev/null 2>&1 && return 0
  fi
  if command -v timeout >/dev/null 2>&1; then
    DATABASE_URL="$dburl" timeout 600 npx --yes --package prisma@6 prisma \
      db push --skip-generate --accept-data-loss </dev/null >/dev/null 2>&1 && return 0
  else
    DATABASE_URL="$dburl" npx --yes --package prisma@6 prisma \
      db push --skip-generate --accept-data-loss </dev/null >/dev/null 2>&1 && return 0
  fi
  echo -e "    ${Y}⚠ database schema sync skipped (prisma CLI unavailable) — the panel will retry on first start${N}"
  return 0
}

# FIRST: reclaim a leftover legacy 2GB /swapfile BEFORE measuring —
# on servers that ran v1.0–v1.3.0 freeing that file alone often makes
# the disk big enough again (v1.3.1.1: it used to run too late,
# AFTER the pre-flight check, so such servers were blocked for nothing).
dg_reclaim_legacy_swap || true

# NEXT: free regenerable caches (turbo/npm cache, tmp artifacts, apt cache)
# — a stale v1.3.0 install often recovers 1–2GB from these alone.
DG_APP_DIR="$APP_DIR"
dg_free_space

# Pre-flight: measure BEFORE copying anything. On a small root the old
# behavior kept going until node_modules + the build filled the disk and
# everything died on ENOSPC. Now we abort cleanly with a readable number.
# Detect a pre-built release asset early so we can (a) lower the disk
# requirement and (b) reclaim heavy, regenerable build artifacts before
# measuring (the pre-built path does not need node_modules/.next).
PREBUILT_URL_EARLY="$(resolve_prebuilt_url || true)"

if [ -n "$PREBUILT_URL_EARLY" ] && [ -d "$APP_DIR" ]; then
  # Pre-built path skips the build, so node_modules and the old .next tree
  # are pure dead weight — but only reclaim them when space is actually
  # tight, so an interrupted install never damages a healthy deployment.
  _avail_now="$(dg_avail_mb "$APP_DIR")"
  if [ "${_avail_now:-0}" -lt 400 ]; then
    rm -rf "$APP_DIR/node_modules" "$APP_DIR/.next" 2>/dev/null || true
  fi
fi

NEED_MB="$DG_INSTALL_MIN_MB"
if [ -n "$PREBUILT_URL_EARLY" ]; then
  NEED_MB=50
  ok "pre-built release asset available — fast path (needs ~${NEED_MB}MB, streamed, no tarball on disk)"
elif [ -f "$APP_DIR/package.json" ]; then
  NEED_MB="$DG_UPDATE_MIN_MB"
  ok "existing install found — refresh mode (needs ${NEED_MB}MB, unchanged install on disk)"
fi
AVAIL_ROOT="$(dg_avail_mb "$APP_DIR")"
AVAIL_RUN="${AVAIL_ROOT:-0}"
if [ "${AVAIL_RUN:-0}" = "0" ] && [ -e "$APP_DIR" ]; then
  echo -e "    ${D}df reports: $(df -Pm "$APP_DIR" 2>/dev/null | tail -1)${N}"
fi
if [ -n "$PREBUILT_URL_EARLY" ]; then
  # Pre-built path replaces files in place — never block on the pre-flight
  # number alone. Only warn.
  if [ "${AVAIL_RUN:-0}" -lt "$NEED_MB" ]; then
    echo -e "    ${Y}⚠ only ${AVAIL_RUN}MB free — attempting streamed in-place install anyway${N}"
  fi
elif [ "${AVAIL_RUN:-0}" -lt "$NEED_MB" ]; then
  die "Not enough disk space: ${AVAIL_RUN:-0}MB free — ${NEED_MB:-2600}MB needed.
    The installer refuses to continue on purpose: it can NEVER fill your disk
    (that was the v1.3.0 crash). NOTHING was written to your server yet.
    Fastest fixes — run any of these, then re-run the installer:
      swapoff /swapfile 2>/dev/null; rm -f /swapfile; sed -i '/^\\/swapfile /d' /etc/fstab   (frees ~2GB if an old swapfile exists)
      see what is eating the root disk:  du -h --max-depth=1 / 2>/dev/null | sort -rh | head -15
      see what is eating the bkup folder:  du -h --max-depth=1 ${APP_DIR} 2>/dev/null | sort -rh | head -10
          (old backup files below ${APP_DIR}/backups often hold gigabytes:  ls -lh ${APP_DIR}/backups | head )
      or install on a filesystem with more room:
      APP_DIR=/path/to/larger/dir bash install.sh"
fi
ok "disk check: ${AVAIL_RUN}MB free (need ${NEED_MB}MB) — root is big enough"

# code-only refresh list — db, backups, .env, secrets, node_modules
# and .next are NEVER touched on an existing installation
CODE_ITEMS=(src prisma public scripts docs docker .github
            package.json bun.lock package-lock.json tsconfig.json next.config.ts
            tailwind.config.ts postcss.config.mjs eslint.config.mjs components.json
            cli.sh install.sh README.md README.fa.md CHANGELOG.md
            .env.example .gitignore .dockerignore Dockerfile docker-compose.yml)

if [ -f "$APP_DIR/package.json" ]; then
  cd "$APP_DIR" || die "cannot enter ${APP_DIR}"
  # v1.2.1: never rewrite a script in place while it may be executing —
  # bash reads scripts incrementally, and rewriting the bytes under a
  # running interpreter aborts it mid-flight with a random syntax error
  # (the root cause of updates dying after the copy, before the build).
  # Executed files are staged and swapped in with atomic rename(2) instead.
  for item in "${CODE_ITEMS[@]}"; do
    [ -e "$RELEASE_SRC/$item" ] || continue
    case "$item" in
      scripts)
        rm -rf "${APP_DIR}/.scripts-new"
        if cp -a "$RELEASE_SRC/scripts" "${APP_DIR}/.scripts-new" 2>/dev/null; then
          rm -rf "${APP_DIR}/scripts"
          mv "${APP_DIR}/.scripts-new" "${APP_DIR}/scripts" 2>/dev/null \
            || { rm -rf "${APP_DIR}/scripts"; cp -a "$RELEASE_SRC/scripts" "${APP_DIR}/scripts" 2>/dev/null || true; }
        fi
        ;;
      cli.sh|install.sh)
        cp -a "$RELEASE_SRC/$item" "${APP_DIR}/.${item}.new" 2>/dev/null || true
        mv -f "${APP_DIR}/.${item}.new" "${APP_DIR}/$item" 2>/dev/null || true
        ;;
      *)
        cp -a "$RELEASE_SRC/$item" "${APP_DIR}/" 2>/dev/null || true
        ;;
    esac
  done
  ok "existing installation refreshed to ${TAG}  ${D}(data, settings and backups preserved)${N}"
else
  mkdir -p "$APP_DIR" || die "cannot create ${APP_DIR}"
  cp -a "$RELEASE_SRC/." "$APP_DIR/" || die "cannot copy source to ${APP_DIR}"
  ok "source ready: ${TAG}"
fi

# final guarantee: the code on disk IS the latest release.
# Force-overwrite package.json (a stale/higher on-disk version must never
# block convergence to the release we just verified).
if [ -f "$RELEASE_SRC/package.json" ]; then
  rm -f "$APP_DIR/package.json" 2>/dev/null || true
  cp -f "$RELEASE_SRC/package.json" "$APP_DIR/package.json" 2>/dev/null || true
  chmod 644 "$APP_DIR/package.json" 2>/dev/null || true
fi
INSTALLED_V="$(grep -o '"version": *"[^"]*"' "$APP_DIR/package.json" | head -1 | cut -d'"' -f4)"
if [ "$INSTALLED_V" != "${TAG#v}" ]; then
  echo -e "    ${Y}⚠ version string on disk is v${INSTALLED_V:-unknown} (release is ${TAG}) — continuing; the running code is the verified release${N}"
  INSTALLED_V="${TAG#v}"
else
  ok "verified: installed code = latest release ${TAG}"
fi
rm -rf "$BKUP_INSTALL_TMP" "${BKUP_INSTALL_TMP}.tar.gz"

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
  pchoice=""
  [ -t 0 ] && read -rp "    choose [1/2, default 1]: " pchoice
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
  pwchoice=""
  if [ -t 0 ]; then
    read -rp "    choose [1/2, default 1]: " pwchoice
  else
    pwchoice="2"   # non-interactive: generate a strong password
  fi
  if [ "$pwchoice" = "2" ]; then
    PANEL_PW="$(head -c 16 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 12)"
  else
    while true; do
      read -rsp "    password (min 4 chars): " PANEL_PW || PANEL_PW=""
      echo ""
      [ "${#PANEL_PW}" -ge 4 ] && break
      if [ ! -t 0 ]; then
        PANEL_PW="$(head -c 16 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 12)"
        break
      fi
      echo -e "    ${Y}too short, try again${N}"
    done
  fi
  ok "password set"
fi

# ── 5. build ────────────────────────────────────────────────
info "[5/8] Installing dependencies & building..."
cd "$APP_DIR" || die "cannot enter ${APP_DIR}"
mkdir -p db backups data

# fast path: pre-built standalone asset from the GitHub release
PREBUILT_URL="$(resolve_prebuilt_url || true)"

USED_PREBUILT=0
if [ -n "$PREBUILT_URL" ]; then
  info "    downloading the pre-built bundle (no compile needed)…"
  dg_setup_swap
  rm -rf "$APP_DIR/.next/standalone"
  mkdir -p "$APP_DIR/.next/standalone"
  if curl -fL "${GH_AUTH[@]}" --max-time 900 --retry 2 "$PREBUILT_URL" \
       | tar -xzf - -C "$APP_DIR/.next/standalone" 2>/dev/null; then
    USED_PREBUILT=1
    # older release assets omitted these; make sure the panel can serve the UI
    [ -d "$APP_DIR/.next/standalone/public" ] || cp -a "$APP_DIR/public" "$APP_DIR/.next/standalone/public" 2>/dev/null || true
    # the bundle ships a ready-made empty DB → no prisma CLI / network needed
    if [ ! -s "$APP_DIR/db/custom.db" ] && [ -s "$APP_DIR/.next/standalone/db/custom.db" ]; then
      cp -a "$APP_DIR/.next/standalone/db/custom.db" "$APP_DIR/db/custom.db" 2>/dev/null || true
    fi
    if [ ! -s "$APP_DIR/db/custom.db" ]; then
      info "    preparing the database…"
      db_sync
    fi
  fi
  rm -f "${BKUP_INSTALL_TMP}.prebuilt.tar.gz" 2>/dev/null || true
fi

if [ "$USED_PREBUILT" != "1" ]; then
  if [ -n "$PREBUILT_URL" ]; then
    echo -e "    ${Y}pre-built bundle failed — falling back to a source build (3-8 min)${N}"
  fi
  info "    building from source (3-8 min, progress below)…"
  dg_setup_swap
  if [ "$PKG_MGR" = "bun" ]; then
    bun install --frozen-lockfile >/dev/null 2>&1 || bun install >/dev/null
    bunx prisma generate </dev/null >/dev/null || die "prisma generate failed"
    db_sync
    bun run build || die "build failed - run 'bash scripts/build-native.sh' to see the error"
  else
    npm install --no-audit --no-fund --loglevel=error || die "npm install failed"
    npx --yes prisma generate </dev/null >/dev/null || die "prisma generate failed"
    db_sync
    NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=1024" npm run build \
      || die "build failed - run 'npm run build' in $APP_DIR to see the real error"
  fi
  rm -rf .next/standalone/public .next/standalone/.next/static
  cp -r public .next/standalone/public 2>/dev/null || true
  mkdir -p .next/standalone/.next
  cp -r .next/static .next/standalone/.next/static 2>/dev/null || true
fi

mkdir -p .next/standalone/data
if [ -d "$APP_DIR/data" ]; then
  cp -a "$APP_DIR/data/." .next/standalone/data/ 2>/dev/null || true
fi
cp -a "$APP_DIR/package.json" .next/standalone/package.json 2>/dev/null || true

[ -f .next/standalone/server.js ] || die "build output is incomplete (standalone/server.js missing)"
ok "build complete"


# ── 6. configuration files ──────────────────────────────────
info "[6/8] Writing configuration…"
# ── .env handling: for existing installs, merge preserving existing values
# This fixes the bug where re-running installer would overwrite custom env vars
if [ -f "$APP_DIR/.env" ] && [ -f "$APP_DIR/db/custom.db" ]; then
  # Existing installation — preserve .env, ensure required keys exist, update PORT if needed
  info "existing .env found — merging with new template (preserving existing values)"
  # Update PORT if it was changed (or keep old)
  if grep -qE '^PORT=' "$APP_DIR/.env" 2>/dev/null; then
    # Replace PORT line with current PORT value
    sed -i "s/^PORT=.*/PORT=${PORT}/" "$APP_DIR/.env" 2>/dev/null || true
  else
    echo "PORT=${PORT}" >> "$APP_DIR/.env"
  fi
  # Ensure other required keys exist
  grep -qE '^DATABASE_URL=' "$APP_DIR/.env" 2>/dev/null || echo "DATABASE_URL=file:${APP_DIR}/db/custom.db" >> "$APP_DIR/.env"
  grep -qE '^BACKUP_DIR=' "$APP_DIR/.env" 2>/dev/null || echo "BACKUP_DIR=${APP_DIR}/backups" >> "$APP_DIR/.env"
  grep -qE '^TZ=' "$APP_DIR/.env" 2>/dev/null || echo "TZ=Asia/Tehran" >> "$APP_DIR/.env"
  grep -qE '^BKUP_APP_DIR=' "$APP_DIR/.env" 2>/dev/null || echo "BKUP_APP_DIR=${APP_DIR}" >> "$APP_DIR/.env"
  grep -qE '^ABX_APP_DIR=' "$APP_DIR/.env" 2>/dev/null || echo "ABX_APP_DIR=${APP_DIR}" >> "$APP_DIR/.env"
  grep -qE '^BKUP_ENV_FILE=' "$APP_DIR/.env" 2>/dev/null || echo "BKUP_ENV_FILE=${APP_DIR}/.env" >> "$APP_DIR/.env"
  grep -qE '^ABX_ENV_FILE=' "$APP_DIR/.env" 2>/dev/null || echo "ABX_ENV_FILE=${APP_DIR}/.env" >> "$APP_DIR/.env"
  # Merge from .env.example if present
  if [ -f "$APP_DIR/.env.example" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      [[ "$line" =~ ^[[:space:]]*# ]] && continue
      [[ "$line" =~ ^[[:space:]]*$ ]] && continue
      key="$(echo "$line" | cut -d= -f1 | tr -d '[:space:]')"
      [ -z "$key" ] && continue
      if ! grep -qE "^${key}=" "$APP_DIR/.env" 2>/dev/null; then
        echo "$line" >> "$APP_DIR/.env"
      fi
    done < "$APP_DIR/.env.example"
  fi
else
  # Fresh install — create new .env
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
fi
chmod 600 "$APP_DIR/.env"
[ -f "$APP_DIR/.cli-secret" ] || (command -v openssl >/dev/null 2>&1 && openssl rand -hex 24 > "$APP_DIR/.cli-secret") || head -c 32 /dev/urandom | md5sum | cut -c1-48 > "$APP_DIR/.cli-secret"
chmod 600 "$APP_DIR/.cli-secret"
# keep the token for future in-place updates (only needed while the repo is private)
if [ -n "${GITHUB_TOKEN:-}" ]; then
  printf '%s' "$GITHUB_TOKEN" > "$APP_DIR/.github-token"
  chmod 600 "$APP_DIR/.github-token"
fi
ok ".env + .cli-secret"


# panel password (direct DB write) — only for fresh installs.
# On the pre-built path there is no $APP_DIR/node_modules, so point Node at
# the prisma client that ships inside the standalone bundle.
PW_NODE_PATH="$APP_DIR/node_modules"
[ -d "$PW_NODE_PATH/@prisma/client" ] || PW_NODE_PATH="$APP_DIR/.next/standalone/node_modules"
if [ "$PW_SET" != "1" ]; then
  NODE_PATH="$PW_NODE_PATH${NODE_PATH:+:$NODE_PATH}" \
  DATABASE_URL="file:$APP_DIR/db/custom.db" \
    node "$APP_DIR/scripts/cli/set-password.mjs" "$PANEL_PW" >/dev/null \
    || die "could not set password"
fi

# ── 7. systemd service ──────────────────────────────────────
info "[7/8] Creating systemd service…"
cat > "/etc/systemd/system/${SERVICE}.service" <<EOF
[Unit]
Description=bkup
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
