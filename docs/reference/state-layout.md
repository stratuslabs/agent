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
| `workspaces/<id>/` | Where an agent's tools put the files they produce — a screenshot a channel uploads, a report it wrote. |

## One directory per agent

`agents/<id>/` holds everything that is *that agent's*, `0700`:

| Path | What it is |
| --- | --- |
| `agents/<id>/sessions.db` | Its conversations, whole: messages, status, and the provider replay state a resumed turn needs. `0600`. |
| `agents/<id>/memory.jsonl` | What it [remembers](../concepts/memory.md), one JSON record per line, plus the derived `memory.jsonl.index` beside it. `0600`. |
| `agents/<id>/whitelist.json` | What it may do unattended: command scopes, origins, and standing tool grants. See [Approvals](../guides/approvals.md#standing-grants). `0600`. |

The agent's **soul stays a file in `agents/`**, not in this directory: a
soul is your input — edited, copied between machines, read by `stratus
agents` with no daemon anywhere near it — while everything above is the
agent's own state.

Per-agent directories are the point rather than a tidier listing. A store
is opened on one agent's path, so there is no query another agent's
conversations or memories could come back from: the handle does not exist,
rather than a filter having remembered to exclude them. Two things follow
that are worth knowing:

- **Deleting `agents/<id>/` forgets that agent's history, memories, and
  grants together**, and leaves every other agent untouched. Its
  `workspaces/<id>/` is separate and outlives it — the files its tools
  produced are yours, not its state. Deleting only the soul keeps both,
  which is deliberate: restore the soul later and the agent finds its
  history where it left it.
- **Renaming an agent's `id:` re-keys all of it.** The old directory stays
  where it is under the old id; nothing moves it, because nothing can tell
  a rename from a new agent.

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
[Updating](../guides/updating.md), which also says why the session half
waits for `stratus serve` or `stratus update` and what the originals are
called afterwards.
