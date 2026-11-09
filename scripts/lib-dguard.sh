#!/usr/bin/env bash
# =============================================================
#  bkup — disk & swap guard (v1.3.1)
#
#  Shared low-RAM / low-disk helper for install.sh and scripts/update.sh.
#  Sourced only — never executed directly.
#
#  WHY THIS EXISTS (the v1.3.0 bug this fixes):
#  The old logic created a FIXED 2 GB /swapfile on every server with
#  < 3 GB RAM. On a small disk (4–6 GB, typical budget VPS) that one
#  swapfile alone ate half the disk; then node_modules + the Next.js
#  build filled the rest — install died on ENOSPC, left the disk full
#  and the install broken, and the server itself crashed under a full
#  root filesystem (logging, panel, even the OS choke on 0 bytes free).
#
#  WHAT THIS LIBRARY DOES:
#    · Pre-flight disk check BEFORE any large write (fail cleanly,
#      change nothing)
#    · Adaptive swap sizing: min(1024 MB, 90% of RAM, free-disk room)
#      — never more than 1 GB, never below a 600 MB free-disk floor
#    · Full self-cleanup on EVERY failure path (swapfile + fstab line)
#    · Reclaims the legacy 2 GB swapfile left by old installs (v1.0–v1.3.0)
#
#  Everything is env-overridable so scripts/test-dguard.sh can exercise
#  the whole logic without root, /proc/meminfo or a real swap:
#    DG_MEM_FILE        fake /proc/meminfo path
#    DG_SWAP_MAX_MB     hard ceiling            (default 1024)
#    DG_MIN_SWAP_MB     smallest useful swap    (default 256)
#    DG_DISK_FLOOR_MB   free MB that must remain (default 600)
#    DG_INSTALL_MIN_MB  install pre-flight need (default 2600)
#    DG_UPDATE_MIN_MB   update  pre-flight need (default 1800)
#    DG_SWAPFILE        swapfile path           (default /swapfile)
#    DG_FSTAB           fstab path              (default /etc/fstab)
#    DG_QUIET           set to 1 to silence dg_say()* messages
# =============================================================

set -uo pipefail 2>/dev/null || set -u

DG_SWAP_MAX_MB="${DG_SWAP_MAX_MB:-1024}"
DG_MIN_SWAP_MB="${DG_MIN_SWAP_MB:-256}"
DG_DISK_FLOOR_MB="${DG_DISK_FLOOR_MB:-600}"
DG_INSTALL_MIN_MB="${DG_INSTALL_MIN_MB:-2600}"
DG_UPDATE_MIN_MB="${DG_UPDATE_MIN_MB:-1800}"
DG_MEM_FILE="${DG_MEM_FILE:-/proc/meminfo}"
DG_SWAPFILE="${DG_SWAPFILE:-/swapfile}"
DG_FSTAB="${DG_FSTAB:-/etc/fstab}"
DG_QUIET="${DG_QUIET:-0}"

# ── output hook — callers may override before/after sourcing ──
if ! declare -F dg_emit >/dev/null 2>&1; then
  dg_emit() { printf '%s\n' "$*"; }
fi
dg_say() { [ "$DG_QUIET" = "1" ] && return 0; dg_emit "$@"; }

# ── memory probes (all over the fake /proc/meminfo path) ─────
_dg_mem_total_mb() {
  awk '/^MemTotal:/{print int($2/1024)}' "$DG_MEM_FILE" 2>/dev/null || echo 0
}
_dg_mem_avail_mb() {
  awk '/^MemAvailable:/{print int($2/1024)}' "$DG_MEM_FILE" 2>/dev/null || echo 0
}
_dg_swap_active_mb() {
  awk '/^SwapTotal:/{print int($2/1024)}' "$DG_MEM_FILE" 2>/dev/null || echo 0
}

# ── disk probe: free MB on the filesystem containing $1 ──────
dg_avail_mb() {
  df -Pm "$1" 2>/dev/null | awk 'NR==2{print $4}'
}

# Small helper: is $1 a positive integer?
_dg_is_int() { [ -n "$1" ] && [ "$1" = "$(( $1 + 0 ))" ] 2>/dev/null; }

# ── 1) PRE-FLIGHT ────────────────────────────────────────────
# Usage: dg_disk_ok <path> <need_mb>  → 0 when free >= need
# The caller prints its own die/abort message.
dg_disk_ok() {
  local free
  free="$(dg_avail_mb "$1")"
  _dg_is_int "$free" || free=0
  [ "$free" -ge "$2" ]
}

# ── 2) LEGACY RECLAIM ────────────────────────────────────────
# Old releases (v1.0–v1.3.0) left a 2 GB /swapfile behind. Free it:
#   · inactive leftover garbage            → delete outright
#   · active swap larger than our ceiling  → swapoff & release, but ONLY
#     when RAM can immediately absorb it (MemAvailable >= swapfile size);
#     otherwise it is left untouched — shrinking live swap on a tight
#     memory box would risk an OOM kill.
# Returns 0 when space was reclaimed.
dg_reclaim_legacy_swap() {
  local sz mb active
  [ -f "$DG_SWAPFILE" ] || return 1
  sz=$(stat -c %s "$DG_SWAPFILE" 2>/dev/null | awk '{print int($1/1024/1024)}')
  _dg_is_int "$sz" || sz=0
  [ "$sz" -gt "$DG_SWAP_MAX_MB" ] || return 1   # not legacy, or swapoff already handled sizing

  active="$( _dg_swap_active_mb )"
  _dg_is_int "$active" || active=0
  if [ "$active" -gt 0 ]; then
    local ram
    ram="$( _dg_mem_avail_mb )"; _dg_is_int "$ram" || ram=0
    if [ "$ram" -lt "$sz" ]; then
      dg_say "swap: /swapfile is ${sz}MB and in use — leaving it (not enough free memory to swapoff safely)"
      return 1
    fi
    if ! swapoff "$DG_SWAPFILE" >/dev/null 2>&1; then
      dg_say "swap: swapoff failed on legacy /swapfile — leaving it untouched"
      return 1
    fi
  fi

  rm -f "$DG_SWAPFILE"
  _dg_fstab_remove
  dg_say "swap: reclaimed legacy /swapfile (${sz}MB) — freed on disk"
  return 0
}

# ── 3) ADAPTIVE SIZING ───────────────────────────────────────
# Echoes how much swap to create, in MB (0 = none).
#   want = min(DG_SWAP_MAX_MB, 90% of RAM) but never more room than
#   (free MB − DG_DISK_FLOOR_MB); below DG_MIN_SWAP_MB skip entirely.
dg_plan_swap_mb() {
  local mem swap_now free room want
  mem="$( _dg_mem_total_mb )";        _dg_is_int "$mem"      || mem=0
  swap_now="$( _dg_swap_active_mb )"; _dg_is_int "$swap_now" || swap_now=0
  free="$(dg_avail_mb "$(dirname "$DG_SWAPFILE")")"; _dg_is_int "$free" || free=0

  # No swap needed: an active swap exists, or RAM is unknown/healthy.
  if [ "$swap_now" -gt 0 ]; then echo 0; return 0; fi
  if [ "$mem" -le 0 ] || [ "$mem" -ge 3000 ]; then echo 0; return 0; fi

  # Room left AFTER keeping the free-disk floor.
  room=$(( free - DG_DISK_FLOOR_MB ))
  [ "$room" -lt 0 ] && room=0

  want="$DG_SWAP_MAX_MB"
  [ "$mem" -lt "$want" ] && want=$(( mem * 90 / 100 ))   # swap never dwarfs RAM
  [ "$want" -gt "$room" ] && want="$room"                # never breach the floor

  if [ "$want" -lt "$DG_MIN_SWAP_MB" ]; then echo 0; return 0; fi
  echo "$want"
}

# ── 4) FAILURE CLEANUP ───────────────────────────────────────
# Removes the swapfile + any fstab line we own. Used on every failure
# path so a half-made swap never lingers eating disk (the v1.3.0 bug).
dg_swap_cleanup() {
  swapoff "$DG_SWAPFILE" >/dev/null 2>&1 || true
  rm -f "$DG_SWAPFILE" 2>/dev/null || true
  _dg_fstab_remove
}

# ── fstab helpers (exact-line, idempotent) ───────────────────
_dg_fstab_has() {
  [ -f "$DG_FSTAB" ] || return 1
  awk -v sf="$DG_SWAPFILE" 'index($0, sf) == 1 {found=1} END{exit !found}' "$DG_FSTAB"
}
_dg_fstab_add() {
  _dg_fstab_has && return 0
  printf '%s none swap sw 0 0\n' "$DG_SWAPFILE" >> "$DG_FSTAB" 2>/dev/null || return 1
  return 0
}
_dg_fstab_remove() {
  # Drop only lines that BEGIN with the swapfile path; keep everything else.
  [ -f "$DG_FSTAB" ] || return 0
  awk -v sf="$DG_SWAPFILE" 'index($0, sf) != 1 {print}' "$DG_FSTAB" > "${DG_FSTAB}.dg-new" 2>/dev/null \
    && mv "${DG_FSTAB}.dg-new" "$DG_FSTAB" 2>/dev/null || true
}

# ── 5) TOP-LEVEL ENTRY ───────────────────────────────────────
# Decide, size, create, enable, persist — and clean up loudly when
# anything fails. Returns 0 even when skipped (skip ≠ error); only a
# real allocation failure returns non-zero.
dg_setup_swap() {
  dg_reclaim_legacy_swap || true

  local plan
  plan="$(dg_plan_swap_mb)"
  _dg_is_int "$plan" || plan=0

  if [ "$plan" -eq 0 ]; then
    dg_say "swap: skipped (RAM OK, or free disk too tight — floor ${DG_DISK_FLOOR_MB}MB kept free)"
    return 0
  fi

  dg_say "swap: creating ${plan}MB swapfile (adaptive — was a fixed 2GB before v1.3.1)"

  if ! fallocate -l "${plan}M" "$DG_SWAPFILE" 2>/dev/null; then
    # fallocate can fail on some filesystems (kernel/FS quirk) — fall back
    # to dd with the SAME capped size, never the old blind 2048 blocks.
    dd if=/dev/zero of="$DG_SWAPFILE" bs=1M count="$plan" status=none 2>/dev/null \
      || { dg_swap_cleanup; dg_say "swap: could not allocate $DG_SWAPFILE — swap skipped"; return 1; }
  fi
  chmod 600 "$DG_SWAPFILE" 2>/dev/null || true

  if ! mkswap "$DG_SWAPFILE" >/dev/null 2>&1; then
    dg_swap_cleanup
    dg_say "swap: mkswap failed — swapfile removed, swap skipped"
    return 1
  fi
  if ! swapon "$DG_SWAPFILE" >/dev/null 2>&1; then
    dg_swap_cleanup
    dg_say "swap: swapon failed (filesystem may not support swap) — swapfile removed, swap skipped"
    return 1
  fi

  _dg_fstab_add || dg_say "swap: warning — could not persist $DG_SWAPFILE in $DG_FSTAB"

  dg_say "swap: enabled (${plan}MB at $DG_SWAPFILE)"
  return 0
}

# ── 6) HUMAN-FRIENDLY PRE-FLIGHT REPORT ──────────────────────
# Usage: dg_report_disk <path> <need_mb> <context>
# Echoes a one-line status; returns the result of dg_disk_ok.
dg_report_disk() {
  local free
  free="$(dg_avail_mb "$1")"; _dg_is_int "$free" || free=0
  if dg_disk_ok "$1" "$2"; then
    dg_say "disk: ${free}MB free of ${2}MB needed (${3})"
    return 0
  fi
  dg_say "disk: ${free}MB free — ${2}MB needed for the ${3} (root too small)"
  return 1
}
