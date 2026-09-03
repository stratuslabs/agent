# Always on

`stratus serve` runs the gateway in the foreground: every agent in your
roster live at once on its own provider and model, sessions in SQLite so
they survive restarts, delegation between agents, a watchdog for stalled
turns, and any installed channels connected. Ctrl+C or SIGTERM drains
cleanly, and a second one during the drain is ignored rather than cutting
it short (SIGKILL ends the process at once).

It stays a foreground process on purpose — debuggable, and composable with
whatever supervisor you already run. Surviving logout, crashes, and reboots
is the platform's job, so `stratus service` hands the daemon to launchd on
macOS and to systemd on Linux:

```bash
stratus service install          # write the unit, start now, start at every login
stratus service install --no-login
stratus service status
stratus service start
stratus service stop
stratus service uninstall
```

`stratus setup` installs it for you at Save & finish unless you opt out, so
most people never run these by hand. What they get:

- **macOS** — a LaunchAgent at
  `~/Library/LaunchAgents/com.stratusagent.stratusd.plist`
- **Linux** — a systemd user unit at
  `~/.config/systemd/user/stratusd.service`

The unit runs the daemon by **absolute path** — the node binary and script
of the process that installed it, never a bare `stratus`. A service manager
starts with a minimal environment and never loads the shell profile that
puts `stratus` on your `PATH`. It stops with SIGTERM, so the gateway's
drain actually runs. (Upgrading node moves those absolute paths — see
[Updating](./updating.md) for why `stratus update` rewrites the unit.)

## Crash restarts, and the `--no-login` asymmetry

A default install restarts the daemon if it crashes, but not after a clean
exit — stopping it yourself keeps it stopped. **`--no-login` gives up crash
restarts on macOS**, and that is launchd's rule rather than a choice:
`KeepAlive` implies `RunAtLoad`, so a job that must not start at login
cannot ask to be revived either. `stratus service install --no-login` says
so when it finishes. On Linux the two are independent, and
`Restart=on-failure` applies either way.

`status` asks the service manager, not the unit file, whether the daemon is
alive, and exits non-zero when it isn't — so it works in a health check:

```text
stratusd  running
  manager   launchd
  unit      ~/Library/LaunchAgents/com.stratusagent.stratusd.plist
  at login  yes
```

## What needs a restart, and what does not

The question every operator asks on their second day:

| Changing | Restart? | How it takes effect |
| --- | --- | --- |
| A soul's contents | No | Re-read before every turn |
| A soul file added or deleted | No | `POST /roster/reload` — `POST /agents` and `PUT /agents/:id` perform it themselves |
| A skill installed, edited, or removed | No | `stratus skill add` reloads the daemon it finds; `stratus skill reload` after a hand edit. See [Skills](./skills.md#installing-while-the-daemon-runs) |
| Tools from an MCP server that reconnects | No | Discovered on reconnect |
| A plugin enabled, disabled, upgraded, or reconfigured | **Yes** | `stratus restart` |
| Credentials, or the `api` and `approvals` blocks | **Yes** | `stratus restart` — they come from a trusted config and decide who may approve and what the daemon binds, so they are not re-read live |
| The `stratus` package itself | **Yes** | `stratus update`, which stops and starts the service around the upgrade |

### `stratus restart`: announced, drained, and back

A plugin is code, and code gets a restart — but an announced one rather
than a surprise, and one that costs the fleet as little as it can.
`stratus restart` (or `POST /restart`) asks the running daemon to:

1. **Refuse new turns**, at once. A message arriving during the drain is
   answered with "stratusd is restarting and will accept new work once it
   is back up" rather than dropped.
2. **Let in-flight turns finish**, for up to the drain window —
   `--drain-timeout <seconds>`, default 30. A turn still running when the
   window closes is aborted the way the watchdog aborts one: its session is
   saved as failed with `Run aborted: stratusd is restarting`, so the next
   daemon finds a finished turn, not an abandoned one. A call parked on a
   human is denied as cancelled, exactly as a stop denies it.
3. **Stop, then start again.** The process that received the restart drains,
   closes its store, lets go of the [home claim](#one-daemon-per-home), and
   then starts a fresh daemon as a child and waits for it. It stays, rather
   than exiting: under systemd and launchd the process
   the manager started *is* the service, and its exit would end the job —
   so staying is what lets the same path hold under the service manager,
   in the foreground, and under `--no-login`, where a clean exit is never
   brought back. `stratus service stop`, Ctrl+C, and SIGTERM still reach
   the daemon through it. The cost is one idle Node process for the rest of
   the run. A daemon that asked for any free port (`--api-port 0`) comes
   back on the port it had, so a dashboard page reconnects to it.

What comes back is what a stop-and-start brings back: durable sessions,
schedules with their catch-up sweep, and channels reconnected — plus the
dashboard's signed-in pages, handed from the old process to the new one in
memory (see [Remote access](./remote-access.md#the-dashboard)). The
announcement is written to `stratus logs` before the drain begins — the last
point that process is certain to reach the structured log; a fresh daemon
that fails before it serves reports to stderr only, as [Logs](./logs.md)
explains.

Refusing new turns first makes the drain's known gap smaller, not closed: a
turn finishing after the drain's snapshot can still start work the snapshot
never saw.

## Login, not power-on

**One limit worth knowing before you rely on it.** A LaunchAgent starts at
**login, not at power-on**, and only while that user is logged in — an
unattended Mac needs automatic login turned on too. (A `LaunchDaemon` would
start without a login, but it runs as a system user, which breaks
`~/.stratus` paths and the Claude subscription token entirely, so the
LaunchAgent is the right choice.) The systemd equivalent is
`loginctl enable-linger` on a machine you don't stay logged in to. Setup
says both in the menu rather than leaving them to be discovered after a
reboot.

## One daemon per home

`stratus serve` refuses to start while another daemon holds the same
`~/.stratus`:

```
Error: stratusd is already running for this home (pid 4242, http://127.0.0.1:4123). ...
```

Two daemons on one home would share the session store and the schedule
table with nothing coordinating them — each slot fires in whichever process
claims it first, each start sweep re-asks the approvals the other is
holding, and the newer one fails as abandoned the turns the older one is
still running. The claim is `~/.stratus/stratusd.lock`, an SQLite file on
which the daemon holds an exclusive transaction open — never writing it —
from before it opens the store until after the store closes. That makes it
atomic between two daemons starting together, keeps a daemon that is still
draining its last turns holding the home against its replacement (the
refusal then says so, since there is no address to name yet), and means a
daemon that died released it with its file descriptors — there is no stale
lock to clean up, and nothing a crash could leave half-written. The empty
file stays between runs; the claim is the open descriptor, not the file's
existence, and a file that is not a database any more is emptied in place
rather than obeyed — never removed and recreated, so two daemons starting
over the same damaged file still contend for the one inode and exactly one
wins. `gateway.json`
is read to name the holder — and, for a daemon from a release before the
lock existed that is still serving across an upgrade, it is the evidence:
a live pid whose address answers with this home's token refuses the start
the same way.

The control API is a required channel: a daemon that cannot bind its port
stops instead of serving without one, with an error naming the port and
the flags that change it. Either refusal under a service manager — the
installed service starting while a hand-run `stratus serve` holds the
home, or its port — is a restart loop until the other process stops,
which is the case the redirect-log truncation in [Logs](./logs.md)
bounds.

## While it runs

- What it will and won't do with nobody watching: [Approvals](./approvals.md)
- What it writes down, and how to read it from another terminal:
  [Logs](./logs.md)
- `--idle-timeout <seconds>` — how long the watchdog lets a streaming
  provider stay silent before aborting the turn (default 120). An aborted
  turn's session comes back `failed` with a reason that says so — `Run
  aborted: no activity for 120000ms` — so it reads differently from a turn
  a person cancelled, whose reason is the bare `Run aborted`.
