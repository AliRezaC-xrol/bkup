#!/usr/bin/env bash
# =============================================================
#  bkup — Interactive Terminal Menu
#  Auto Backup for 3x-ui + HM Panel + PasarGuard + Rebecca → Telegram
#  Focused CLI: status, web-panel URL, password, port, logs,
#  updates and uninstall. Everything else lives in the web panel.
# =============================================================
set -uo pipefail

# ── resolve app dir ─────────────────────────────────────────
resolve_app() {
  local self; self="$(readlink -f "${BASH_SOURCE[0]}")"
  local cands=("${BKUP_APP_DIR:-}" "${ABX_APP_DIR:-}" "/opt/bkup" "/opt/auto-backup-xui" "$(dirname "$self")")
  for d in "${cands[@]}"; do
    if [ -n "$d" ] && [ -f "$d/package.json" ] && [ -f "$d/cli.sh" ]; then echo "$d"; return 0; fi
  done
  return 1
}
APP_DIR="$(resolve_app)" || { echo "bkup installation not found."; exit 1; }
cd "$APP_DIR"

# ── look & feel ─────────────────────────────────────────────
if [ -t 1 ]; then
  G=$'\033[1;32m'; C=$'\033[1;36m'; Y=$'\033[1;33m'; R=$'\033[1;31m'; B=$'\033[1m'; W=$'\033[1;37m'; D=$'\033[2m'; N=$'\033[0m'
else
  G=""; C=""; Y=""; R=""; B=""; W=""; D=""; N=""
fi

# Aligned ASCII banner — proper ANSI Shadow "BKUP", white on term
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
  echo -e "${W}     b k u p${N}"
  echo -e "${D}     3x-ui / HMPanel / PasarGuard / Rebecca → Telegram${N}"
  echo ""
}

# ── env helpers ─────────────────────────────────────────────
env_get() { grep -E "^$1=" "$APP_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-; }

PORT="$(env_get PORT)"; PORT="${PORT:-3000}"
SERVICE="bkup"
# legacy installs still use the old unit name
if command -v systemctl >/dev/null 2>&1; then
  if ! systemctl list-unit-files 2>/dev/null | grep -q "^${SERVICE}.service" \
     && systemctl list-unit-files 2>/dev/null | grep -q "^autobackup-xui.service"; then
    SERVICE="autobackup-xui"
  fi
fi
SECRET_FILE="$APP_DIR/.cli-secret"

# ── service helpers (systemd optional) ──────────────────────
has_systemd() { command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q "^${SERVICE}.service"; }

svc_state() {
  if has_systemd; then systemctl is-active "$SERVICE" 2>/dev/null || true
  else
    if curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/api/auth/state"; then echo "active"; else echo "inactive"; fi
  fi
}

api() {
  local method="$1" path="$2" data="${3:-}"
  local -a args=(-s -o - -w $'\n%{http_code}' --max-time 90 -X "$method" -H "X-CLI-Secret: $(cat "$SECRET_FILE" 2>/dev/null || echo NONE)")
  [ -n "$data" ] && args+=(-H "Content-Type: application/json" -d "$data")
  curl "${args[@]}" "http://127.0.0.1:${PORT}${path}" 2>/dev/null
}

ver() { python3 -c "import json;print(json.load(open('$APP_DIR/package.json'))['version'])" 2>/dev/null || echo "?"; }

jsonget() { python3 -c "import json,sys;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$2" 2>/dev/null; }

status_json() {
  # CLI helpers load .env themselves (scripts/cli/_env.mjs) — no env plumbing needed
  if ! command -v node >/dev/null 2>&1; then
    echo ""; return 1
  fi
  node "$APP_DIR/scripts/cli/status.mjs" 2>/dev/null
}

primary_ip() { hostname -I 2>/dev/null | awk '{print $1}'; }

pause() { echo ""; read -rp "$(echo -e "${D}Press Enter to continue…${N}")" _; }

# ── screens ─────────────────────────────────────────────────
show_status() {
  local st; st="$(svc_state)"
  local j; j="$(status_json)"
  if [ -z "$j" ]; then
    if ! command -v node >/dev/null 2>&1; then
      echo -e "${R}✗ Node.js runtime not found — reinstall Node 20+:${N}"
      echo -e "   curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs"
    else
      echo -e "${R}✗ could not read app database${N}"
      echo -e "${D}  debug: DATABASE_URL=$(env_get DATABASE_URL) | node $(node -v 2>/dev/null)${N}"
      echo -e "${D}  try:   node $APP_DIR/scripts/cli/status.mjs${N}"
    fi
    return 1
  fi

  local enabled version total success failed last24 panel tg mode lastStatus lastFile lastAt pwset ptype
  enabled=$(echo "$j" | jsonget b "d['enabled']" | grep -q True && echo yes || echo no)
  version=$(echo "$j" | jsonget s "d['version']")
  total=$(echo "$j" | jsonget n "d['stats']['total']")
  success=$(echo "$j" | jsonget n "d['stats']['success']")
  failed=$(echo "$j" | jsonget n "d['stats']['failed']")
  last24=$(echo "$j" | jsonget n "d['stats']['last24h']")
  interval=$(echo "$j" | jsonget i "d['intervalSeconds']")
  pwset=$(echo "$j" | jsonget b "d['passwordSet']" | grep -q True && echo yes || echo no)
  lastStatus=$(echo "$j" | jsonget s "(d['lastRun'] or {}).get('status','-')")
  lastPanel=$(echo "$j" | jsonget s "((d['lastRun'] or {}).get('panel') or '-').upper()")
  lastFile=$(echo "$j" | jsonget s "(d['lastRun'] or {}).get('fileName','-')")
  lastAt=$(echo "$j" | jsonget s "str((d['lastRun'] or {}).get('startedAt','-'))")

  # independent dual-panel readiness
  panel_state() { # $1 = json bool expr for enabled, $2 = ready
    local en rd
    en=$(echo "$j" | jsonget b "$1" | grep -q True && echo yes || echo no)
    rd=$(echo "$j" | jsonget b "$2" | grep -q True && echo "${G}connected${N}" || echo "${Y}not set${N}")
    if [ "$en" = "yes" ]; then echo -e "${rd}"
    else echo -e "${D}off${N}"; fi
  }
  xui_line=$(panel_state "d['panels']['xui']['enabled']" "d['panels']['xui']['ready']")
  hm_line=$(panel_state "d['panels']['hm']['enabled']" "d['panels']['hm']['ready']")
  pg_line=$(panel_state "(d['panels']['pg'] or {}).get('enabled', False)" "(d['panels']['pg'] or {}).get('ready', False)")
  rb_line=$(panel_state "(d['panels']['rebecca'] or {}).get('enabled', False)" "(d['panels']['rebecca'] or {}).get('ready', False)")
  hm_prem=$(echo "$j" | jsonget b "((d['panels']['hm'] or {}).get('premium')) or False" | grep -q True && echo yes || echo no)
  tg=$(echo "$j" | jsonget b "d['telegramReady']" | grep -q True && echo "${G}ready${N}" || echo "${Y}not set${N}")

  local stc="$R"; [ "$st" = "active" ] && stc="$G"
  local enc="$R"; [ "$enabled" = "yes" ] && enc="$G"

  echo -e "${B}──────────────── Service ────────────────${N}"
  echo -e "  Service status : ${stc}● ${st}${N}      ${D}(port ${PORT})${N}"
  echo -e "  Auto backups   : ${enc}● $( [ "$enabled" = "yes" ] && echo ENABLED || echo DISABLED )${N} ${D}(every ${interval}s)${N}"
  echo -e "  Web panel      : http://$(primary_ip)${PORT:+:${PORT}}   ${D}(password: $([ "$pwset" = "yes" ] && echo set || echo NOT SET))${N}"
  echo -e ""
  echo -e "${B}──────────────── Backups ─────────────────${N}"
  echo -e "  Total: ${B}${total}${N}   ${G}Success: ${success}${N}   ${R}Failed: ${failed}${N}   ${C}Last 24h: ${last24}${N}"
  echo -e "  Last run: [${lastPanel}] ${lastStatus} ${D}${lastFile} @ ${lastAt}${N}"
  echo -e ""
  echo -e "${B}──────────────── Connections ─────────────${N}"
  echo -e "  3x-ui panel    : $xui_line"
  echo -e "  HM Panel       : $hm_line$([ "$hm_prem" = "yes" ] && echo -e " ${Y}⭐ Premium${N}")"
  echo -e "  PasarGuard     : $pg_line"
  echo -e "  Rebecca        : $rb_line"
  echo -e "  Telegram bot   : $tg"
  echo -e ""
  echo -e "${B}──────────────── Version ─────────────────${N}"
  echo -e "  Installed      : v$(ver)   ${D}(update check → menu item 6)${N}"
  if [ "$st" != "active" ]; then
    echo -e ""
    echo -e "  ${Y}⚠ service is not running${N} ${D}→ start it from the web panel (System) or:${N}"
    echo -e "  ${D}   sudo systemctl start ${SERVICE}${N}"
  fi
}

show_url() {
  local ip; ip="$(primary_ip)"
  echo -e "${B}Web panel address:${N}"
  echo -e ""
  echo -e "   ${G}${B}http://${ip}:${PORT}${N}"
  echo -e ""
  echo -e "  ${D}local: http://127.0.0.1:${PORT}${N}"
  if [ "$(status_json | jsonget b "d['passwordSet']" | grep -q True && echo yes || echo no)" = "no" ]; then
    echo -e "  ${Y}⚠ No password set yet — the panel will ask you to create one on first open.${N}"
  fi
  if [ "$(svc_state)" != "active" ]; then
    echo -e "  ${R}⚠ Service is not running — start it from the web panel (System) or:${N}"
    echo -e "  ${D}   sudo systemctl start ${SERVICE}${N}"
  fi
}

change_port_flow() {
  read -rp "New web panel port [10000-65000]: " p
  if ! [[ "$p" =~ ^[0-9]+$ ]] || [ "$p" -lt 1 ] || [ "$p" -gt 65535 ]; then echo -e "${R}invalid port${N}"; return; fi
  if [ "$p" = "$PORT" ]; then echo -e "${Y}already on port ${p}${N}"; return; fi
  python3 - "$APP_DIR/.env" "$p" <<'PY'
import sys, pathlib
env, port = pathlib.Path(sys.argv[1]), sys.argv[2]
lines = [l for l in env.read_text().splitlines() if l.strip() and not l.startswith("PORT=")]
lines.append(f"PORT={port}")
env.write_text("\n".join(lines) + "\n")
print("port written to .env")
PY
  # keep THIS shell session on the new port too (URL, api calls, status)
  PORT="$p"
  if has_systemd; then
    echo -e "${C}restarting service on port ${p}…${N}"
    systemctl restart "$SERVICE"
    local ok=0
    for _ in $(seq 1 15); do
      sleep 2
      if curl -sf -o /dev/null --max-time 3 "http://127.0.0.1:${p}/api/auth/state"; then ok=1; break; fi
    done
    if [ "$ok" = "1" ]; then
      echo -e "${G}✔ panel is now running on port ${p}${N}"
      echo -e "   ${G}${B}http://$(primary_ip):${p}${N}"
    else
      echo -e "${Y}⚠ not up yet — check: journalctl -u ${SERVICE} -n 30${N}"
    fi
  else
    echo -e "${Y}systemd not available — restart the app manually to apply port ${p}${N}"
    echo -e "   new address once restarted: http://$(primary_ip):${p}"
  fi
}

change_password_flow() {
  read -rsp "New panel password (min 4 chars): " p1; echo ""
  read -rsp "Repeat: " p2; echo ""
  [ "$p1" != "$p2" ] && { echo -e "${R}✗ passwords do not match${N}"; return; }
  [ "${#p1}" -lt 4 ] && { echo -e "${R}✗ too short${N}"; return; }
  if ! command -v node >/dev/null 2>&1; then echo -e "${R}✗ node not found${N}"; return; fi
  node "$APP_DIR/scripts/cli/set-password.mjs" "$p1" >/dev/null 2>&1 \
    && echo -e "${G}✔ password changed (web sessions invalidated)${N}" \
    || echo -e "${R}✗ failed — run: node $APP_DIR/scripts/cli/set-password.mjs <pass>${N}"
}

check_update_flow() {
  echo -e "${C}checking GitHub…${N}"
  local -a hdr=()
  [ -s "$APP_DIR/.github-token" ] && hdr=(-H "Authorization: Bearer $(cat "$APP_DIR/.github-token")")
  local latest; latest=$(curl -s --max-time 10 "${hdr[@]}" "https://api.github.com/repos/AliRezaC-xrol/bkup/releases/latest" | jsonget s "d.get('tag_name','')")
  local local_v; local_v="$(ver)"
  if [ -z "$latest" ] || [ "$latest" = "None" ]; then
    echo -e "${Y}no releases published yet (installed: v${local_v})${N}"
  else
    local lv="${latest#v}"
    if [ "$(printf '%s\n' "$local_v" "$lv" | sort -V | head -1)" = "$local_v" ] && [ "$local_v" != "$lv" ]; then
      echo -e "${G}update available: v${local_v} -> ${latest}${N}   ${D}(menu -> 7 to install)${N}"
    else
      echo -e "${G}✔ up to date (v${local_v})${N}"
    fi
  fi
}

update_flow() {
  echo -e "${C}updating from GitHub (data & settings are preserved)…${N}"
  bash "$APP_DIR/scripts/update.sh"
}

# one-command local Telegram Bot API server - single-file uploads up to 2GB
botapi_flow() {
  echo -e "${C}==> local Telegram Bot API server setup${N}"
  bash "$APP_DIR/scripts/setup-botapi.sh"
}

# start / stop / restart the bkup web panel service
svc_control_flow() {
  local action="$1"
  if ! has_systemd; then
    echo -e "${Y}systemd not available — control the process manually${N}"
    return
  fi
  echo -e "${C}==> systemctl ${action} ${SERVICE}${N}"
  if systemctl "$action" "$SERVICE"; then
    echo -e "${G}✔ service ${action} — OK${N}"
  else
    echo -e "${R}✗ systemctl ${action} failed — check: journalctl -u ${SERVICE} -n 30${N}"
    return
  fi
  if [ "$action" != "stop" ]; then
    local ok=0
    for _ in $(seq 1 15); do
      sleep 2
      curl -sf -o /dev/null --max-time 3 "http://127.0.0.1:${PORT}/api/auth/state" && { ok=1; break; }
    done
    [ "$ok" = "1" ] && echo -e "${G}✔ web panel is answering on port ${PORT}${N}" \
      || echo -e "${Y}⚠ not answering yet — check: journalctl -u ${SERVICE} -n 30${N}"
  fi
}

logs_flow() {
  if has_systemd; then
    journalctl -u "$SERVICE" -f --no-pager
  else
    echo -e "${Y}systemd not available — tailing app logs from the database (Ctrl+C to exit)${N}"
    if ! command -v node >/dev/null 2>&1; then echo -e "${R}✗ node not found${N}"; return; fi
    node "$APP_DIR/scripts/cli/logs.mjs" 50
  fi
}

uninstall_flow() {
  echo -e "${R}${B}This will REMOVE bkup from this server.${N}"
  read -rp "Also delete backup files and the app database? [y/N]: " del
  read -rp "Type YES to confirm: " c
  [ "$c" = "YES" ] || { echo "cancelled."; return; }
  echo -e "${C}stopping service…${N}"
  has_systemd && { systemctl disable --now "$SERVICE" 2>/dev/null; rm -f "/etc/systemd/system/${SERVICE}.service"; systemctl daemon-reload 2>/dev/null; }
  echo -e "${C}removing bkup command…${N}"
  rm -f /usr/local/bin/bkup
  if [ "${del:-n}" = "y" ]; then
    echo -e "${C}deleting app directory…${N}"
    cd / && rm -rf "$APP_DIR"
    echo -e "${G}✔ fully removed${N}"
  else
    echo -e "${G}✔ service removed — files kept at ${APP_DIR}${N}"
  fi
  echo -e "${D}Telegram history and local backups (if kept) are untouched.${N}"
}

# ── menu ────────────────────────────────────────────────────
update_notice() {
  # quick check (cached 1h in /tmp) — shown above the menu when a new release exists
  local cache="/tmp/.bkup-update-notice"
  if [ -s "$cache" ] && [ "$(find "$cache" -mmin -60 2>/dev/null)" ]; then
    [ "$(cat "$cache")" != "-" ] && echo -e "  ${Y}$(cat "$cache")  ${D}-> menu 7 to install${N}"
    return
  fi
  local -a hdr=()
  [ -s "$APP_DIR/.github-token" ] && hdr=(-H "Authorization: Bearer $(cat "$APP_DIR/.github-token")")
  local latest; latest=$(curl -s --max-time 5 "${hdr[@]}" "https://api.github.com/repos/AliRezaC-xrol/bkup/releases/latest" | jsonget s "d.get('tag_name','')" 2>/dev/null)
  local local_v; local_v="$(ver)"
  if [ -n "$latest" ] && [ "$latest" != "None" ]; then
    local lv="${latest#v}"
    if [ "$(printf '%s\n' "$local_v" "$lv" | sort -V | head -1)" = "$local_v" ] && [ "$local_v" != "$lv" ]; then
      echo "new release ${latest} available (installed v${local_v})" > "$cache"
      echo -e "  ${Y}new release ${latest} available  ${D}(installed v${local_v}) -> menu 7 to install${N}"
      return
    fi
  fi
  echo "-" > "$cache"
}

menu() {
  while true; do
    clear 2>/dev/null || true
    banner
    update_notice
    cat <<MENU
  ${B}1)${N}  Status overview
  ${B}2)${N}  Show web panel URL
  ${B}3)${N}  Change web panel password
  ${B}4)${N}  Change web panel port
  ${B}5)${N}  Live service logs
  ${B}6)${N}  Check for updates
  ${B}7)${N}  Update from GitHub
  ${B}8)${N}  Start web panel service
  ${B}9)${N}  Stop web panel service
  ${B}10)${N} Restart web panel service
  ${B}11)${N} Set up local Telegram Bot API server (2GB single-file backups)
  ${B}12)${N} Uninstall
  ${B}0)${N}  Exit

  ${D}backups & settings → web panel (option 2)${N}
MENU
    echo ""
    read -rp "$(echo -e "${B}bkup${N} > ")" choice
    case "$choice" in
      1) show_status; pause ;;
      2) show_url; pause ;;
      3) change_password_flow; pause ;;
      4) change_port_flow; pause ;;
      5) logs_flow ;;
      6) check_update_flow; pause ;;
      7) update_flow; pause ;;
      8) svc_control_flow start; pause ;;
      9) svc_control_flow stop; pause ;;
      10) svc_control_flow restart; pause ;;
      11) botapi_flow; pause ;;
      12) uninstall_flow; [ -f "$APP_DIR/cli.sh" ] || exit 0; pause ;;
      0|"q"|"Q") exit 0 ;;
      *) ;;
    esac
  done
}

# non-interactive: print status when piped
if [ -t 0 ]; then
  menu
else
  show_status
fi
