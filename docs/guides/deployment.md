# Deployment: a server of your own

The single-tenant profile: one team's agents on a VM that nobody logs in
to, with every tool available and anything risky asked of a person in
Slack. Everything here is the same `stratus serve` a workstation runs —
this page is where it lives, how secrets reach it, where its output goes,
and how to back it up, upgrade it, and lock it down.

On your own machine, [Always on](./always-on.md) is the simpler path:
`stratus service install` and you are done.

## Docker or a system unit

| | Docker ([`deploy/docker`](../../deploy/docker)) | System unit ([`deploy/systemd`](../../deploy/systemd/stratusd.service)) |
| --- | --- | --- |
| What runs | An image built from a checkout, every first-party package installed | `npm install -g` on the host, and the packages you choose |
| Runs as | `node` (uid 1000) in the container | A dedicated `stratus` system account |
| The home | Named volume at `/home/node/.stratus` | `/var/lib/stratus/.stratus` |
| Secrets from | `deploy/docker/stratusd.env` (`env_file`) | `/etc/stratus/stratusd.env` (`EnvironmentFile`) |
| Output | `docker logs` — JSON lines | The journal — JSON lines |
| Upgrade | Build the new tag, recreate the container | `npm install -g` the new version, restart |

Both start from boot and restart on a crash, both run the daemon with
`--log-format json`, and both are hardened along the
[checklist](#hardening-checklist) below. Pick Docker unless you have a
reason not to: the image is the unit of upgrade and rollback, and a
read-only root filesystem is one line.

## What lives in the home

Everything the daemon keeps is one directory — config, credentials, souls,
skills, each agent's sessions, memory, grants and workspace, the schedules,
and the logs. [State layout](../reference/state-layout.md) is the map. So
the volume (or `/var/lib/stratus`) is the deployment's entire state, and
the image or the npm install is replaceable.

**Use a named volume, not a bind mount into a shared or synced folder.**
The session stores are SQLite in WAL mode, which needs working file locks
and shared memory on the same host. Docker Desktop's file sharing
(virtiofs, gRPC FUSE) and network filesystems (NFS, SMB) do not reliably
provide either, and the failure is a corrupt database rather than an
error. A named volume, or a bind mount of a directory on the VM's own
disk, is fine.

## First run: Docker

From a checkout of the release you want to run:

```bash
git clone https://github.com/stratuslabs/agent && cd agent
git checkout v0.11.7                        # the release tag you want
cd deploy/docker
cp stratusd.env.example stratusd.env && chmod 600 stratusd.env
$EDITOR stratusd.env                        # a provider, and its key — see below
docker compose up -d --build --wait            # returns once the health check passes
docker compose exec stratusd stratus health
```

```text
stratusd ok at http://0.0.0.0:4123 — version 0.11.6, up 8s, 1 agent, 0 sessions, 0 approvals pending
```

The address is the container's own: `0.0.0.0` inside it, published as
`127.0.0.1:4123` on the host. An empty `stratusd.env` starts the offline
demo provider, which is a fine way to prove the plumbing first.

For [`tool-browser`](./browser.md), set `target: browser` in
[`compose.yaml`](../../deploy/docker/compose.yaml) (and a different
`image:` tag) and build again: the `browser` target adds Playwright's
Chromium and its system libraries to the slim image. Without it the daemon
runs normally and a `browser.*` call fails with a message naming the fix.

Then give it the [VM profile](../../examples/profiles/vm) — every tool
plugin, remote approvals, named operators — as a template. The image's
root filesystem is read-only, so pipe the folder into `/tmp`:

```bash
tar -C ../../examples/profiles -cf - vm | docker exec -i stratusd tar -C /tmp -xf -
docker exec -it stratusd stratus template add /tmp/vm     # review, then y
docker exec stratusd stratus restart
```

Anything else you would run at a terminal, run through `docker exec`:
`stratus agents`, `stratus plugins`, `stratus logs -f`, `stratus grants ops`.
`stratus dashboard --no-open` prints a one-time sign-in link; open it on the
host with `127.0.0.1` in place of the `0.0.0.0` it names.

To call the control API from the host:

```bash
TOKEN=$(docker compose exec -T stratusd cat /home/node/.stratus/gateway-token)
curl -H "authorization: Bearer $TOKEN" http://127.0.0.1:4123/api/v1/agents
```

Or choose the token yourself, so whatever manages the container knows it
without reading it back: see the control API's token under
[Credentials](#credentials).

## First run: a system unit

Node `>=22.13 <23 || >=23.4` on the host, then:

```bash
sudo useradd --system --home-dir /var/lib/stratus --shell /usr/sbin/nologin stratus
sudo npm install -g @stratusagent/cli @stratusagent/control-api @stratusagent/channel-slack \
  @stratusagent/tool-fs @stratusagent/tool-shell @stratusagent/tool-web @stratusagent/tool-browser
sudo install -d -m 0700 /etc/stratus
sudo install -m 0600 /dev/null /etc/stratus/stratusd.env    # then add provider keys
sudo cp deploy/systemd/stratusd.service /etc/systemd/system/
sudo systemctl edit --full stratusd                          # check the ExecStart paths
sudo systemctl daemon-reload && sudo systemctl enable --now stratusd
sudo -u stratus -H stratus health
```

`ExecStart` names node and the CLI's entry script by absolute path — never
a bare `stratus`, which is a `#!/usr/bin/env node` script and would run
whichever node the service's `PATH` finds. The unit's comments say how to
find both. The same applies after upgrading node.

Run every other command as the account, so it reads the same home:
`sudo -u stratus -H stratus template add ./examples/profiles/vm`,
`sudo -u stratus -H stratus logs -f`. `stratus setup` works the same way;
decline the always-on service it offers at the end, because this unit is
the service.

## Credentials

What a container or a unit can take from its environment, and what it
cannot:

| Secret | From the environment? | How |
| --- | --- | --- |
| A provider API key | **Yes** | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `CODEX_API_KEY`. A key alone does not select a provider — with nothing naming one, agents run on the demo — so set `STRATUS_PROVIDER` too, or `provider` in the config, or `provider:` in a soul. `STRATUS_API_KEY` outranks every provider's own variable at once, so it belongs only on a single-provider fleet. See [Configuration](../reference/config.md). |
| A named credential (`search.apiKey`) | **Yes**, in the image | By its exact name, read after any stored entry of that name — and only by an agent whose soul lists it under `credentials:`. The image starts the daemon with no shell in between because a POSIX shell drops a variable named `search.apiKey` on its way to exec; a system unit's `EnvironmentFile=` may refuse such a name too. Storing it works everywhere: `printf %s "$KEY" \| docker exec -i stratusd stratus credential set search.apiKey`. |
| The control API's token | **Yes**, as a file | Set `STRATUS_GATEWAY_TOKEN_FILE` to a file holding the token (a mounted secret), and the daemon uses it instead of generating one, copying it into `~/.stratus/gateway-token` so `stratus health` and the other local commands keep working. One line, at least 32 printable characters, no spaces. Replace the file and restart to rotate it; a file that is missing or malformed stops the daemon from starting rather than falling back to a token nothing else knows. Unset, the daemon generates its own the first time, as before. |
| Slack tokens | **No** | Read only from `credentials.json` in the home, because they are the daemon's own and an agent must never resolve them. Store them with `docker exec -it stratusd stratus setup` → **Channels**, or through the API (below), then `stratus restart`. |
| A Claude subscription or a codex sign-in | **No** | Stored by `stratus setup`. The `claude-code` and `codex` runtimes also run their vendor's CLI, which keeps its own state under the home directory — outside the volume, and read-only in the image — so they need that directory made writable (a second volume at `/home/node/.claude` or `/home/node/.codex`) and are not covered by the backup below. An API key is the path this recipe is built around. |

Slack through the API, for a script rather than a menu (the app setup
itself is in the [channel's README](../../packages/channel-slack/README.md#setting-up-an-agents-slack-app-2-minutes)):

```bash
curl -fsS -X PUT http://127.0.0.1:4123/api/v1/credentials/channels/slack \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d @slack-ops.json        # {"agentId":"ops","appToken":"xapp-…","botToken":"xoxb-…"}, 0600
docker exec stratusd stratus restart
```

Keep `stratusd.env` and `/etc/stratus/stratusd.env` owner-readable only.
A key in the daemon's environment does not reach the commands its agents
run — see [env scrubbing](#hardening-checklist).

## Logs

The daemon runs with [`--log-format json`](./logs.md#logs-on-stdout-for-a-container-or-journald):
every record it writes to `~/.stratus/logs/stratusd.jsonl` also goes to
stdout as one JSON line, and nothing else does. So:

```bash
docker compose logs -f stratusd                  # Docker
journalctl -u stratusd -o cat -f | jq .          # the system unit
docker exec stratusd stratus logs -f --agent ops # the file, filtered, from inside
```

Ship stdout the way you ship anything else — a Docker logging driver
(`journald`, `fluentd`, `awslogs`, `gcplogs`), or an agent such as Vector or
Fluent Bit reading the Docker socket or the journal and parsing each line as
JSON. The compose file bounds the default `json-file` driver at 5 × 10 MB.

Two things to carry into whatever collects it:

- **Keep stderr.** It is not JSON, and it holds what never became a record:
  a daemon that failed **before it started serving** writes nothing to the
  structured log at all, so its reason is on stderr and nowhere else
  (`docker logs` shows both streams; so does the journal). A third-party
  library's own warnings land there too.
- **It is a trace, not a transcript** — tool names, session ids, statuses;
  never prompts, replies, or tool inputs. The one exception is a failed
  session, whose provider error text is recorded verbatim and can quote the
  request. See [Logs](./logs.md#a-trace-not-a-transcript) before sending it
  somewhere shared.

## Health checks

`stratus health` asks the running daemon's `GET /api/v1/health`, using
`~/.stratus/gateway.json` to find it and `~/.stratus/gateway-token` to
authenticate, exactly as `stratus restart` does. It exits 0 with one line
when the daemon answers `ok`, and 1 with one sentence otherwise — no
daemon, a daemon that does not answer within 5 seconds, a rejected token.
`--format json` prints the daemon's whole answer (or `{"ok":false,"error"}`)
instead. It changes nothing on disk — it skips the state migrations every
command that touches the home runs first, since whatever probes it runs it
forever, and the home's format is the daemon's business.

The image's `HEALTHCHECK` and the compose `healthcheck` both run it. For
Kubernetes:

```yaml
livenessProbe:
  exec: { command: ["stratus", "health"] }
  periodSeconds: 30
  timeoutSeconds: 10
  failureThreshold: 3
```

A check that lands inside an announced restart (`stratus restart`) fails:
the old daemon removes `gateway.json` when it stops serving and the new one
writes it when its API binds, and the check says "not serving" in between.
That is what `retries` / `failureThreshold` are for.

## Back up and restore

The home is the backup. Copy it with the daemon **stopped**, so every
SQLite database has been checkpointed and there is no `-wal` file to lose
the newest turns in:

```bash
cd deploy/docker
docker compose stop stratusd                     # drains, then stops
(umask 077; docker run --rm -v stratus_stratus-home:/data:ro node:22-bookworm-slim \
  tar -czf - -C /data . > stratus-home-$(date +%F).tgz)
docker compose start --wait stratusd
```

`stratus_stratus-home` is compose's name for the volume (`<project>_<volume>`;
`docker volume ls` shows it). The archive holds `credentials.json` and the
API token, so it is as secret as they are — hence the `umask`. Store it
encrypted, somewhere else. The env file is not in it; keep that with your
other secrets. On a system unit the same thing is:

```bash
sudo systemctl stop stratusd
(umask 077; sudo tar -C /var/lib/stratus -czf - .stratus > stratus-home-$(date +%F).tgz)
sudo systemctl start stratusd
```

### The restore drill

A backup nobody has restored is a hope. Once, and after anything that
changes how you take them, restore into a **fresh** volume and start a
daemon on it — with the original still stopped, since both hold the same
Slack tokens and schedules, and two daemons would split the one's events
and fire the other's slots:

```bash
docker compose stop stratusd
docker volume create stratus-home-restored
docker run --rm -i -v stratus-home-restored:/data node:22-bookworm-slim \
  tar -xzf - -C /data < stratus-home-2026-09-29.tgz
docker run -d --name stratusd-restore-drill --init --read-only --tmpfs /tmp \
  --cap-drop ALL --security-opt no-new-privileges:true \
  -v stratus-home-restored:/home/node/.stratus stratusd:slim
docker exec stratusd-restore-drill stratus health
docker exec stratusd-restore-drill stratus agents
docker exec stratusd-restore-drill stratus logs -n 20
```

```text
stratusd ok at http://0.0.0.0:4123 — version 0.11.6, up 2s, 2 agents, 2 sessions, 0 approvals pending
```

The agent and session counts should be the ones you stopped with, and
`stratus agents` should list every soul. Then put things back:

```bash
docker stop -t 45 stratusd-restore-drill && docker rm stratusd-restore-drill
docker volume rm stratus-home-restored
docker compose start --wait stratusd
```

Ownership survives the round trip — the archive records uid 1000, and
`tar` running as root in the throwaway container restores it — so the
restored home is the `node` user's without a `chown`.

### Restoring for real

Into the volume compose uses, so nothing else changes:

```bash
docker compose down                              # the container, not the volume
docker volume rm stratus_stratus-home
docker compose create                            # a fresh, empty volume
docker run --rm -i -v stratus_stratus-home:/data node:22-bookworm-slim \
  tar -xzf - -C /data < stratus-home-2026-09-29.tgz
docker compose start --wait
docker compose exec stratusd stratus health
```

Scheduled, off-machine backups with secret scanning and encrypted
conversations are planned, not yet
shipped. Until then this is the procedure; run it from cron on the host
if you want it nightly — the stop costs up to the 30-second drain.

## Upgrade

[Updating](./updating.md) explains what an upgrade does to the home. On a
server:

1. **Back up first** (above). It is the only way back: the home is stamped
   with the schema it was migrated to, and an older build refuses to serve
   it — `stratus serve` exits with a line naming the fix, and the container
   restarts into the same refusal until you restore.
2. **Docker:** build the new release and recreate the container. The volume
   is untouched; the new daemon runs any pending migrations at start, while
   it holds the home, before it opens a store.

   ```bash
   docker tag stratusd:slim stratusd:v0.11.7    # the image you are leaving, for a rollback
   git fetch --tags && git checkout v0.11.8
   cd deploy/docker && docker compose up -d --build --wait
   docker compose exec stratusd stratus health
   docker compose logs stratusd | grep 'state migration'
   ```

   Rolling back is both halves together: the old image (set `image:` to
   the tag you kept) *and* the backup you took before, restored as above.
   If the new build migrated the home, the old image alone is refused by it.

   Do not run `stratus update` inside the container. It upgrades by
   `npm install -g`, which the read-only image cannot take and should not:
   the image is the thing you version and roll back.
3. **System unit:** stop, upgrade every first-party package together — they
   ship in lockstep, and `stratus doctor` flags a companion older than the
   CLI — then check the unit's paths and start:

   ```bash
   sudo systemctl stop stratusd
   sudo npm install -g @stratusagent/cli@0.11.7 @stratusagent/control-api@0.11.7 …   # every one you have
   sudo systemctl start stratusd && sudo -u stratus -H stratus health
   ```

   `stratus update` rewrites the *user* unit it installs, not this one, so
   it is not the tool here. A node upgrade moves the interpreter; check
   `ExecStart` afterwards.

## Hardening checklist

What the recipe sets, and what it leaves to you.

- [ ] **Not root.** The image runs as `node` (uid 1000); the unit as the
  `stratus` system account. Neither holds a capability: `cap_drop: [ALL]`,
  and an empty `CapabilityBoundingSet=`.
- [ ] **No new privileges.** `no-new-privileges:true` / `NoNewPrivileges=yes`:
  nothing an agent's command runs can gain them through a setuid binary.
- [ ] **Read-only everywhere but the home.** `read_only: true` with a tmpfs
  `/tmp`; `ProtectSystem=strict` with `ReadWritePaths=` for the state
  directory and `ProtectHome=yes`. A shell command an agent runs can write
  its workspace and `/tmp`, and nothing else. A `tool-fs` root outside the
  home needs its own `ReadWritePaths=` or mount.
- [ ] **The API on loopback only.** Compose publishes `127.0.0.1:4123`;
  the unit uses the config's `api.host`, which the VM profile sets to
  `127.0.0.1`. Reach it from elsewhere through a tunnel — Tailscale, or
  `ssh -L 4123:127.0.0.1:4123` — never by publishing it on a public
  interface. See [Remote access](./remote-access.md).
- [ ] **Remote approvals, a named approver, named operators.** The
  [VM profile](../../examples/profiles/vm) sets `approvals.mode: remote`,
  `slackApprovers`, and `principals.admit: principals`. Replace its
  placeholder ids before you rely on it.
- [ ] **Env scrubbing.** The daemon's environment holds the provider keys;
  the commands agents run do not get it. `tool-shell` *replaces* a
  command's environment with `passEnv` (default `PATH`, `HOME`, `LANG`,
  `LC_ALL`, `TZ`) plus the `env` you set, and stdio MCP servers get the same
  treatment — tested in
  [`tool-shell`'s suite](../../packages/tool-shell/test/shell.test.ts)
  ("the child cannot read the daemon's credentials through its
  environment"), which runs `env` and `echo "$ANTHROPIC_API_KEY"` against a
  daemon environment holding a key. Never add a secret's name to
  `passEnv`; put a value a command genuinely needs in `env`, where a reader
  of the config can see it. See [Shell commands](./shell.md).
- [ ] **Egress.** In process, `web.fetch` and the browser refuse loopback,
  private, link-local, and metadata addresses (`169.254.169.254`), checked
  on the connection itself — see
  [`@stratusagent/egress`](../../packages/egress/README.md); `allowedHosts`
  opens one host on purpose. That covers two tools, not a shell command or an
  MCP server, so also restrict egress at the network layer — a security
  group or firewall allowing the provider APIs, Slack, and what your agents
  are meant to reach.
- [ ] **An outbound proxy, if you have one.** The provider SDKs call Node's
  `fetch`, which ignores `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1` is set
  too — honoured from Node 22.21.0 on the 22.x line, so check `node
  --version` on a host install; the image's Node is newer. `web.fetch` and
  the browser never go through it: they connect directly to the address
  they checked, which is what the check is worth. Put both variables in the
  env file.
- [ ] **Reaped children.** `init: true` (or `docker run --init`) so the
  processes a shell command leaves behind do not accumulate as zombies.
- [ ] **Bounded.** `mem_limit`, `cpus`, and `pids_limit` in the compose
  file — size them to your roster, and give the `browser` target more
  memory than the slim one.
- [ ] **Stopped gracefully.** `stop_grace_period: 45s` / `TimeoutStopSec=45`,
  longer than the 30-second drain, so a stop finishes in-flight turns
  rather than failing them.
- [ ] **Rebuilt.** The image carries Node and Debian; rebuild it for their
  security releases, not only for Stratus ones.
