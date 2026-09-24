# What is in `~/.stratus`

Everything a Stratus install keeps on disk, and which of it belongs to one
agent. Paths are relative to `~/.stratus` (or to `$HOME/.stratus` for the
user the daemon runs as). Nothing here is a file you have to manage by
hand — this is for reading a directory listing, backing one up, and knowing
what moves when you rename an agent.

## The fleet's own files

| Path | What it is |
| --- | --- |
| `config.json` | The global [configuration](./config.md). The **trusted** config: `api`, `approvals`, `soul`, and `systemPrompt` are read only from here (or a `--config` file you named), never from a project-local one. |
| `credentials.json` | Stored sign-ins and Slack channel tokens. `0600`. No endpoint ever returns a secret from it. |
| `state.json` | The schema stamp: which format this home is in, and which migrations have run. See [Updating](../guides/updating.md). |
| `fleet.db` | The schedules, and the session index that says which agent's store holds a given session id. Fleet infrastructure, deliberately not per agent — see below. |
| `gateway-token`, `gateway.json` | The [control API](../../packages/control-api/README.md)'s bearer token and the address a running daemon bound. Both `0600`. |
| `stratusd.lock` | Held by the daemon serving this home; how a second `stratus serve` is refused. |
| `logs/` | `stratusd.jsonl`, the structured trace [`stratus logs`](../guides/logs.md) reads, plus the macOS LaunchAgent's stdout/stderr redirects. `0700`. |
| `skills/` | Operator-installed [skills](../guides/skills.md), one directory each. |
| `agents/` | One `<id>.md` soul per agent, plus one directory per agent — below. |

## One directory per agent

`agents/<id>/` holds everything that is *that agent's*, `0700`:

| Path | What it is |
| --- | --- |
| `agents/<id>/sessions.db` | Its conversations, whole: messages, status, and the provider replay state a resumed turn needs. `0600`. |
| `agents/<id>/memory.jsonl` | What it [remembers](../concepts/memory.md), one JSON record per line, plus the derived `memory.jsonl.index` beside it. `0600`. |
| `agents/<id>/whitelist.json` | What it may do unattended: command scopes, origins, and standing tool grants. See [Approvals](../guides/approvals.md#standing-grants). `0600`. An install still waiting on the upgrade move has this as `agents/<id>.whitelist.json`, and that file is the one both read and written until it moves. |
| `agents/<id>/workspace/` | Where its tools put the files they produce — a screenshot a channel uploads, a report it wrote, an image an MCP server returned — plus `fs-provenance.jsonl`, the ledger that remembers which of those files came from outside (see [Tools](../guides/tools.md)). `0700`. An install still waiting on the upgrade move has this as `workspaces/<id>/`. |

The agent's **soul stays a file in `agents/`**, not in this directory: a
soul is your input — edited, copied between machines, read by `stratus
agents` with no daemon anywhere near it — while everything above is the
agent's own state.

Per-agent directories are the point rather than a tidier listing. A store
is opened on one agent's path, so there is no query another agent's
conversations or memories could come back from: the handle does not exist,
rather than a filter having remembered to exclude them. Two things follow
that are worth knowing:

- **Deleting `agents/<id>/` forgets that agent's history, memories, grants
  and produced files together**, and leaves every other agent untouched.
  One path to name is the point of the workspace living in here: before it
  did, an "erase this agent" had two directories to remember. Copy
  `agents/<id>/workspace/` out first if the files its tools produced are
  yours to keep. Deleting only the soul keeps all of it, which is
  deliberate: restore the soul later and the agent finds its history where
  it left it.
- **Renaming an agent's `id:` re-keys all of it.** The old directory stays
  where it is under the old id; nothing moves it, because nothing can tell
  a rename from a new agent.
- **The `workspace/` segment is load-bearing, not tidiness.** `fs` has no
  default roots — no roots means no filesystem — but this is the directory
  you would name as one to let an agent read back what its own tools
  produced, it is where `shell.run` starts, and it is what a sandboxed
  executor mounts. One level up, its `whitelist.json` — the file saying
  what it may do unattended — its `sessions.db` and its `memory.jsonl` are
  *siblings* of that directory rather than descendants, and no path inside
  it reaches them. Were the workspace `agents/<id>/` itself, that same
  choice would hand the agent its own grant file.
- **No path Stratus derives may pass through a symlink**, at any component
  below the home — not `agents/`, not `agents/<id>/`, not `sessions.db`,
  `memory.jsonl`, `memory.jsonl.index` or `whitelist.json`, and not
  `fleet.db` beside them. Stratus chose these names, so a link at one is not
  a layout decision somebody made, it is this agent's state pointing at
  another agent's file or outside the home; and the `0700`/`0600` tightening
  would be applied to whatever it points at. A link at `agents/` redirects
  the whole fleet at once, which is why the rule is about the walk rather
  than the last name in it.
  `workspace/` is the one exception, and it is an exception to the *leaf*
  rather than to the walk: it may itself be a link, because where an agent's
  *output* lives is a layout decision an operator can legitimately make
  (another volume, a larger disk), and the upgrade move carries an existing
  one across as a link rather than copying through it — but it is still
  reached through `agents/<id>/`, which may not be.
  Reads are refused as well as writes, because a
  store that will not *place* a memory through a link but answers happily
  with what is on the far side of one has only moved the leak. A daemon
  refuses; the upgrade move quarantines and says which component. The one
  path it reads through a link rather than refusing is the *legacy* shared
  `sessions.db` of a home upgrading from before this rule: refusing it would
  strand that home with every session inside the file being refused for, so
  it is read, its link is renamed (which leaves their file where it is), and
  its mode is not changed through the link. This is
  about Stratus's own paths only — `~/.stratus` itself may be a symlink to a
  directory elsewhere (another volume, a synced folder), and is followed
  wherever it is checked, which is the asymmetry the whole rule turns on:
  the home is the operator's path, everything below it is ours. A soul file
  in `agents/` may be a link too (see
  [Templates](../guides/templates.md)).
- **Two ids a filesystem reads as one name are one directory**, because
  macOS and Windows fold `agents/Ava/` and `agents/ava/` onto the same name
  — and APFS folds Unicode normalization too, so an accent written as one
  code point and as a combining pair land there as well. One directory
  holding two agents is the sessions, the memories, and the unattended
  grants of both. The roster refuses to load rather than serve
  them, on every platform including the ones that would keep the two apart:
  a souls directory gets copied between machines, and this must not be an
  answer that changes with the machine. The upgrade move applies the same
  rule to the ids it finds in *stored* rows, where no soul had to exist:
  the second spelling is quarantined and named, its rows left in the
  preserved original.

## What stays fleet-wide, and why

Two things deliberately do not shard, and both live in `fleet.db`:

- **Schedules.** The scheduler ticks once for the whole fleet, `stratus
  schedules` is the fleet's audit list, and cancelling by bare id revokes
  the standing destination grant riding on the row. Scattered across
  per-agent files, a schedule outside whichever file happened to be open
  would neither fire, nor appear in the audit, nor be cancellable — a
  standing grant outliving your reach.
- **The session index.** Session ids are chosen by whoever opens the
  conversation, and `GET /sessions/:id` resolves one with no agent in hand.
  The index is where an id is claimed (a second agent cannot take one that
  is already held) and what such a lookup consults. It carries routing and
  status, never a message: nothing about a conversation can be read out of
  a fleet-wide file.

## Moving or backing up a home

Copy the whole directory. The SQLite files are in WAL mode, so copy them
with the daemon stopped (`stratus service stop`) or copy `*-wal` and
`*-shm` alongside each database; otherwise the newest turns are the ones
you lose.

An install upgrading from before this layout is migrated on first use — see
[Updating](../guides/updating.md), which also says why the sessions,
schedules, and grants wait for `stratus serve` or `stratus update` while
the memories are copied straight away, and what the preserved originals are
called afterwards.
