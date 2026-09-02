# Always on

`stratus serve` runs the gateway in the foreground: every agent in your
roster live at once on its own provider and model, sessions in SQLite so
they survive restarts, delegation between agents, a watchdog for stalled
turns, and any installed channels connected. Ctrl+C or SIGTERM drains
cleanly.

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

## While it runs

- What it will and won't do with nobody watching: [Approvals](./approvals.md)
- What it writes down, and how to read it from another terminal:
  [Logs](./logs.md)
- `--idle-timeout <seconds>` — how long the watchdog lets a streaming
  provider stay silent before aborting the turn (default 120). An aborted
  turn's session comes back `failed` with a reason that says so — `Run
  aborted: no activity for 120000ms` — so it reads differently from a turn
  a person cancelled, whose reason is the bare `Run aborted`.
