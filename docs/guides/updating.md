# Updating

`~/.stratus` is a real on-disk format — config, credentials, souls, and
each agent's own [state directory](../reference/state-layout.md) — so
upgrading is more than `npm install -g`. Two pieces handle it.

## State is versioned, and migrations run themselves

`~/.stratus/state.json` records a schema version and which migrations have
been applied. On the first command of a newer build — whatever installed
it: npm directly, Homebrew, a pinned version in CI — any pending migrations
run automatically, each one idempotent, applied in order, and recorded once
the last of them has run. This is deliberate: an upgrade path that migrates only
through one blessed command leaves the other install methods on unmigrated
state, and the two populations diverge silently. (One constraint that keeps
the automatic path honest: a migration must be safe to run while a daemon
is serving, because this path does not stop the managed service — only
`stratus update` does. A migration that needs exclusive access to state a
daemon holds open says so, and is deferred here until a caller that has the
home to itself runs it: `stratus update`, which stops the service first, or
`stratus serve`, which holds the claim and is about to open the stores
anyway. Schema 3 asks for that bracket **always**, not only when the old
state is still visible: "is there anything in the old place" is a question
about right now, and a daemon of the older build starting a moment later
creates exactly what the check just failed to see — leaving the home
recorded as migrated while it fills with state nothing will move. A run that
has to defer records which migrations it ran but proposes **no schema
version**, so it can raise nothing and lower nothing: only a run that
finished everything sets the version. Stamping the part it finished would
read as the better answer and is not, because two runs overlap — the
ordinary one reads the stamp before the exclusive one records the move, its
write lands last, and the home is marked as not having had a move it has
just had. A stamp that *under*-reports is the one that admits an older build
to state it cannot read. So a home waiting for its bracket reads as schema 0
until its first `stratus serve` or `stratus update`, which is also the
truthful answer to an older build asking whether it may write there.) The ones it ran are idempotent and simply run again on
the next command, which is the cheaper half of that trade: a run that
recorded a partial set could have its record land on top of the complete
one written by the `stratus update` beside it, and take the finished move
back out of the stamp.)

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

Schema 3 moves each agent's state into its own directory:
`~/.stratus/agents/<id>/` now holds that agent's `sessions.db`,
`memory.jsonl`, and `whitelist.json`, while the schedules move out of the
shared session database into `~/.stratus/fleet.db` beside a session index.
[State layout](../reference/state-layout.md) is the map. What moves when
is decided by what a daemon of the *older* build — still serving, because
nothing has restarted it yet — can do to each file:

- **Sessions, schedules, and grants wait for `stratus update` or the next
  `stratus serve`**, the two callers that have the home to themselves. That
  daemon holds the session database open, and moving it out from under one
  loses every turn saved after the split; it also holds its grants cached
  and writes that file back whole, so a revocation made through it after a
  move would land on the old path while the moved file still granted — a
  grant back from the dead. Nothing can reconcile those afterwards, so the
  move waits instead. Until it happens, `stratus schedules` keeps reading
  whichever database the rows are actually in, and grants are both read
  *and written* on the old file — one file at a time, whichever is
  currently the agent's, is what keeps the two builds writing the same
  list, so nothing goes quiet or comes back from the dead in between.
- **Memories are copied on the first command of the new build**, and keep
  being copied. The JSONL is an append-only log opened by pathname on every
  read and every write, so folding it in is not a one-shot migration at all
  but a copy that every command and every daemon start runs until the
  source stops changing. Copied rather than moved, and the source is
  retired only under the bracket, because both ends have a reader to keep
  whole: waiting would mean every `run`, `agents`, and `memory` on the new
  build reading an agent that remembers nothing, while taking the file away
  early would do the same to the old daemon still serving from it. An
  upgrade must never look like the agent forgot — in either direction.

Nothing is deleted: the shared database and the shared memory file stay on
disk as `sessions.db.migrated` and `memory.jsonl.migrated`, and the old
`agents/<id>.whitelist.json` files are moved rather than copied. An agent
whose soul is absent keeps its rows — the migration walks the stored agent
ids, not the roster — so restoring the soul later finds its history where
the layout says it lives. An id with no directory to own — one that is not a
single path segment, one whose name is already a file, one the platform
refuses — keeps its rows in the preserved original, and the migration names
it and the reason on the way past rather than dropping it silently or
failing the upgrade over it. Its grant file is archived too, as
`agents/<id>.whitelist.json.migrated`: left under the old name it would
read as a home the move never reached, and the daemon would refuse to start
over a file no later run was going to pick up. That agent has no standing
grants until you rename its id and put the file back — the safe direction,
and the reason the original is kept.

One thing a rollback does lose, and it is not stamped: an agent's
`origins` and `tools` grants. `whitelist.json` holds every kind of
grant under the same version, so a daemon predating
[browser actions](./browser.md) or
[standing grants](./approvals.md#standing-grants) reads it happily and
drops the keys it does not know the next time an "always" answer writes to
it. That fails in the safe direction — the calls ask again, or are refused
in `headless` with a line naming the site or the tool — but the grants do
not come back when you upgrade again, and you re-approve them. Copy the
file first if a rollback is planned.

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

The service stop comes first so no daemon holds a session database while
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

## The companion packages go up with it

The CLI is one global install and its optional companions are others — the
[Slack channel](./slack.md), the [control API and
dashboard](./remote-access.md), and each [tool plugin](./tools.md). They
ship from one repository in lockstep with the CLI, so `stratus update`
upgrades every one this machine has, to the version the CLI is going to,
in the same `npm install` call. Nothing else does: upgrading the CLI alone
used to leave each of them at whatever version was installed the day
`stratus setup` first ran, and nothing reported it — `stratus doctor` says
`installed`, which was equally true of a Slack adapter two releases behind
the daemon loading it.

A companion left behind is actionable on its own, so it is reported and
exits 1 even when the CLI itself is current:

```
$ stratus update --check
stratus 0.11.2
  latest      0.11.2 — up to date
  packages    3 first-party alongside the CLI, 1 behind
              @stratusagent/channel-slack 0.10.1 → 0.11.2
Run `stratus update` to apply the above.
```

Only packages that are installed are considered — installing one is still
a separate, deliberate act (`stratus setup` offers the ones your answers
imply), and `update` never adds a package you do not have. Which ones are
installed, and what each contributes, is `stratus plugins`.
