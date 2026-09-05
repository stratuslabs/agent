# Updating

`~/.stratus` is a real on-disk format — config, credentials, souls, memory,
the session database — so upgrading is more than `npm install -g`. Two
pieces handle it.

## State is versioned, and migrations run themselves

`~/.stratus/state.json` records a schema version and which migrations have
been applied. On the first command of a newer build — whatever installed
it: npm directly, Homebrew, a pinned version in CI — any pending migrations
run automatically, each one idempotent, applied in order, and recorded as
it completes. This is deliberate: an upgrade path that migrates only
through one blessed command leaves the other install methods on unmigrated
state, and the two populations diverge silently. (One constraint that keeps
the automatic path honest: a migration must be safe to run while a daemon
is serving, because this path does not stop the managed service — only
`stratus update` does. A migration needing exclusive access to shared state
is not registered until the registry can require that bracket.)

Schema 2 is the first stamp that exists only to be refused: since
[provenance](../concepts/memory.md#where-a-fact-came-from) landed, memory
entries, sessions, schedules, and the filesystem provenance ledger carry
trust labels, and a build from before them would read an `external` fact as
the agent's own conclusion and keep writing unlabelled state beside the
labelled kind. Nothing is rewritten on the way up; on the way down, a build
that understands schema 1 refuses to write. A daemon from *before* this
build that is still running when the stamp advances never re-reads it — a
stamp is checked by a build that knows to check — so it keeps serving until
it is restarted; `stratus update` stops it first, and an install that went
around `stratus update` should restart the service (`stratus service
restart`). From this build on, the daemon re-reads the stamp on every
dispatch, scheduler tick, and rollover and refuses new work once a newer
build has stamped the home, so the next bump stops a live daemon on its
own. A turn already in flight at that moment finishes in this build's
shape — the same thing `stratus service stop` lets an in-flight turn do —
which is why `stratus update` stops the service *before* it migrates
rather than relying on the stamp to do it.

One thing a rollback does lose, and it is not stamped: an agent's
`origins` grants. `<id>.whitelist.json` holds both kinds of grant under the
same version, so a daemon predating [browser actions](./browser.md) reads
it happily and drops the origins the next time an "always" answer writes to
it. That fails in the safe direction — the calls ask again, or are refused
in `headless` with a line naming the site — but the grants do not come back
when you upgrade again, and you re-approve them. Copy the file first if a
rollback is planned.

The reverse direction refuses instead of guessing: against state stamped by
a **newer** build than itself, anything that *writes* under `~/.stratus` —
`serve`, `setup`, `chat`, `run`, `skill add`, `dashboard`,
`schedules cancel`, `memory reassert`, `session rollover`, `credential`
writes, `service install`/`start` — refuses with a line naming
the fix, because a downgraded build writing into a newer format is the one
way to corrupt it. Read-only commands (`logs`, `agents`, `doctor`,
`service status`/`stop`) warn and continue: reading is how you diagnose
your way out. The same split applies when a migration itself fails — most
often a `~/.stratus/state.json` that cannot be written: a command that
writes state refuses rather than persist data the stamp was meant to
protect, and a read-only one warns and continues.

## `stratus update` does the sequence in the order that cannot lose data

```bash
stratus update            # stop stratusd → upgrade from npm → migrate →
                          # rewrite the service unit → restart
stratus update --check    # report all of it, change nothing (exits 1 when
                          # something is actionable, for scripts and cron)
```

The service stop comes first so no daemon holds the session database while
state changes, and the unit rewrite is the step nothing else performs: the
unit runs the daemon by **absolute paths** (see
[Always on](./always-on.md)), so upgrading node — under nvm, a whole new
version directory — leaves the unit pointing at an interpreter that no
longer exists. The service stops working and nothing says so; the agents
just stop answering. `stratus update` rewrites the unit with the current
node and entrypoint paths, preserving its `--config` pin and login setting,
and `stratus doctor` flags a stale unit path as a problem. Every step
degrades independently — with npm unreachable, `update` skips the package
upgrade but still migrates and repairs the unit, which is exactly what the
offline case needs. A daemon that was deliberately stopped before the
update is left stopped after it.
