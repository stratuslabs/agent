#!/usr/bin/env bash
# Bring up compose.yaml as documented, on the offline demo provider, and check
# what it promises: it starts and answers `stratus health`, the state volume
# belongs to the daemon's user, the root filesystem is read-only with /tmp
# writable, every capability is dropped and no-new-privileges holds, and state
# survives a restart. It also reports whether the shell tool's sandbox
# (bubblewrap) can start inside these limits, which depends on the host.
#
#   deploy/docker/compose-smoke.sh    # from the repository root
#
# Needs Docker with Compose v2.24.4 or later (for `!override`) and curl.
# Everything it creates is its own: a project, container, image tag and
# volume named for this run, its own env file and a port Docker picks. An
# existing deployment's stratusd.env, container, port and volume are never
# touched. It removes what it created on the way out.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
RUN_ID="$(date +%s)-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
PROJECT="stratus-smoke-${RUN_ID}"
IMAGE="stratusd:compose-smoke-${RUN_ID}"
WORK=$(mktemp -d)
UP=0
API=
TOKEN=

compose() {
  docker compose -p "$PROJECT" -f "$DIR/compose.yaml" -f "$WORK/override.yaml" "$@"
}

cleanup() {
  if [ "${1:-0}" != 0 ] && [ "$UP" = 1 ]; then
    echo "--- container logs" >&2
    compose logs --no-color >&2 2>&1 || true
  fi
  if [ "$UP" = 1 ]; then
    # -v: this project's named volume only; the project name is unique to the run.
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    docker rmi "$IMAGE" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap 'cleanup $?' EXIT

fail() { echo "compose-smoke: $*" >&2; exit 1; }
in_container() { compose exec -T stratusd "$@"; }

call() { # method path [json]
  if [ $# -ge 3 ]; then
    curl -fsS --max-time 30 -X "$1" -H "authorization: Bearer ${TOKEN}" -H 'content-type: application/json' -d "$3" "${API}$2"
  else
    curl -fsS --max-time 30 -X "$1" -H "authorization: Bearer ${TOKEN}" "${API}$2"
  fi
}

# The published port is read back after every start: one Docker chose can
# change across a restart.
find_api() {
  local published
  published=$(compose port stratusd 4123 | head -n 1) || fail "the API port is not published"
  [ -n "$published" ] || fail "the API port is not published"
  API="http://127.0.0.1:${published##*:}/api/v1"
}

wait_healthy() {
  local deadline=$((SECONDS + 90))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if in_container stratus health >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  fail "the daemon did not answer stratus health within 90 seconds"
}

# The env file the documented setup copies from the example, with the offline
# demo provider so no key is needed.
cp "$DIR/stratusd.env.example" "$WORK/stratusd.env"
printf '\nSTRATUS_PROVIDER=demo\n' >> "$WORK/stratusd.env"
chmod 600 "$WORK/stratusd.env"

cat > "$WORK/override.yaml" <<EOF
services:
  stratusd:
    image: ${IMAGE}
    container_name: ${PROJECT}
    env_file: !override
      - ${WORK}/stratusd.env
    ports: !override
      - "127.0.0.1::4123"
EOF

echo "--- up (build, then wait for the healthcheck)"
UP=1
compose up -d --build --wait --wait-timeout 300 || fail "compose up did not reach a healthy container"
in_container stratus health >/dev/null || fail "stratus health failed in the container"

echo "--- the state volume belongs to the daemon's user"
owner=$(in_container stat -c '%u:%g' /home/node/.stratus)
[ "$owner" = "1000:1000" ] || fail "the state volume is owned by $owner, not 1000:1000"
in_container sh -c 'test -s /home/node/.stratus/gateway-token' || fail "the daemon wrote no gateway token into the volume"

echo "--- read-only root, writable /tmp"
if in_container sh -c 'touch /opt/stratus/.compose-smoke' 2>/dev/null; then
  fail "the root filesystem is writable"
fi
in_container sh -c 'touch /tmp/.compose-smoke && rm /tmp/.compose-smoke' || fail "/tmp is not writable"

echo "--- no capabilities, no new privileges"
# The bounding set, not the effective one: a non-root process has no
# effective capabilities either way, and cap_drop is what empties the bound.
# PID 1 is compose's init (init: true), which the daemon runs under.
caps=$(in_container sh -c "awk '/^CapBnd:/ {print \$2}' /proc/1/status")
[ "$caps" = "0000000000000000" ] || fail "the container's capability bounding set is $caps, not empty"
nnp=$(in_container sh -c "awk '/^NoNewPrivs:/ {print \$2}' /proc/1/status")
[ "$nnp" = "1" ] || fail "no-new-privileges is not set (NoNewPrivs: $nnp)"

echo "--- state survives a restart"
TOKEN=$(in_container cat /home/node/.stratus/gateway-token | tr -d '\r\n')
find_api
call PUT /intake '{"paused":true,"message":"Compose smoke test pause."}' | grep -q '"paused":true' || fail "pause was refused"
compose restart stratusd >/dev/null
wait_healthy
find_api
call GET /intake | grep -q '"paused":true' || fail "the pause did not survive a restart"
call PUT /intake '{"paused":false}' | grep -q '"paused":false' || fail "resume was refused"

echo "--- the shell tool's sandbox inside these limits"
# The probe tool-shell itself runs before it trusts bwrap. Reported, not
# required: whether unprivileged user namespaces are allowed is the host's
# call (docs/guides/deployment.md, "A shell sandbox that can start").
if probe=$(in_container bwrap --ro-bind / / --unshare-pid -- /bin/true 2>&1); then
  echo "shell sandbox: bwrap starts here"
else
  echo "shell sandbox: bwrap cannot start here: ${probe}"
fi

echo "compose-smoke: ok"
