# What is in `~/.stratus`

Everything a Stratus install keeps on disk, and which of it belongs to one
agent. Paths are relative to `~/.stratus` (or to `$HOME/.stratus` for the
user the daemon runs as). Nothing here is a file you have to manage by
hand — this is for reading a directory listing, backing one up, and knowing
what moves when you rename an agent.

## The fleet's own files

| Path | What it is |
| --- | --- |
| `config.json` | The global [configuration](./config.md). The **trusted** config: `api`, `approvals`, `soul`, and `systemPrompt` are read only from here (or a `--config` file you named), never from a project-local one. `0600`, since plugin config can carry secrets — tool-shell's `env` block among them. |
| `credentials.json` | Stored sign-ins (the shared ones, and any agent's own under `agentSignIns`), channel tokens, and named credentials. `0600`. No endpoint ever returns a secret from it. |
| `state.json` | The schema stamp: which format this home is in, and which migrations have run. See [Updating](../guides/updating.md). |
| `fleet.db` | The schedules, and the session index that says which agent's store holds a given session id. Fleet infrastructure, deliberately not per agent — see below. |
| `promoted.json` | The last version promoted on this home under `stratus serve --hold-new-version`, and when. A start of any other version is held until promoted. `0600`. |
| `intake.json` | Present only while intake is paused (`PUT /api/v1/intake`): the pause, its message, and when it began. Read at start, so a pause survives a restart; a file that cannot be read starts the daemon paused. `0600`. |
| `slack-pending-intake.json` | Present only while Slack messages sent during a restart or stop wait for the next start: per message the agent, workspace, channel, ts, thread, sender, channel type, and when it was kept. Never the text, which is read back from Slack. Each entry is removed as it is handled; one over a day old is dropped. `0600`. |
| `gateway-token`, `gateway.json` | The [control API](../../packages/control-api/README.md)'s bearer token and the address a running daemon bound. Both `0600`. |
| `stratusd.lock` | Held by the daemon serving this home; how a second `stratus serve` is refused. |
| `grants.lock` | Held for a moment while a grant file is read by the daemon or rewritten by `stratus grants revoke`, so a daemon never reads one halfway through a revoke. Empty; safe to delete when nothing is running. |
| `workspace-links.json` | Only while the upgrade move of `workspaces/` is unfinished: which workspace links that move pointed somewhere new, so a later start can point them back if their target turns out to stay put. An entry saved just before its link is written is held as pending until the link exists, and a start that finds that very link there with the entry still pending refuses, since it cannot tell the link from one you made yourself — the error names the file and how to settle it. An entry is dropped once its target has moved, and the file once it holds none; `workspaces/` being gone does not settle it, since a command of an older build can make an entry again. One that will not read stops the move, naming the file, rather than being skipped. `0600`. |
| `logs/` | `stratusd.jsonl`, the structured trace [`stratus logs`](../guides/logs.md) reads, plus the macOS LaunchAgent's stdout/stderr redirects. `0700`. |
| `skills/` | Operator-installed [skills](../guides/skills.md), one directory each. |
| `plugins/<package>/` | What one [plugin](../architecture/plugins.md) keeps across restarts, such as a channel's read position, by package name; a scoped package nests under its scope (`plugins/@scope/name/`). Created only when a plugin asks for it. `0700` at every level. |
| `agents/` | One `<id>.md` soul per agent, plus one directory per agent — below. Each soul, and each agent's `workspace/`, is normally a link into the [agents folder](#the-agents-folder). |
| `agents/.agents-folder` | The agents folder those links were made into, one absolute path. Written by `serve` and `update`; a home copied or restored to another path uses it to re-point its links (see [the agents folder](#the-agents-folder)). |

## One directory per agent

`agents/<id>/` holds everything that is *that agent's*, `0700`:

| Path | What it is |
| --- | --- |
| `agents/<id>/sessions.db` | Its conversations, whole: messages, status, and the provider replay state a resumed turn needs. `0600`. |
| `agents/<id>/memory.jsonl` | What it [remembers](../concepts/memory.md), one JSON record per line, plus the derived `memory.jsonl.index` beside it. `0600`. |
| `agents/<id>/whitelist.json` | What it may do unattended: command scopes, commands granted by name, origins, and standing tool grants. See [Approvals](../guides/approvals.md#standing-grants). `0600`. An install still waiting on the upgrade move has this as `agents/<id>.whitelist.json`, and that file is the one both read and written until it moves. |
| `agents/<id>/workspace/` | A link to `~/Agents/<id>/workspace/` (see [the agents folder](#the-agents-folder)). Where its tools put the files they produce — a screenshot a channel uploads, a report it wrote, an image an MCP server returned — plus `fs-provenance.jsonl`, the ledger that remembers which of those files came from outside (see [Tools](../guides/tools.md)). `0700`. An install still waiting on the upgrade move has this as `workspaces/<id>/`. |

The agent's **soul is named in `agents/`**, not in this directory: a
soul is your input — edited, copied between machines, read by `stratus
agents` with no daemon anywhere near it — while everything above is the
agent's own state. The file itself is normally in the agents folder, below.

## The agents folder

The two things in here that a person opens, each agent's soul and the files
its tools produced, live in a visible folder in your home directory, beside
Documents and Downloads, so neither needs hidden files shown:

| Path | What it is |
| --- | --- |
| `~/Agents/<id>/soul.md` | The agent's soul. Edit it here. `~/.stratus/agents/<id>.md` is a link to it, and is the name the roster, `stratus agents` and `--soul` go on using. |
| `~/Agents/<id>/workspace/` | Its workspace. `~/.stratus/agents/<id>/workspace` is a link to it. |
| `~/Agents/.stratus-agents` | The marker that says this folder is Stratus's. |

Sessions, memories, grants and everything else stay in `~/.stratus`.

- **Which folder.** `~/Agents`, unless that name already belongs to
  something else: a folder Stratus did not create (it has no
  `.stratus-agents` marker) is never written to, and `~/Stratus` is used by
  the same rule instead. On macOS's default case-insensitive disk an
  existing `~/agents` *is* `~/Agents`, so it counts as taken. When both
  names are taken there is no agents folder, and souls and workspaces stay
  as real files in `~/.stratus/agents/` as they always were.
- **Only on the same disk as `~/.stratus`.** When `~/.stratus` is on a
  different filesystem from the rest of your home directory, there is no
  agents folder either. That is the Docker image, whose volume holds
  `~/.stratus` and nothing else: anything written to `~/Agents` there
  would be lost when the container is recreated. A Fly volume or a second
  disk mounted at `~/.stratus` is the same case.
  Where symlinks cannot be made (Windows without Developer Mode or
  Administrator), there is no agents folder and the hidden layout stays.
- **Choosing it yourself.** `STRATUS_AGENTS_DIR` names the folder outright
  (`~` expands; it may not be inside `~/.stratus`, and it is used even on
  another disk), and `STRATUS_AGENTS_DIR=off` turns the folder off.
  `stratus doctor` prints which folder is in use, or why there is none.
- **When things move there.** A new agent (`stratus agent new`,
  `stratus template add`) is written there, and a workspace is made there
  the first time a tool writes a file. A soul or workspace that is still a
  real file in `~/.stratus/agents/` (an install from before this, or a soul
  you dropped in by hand) is moved there by the next `stratus serve` or
  `stratus update`, and a link left at the old path. The move carries each
  workspace's provenance ledger across, so a fetched file stays labeled as
  fetched. A folder that already has a soul or workspace under that id is
  left alone, and the start says so. A workspace you linked somewhere else
  yourself stays where you put it. `stratus update --check` lists a move
  that is still to happen. An `agent new` or `template add` stopped
  partway can leave a soul in the folder that nothing links to; running
  it again finishes it, and `stratus doctor` lists any it finds.
- **An agent cannot edit its own soul there.** `fs.*` refuses every soul
  under its visible name too, so an agent given `~/Agents` as a root still
  cannot rewrite its tools or credentials.
- **Deleting or renaming `~/Agents/<id>/`** leaves the links pointing at
  nothing: the agent drops off the roster with a warning, and its workspace
  comes back empty on the next write. `stratus doctor` lists the broken
  links. Its sessions, memories and grants are untouched in `~/.stratus`.
  Put the folder back, or rename it back, to restore the agent.
- **Copying or restoring a whole home to another path** (another user, a
  new host path, a backup restored elsewhere) carries the links as they
  are, still naming the old path. Copy the agents folder along with
  `~/.stratus`. Each start records the folder the links were made into in
  `~/.stratus/agents/.agents-folder`, and the copy carries that record: the
  next `stratus serve` or `stratus update` re-points each soul and
  workspace link whose target is gone and that names the recorded folder at
  the same file in this home's folder (when the folder carries the marker
  and has that file), re-records a workspace's provenance ledger at the new
  path, and says how many it re-pointed. A link into any other folder is
  left as it is, because an operator's link to storage that is offline
  looks exactly the same. A home last started by a build before the record
  (0.13.6 or earlier) has none: `stratus doctor` names the folder its links
  point into and gives the one command that records it, and the next start
  re-points them. Every broken link left as it is is named by
  `stratus doctor`, with where it points, and by the roster's warning when
  it skips that soul.

Per-agent directories are the point rather than a tidier listing. A store
is opened on one agent's path, so there is no query another agent's
conversations or memories could come back from: the handle does not exist,
rather than a filter having remembered to exclude them. Two things follow
that are worth knowing:

- **Deleting `agents/<id>/` forgets that agent's history, memories and
  grants together**, and leaves every other agent untouched. Its produced
  files go too when its workspace is a real directory in here; when it is
  the usual link into the [agents folder](#the-agents-folder), only the
  link goes and the files stay in `~/Agents/<id>/workspace/`, so erasing
  the agent completely means deleting `~/Agents/<id>/` as well. Deleting only the soul keeps all of it, which is
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
  refuses, and so do the commands that write here on their own —
  `stratus agent new`, `template add`, and `stratus schedules` opening
  `fleet.db`; the upgrade move quarantines a linked `agents/<id>/` and says
  which component, and refuses to run at all under a linked `agents/`,
  which it cannot move around. The one
  path it reads through a link rather than refusing is the *legacy* shared
  `sessions.db` of a home upgrading from before this rule: refusing it would
  strand that home with every session inside the file being refused for, so
  it is read — opened read-only, with no journal switch and no write lock
  taken on it — its link is renamed (which leaves their file where it is),
  and its mode is not changed through the link. This is
  about Stratus's own paths only — `~/.stratus` itself may be a symlink to a
  directory elsewhere (another volume, a synced folder), and is followed
  wherever it is checked, which is the asymmetry the whole rule turns on:
  the home is the operator's path, everything below it is ours. A soul file
  in `agents/` may be a link too (see
  [Templates](../guides/templates.md)).
- **Two ids a filesystem reads as one name are one directory**, because
  macOS and Windows fold `agents/Blair/` and `agents/blair/` onto the same name
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
you lose. On a server the home is a Docker volume or
`/var/lib/stratus/.stratus`; [Deployment](../guides/deployment.md#back-up-and-restore)
has the archive-and-restore procedure and a drill that proves it.

An install upgrading from before this layout is migrated on first use — see
[Updating](../guides/updating.md), which also says why the sessions,
schedules, and grants wait for `stratus serve` or `stratus update` while
the memories are copied straight away, and what the preserved originals are
called afterwards.
