#!/usr/bin/env bash
set -Eeuo pipefail

run_server() {
  echo "[start] Proxy (env from .env)"
  npm run dev >/tmp/swp.log 2>&1 &
  SWP_PID=$!
  for i in {1..50}; do
    if curl -sk https://127.0.0.1:8443/health | grep -q '^ok$'; then
      echo "[ready] PID $SWP_PID"
      return
    fi
    sleep 0.2
  done
  echo "[error] Proxy failed to become healthy"
  tail -n +1 /tmp/swp.log || true
  exit 1
}

stop_server() {
  if [[ -n "${SWP_PID:-}" ]]; then
    kill "$SWP_PID" 2>/dev/null || true
    wait "$SWP_PID" 2>/dev/null || true
    unset SWP_PID
  fi
}

check_noauth_407() {
  echo "[2] CONNECT without auth (expect 407)"
  curl -sk -D /tmp/h_noauth -x https://127.0.0.1:8443 --proxy-insecure https://example.com/ -o /dev/null || true
  grep -q "HTTP/1.1 407" /tmp/h_noauth && echo "OK (407)" || { echo "FAIL (no 407)"; exit 1; }
}

check_auth_200() {
  echo "[3] CONNECT with auth (expect 200 tunnel)"
  curl -sk -D /tmp/h_auth -x https://127.0.0.1:8443 --proxy-user myuser:mypassword --proxy-insecure https://example.com/ -o /dev/null
  grep -q "HTTP/1.1 200 Connection Established" /tmp/h_auth && echo "OK (200 tunnel)" || { echo "FAIL (no 200)"; exit 1; }
}

check_private_403() {
  echo "[4] Private IP blocked (expect 403)"
  curl -sk -D /tmp/h_priv -x https://127.0.0.1:8443 --proxy-user myuser:mypassword --proxy-insecure https://127.0.0.1/ -o /dev/null || true
  grep -q "HTTP/1.1 403" /tmp/h_priv && echo "OK (403 blocked)" || { echo "FAIL (no 403)"; exit 1; }
}

check_rate_limit_429() {
  echo "[5] Rate-limit (expect some 429)"
  stop_server
  MAX_CONNS_PER_IP=2 npm run dev >/tmp/swp_rl.log 2>&1 &
  SWP_PID=$!
  for i in {1..50}; do
    if curl -sk https://127.0.0.1:8443/health | grep -q '^ok$'; then break; fi
    sleep 0.2
  done
  rm -f /tmp/h_rl_*
  for i in {1..6}; do
    curl -sk -D "/tmp/h_rl_$i" -x https://127.0.0.1:8443 --proxy-user myuser:mypassword --proxy-insecure https://example.com/ -o /dev/null &
  done
  wait
  C=$(grep -l "HTTP/1.1 429" /tmp/h_rl_* 2>/dev/null | wc -l || true)
  [[ "$C" -ge 1 ]] && echo "OK ($C x 429)" || echo "WARN: 429 not observed; increase concurrency"
}

trap 'stop_server' EXIT

echo "[1] Start + health"
run_server
curl -sk https://127.0.0.1:8443/health | grep -q '^ok$' && echo "OK (health)"

check_noauth_407
check_auth_200
check_private_403
check_rate_limit_429

echo "[done] All core checks completed"