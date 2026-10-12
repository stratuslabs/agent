#!/usr/bin/env bash
# Build the image and prove it serves: a seeded control API token, a held
# start and its promotion, and a pause that survives a container restart.
#
#   deploy/docker/smoke.sh            # from the repository root
#
# Needs Docker and curl. Leaves nothing running; the image stays tagged
# stratusd:smoke.
set -euo pipefail

IMAGE=stratusd:smoke
NAME="stratusd-smoke-$$-$(date +%s)"
CREATED=0
PORT=${SMOKE_PORT:-4199}
WORK=$(mktemp -d)
TOKEN="smoke-$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
API="http://127.0.0.1:${PORT}/api/v1"

cleanup() {
  if [ "${1:-0}" != 0 ]; then
    echo "--- container logs" >&2
    docker logs "$NAME" >&2 2>&1 || true
  fi
  # Only a container this run created (the name is unique to it), with its
  # anonymous home volume (the Dockerfile declares one, and `rm` without -v
  # leaves it behind). Set before `docker run`, because run can create the
  # container and then fail to start it, a bound port for example.
  if [ "$CREATED" = 1 ]; then
    docker rm -fv "$NAME" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap 'cleanup $?' EXIT

fail() { echo "smoke: $*" >&2; exit 1; }

call() { # method path [json]
  if [ $# -ge 3 ]; then
    curl -fsS -X "$1" -H "authorization: Bearer ${TOKEN}" -H 'content-type: application/json' -d "$3" "${API}$2"
  else
    curl -fsS -X "$1" -H "authorization: Bearer ${TOKEN}" "${API}$2"
  fi
}

wait_healthy() {
  for _ in $(seq 1 60); do
    if docker exec "$NAME" stratus health >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  fail "the daemon did not answer stratus health within 60 seconds"
}

echo "--- build"
docker build -f deploy/docker/Dockerfile --target slim -t "$IMAGE" .

printf '%s\n' "$TOKEN" > "$WORK/gateway-token"
chmod 0644 "$WORK/gateway-token" # readable by the image's uid 1000

echo "--- start held, with a seeded token"
CREATED=1
docker run -d --name "$NAME" \
  -e STRATUS_GATEWAY_TOKEN_FILE=/run/secrets/gateway-token \
  -v "$WORK/gateway-token:/run/secrets/gateway-token:ro" \
  -p "127.0.0.1:${PORT}:4123" \
  "$IMAGE" stratus serve --api-host 0.0.0.0 --log-format json --held >/dev/null
wait_healthy

call GET /health | grep -q '"held":true' || fail "health does not report held"
status=$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer wrong-token" "${API}/health")
[ "$status" = 401 ] || fail "a wrong token got $status, not 401"

echo "--- promote"
call POST /promote | grep -q '"held":false' || fail "promote did not release the hold"
call GET /health | grep -q '"held":false' || fail "health still reports held after promote"

echo "--- pause, restart, still paused"
call PUT /intake '{"paused":true,"message":"Smoke test pause."}' | grep -q '"paused":true' || fail "pause was refused"
docker restart "$NAME" >/dev/null
wait_healthy
call GET /intake | grep -q '"paused":true' || fail "the pause did not survive a restart"
# Started by the same command, so held again until promoted: a service
# manager's restart is not an announced one.
call GET /health | grep -q '"held":true' || fail "a restart with --held should start held again"
call POST /promote | grep -q '"held":false' || fail "the second promote did not release the hold"
call PUT /intake '{"paused":false}' | grep -q '"paused":false' || fail "resume was refused"

echo "smoke: ok"
