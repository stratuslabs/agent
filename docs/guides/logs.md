# Logs

Under a service manager the daemon's stdout is gone, so everything
`stratus serve` says is also written to `~/.stratus/logs/stratusd.jsonl`
(owner-read-only, rotated at 8 MB, three generations kept). That file is
the record of an overnight run, and `stratus logs` reads it from any
terminal:

```bash
stratus logs                     # the last 50 records
stratus logs -f                  # follow, across rotations
stratus logs -n 200
stratus logs --agent ava
stratus logs --session slack:ava:T01ABCDEF:C07GHIJKL:1731900000.123456
stratus logs --format json       # the raw records, for jq
```

```text
09:14:02  —           stratusd ready — 3 agents, slack connected
09:14:31  ava         session.created [slack:ava:T01ABCDEF:C07GHIJKL:1731900000.123456]
09:14:36  ava         tool.completed tool=memory.remember ok=true [slack:ava:T01ABCDEF:C07GHIJKL:1731900000.123456]
09:18:44  ava         session.tainted trust=external source=web.fetch [slack:ava:T01ABCDEF:C07GHIJKL:1731900000.123456]
09:21:07  —           warning: anthropic returned 529; retrying on the fallback model
09:40:12  —           warning: mcp server linear disconnected — its tools are unavailable until it comes back
```

A plugin's lifecycle lines land here too — an MCP server that dropped or
came back, a reconnect that failed — not only on the stderr the service
manager owns.

Session ids are the channel's own key —
`channel:agent:team:conversation[:thread]` — so the id in the last column
is exactly what `--session` wants, and the same conversation keeps it
across daemon restarts.

## A trace, not a transcript

The log records that a tool ran and that a session completed, with the
tool's name, the agent, and the session id. Prompts, replies, and tool
inputs are not written — what was said lives in the session store instead.
A memory write or forget also records the **entry id** it touched (never
the fact itself), so "when did the agent learn this" has an answer. When a
session's trust label drops, `session.tainted` records the new label and
the **name** of what lowered it — a tool, or `memory`, `sender`, `legacy` —
and never the content that did: "since when has this conversation been
reading strangers' text" is answerable without the text being in the log.
See [Memory](../concepts/memory.md#where-a-fact-came-from). For
what it records about a shell command — the scope, never the command — see
[Shell commands](./shell.md#what-the-log-records-about-a-command).

One exception worth knowing before you paste a log anywhere. A failed
session records the **provider's error text verbatim**, and providers
routinely quote the request that failed — so a malformed prompt can end up
inside an error message. Skim a log before sharing it, and prefer `--agent`
or `--session` to narrow it to the run you actually mean.

## When the log is empty

A daemon that fails *before* it starts serving — a broken install, an
unreadable credentials file — never gets as far as opening the structured
log, so `stratus logs` shows nothing or shows yesterday. Those errors go to
stderr, and where stderr lands is the service manager's business, so it
differs by platform:

```bash
tail ~/.stratus/logs/stratusd.err.log      # macOS
journalctl --user-unit=stratusd.service    # Linux
```

That is where a restart loop explains itself. On macOS the LaunchAgent
redirects both streams to files, so Stratus truncates them when `serve`
starts and every five minutes while it runs — a crash loop cannot fill the
disk with the same error a million times. On Linux systemd keeps the same
output in the journal instead, which does its own rotation, so there is
nothing beside the JSONL to bound and nothing to clean up.
