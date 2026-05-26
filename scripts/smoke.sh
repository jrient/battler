#!/usr/bin/env bash
# End-to-end smoke test: exercises the full agent闭环 via curl.
# Requires: server running on $AC_BASE (default http://localhost:8787).

set -euo pipefail

BASE="${AC_BASE:-http://localhost:8787}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STORE="$ROOT/data/store.json"

if [ -z "${AC_KEY:-}" ]; then
  if [ ! -f "$STORE" ]; then
    echo "no $STORE found. Run 'pnpm seed' first." >&2
    exit 1
  fi
  AC_KEY=$(node -e "const s=require('$STORE'); const c=Object.values(s.commanders)[0]; if(!c){process.exit(2)}; console.log(c.commanderKey)")
fi

H="Authorization: Bearer $AC_KEY"
JC="Content-Type: application/json"

hr() { echo; echo "================================================================"; echo "$1"; echo "================================================================"; }

hr "1. GET /api/commander  (read current state)"
curl -sS -H "$H" "$BASE/api/commander" | node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(0,"utf8")), null, 2))'

hr "2. GET /api/opponents  (list public bots)"
curl -sS "$BASE/api/opponents" | node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(0,"utf8")), null, 2))'

hr "3. POST /api/commander/code  (publish sample agent)"
PAYLOAD=$(node -e "
const fs=require('fs');
const code=fs.readFileSync('$ROOT/scripts/sample-agent.js','utf8');
console.log(JSON.stringify({code, submittedBy:'smoke/sample', changelog:'smoke v1'}));
")
curl -sS -X POST -H "$H" -H "$JC" -d "$PAYLOAD" "$BASE/api/commander/code" | node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(0,"utf8")), null, 2))'

hr "4. POST /api/commander/simulate  (vs red-charger)"
SIM=$(curl -sS -X POST -H "$H" -H "$JC" -d '{"opponent":"red-charger"}' "$BASE/api/commander/simulate")
echo "$SIM" | node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(0,"utf8")), null, 2))'
MATCH_ID=$(echo "$SIM" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).matchId)')

hr "5. GET /api/matches/$MATCH_ID/agent.json  (full battle report)"
curl -sS -H "$H" "$BASE/api/matches/$MATCH_ID/agent.json" | node -e '
const r=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log("result:", r.result);
console.log("myArmy:", JSON.stringify(r.myArmy));
console.log("enemyArmy:", JSON.stringify(r.enemyArmy));
console.log();
console.log("--- events (last 20) ---");
for (const e of r.events.slice(-20)) console.log(e);
console.log();
console.log("--- summary ---");
console.log(JSON.stringify(r.summary, null, 2));
'

hr "6. POST /api/commander/simulate again immediately  (expect 429 rate limited)"
HTTP_AND_BODY=$(curl -sS -X POST -H "$H" -H "$JC" -d '{"opponent":"red-charger"}' -w "\nHTTP_CODE:%{http_code}" "$BASE/api/commander/simulate")
echo "$HTTP_AND_BODY"

echo
echo "=== smoke complete ==="
