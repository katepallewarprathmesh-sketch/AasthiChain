#!/usr/bin/env bash
# End-to-end regression sweep: existing AasthiChain surface + new UMI rail.
API=http://localhost:8080
GW=http://localhost:21100
PASS=0; FAIL=0
chk() { # chk "name" expected_code actual_code [extra]
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); printf "  ok   %-52s %s\n" "$1" "$3";
  else FAIL=$((FAIL+1)); printf "  FAIL %-52s got %s want %s %s\n" "$1" "$3" "$2" "$4"; fi
}
code() { curl -s -o /tmp/out.$$ -w "%{http_code}" "$@"; }

TOK=$(curl -s -X POST $API/api/auth/login -H 'Content-Type: application/json' -d '{"identityId":"investor1","role":"Investor"}' | python3 -c "import json,sys;print(json.load(sys.stdin).get('token',''))")
AUTH="Authorization: Bearer $TOK"

echo "== existing API (must be untouched) =="
chk "GET /api/health"            200 "$(code $API/api/health)"
chk "GET /api/properties"        200 "$(code -H "$AUTH" $API/api/properties)"
chk "GET /api/properties/:id"    200 "$(code -H "$AUTH" $API/api/properties/PROP-GREEN-VALLEY-PUNE-001)"
chk "GET /api/balances/wallet"   200 "$(code -H "$AUTH" $API/api/balances/wallet/investor1)"
chk "GET /api/transfers/history" 200 "$(code -H "$AUTH" $API/api/transfers/history)"
chk "GET /api/chain"             200 "$(code $API/api/chain)"
chk "GET /api/chain/verify"      200 "$(code $API/api/chain/verify)"
chk "GET /api/npci/config"       200 "$(code $API/api/npci/config)"
chk "GET /api/drunix/info"       200 "$(code $API/api/drunix/info)"
chk "GET /api/portfolio/nav"     200 "$(code -H "$AUTH" $API/api/portfolio/investor1/nav)"
chk "GET /api/testnet/config"    200 "$(code $API/api/testnet/config)"
chk "GET /api/openfinance/caps"  200 "$(code -H "$AUTH" $API/api/openfinance/capabilities)"
chk "POST /api/transfers (core buy path)" 200 "$(code -X POST -H "$AUTH" -H 'Content-Type: application/json' -d '{"assetId":"PROP-GREEN-VALLEY-PUNE-001","fromId":"investor1","toId":"investor2","amount":5}' $API/api/transfers)"
chk "GET /api/chain/verify after transfer" 200 "$(code $API/api/chain/verify)"
V=$(curl -s $API/api/chain/verify | python3 -c "import json,sys;print(json.load(sys.stdin)['valid'])")
chk "legacy chain still valid"   True "$V"

echo "== existing Go gateway (must be untouched) =="
chk "GET /health"                200 "$(code $GW/health)"
chk "GET /drunix/ledger/status"  200 "$(code $GW/drunix/ledger/status)"
chk "GET /fraud/config"          200 "$(code $GW/fraud/config)"
chk "GET /drunix/pipeline/stats" 200 "$(code $GW/drunix/pipeline/stats)"
chk "POST /drunix/submit"        201 "$(code -X POST -H 'Content-Type: application/json' -d '{"chaincode":"aasthichain","function":"TransferTokens","args":["PROP-GREEN-VALLEY-PUNE-001","originator1","investor1","10"],"creatorMsp":"InvestorMSP"}' $GW/drunix/submit)"

echo "== UI routes (SPA) =="
for p in / /login /marketplace /ledger /support /umi /wallet; do
  chk "GET $p" 200 "$(code $API$p)"
done

echo "== UMI rail =="
chk "GET  /api/umi/config"        200 "$(code $API/api/umi/config)"
# Seed a fresh asset per run. Re-seeding the demo asset returned 409
# SUPPLY_EXCEEDED on the second sweep against a long-lived rail, because the
# authorised cap was already set by the run before it — a failure about the
# previous sweep, not about this one.
SEEDASSET="PROP-SWEEP-$(date +%s%N)"
chk "POST /api/umi/seed"          200 "$(code -X POST -H 'Content-Type: application/json' -d "{\"assetId\":\"$SEEDASSET\",\"holder\":\"originator1\",\"tokens\":15000}" $API/api/umi/seed)"
chk "POST fund investor1"         200 "$(code -X POST -H 'Content-Type: application/json' -d '{"amountINR":100000}' $API/api/umi/wallets/investor1/fund)"
POOR="poor$(date +%s%N)"   # fresh underfunded participant (boot-seeded wallets may be rich)
chk "POST fund $POOR"          200 "$(code -X POST -H 'Content-Type: application/json' -d '{"amountINR":2000}' $API/api/umi/wallets/$POOR/fund)"
chk "POST dvp (happy)"            200 "$(code -X POST -H 'Content-Type: application/json' -d '{"assetId":"PROP-GREEN-VALLEY-PUNE-001","seller":"originator1","buyer":"investor1","tokens":100,"pricePerTokenINR":500}' $API/api/umi/dvp)"
chk "POST dvp (insufficient cash → 400)" 400 "$(code -X POST -H 'Content-Type: application/json' -d "{\"assetId\":\"PROP-GREEN-VALLEY-PUNE-001\",\"seller\":\"originator1\",\"buyer\":\"$POOR\",\"tokens\":100,\"pricePerTokenINR\":500}" $API/api/umi/dvp)"
chk "POST dvp (self → 400)"       400 "$(code -X POST -H 'Content-Type: application/json' -d '{"assetId":"PROP-GREEN-VALLEY-PUNE-001","seller":"originator1","buyer":"originator1","tokens":1,"pricePerTokenINR":500}' $API/api/umi/dvp)"
chk "POST dvp (bad amount → 400)" 400 "$(code -X POST -H 'Content-Type: application/json' -d '{"assetId":"PROP-GREEN-VALLEY-PUNE-001","seller":"originator1","buyer":"investor1","tokens":-5,"pricePerTokenINR":500}' $API/api/umi/dvp)"
chk "POST dvp (malformed json → 400)" 400 "$(code -X POST -H 'Content-Type: application/json' -d '{oops' $API/api/umi/dvp)"
chk "GET  dvp with GET (→405)"    405 "$(code $API/api/umi/dvp)"
chk "POST servicing"              200 "$(code -X POST -H 'Content-Type: application/json' -d '{"assetId":"PROP-GREEN-VALLEY-PUNE-001","payer":"originator1","amountINR":6000}' $API/api/umi/servicing)"
chk "GET  instructions"           200 "$(code $API/api/umi/instructions)"
chk "GET  unknown instruction→404" 404 "$(code $API/api/umi/instructions/NOPE)"
chk "GET  unknown wallet→404"     404 "$(code $API/api/umi/wallets/ghost)"
chk "GET  reconciliation"         200 "$(code $API/api/umi/reconciliation)"

echo "== UMI invariants =="
python3 - <<'EOF'
import json,urllib.request
d=json.load(urllib.request.urlopen('http://localhost:8080/api/umi/reconciliation'))
print("  conserved:",d['conserved'],"| funded ₹",d['totalFundedINR'],"| held ₹",d['totalBalanceINR'],
      "| chain valid:",d['chain']['valid'],"| settled",d['settledInstructions'],"failed",d['failedInstructions'])
assert d['conserved'], "MONEY NOT CONSERVED"
assert d['chain']['valid'], "CHAIN BROKEN"
EOF
chk "money conserved + chain valid" 0 "$?"

echo "== concurrency over HTTP (20 parallel DvP on a wallet funded for 2) =="
# unique participant per run so repeated sweeps don't inherit prior balances/servicing credits
STRESS="stress$(date +%s%N)"
curl -s -X POST -H 'Content-Type: application/json' -d '{"amountINR":1000}' $API/api/umi/wallets/$STRESS/fund >/dev/null
seq 20 | xargs -P20 -I{} curl -s -o /tmp/stress.{} -w "%{http_code}\n" -X POST -H 'Content-Type: application/json' \
  -d "{\"assetId\":\"PROP-GREEN-VALLEY-PUNE-001\",\"seller\":\"originator1\",\"buyer\":\"$STRESS\",\"tokens\":1,\"pricePerTokenINR\":500}" \
  $API/api/umi/dvp | sort | uniq -c | sed 's/^/  /'
STRESS=$STRESS python3 - <<'EOF'
import json,os,urllib.request
w=json.load(urllib.request.urlopen('http://localhost:8080/api/umi/wallets/'+os.environ['STRESS']))['wallet']
r=json.load(urllib.request.urlopen('http://localhost:8080/api/umi/reconciliation'))
print("  stress wallet balance ₹",w['balanceINR'],"(expect 0) | reserved ₹",w['balanceINR']-w['availableINR'],"(expect 0)")
print("  conserved after stress:",r['conserved'],"| chain valid:",r['chain']['valid'])
assert w['balancePaise']==0 and w['reservedPaise']==0 and r['conserved'] and r['chain']['valid']
EOF
chk "no double-spend / no leaked locks" 0 "$?"

echo "== rail-offline degradation =="
echo "  (checked separately)"

# Node suites. Discovered, not listed: every suite written so far had to be
# remembered into this file by hand, and listtotrade/preflight/chainpaging all
# sat outside the sweep for weeks because nobody remembered. A new file in
# tests/ is now in the sweep the moment it exists.
# This rig stays on mock-api-server.js while the main app runs server.js.
# The serverless handler persists its state to /tmp and reloads it on boot,
# so token supply carries over between runs and the primary sale eventually
# reads as fully subscribed; Express reseeds on every start, which is what a
# repeatable purchase test needs. Not a defect in either server.
# Three suites (payusettle, releasedresume, releaserail) drive the PayU
# callback path, which needs a gateway in payu mode with known test
# credentials. That instance used to be started by hand, which is exactly why
# those suites lived outside the sweep. Start it here, tear it down after.
PAYU_PID=""
if command -v node >/dev/null 2>&1; then
  NPCI_MODE=payu PAYU_MERCHANT_KEY=testkey PAYU_SALT=testsalt \
  PAYU_BASE_URL=https://test.payu.in/_payment \
  ADMIN_DASHBOARD_KEY=devkey UMI_GATEWAY_URL=$GW PORT=8099 \
  node /home/user/repo/mock-api-server.js >/tmp/payu-rig.log 2>&1 &
  PAYU_PID=$!
  for _ in $(seq 1 40); do
    curl -s -o /dev/null http://localhost:8099/api/health && break
    sleep 0.25
  done
fi

echo
echo "== secrets =="
SCAN=$(bash /home/user/repo/scripts/secret-scan.sh 2>&1); SCANRC=$?
printf '%s\n' "$SCAN"
chk "no credentials in tracked files" 0 "$SCANRC"

echo
echo "== node suites (tests/*.test.mjs) =="
for f in /home/user/repo/tests/*.test.mjs; do
  [ -e "$f" ] || continue
  name=$(basename "$f" .test.mjs)
  out=$(cd /home/user/repo && node "$f" 2>&1); rc=$?
  tally=$(printf '%s' "$out" | grep -oE '[0-9]+/[0-9]+ passed' | tail -1)
  if [ $rc -eq 0 ]; then
    PASS=$((PASS+1)); printf "  ok   %-52s %s\n" "$name" "$tally"
  else
    FAIL=$((FAIL+1)); printf "  FAIL %-52s %s\n" "$name" "${tally:-exit $rc}"
    printf '%s\n' "$out" | grep -E '^\s+FAIL' | head -5 | sed 's/^/       /'
  fi
done

# Never pkill — only the instance this script started.
if [ -n "$PAYU_PID" ]; then kill "$PAYU_PID" 2>/dev/null; wait "$PAYU_PID" 2>/dev/null; fi

echo
echo "RESULT: $PASS passed, $FAIL failed"
exit $FAIL
