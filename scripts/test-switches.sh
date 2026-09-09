#!/usr/bin/env bash
# =============================================================
# bkup — API-level switch/persistence/password test harness
# Boots the standalone build on :3999 with a throwaway DB and
# exercises the exact flows the user reported broken.
# =============================================================
set -uo pipefail
BASE="http://127.0.0.1:3999"
COOKIE=/tmp/bkup-test-cookies.txt
rm -f "$COOKIE" /tmp/bkup-test.db
DB="file:/tmp/bkup-test.db"

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export DATABASE_URL="$DB"
export PORT=3999
export HOSTNAME=127.0.0.1

npx prisma db push --skip-generate >/dev/null 2>&1 || { echo "✗ db push failed"; exit 1; }

NODE_ENV=production node .next/standalone/server.js >/tmp/bkup-test-server.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT

# wait for boot
for i in $(seq 1 30); do
  curl -sf "$BASE/api/auth/state" >/dev/null 2>&1 && break
  sleep 0.5
done

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "✔ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "✗ $1"; }
check(){ if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (expected=$1 got=$2)"; fi; }

api() { # method path [json] → body ; saves HTTP code in /tmp/api-http
  local m="$1" p="$2" d="${3:-}"
  if [ -n "$d" ]; then
    curl -s -o /tmp/api-out.json -w "%{http_code}" -b "$COOKIE" -c "$COOKIE" \
      -X "$m" -H "Content-Type: application/json" -d "$d" "$BASE$p" > /tmp/api-http
  else
    curl -s -o /tmp/api-out.json -w "%{http_code}" -b "$COOKIE" -c "$COOKIE" \
      -X "$m" "$BASE$p" > /tmp/api-http
  fi
  HTTP=$(cat /tmp/api-http)
  cat /tmp/api-out.json
}

echo "== 1. setup password (first run) =="
OUT=$(api POST /api/auth/login '{"password":"test1234","setup":true}')
check 200 "$(cat /tmp/api-http)" "setup returns 200"
STATE=$(api GET /api/auth/state)
echo "$STATE" | grep -q '"passwordSet":true' && ok "passwordSet=true after setup" || bad "passwordSet: $STATE"
echo "$STATE" | grep -q '"authenticated":true' && ok "authenticated after setup" || bad "not authenticated: $STATE"

echo "== 2. config GET (initial) =="
OUT=$(api GET /api/config)
check 200 "$(cat /tmp/api-http)" "config GET 200"
echo "$OUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print('   enabled:',d['enabled'],'xui:',d['xuiEnabled'],'skipTls:',d['skipTlsVerify'])"

echo "== 3. toggle enabled=true → GET must persist =="
OUT=$(api PUT /api/config '{"enabled":true}')
check 200 "$(cat /tmp/api-http)" "PUT enabled=true 200"
echo "$OUT" | grep -q '"enabled":true' && ok "PUT response enabled=true" || bad "PUT resp: $OUT"
OUT=$(api GET /api/config)
echo "$OUT" | grep -q '"enabled":true' && ok "persisted: GET enabled=true" || bad "GET after PUT: $OUT"

echo "== 4. toggle enabled=false (dashboard OFF path) =="
api PUT /api/config '{"enabled":false}' >/dev/null
OUT=$(api GET /api/config)
echo "$OUT" | grep -q '"enabled":false' && ok "persisted: GET enabled=false" || bad "GET: $OUT"

echo "== 5. toggle xuiEnabled + skipTlsVerify independently =="
api PUT /api/config '{"xuiEnabled":true}' >/dev/null
api PUT /api/config '{"skipTlsVerify":true}' >/dev/null
OUT=$(api GET /api/config)
echo "$OUT" | python3 -c "
import json,sys
d=json.load(sys.stdin)
assert d['xuiEnabled'] is True, 'xuiEnabled not persisted'
assert d['skipTlsVerify'] is True, 'skipTlsVerify not persisted'
assert d['enabled'] is False, 'enabled changed unexpectedly (cross-toggle leak!)'
print('   xui=True skipTls=True enabled=False — independent ✓')
" && ok "independent toggles, no cross-leak" || bad "independence check"

echo "== 6. status endpoint reflects enabled=false (dashboard/settings single source) =="
OUT=$(api GET /api/status)
check 200 "$(cat /tmp/api-http)" "status GET 200"
echo "$OUT" | python3 -c "
import json,sys
d=json.load(sys.stdin)
assert d['scheduler']['enabled'] is False, 'scheduler.enabled mismatch with config.enabled'
print('   status.scheduler.enabled=False == config.enabled ✓')
" && ok "dashboard & settings same source" || bad "status mismatch"

echo "== 7. change password (web panel flow) =="
OUT=$(api POST /api/auth/change-password '{"current":"test1234","next":"newpass99"}')
check 200 "$(cat /tmp/api-http)" "change-password 200"
# old session should now be invalid → re-login with new password
OUT=$(api POST /api/auth/login '{"password":"newpass99"}')
check 200 "$(cat /tmp/api-http)" "login with NEW password 200"
STATE=$(api GET /api/auth/state)
echo "$STATE" | grep -q '"authenticated":true' && ok "authenticated with new password" || bad "state: $STATE"
echo "== 7b. wrong old password must be rejected =="
OUT=$(api POST /api/auth/change-password '{"current":"test1234","next":"hack9999"}')
[ "$(cat /tmp/api-http)" != "200" ] && ok "old password rejected (HTTP $HTTP)" || bad "old password ACCEPTED!"

echo "== 8. rapid toggles (double-click protection & final state wins) =="
api PUT /api/config '{"enabled":true}'  >/dev/null
api PUT /api/config '{"enabled":false}' >/dev/null
api PUT /api/config '{"enabled":true}'  >/dev/null
OUT=$(api GET /api/config)
echo "$OUT" | grep -q '"enabled":true' && ok "final state = last write (true)" || bad "rapid toggle ended wrong"

echo ""
echo "================================"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = "0" ] || exit 1
