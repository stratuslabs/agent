#!/usr/bin/env bash
# Build the image and prove it serves: a seeded control API token, a held
# start and its promotion, and a pause that survives a container restart.
#
#   deploy/docker/smoke.sh            # from the repository root
#
# Needs Docker and curl. Leaves nothing running and no tag behind; the
# build's layers stay in Docker's cache.
set -euo pipefail

RUN_ID="$$-$(date +%s)"
# Unique to this run, the image as much as the container: two checkouts
# smoke-testing on one Docker host must each run the image they built.
IMAGE="stratusd:smoke-${RUN_ID}"
NAME="stratusd-smoke-${RUN_ID}"
BUILT=0
CREATED=0
# Empty: Docker picks a free host port for this run, read back below.
PORT=${SMOKE_PORT:-}
WORK=$(mktemp -d)
TOKEN="smoke-$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
API=

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
  if [ "$BUILT" = 1 ]; then
    docker rmi "$IMAGE" >/dev/null 2>&1 || true
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

# Where the API is published, read back from Docker after every start: a
# port Docker chose can change when the container restarts.
find_api() {
  local published
  published=$(docker port "$NAME" 4123/tcp | head -n 1) || fail "the API port is not published"
  API="http://127.0.0.1:${published##*:}/api/v1"
}

wait_healthy() {
  # A deadline on the clock, not a count of tries: one probe can itself take
  # the CLI's 5-second health timeout, so 60 tries could be six minutes.
  local deadline=$((SECONDS + 60))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if docker exec "$NAME" stratus health >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  fail "the daemon did not answer stratus health within 60 seconds"
}

echo "--- build"
BUILT=1
docker build -f deploy/docker/Dockerfile --target slim -t "$IMAGE" .

printf '%s\n' "$TOKEN" > "$WORK/gateway-token"
chmod 0644 "$WORK/gateway-token" # readable by the image's uid 1000
# `Z` relabels the per-run file for an SELinux host, which would otherwise
# refuse the container a mount it can see; elsewhere it does nothing.

echo "--- start held, with a seeded token"
CREATED=1
docker run -d --name "$NAME" \
  -e STRATUS_GATEWAY_TOKEN_FILE=/run/secrets/gateway-token \
  -v "$WORK/gateway-token:/run/secrets/gateway-token:ro,Z" \
  -p "127.0.0.1:${PORT}:4123" \
  "$IMAGE" stratus serve --api-host 0.0.0.0 --log-format json --held >/dev/null
wait_healthy
find_api

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
find_api
call GET /intake | grep -q '"paused":true' || fail "the pause did not survive a restart"
# Started by the same command, so held again until promoted: a service
# manager's restart is not an announced one.
call GET /health | grep -q '"held":true' || fail "a restart with --held should start held again"
call POST /promote | grep -q '"held":false' || fail "the second promote did not release the hold"
call PUT /intake '{"paused":false}' | grep -q '"paused":false' || fail "resume was refused"

echo "smoke: ok"
