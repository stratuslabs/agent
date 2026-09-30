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

## Logs on stdout, for a container or journald

In a container, or under a system unit, stdout is not gone — it is the
log pipeline. `docker logs`, a Docker logging driver, journald, and
shippers like Vector or Fluent Bit all read it line by line, and they want
one JSON object per line rather than the terminal's aligned text:

```bash
stratus serve --log-format json
```

```json
{"ts":"2026-09-29T09:14:02.114Z","level":"info","msg":"stratusd ready — 3 agents, slack connected"}
{"ts":"2026-09-29T09:14:31.020Z","level":"event","event":"session.created","sessionId":"slack:ava:T01ABCDEF:C07GHIJKL:1731900000.123456","agentId":"ava"}
{"ts":"2026-09-29T09:14:36.482Z","level":"event","event":"tool.called","sessionId":"slack:ava:T01ABCDEF:C07GHIJKL:1731900000.123456","detail":{"tool":"web.fetch"},"agentId":"ava"}
```

- **The same records as the file, not a second stream.** Every record
  written to `stratusd.jsonl` is written to stdout as it is, in the same
  order — so everything below about what the log does and does not hold
  applies to the stream too. With `--no-log-file` the file is skipped and
  stdout still carries them.
- **Nothing else goes to stdout.** The human lines are not printed, and
  neither are warnings on stderr — a warning is already a record, and both
  streams land in the same `docker logs`. `--no-events` has nothing to hide
  in this mode: the event lines it suppresses are not printed anyway, and
  the event *records* are the file's, which it never touched.
- **What comes before the daemon is a record too.** A state migration's
  notice on the first start after an upgrade, a refused or failed start, a
  flag that does not parse, and a log file that cannot be written are each
  a `warn` record on stdout. Those from before the daemon started serving
  are on stdout only: the file was not open yet (see
  [below](#when-the-log-is-empty)). What can still reach stderr is what
  Node itself prints, for a crash the CLI never caught — keep stderr in
  whatever collects stdout.
- **`stratus logs` still works** inside the container, reading the file,
  as long as the file is being written.

The [Docker image](./deployment.md) starts the daemon this way.

## A trace, not a transcript

The log records that a tool ran and that a session completed, with the
tool's name, the agent, and the session id. Prompts, replies, and tool
inputs are not written — what was said lives in the session store instead.
A memory write, forget, supersession, or pin also records the **entry id**
it touched (never the fact itself), so "when did the agent learn this" has
an answer. A supersession names both halves of the revision — the entry
written and the one it retired — and a pin records whether it took, since
the pinned core refuses rather than evicting and a refusal is a decision
worth a line. When a
session's trust label drops, `session.tainted` records the new label and
the **name** of what lowered it — a tool, or `memory`, `sender`, `legacy` —
and never the content that did: "since when has this conversation been
reading strangers' text" is answerable without the text being in the log.
A message an agent overheard in a shared thread — said to somebody else,
appended with no turn run — is `session.observed`, by session and agent
alone; that it was heard is the trace, and what was heard stays in the
session store like every other message. When a conversation grows past what
the model can read in one request and its oldest messages stop being sent,
`session.context-trimmed` records how many left and how many are now held
back — counts only, for the same reason. It is worth watching for: the
answers stay plausible while the agent quietly stops being able to remember
the start of the conversation. See
[a conversation that outgrows the model](./troubleshooting.md#a-conversation-that-outgrows-the-model).
See [Memory](../concepts/memory.md#where-a-fact-came-from). For
what it records about a shell command — the scope, never the command — see
[Shell commands](./shell.md#what-the-log-records-about-a-command). A call
that ran under a **standing grant** is recorded as such, with the grant's
date and approver, so it can be told from one that ran because the tool was
`safe` — see [Approvals](./approvals.md#what-the-log-records-about-a-grant).

Every model call's usage is a `session.usage` record — provider, model, and
the four token counts, the same rows [`stratus usage`](./usage-and-budgets.md)
sums — so a spend can be followed to the turn that made it. Every use of a
[leased credential](./leases.md) is a `credential.leased` record, allowed or
refused, with the credential's name, the lease that paid, and what it was
used for — never the key. A lease an agent asked for
[from Slack](./leases.md#asking-for-one-from-slack) is a `lease.requested`
record (the credential, duration, and use limit, not the agent's reason)
and a `lease.decided` one (approved or denied, by whom, and the lease
granted). A turn stopped by a spent budget or a missing
lease is `session.failed` with `refused: true`, its error the sentence the
person in the conversation was shown.

One exception worth knowing before you paste a log anywhere. A failed
session records the **provider's error text verbatim**, and providers
routinely quote the request that failed — so a malformed prompt can end up
inside an error message. Skim a log before sharing it, and prefer `--agent`
or `--session` to narrow it to the run you actually mean.

## When the log is empty

A daemon that fails *before* it starts serving — a broken install, an
unreadable credentials file — never gets as far as opening the structured
log, so `stratus logs` shows nothing or shows yesterday. Those errors go to
stderr — or, under `--log-format json`, to stdout as `warn` records — and
where either lands is the service manager's business, so it differs by
platform:

```bash
tail ~/.stratus/logs/stratusd.err.log      # macOS
journalctl --user-unit=stratusd.service    # Linux
docker logs stratusd                       # the Docker image — stdout and stderr both
journalctl -u stratusd.service             # the system unit in deploy/systemd
```

That is where a restart loop explains itself. On macOS the LaunchAgent
redirects both streams to files, so Stratus truncates them when `serve`
starts and every five minutes while it runs — a crash loop cannot fill the
disk with the same error a million times. On Linux systemd keeps the same
output in the journal instead, which does its own rotation, so there is
nothing beside the JSONL to bound and nothing to clean up.
