#!/usr/bin/env bash
# Install this checkout under deploy/systemd/stratusd.service, the way
# docs/guides/deployment.md ("First run: a system unit") does, and check what
# the unit promises: it starts and answers `stratus health` as the `stratus`
# account, the state directory is that account's and private, no capability
# or new privilege, the filesystem read-only outside the state directory,
# /home hidden and /tmp private, JSON logs in the journal, state kept across
# a restart, a clean stop inside TimeoutStopSec, and a shell command running
# in the shell tool's sandbox (bubblewrap) under the unit's settings.
#
#   deploy/systemd/smoke.sh    # from the repository root, after `pnpm build`
#
# For a throwaway Linux machine with systemd (a CI runner): it uses sudo to
# create the `stratus` system account, /etc/stratus, /var/lib/stratus,
# /opt/stratus and the unit, refuses to start if any of them exists already,
# and removes what it created on the way out. Needs node (>=22.13), pnpm,
# npm, curl and bubblewrap.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
UNIT=stratusd.service
PROBE=stratus-smoke-probe.service
PREFIX=/opt/stratus
STATE=/var/lib/stratus
ETC=/etc/stratus
WORK=$(mktemp -d)
CREATED=0
NODE=
CLI=
API=http://127.0.0.1:4123/api/v1
TOKEN=

fail() { echo "systemd-smoke: $*" >&2; exit 1; }

cleanup() {
  if [ "${1:-0}" != 0 ] && [ "$CREATED" = 1 ]; then
    echo "--- journal" >&2
    sudo journalctl -u "$UNIT" -u "$PROBE" --no-pager -o cat -n 80 >&2 || true
  fi
  if [ "$CREATED" = 1 ]; then
    sudo systemctl disable --now "$UNIT" >/dev/null 2>&1 || true
    sudo systemctl stop "$PROBE" >/dev/null 2>&1 || true
    sudo rm -rf "/etc/systemd/system/$UNIT" "/etc/systemd/system/$UNIT.d" "/etc/systemd/system/$PROBE"
    sudo systemctl daemon-reload || true
    sudo systemctl reset-failed "$UNIT" "$PROBE" >/dev/null 2>&1 || true
    sudo userdel stratus >/dev/null 2>&1 || true
    sudo groupdel stratus >/dev/null 2>&1 || true
    sudo rm -rf "$STATE" "$ETC" "$PREFIX"
  fi
  rm -rf "$WORK"
}
trap 'cleanup $?' EXIT

as_stratus() { sudo -u stratus -H "$NODE" "$CLI" "$@"; }
main_pid() { systemctl show -p MainPID --value "$UNIT"; }
in_unit_ns() { sudo nsenter -t "$(main_pid)" -m -- "$@"; }

call() { # method path [json]
  if [ $# -ge 3 ]; then
    curl -fsS --max-time 30 -X "$1" -H "authorization: Bearer ${TOKEN}" -H 'content-type: application/json' -d "$3" "${API}$2"
  else
    curl -fsS --max-time 30 -X "$1" -H "authorization: Bearer ${TOKEN}" "${API}$2"
  fi
}

wait_healthy() {
  local deadline=$((SECONDS + 90))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if as_stratus health >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  as_stratus health >&2 || true
  fail "the daemon did not answer stratus health within 90 seconds"
}

[ "$(ps -p 1 -o comm=)" = systemd ] || fail "PID 1 is not systemd"
# Everything the cleanup removes must be something this run created.
for path in "$STATE" "$ETC" "$PREFIX" "/etc/systemd/system/$UNIT" "/etc/systemd/system/$UNIT.d" "/etc/systemd/system/$PROBE"; do
  [ ! -e "$path" ] || fail "$path exists already; this test only runs on a machine without a Stratus system install"
done
! id stratus >/dev/null 2>&1 || fail "a stratus account exists already; this test only runs on a machine without a Stratus system install"
! getent group stratus >/dev/null 2>&1 || fail "a stratus group exists already; this test only runs on a machine without a Stratus system install"
NODE=$(readlink -f "$(command -v node)")
CLI="$PREFIX/node_modules/@stratusagent/cli/dist/bin.js"

echo "--- pack this checkout and install it under $PREFIX"
# The tarballs npm would publish, installed flat with overrides so no
# published @stratusagent package is mixed in (see deploy/docker/pack.mjs).
node "$ROOT/deploy/docker/pack.mjs" "$ROOT" "$WORK/packs" >/dev/null
CREATED=1
sudo install -d -m 0755 "$PREFIX"
sudo cp -r "$WORK/packs" "$PREFIX/packs"
sudo mv "$PREFIX/packs/package.json" "$PREFIX/package.json"
(cd "$PREFIX" && sudo npm install --omit=dev --no-audit --no-fund --loglevel=error >/dev/null)
[ -f "$CLI" ] || fail "the install has no $CLI"

echo "--- the account, the env file and the unit, as the guide says"
sudo useradd --system --home-dir "$STATE" --shell /usr/sbin/nologin stratus
sudo install -d -m 0700 "$ETC"
sudo install -m 0600 /dev/null "$ETC/stratusd.env"
# The offline demo provider, so no key is needed.
echo 'STRATUS_PROVIDER=demo' | sudo tee "$ETC/stratusd.env" >/dev/null
sudo cp "$ROOT/deploy/systemd/$UNIT" "/etc/systemd/system/$UNIT"
# The guide's `systemctl edit --full stratusd # check the ExecStart paths`:
# node and the CLI live elsewhere here than the unit's Debian defaults.
sudo install -d "/etc/systemd/system/$UNIT.d"
printf '[Service]\nExecStart=\nExecStart=%s %s serve --log-format json\n' "$NODE" "$CLI" \
  | sudo tee "/etc/systemd/system/$UNIT.d/paths.conf" >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now "$UNIT" >/dev/null 2>&1 || fail "systemctl enable --now $UNIT failed"
wait_healthy

echo "--- it runs as stratus, and the state directory is stratus's own"
pid=$(main_pid)
[ "$pid" != 0 ] || fail "the unit has no main process"
[ "$(ps -o user= -p "$pid")" = stratus ] || fail "the daemon runs as $(ps -o user= -p "$pid"), not stratus"
[ "$(sudo stat -c '%U %a' "$STATE")" = "stratus 700" ] || fail "$STATE is $(sudo stat -c '%U %a' "$STATE"), not stratus 700"
sudo test -s "$STATE/.stratus/gateway-token" || fail "the daemon wrote no gateway token under $STATE/.stratus"

echo "--- no capabilities, no new privileges, a syscall filter"
status=$(sudo cat "/proc/$pid/status")
[ "$(awk '/^CapBnd:/ {print $2}' <<<"$status")" = 0000000000000000 ] || fail "the capability bounding set is not empty"
[ "$(awk '/^NoNewPrivs:/ {print $2}' <<<"$status")" = 1 ] || fail "no-new-privileges is not set"
[ "$(awk '/^Seccomp:/ {print $2}' <<<"$status")" = 2 ] || fail "no seccomp filter (SystemCallFilter=) is applied"

echo "--- read-only outside the state directory, /home hidden, /tmp private"
# Inside the unit's own mount namespace, as root: only the mounts the unit
# set up can refuse these writes.
if in_unit_ns touch /usr/.systemd-smoke 2>/dev/null; then
  sudo rm -f /usr/.systemd-smoke
  fail "/usr is writable under the unit (ProtectSystem=strict)"
fi
in_unit_ns sh -c "touch $STATE/.systemd-smoke && rm $STATE/.systemd-smoke" || fail "$STATE is not writable under the unit"
[ -d "$HOME" ] || fail "this test needs a home under /home to look for"
if in_unit_ns test -e "$HOME" 2>/dev/null; then
  fail "$HOME is visible under the unit (ProtectHome=yes)"
fi
marker="/tmp/systemd-smoke-$$"
touch "$marker"
if in_unit_ns test -e "$marker" 2>/dev/null; then
  rm -f "$marker"
  fail "the host's /tmp is visible under the unit (PrivateTmp=yes)"
fi
rm -f "$marker"

echo "--- JSON logs in the journal"
line=$(sudo journalctl -u "$UNIT" -o cat --no-pager | grep -m 1 '^{' || true)
[ -n "$line" ] || fail "no JSON log line in the journal"
node -e 'JSON.parse(process.argv[1])' "$line" || fail "the journal's log line is not JSON: $line"

echo "--- state survives a restart"
TOKEN=$(sudo cat "$STATE/.stratus/gateway-token" | tr -d '\r\n')
call PUT /intake '{"paused":true,"message":"systemd smoke test pause."}' | grep -q '"paused":true' || fail "pause was refused"
sudo systemctl restart "$UNIT"
[ "$(main_pid)" != "$pid" ] || fail "the daemon was not restarted"
wait_healthy
call GET /intake | grep -q '"paused":true' || fail "the pause did not survive a restart"
call PUT /intake '{"paused":false}' | grep -q '"paused":false' || fail "resume was refused"

echo "--- a signed event reaches the listener and leaves its row"
# A source in the trusted config and its secret in the store, as
# docs/guides/events.md says, then a restart: the listener opens at start on
# 127.0.0.1:4124, under the unit as it ships.
EVENT_SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
sudo test ! -e "$STATE/.stratus/config.json" || fail "$STATE/.stratus/config.json exists already; this test writes its own"
printf '{"events":{"sources":{"github":{"verify":"github","secrets":["events.github"]}}}}\n' \
  | sudo -u stratus tee "$STATE/.stratus/config.json" >/dev/null
printf %s "$EVENT_SECRET" | as_stratus credential set events.github >/dev/null || fail "could not store events.github"
sudo systemctl restart "$UNIT"
wait_healthy
delivery="systemd-smoke-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
body='{"zen":"Keep it logically awesome.","hook_id":1}'
signature=$(printf %s "$body" | openssl dgst -sha256 -hmac "$EVENT_SECRET" | awk '{print $NF}')
answer=$(curl -sS --max-time 30 -X POST http://127.0.0.1:4124/events/github \
  -H 'content-type: application/json' -H 'x-github-event: ping' -H "x-github-delivery: ${delivery}" \
  -H "x-hub-signature-256: sha256=${signature}" -d "$body") || fail "the signed delivery got no answer"
[ "$answer" = '{"status":"unmatched"}' ] || fail "the signed delivery was answered $answer, not unmatched"
call GET "/events/deliveries?source=github" | grep -q "\"eventId\":\"${delivery}\"" || fail "the delivery left no row"
# Captured first: grep -q closing the pipe early would fail the CLI's write under pipefail.
events_out=$(as_stratus events) || fail "stratus events failed"
grep -q '^github$' <<<"$events_out" || fail "stratus events does not list the github source: $events_out"

echo "--- a clean stop inside TimeoutStopSec"
started=$SECONDS
sudo systemctl stop "$UNIT"
took=$((SECONDS - started))
result=$(systemctl show -p Result --value "$UNIT")
[ "$result" = success ] || fail "the stop ended as $result, not success (exit status $(systemctl show -p ExecMainStatus --value "$UNIT"))"
echo "stopped cleanly in ${took}s"

echo "--- the shell tool's sandbox under the unit's settings"
# A command run the way shell.run runs it: tool-shell's createCommand plans
# the bubblewrap invocation (probing bwrap first, and refusing when it can't
# start), and the plan is spawned. It runs as a oneshot copy of the unit,
# same account and every hardening line, with only ExecStart and the
# restart policy changed.
sudo tee "$PREFIX/shell-probe.mjs" >/dev/null <<'PROBE_EOF'
import { spawnSync } from 'node:child_process';
import { createShellTool } from '@stratusagent/tool-shell';

const tool = createShellTool({ workspaceRoot: '/var/lib/stratus/shell-probe' });
const session = { id: 'systemd-smoke', agent: { id: 'smoke' }, metadata: {}, messages: [] };
let run;
try {
  run = await tool.createCommand({ command: 'echo "sandboxed pid $$"' }, session, {});
} catch (error) {
  console.log(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const result = spawnSync(run.command, run.args, { cwd: run.cwd, env: run.env, encoding: 'utf8' });
console.log(`shell.run: exit ${result.status} via ${run.command}: ${(result.stdout + result.stderr).trim()}`);
process.exit(result.status === 0 && /^sandboxed pid [12]$/m.test(result.stdout) ? 0 : 1);
PROBE_EOF
sudo sed -e 's/^Type=simple$/Type=oneshot/' -e '/^ExecStart=/d' -e '/^Restart/d' -e '/^\[Install\]/,$d' \
  "/etc/systemd/system/$UNIT" | sudo tee "/etc/systemd/system/$PROBE" >/dev/null
echo "ExecStart=$NODE $PREFIX/shell-probe.mjs" | sudo tee -a "/etc/systemd/system/$PROBE" >/dev/null
sudo systemctl daemon-reload
probed=0
sudo systemctl start "$PROBE" 2>/dev/null || probed=$?
sudo journalctl -u "$PROBE" -o cat --no-pager | grep -m 1 '^shell\.run' || true
[ "$probed" = 0 ] || fail "no shell command can run sandboxed under the unit"
sudo systemd-analyze security "$UNIT" --no-pager 2>/dev/null | tail -n 1 || true

echo "systemd-smoke: ok"
