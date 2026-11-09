#!/usr/bin/env bash
# =============================================================
# bkup — unit tests for scripts/lib-dguard.sh (v1.3.1)
#
# Runs the WHOLE disk/swap logic locally with mocked df / fallocate /
# dd / mkswap / swapon / swapoff and a fake /proc/meminfo — no root,
# no real swap, no big disk writes (all limits are scaled down via the
# DG_* env knobs; the math under test is identical).
#
# Run:  bash scripts/test-dguard.sh
# =============================================================
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"

PASS=0
FAIL=0

# ── scaled-down test knobs (same ratios, tiny MB) ────────────
export DG_SWAP_MAX_MB=64      # real default: 1024
export DG_MIN_SWAP_MB=8       # real default: 256
export DG_DISK_FLOOR_MB=10    # real default: 600

# silence library chatter during assertions
export DG_QUIET=1

source "$DIR/lib-dguard.sh"

# ── mock df (dynamic free space from DG_TEST_DF_FREE) ────────
df() {
  echo "Filesystem 1M-blocks Used Available Use% Mounted"
  echo "mockdev 1024 0 ${DG_TEST_DF_FREE:-100} 0% ${3:-/}"
  return 0
}

# ── mock binaries; every call is journaled to $TDIR/trace ────
mkbig() { _mb="$1"; _f="$2"
  if command -v truncate >/dev/null 2>&1; then truncate -s "${_mb}M" "$_f"
  else command dd if=/dev/zero of="$_f" bs=1M count="$_mb" status=none; fi
}
fallocate() {
  echo "fallocate $*" >> "$TDIR/trace"
  [ "${FALLOCATE_FAIL:-0}" = "0" ] || return 1
  # real signature: fallocate -l <size> <file>
  mkbig "$2" "$3"
}
dd() {
  if [ "${DD_REAL:-0}" = "1" ]; then command dd "$@"; return $?; fi
  echo "dd $*" >> "$TDIR/trace"
  [ "${DD_FAIL:-0}" = "0" ] || return 1
  local n=1 f=""
  local a
  for a in "$@"; do
    case "$a" in
      count=*) n="${a#count=}" ;;
      of=*)    f="${a#of=}" ;;
    esac
  done
  [ -n "$f" ] && mkbig "$n" "$f"
  return 0
}
mkswap() { echo "mkswap $*" >> "$TDIR/trace"; return ${MKSWAP_FAIL:-0}; }
swapon() { echo "swapon $*" >> "$TDIR/trace"; return ${SWAPON_FAIL:-0}; }
swapoff() { echo "swapoff $*" >> "$TDIR/trace"; return 0; }

# ── helpers ──────────────────────────────────────────────────
memfile() { # <totalKB> <availKB> <swapKB>
  printf 'MemTotal: %s kB\nMemAvailable: %s kB\nSwapTotal: %s kB\nSwapFree: %s kB\n' \
    "$1" "$2" "$3" "$3" > "$TDIR/meminfo"
  DG_MEM_FILE="$TDIR/meminfo"
  DG_SWAPFILE="$TDIR/swapfile"
  DG_FSTAB="$TDIR/fstab"
}
assert_eq() {
  if [ "$1" = "$2" ]; then echo "  ✔ ${3:-assert}"; return 0; fi
  echo "  ✘ ${3:-assert} — got [${1}], want [${2}]"
  return 1
}
assert_file_absent() {
  if [ ! -f "$1" ]; then echo "  ✔ $2"; return 0; fi
  echo "  ✘ $2 — file still exists: $1"
  return 1
}
assert_trace() {
  if grep -q "$2" "$TDIR/trace" 2>/dev/null; then echo "  ✔ $1"; return 0; fi
  echo "  ✘ $1 — trace has no [$2]: $(cat "$TDIR/trace" 2>/dev/null | tr '\n' ' ')"
  return 1
}
assert_no_trace() {
  if ! grep -q "$2" "$TDIR/trace" 2>/dev/null; then echo "  ✔ $1"; return 0; fi
  echo "  ✘ $1 — trace unexpectedly contains [$2]"
  return 1
}

# ══════════════════════════════════════════════════════════════
#  SIZING (dg_plan_swap_mb)
# ══════════════════════════════════════════════════════════════
T_plan_small_ram() {                 # 1GB-class RAM → swap capped at 64MB (scaled 1GB)
  TDIR="$(mktemp -d)"; memfile 1048576 524288 0; DG_TEST_DF_FREE=200
  local p; p="$(dg_plan_swap_mb)"
  assert_eq "$p" "64" "small RAM gets the capped swap (64 = scaled 1024)"
}

T_plan_big_ram() {                   # 3GB+ RAM → zero swap
  TDIR="$(mktemp -d)"; memfile 3145728 1048576 0; DG_TEST_DF_FREE=5000
  local p; p="$(dg_plan_swap_mb)"
  assert_eq "$p" "0" "RAM >= 3GB needs no swap"
}

T_plan_unknown_ram() {               # /proc/meminfo unreadable → zero swap
  TDIR="$(mktemp -d)"; DG_MEM_FILE="$TDIR/does-not-exist"; DG_SWAPFILE="$TDIR/swapfile"; DG_FSTAB="$TDIR/fstab"
  local p; p="$(dg_plan_swap_mb)"
  assert_eq "$p" "0" "unknown RAM → no swap (safe default)"
}

T_plan_swap_active() {               # an active swap exists → never create another
  TDIR="$(mktemp -d)"; memfile 1048576 524288 65536; DG_TEST_DF_FREE=5000
  local p; p="$(dg_plan_swap_mb)"
  assert_eq "$p" "0" "active swap → no new swap"
}

T_plan_disk_floor() {                # free 60MB → room 50 → swap = 50 (floor kept)
  TDIR="$(mktemp -d)"; memfile 1048576 524288 0; DG_TEST_DF_FREE=60
  local p; p="$(dg_plan_swap_mb)"
  assert_eq "$p" "50" "swap capped by free-disk floor (free 60 - floor 10)"
}

T_plan_tiny_room() {                 # free 15MB → room 5 < min 8 → skip entirely
  TDIR="$(mktemp -d)"; memfile 1048576 524288 0; DG_TEST_DF_FREE=15
  local p; p="$(dg_plan_swap_mb)"
  assert_eq "$p" "0" "disk too tight → swap skipped instead of filling the disk"
}

# ══════════════════════════════════════════════════════════════
#  SETUP (dg_setup_swap) — happy path + every failure path
# ══════════════════════════════════════════════════════════════
T_setup_success() {
  TDIR="$(mktemp -d)"; : > "$TDIR/trace"; memfile 1048576 524288 0; DG_TEST_DF_FREE=200
  dg_setup_swap
  assert_eq "$?" "0" "setup returns success"
  assert_trace "swapfile enabled via swapon" "^swapon"
  assert_no_trace "no cleanup pass on success" "^swapoff"
  assert_eq "$(awk -v sf="$DG_SWAPFILE" 'index($0,sf)==1' "$DG_FSTAB" | wc -l)" "1" "fstab line persisted"
  local sz; sz=$(stat -c %s "$DG_SWAPFILE" 2>/dev/null | awk '{print int($1/1024/1024)}')
  assert_eq "$sz" "64" "swapfile sized 64MB (scaled), not the old blind 2048"
}

T_setup_dd_fallback() {
  TDIR="$(mktemp -d)"; : > "$TDIR/trace"; memfile 1048576 524288 0; DG_TEST_DF_FREE=200
  FALLOCATE_FAIL=1
  local rc=0; dg_setup_swap || rc=$?
  assert_eq "$rc" "0" "fallocate failure falls back to dd and still succeeds"
  assert_trace "dd was the fallback allocator" "^dd"
}

T_setup_dd_total_failure_cleans_up() {
  TDIR="$(mktemp -d)"; : > "$TDIR/trace"; memfile 1048576 524288 0; DG_TEST_DF_FREE=200
  FALLOCATE_FAIL=1; DD_FAIL=1
  local rc=0; dg_setup_swap || rc=$?
  assert_file_absent "$DG_SWAPFILE" "NO swapfile garbage left when allocation fails"
  assert_eq "$rc" "1" "reports failure (rc=1)"
  assert_eq "$(grep -c "swap" "$DG_FSTAB" 2>/dev/null || echo 0)" "0" "no fstab entry on failure"
}

T_setup_mkswap_fails_cleans_up() {
  TDIR="$(mktemp -d)"; : > "$TDIR/trace"; memfile 1048576 524288 0; DG_TEST_DF_FREE=200
  MKSWAP_FAIL=1
  local rc=0; dg_setup_swap || rc=$?
  assert_file_absent "$DG_SWAPFILE" "mkswap failure → swapfile removed (old code left it)"
  assert_no_trace "swapon never ran on a broken swap" "^swapon"
}

T_setup_swapon_fails_cleans_up() {
  TDIR="$(mktemp -d)"; : > "$TDIR/trace"; memfile 1048576 524288 0; DG_TEST_DF_FREE=200
  SWAPON_FAIL=1
  local rc=0; dg_setup_swap || rc=$?
  assert_file_absent "$DG_SWAPFILE" "swapon failure → swapfile removed + no disk waste"
}

# ══════════════════════════════════════════════════════════════
#  LEGACY RECLAIM (dg_reclaim_legacy_swap) — old 2GB swapfile
# ══════════════════════════════════════════════════════════════
T_reclaim_inactive() {
  TDIR="$(mktemp -d)"; : > "$TDIR/trace"; memfile 1048576 524288 0; DG_TEST_DF_FREE=400
  printf 'otherfs none ext4 defaults 0 0\n%s none swap sw 0 0\n' "$DG_SWAPFILE" > "$DG_FSTAB"
  mkbig 128 "$DG_SWAPFILE"           # legacy 2GB at test scale (128 > cap 64), inactive
  dg_reclaim_legacy_swap
  assert_file_absent "$DG_SWAPFILE" "legacy leftover swapfile deleted"
  assert_eq "$(awk 'index($0,"otherfs")==1' "$DG_FSTAB" | wc -l)" "1" "other fstab lines preserved"
  assert_eq "$(awk '/none swap/{c++} END{print c+0}' "$DG_FSTAB")" "0" "legacy fstab swap line removed"
}

T_reclaim_active_with_memory() {
  TDIR="$(mktemp -d)"; : > "$TDIR/trace"; memfile 1048576 524288 131072; DG_TEST_DF_FREE=400
  mkbig 128 "$DG_SWAPFILE"
  dg_reclaim_legacy_swap
  assert_trace "swapoff called before reclaim (memory could absorb it)" "^swapoff"
  assert_file_absent "$DG_SWAPFILE" "active legacy swapfile reclaimed"
}

T_reclaim_active_low_memory() {
  TDIR="$(mktemp -d)"; : > "$TDIR/trace"; memfile 1048576 32768 131072; DG_TEST_DF_FREE=400
  mkbig 128 "$DG_SWAPFILE"
  local rc=0; dg_reclaim_legacy_swap || rc=$?
  assert_eq "$rc" "1" "declines to reclaim when RAM cannot absorb the swap"
  assert_no_trace "swapoff NOT attempted when unsafe" "^swapoff"
  assert_eq "$(stat -c %s "$DG_SWAPFILE" 2>/dev/null | awk '{print int($1/1024/1024)}')" "128" "swapfile untouched"
}

T_reclaim_normal_sized_untouched() {
  TDIR="$(mktemp -d)"; : > "$TDIR/trace"; memfile 1048576 524288 0; DG_TEST_DF_FREE=400
  mkbig 32 "$DG_SWAPFILE"            # smaller than the cap → NOT legacy
  local rc=0; dg_reclaim_legacy_swap || rc=$?
  assert_eq "$rc" "1" "normal-sized files are not touched"
  assert_eq "$(stat -c %s "$DG_SWAPFILE" 2>/dev/null | awk '{print int($1/1024/1024)}')" "32" "file kept"
}

# ══════════════════════════════════════════════════════════════
#  PRE-FLIGHT (dg_disk_ok / dg_report_disk) + fstab idempotence
# ══════════════════════════════════════════════════════════════
T_preflight_ok() {
  TDIR="$(mktemp -d)"; DG_SWAPFILE="$TDIR/swapfile"; DG_FSTAB="$TDIR/fstab"
  DG_TEST_DF_FREE=2600
  dg_disk_ok "$TDIR" 12
  assert_eq "$?" "0" "2600MB free (>= install minimum 12 scaled) passes"
}

T_preflight_fail() {
  TDIR="$(mktemp -d)"; DG_SWAPFILE="$TDIR/swapfile"; DG_FSTAB="$TDIR/fstab"
  DG_TEST_DF_FREE=800
  dg_disk_ok "$TDIR" 3000
  assert_eq "$?" "1" "800MB free < 3000 needed → pre-flight fails"
}

T_fstab_idempotent() {
  TDIR="$(mktemp -d)"; DG_SWAPFILE="$TDIR/swapfile"; DG_FSTAB="$TDIR/fstab"; : > "$DG_FSTAB"
  _dg_fstab_add; _dg_fstab_add; _dg_fstab_add
  assert_eq "$(grep -c "swap" "$DG_FSTAB")" "1" "three adds → exactly one fstab line"
}

T_fstab_remove_targeted() {
  TDIR="$(mktemp -d)"; DG_SWAPFILE="$TDIR/swapfile"; DG_FSTAB="$TDIR/fstab"
  printf 'usr noatime 0 0\n%s none swap sw 0 0\nvartmp none tmpfs 0 0\n' "$DG_SWAPFILE" > "$DG_FSTAB"
  _dg_fstab_remove
  assert_eq "$(wc -l < "$DG_FSTAB")" "2" "only the swapfile line removed"
  assert_eq "$(grep -c "noatime\|tmpfs" "$DG_FSTAB")" "2" "other fstab entries survive intact"
}

# ══════════════════════════════════════════════════════════════
#  RUN
# ══════════════════════════════════════════════════════════════
echo "═══ bkup lib-dguard tests ═══"
for t in T_plan_small_ram T_plan_big_ram T_plan_unknown_ram T_plan_swap_active \
         T_plan_disk_floor T_plan_tiny_room \
         T_setup_success T_setup_dd_fallback T_setup_dd_total_failure_cleans_up \
         T_setup_mkswap_fails_cleans_up T_setup_swapon_fails_cleans_up \
         T_reclaim_inactive T_reclaim_active_with_memory T_reclaim_active_low_memory \
         T_reclaim_normal_sized_untouched \
         T_preflight_ok T_preflight_fail T_fstab_idempotent T_fstab_remove_targeted; do
  echo "▶ $t"
  if ( "$t" ); then
    PASS=$((PASS+1))
  else
    FAIL=$((FAIL+1))
    echo "  ✘ SCENARIO FAILED"
  fi
done

echo
echo "═══ results: $PASS passed, $FAIL failed ═══"
[ "$FAIL" -eq 0 ]
