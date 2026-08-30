# 27 — Live reload: install a skill without restarting the fleet

## Goal

Installing a skill takes effect without restarting the daemon. Installing a
plugin still restarts — deliberately — but the restart is announced, drains
what it can, and is a visible operation rather than a surprise.

## Why now

`start()` runs `loadPlugins` and the operator-skills load exactly once.
`reloadRoster()` re-runs the roster and nothing else. So:

| Installing | Restart needed |
| --- | --- |
| A new agent, or an edited soul | **No** — `reloadRoster()` exists and is exposed |
| A skill | **Yes** |
| A plugin — tools, MCP servers | **Yes** |
| Tools from an MCP server that reconnects | No — the registration view is kept live for exactly this |

Souls already hot-reload, which makes the gap sharper rather than smaller: the
capability exists and stops one layer short of where people hit it. And a
restart costs more here than in a single-agent product — it drops **every**
agent's channel connection at once and interrupts in-flight turns across the
whole fleet, for a change that concerned one agent.

Skills are the case people meet first and most often, and they are the easy
half: prose read from disk, no code imported, nothing holding a socket.

## Scope

**In:**

- **Skills reload without a restart**, through the same shape `reloadRoster()`
  established: a callable seam on the gateway, exposed over the control API,
  and re-run by `stratus skills install` so the ordinary path needs no second
  step.
- **Reload swaps rather than merges.** `SkillRegistry.register` throws on a
  duplicate id, so a naive second pass fails on every skill already loaded. A
  reload builds the new set and replaces, and it must preserve what the
  registry already gets right — the contested-alias rule, and operator skills
  outranking a plugin's bare alias.
- **A failed reload changes nothing.** A malformed `SKILL.md` in the directory
  leaves the previous set serving and reports what was wrong. Half a catalog is
  worse than a stale one.
- **An announced restart path for plugins**: a gateway operation that says a
  restart is coming, stops accepting new turns, lets in-flight turns finish
  within a bounded window, then exits for the service manager to restart. What
  the daemon already does well on the way back up — durable sessions, approval
  restart-recovery, the scheduler's catch-up sweep, channel reconnect — is what
  makes this survivable; the missing half is doing it deliberately rather than
  as a crash.
- **Docs saying plainly what needs a restart and what does not.** This is the
  question every operator asks on their second day.

**Out:**

- **Hot-reloading plugins.** Importing code at runtime means old and new
  modules coexisting, `dispose` ordering against in-flight tool calls, and
  half-loaded state when a `setup` throws — a class of failure that is hard to
  reason about and worse to debug than the restart it avoids. A plugin is code;
  code gets a restart.
- **Watching the filesystem.** A reload is something an operator or the API
  asks for. A watcher reloading on every editor save is a surprise, and it
  makes "what is running" depend on what a text editor did.
- **Zero-downtime restart.** Draining and reconnecting is not the same as
  never dropping, and a design that promised the second would need two
  processes sharing one session database and one set of channel tokens. Not
  worth it for an install.
- **Reloading credentials or the `api` and `approvals` config.** Those come
  from a trusted config and decide who may approve and what a daemon binds.
  Re-reading them live is a larger security question than this step.

## Design sketch

- Follow `reloadRoster()` rather than inventing a second shape: idempotent,
  serialized against itself, and a failure that leaves the previous state
  serving rather than blocking every reload after it.
- The drain already has a documented limit and this step must not overstate it:
  `stop()` drains a **one-time snapshot** of in-flight work, and a turn still
  finishing can start work the snapshot never saw. An announced restart makes
  that window smaller by refusing new turns first; it does not close it.
- A restart is the moment an operator most wants the log to be useful, and it
  is also the case the log cannot cover — a daemon that fails before it serves
  writes nothing to the JSONL. Whatever this step prints, it should print
  before the process is in a state where only stderr works.
- **Reload is not free of the two gates.** A newly loaded skill is loadable, not
  enabled: an agent still reaches it only if its soul lists it, and nothing
  becomes reachable to an agent that did not already allow it.

## Acceptance criteria

- A skill installed while the daemon is running is usable by an allowlisted
  agent on the next turn, with no restart and no dropped channel connection.
- A skill removed while running stops being loadable, and an agent whose soul
  still lists it fails the way it would for any missing skill.
- A malformed `SKILL.md` fails the reload, names the file, and leaves the
  previously loaded set serving.
- Reloading twice with no change is a no-op, and reloading concurrently with a
  turn that is reading a skill does not fail that turn.
- Operator-skill precedence and contested aliases survive a reload — asserted,
  because a rebuild is exactly where that state gets dropped.
- An announced restart refuses new turns, lets a running turn finish inside the
  window, and comes back with sessions, schedules, and channels intact.
- The docs name what needs a restart and what does not.

## Open questions

- **Does the plugin catalog need a reload for *disabling*?** Removing a plugin
  from the trusted config is a capability *reduction*, which is a different and
  safer operation than loading code — plausibly it can take effect on a roster
  reload without a restart. Worth deciding separately from the loading case.
- **How long is the drain window?** Too short and it is a crash with extra
  steps; too long and an operator waits on one stuck turn. Probably bounded
  with a forced exit, and probably configurable.
- **Should `stratus skills install` reload by default, or print the command?**
  Reloading by default is what people want and makes a local install change a
  running fleet, which is a surprise on a shared machine.
