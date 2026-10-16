# Troubleshooting

`stratus doctor` answers one question — *what would a run use right now,
and who decided that?* Every setting is shown with the file or environment
variable it came from, because the answer is usually that something
outranks what you thought you configured:

```bash
stratus doctor
stratus doctor --format json
```

```text
Stratus Agent — what a run would use right now

  provider  anthropic
            from ~/.stratus/agents/blair.md (soul frontmatter)
  model     claude-opus-5-5
            from ~/.stratus/agents/blair.md (soul frontmatter)
  soul      ~/.stratus/agents/blair.md
            from ~/.stratus/config.json
  agent     Blair (blair)

Files
  config    ~/.stratus/config.json
  agents    1 soul file

Sign-ins
  anthropic Claude subscription (Pro/Max) — runs go through the Claude Code runtime
  openai    not signed in
  codex     not signed in

Channels
  slack     no agents connected
            @stratusagent/channel-slack installed

Daemon
  daemon    running 0.12.0, started 2026-10-12T08:00:00.000Z
            loaded ~/.stratus/config.json

1 problem found:
  ! A fallback model (gpt-4.1-mini) is configured but could not be resolved — usually
    no sign-in for its provider. A failing primary model has nothing to retry on.
```

It resolves the config exactly the way a run does rather than re-deriving
the rules, so what it prints is what you would get. It exits non-zero when
it finds a problem, and it is the fastest answer to the two most common
surprises: a run that turns out to be on the `demo` provider, and an
`ANTHROPIC_API_KEY` in the environment quietly demoting a Claude
subscription sign-in to per-token billing.

Doctor stays on the machine by default. `stratus doctor --live` also asks
each provider your runs use (the default and any fallback) whether it
accepts the key that run would send, using the same free models-list call
setup makes when you enter a key. When the key is accepted, it then asks the
run's model for a one-token reply, which catches a model name the provider
doesn't know or an account it won't bill:

```text
Live check
  anthropic key accepted · claude-opus-5 answered
```

That reply is a real, billed call (one output token on Anthropic; an
OpenAI-compatible endpoint gets the same uncapped request a run sends).

A refused key or a refused model is a problem and doctor exits non-zero. No
answer (offline, rate-limited, overloaded, or a compatible endpoint with no
models route) says nothing about the key or model, so it isn't a problem. A
subscription sign-in has no key to send and is reported as not checked, and a
codex model is not asked because codex runs it through its own harness.

The files are only half the answer when a daemon is running. It
re-resolves runtime settings (provider, model, system prompt and the rest of
the runtime config) on every turn, but daemon-level settings (plugins,
executor, memory store, Slack, approvals, principals, turn limits and the
control API) are read once, at start, and stay as they were until `stratus
restart`. So doctor also asks the running daemon
(through the control API, at the address in `~/.stratus/gateway.json`) what
it met while starting. Each warning it logged then (a plugin that did not
load, nobody able to approve, and so on) is a problem, and so is a config
file that has changed, appeared or gone since the daemon started, including a
global config behind a project one, since a restart is what applies the
daemon-level settings in it. No daemon found is not a problem, since `stratus run`
needs none; doctor says `none found (no control API published)` because a
daemon started with its API off publishes no address either. A damaged
`gateway.json`, or a daemon that published its address and does not answer, is
a problem.

## The usual suspects

- **"Why is this using the demo provider?"** — run `stratus doctor`; some
  file or env var outranks what you set. The
  [precedence chain](../reference/config.md) is: flags → `STRATUS_*` env
  vars → soul file hints → config file.
- **A file an agent produced is not where the docs say it should be** — run
  `stratus doctor`; it names any workspace still at the pre-0.11.5
  `~/.stratus/workspaces/<id>` path, which this build does not read. A
  command of an older build running during the upgrade is what leaves one.
  Starting the daemon or running `stratus update` folds its provenance
  labels into the agent's live ledger; the files move too unless the agent's
  own workspace already holds files of its own, in which case they stay put
  rather than overwriting newer ones. [Updating](./updating.md) says which
  is which.
- **Doctor says `config.json` can be read by other users** — an older build
  wrote it at your umask's mode, and it can hold secrets (tool-shell's `env`
  block is the usual one). Run `chmod 600 ~/.stratus/config.json`; every
  save from this build writes it `0600`, and tightens a loose one.
- **`stratus update` upgraded, then said `State migration failed: The
  requested module '@stratusagent/state' does not provide an export named
  …`** — the upgrade itself landed; the build doing the updating mixed its
  own modules with the newly installed ones (fixed in the release after
  0.11.7, which only helps updates *from* it). Run `stratus update` again:
  the CLI is now the new build, so it finishes the migrations and rewrites
  the service unit.
- **The agents stopped answering after a node upgrade** — the service unit
  points at an interpreter that no longer exists. `stratus update` repairs
  it; [Updating](./updating.md) explains why.
- **Slack replies arrive full of `**` and `##`, or some other companion
  behaves like an older build** — the optional packages are global installs
  of their own, so one can lag the CLI loading it. `stratus update --check`
  names any that are behind, and so do `stratus doctor` and the warnings
  `stratus serve` prints when it starts. `stratus update` brings them up, and
  then restart the daemon: a running daemon keeps the version it loaded.
- **The daemon won't start and says it cannot use its config** — the
  trusted config has a syntax or validation error, and `stratus serve`
  refuses to run without it rather than starting every agent bare. The
  message names the file and position; `stratus doctor` says the same.
  See [Always on](./always-on.md#a-config-that-will-not-load-stops-the-daemon).
- **`stratus logs` shows nothing, but the daemon won't start** — a daemon
  that fails before it starts serving never opens the structured log. See
  [When the log is empty](./logs.md#when-the-log-is-empty) for where those
  errors actually land on each platform.
- **A Slack app is silent** — the daemon isn't running
  ([Always on](./always-on.md)), or the channel package isn't installed
  (`stratus serve` names it at startup).
- **An agent's shell cannot find `node`, `npm`, `gh`, or another tool you
  have installed** — the always-on service runs with the `PATH` of the
  shell `stratus service install` was run from, and a unit written before
  that existed has the service manager's minimal default. Run `stratus
  service install` (or `stratus update`) from a terminal where `which node`
  works. See [Always on](./always-on.md).
- **It answers mentions but not replies in its own thread** — the app was
  installed before the channel history scopes were in the manifest, so
  Slack tells it about mentions only. Add `channels:history` /
  `groups:history` / `mpim:history` and the matching `message.*` events and
  reinstall the app once; [Slack](./slack.md#talking-to-an-agent) has the
  rest of the addressing rules. You don't have to guess: when an agent's app
  connects, the daemon warns `slack: <agent>'s app is missing bot scopes: …`
  for every scope the manifest asks for that the app lacks (`files:read`
  too, without which images reach the agent by name only), and `stratus
  doctor` lists the same line under the daemon's startup warnings. A daemon
  started with `--held` (or a held `--hold-new-version` start) connects
  Slack only when it is promoted, so there the warning is in the daemon log
  but not in `stratus doctor`. Slack can't report event subscriptions to a
  bot token, so no warning only clears the scopes: check the app's
  `message.*` events too. With scopes and events both in place, check the
  soul's [`listens`](./slack.md#how-an-agent-listens) setting: `mentions`
  hears untagged replies without answering them, and `judge` may choose
  silence or be past its attention window. Under the default `thread`, a
  missing reply usually means the thread belongs to another agent: it was
  there first. Mention the agent you want, or start a new thread with it.
- **A DM to the app says "Sending messages to this app has been turned
  off"** — that is Slack's App Home setting, not Stratus: the app was
  created before the manifest turned on its Messages Tab. In the app's
  settings, **App Home → Messages Tab → Allow users to send Slash commands
  and messages from the messages tab**, then reopen the DM. Channels are
  unaffected. See [Setting up an agent's Slack
  app](../../packages/channel-slack/README.md#setting-up-an-agents-slack-app-2-minutes).
- **An agent replies as though it used a tool, but nothing happened** — check
  the daemon's startup lines for `lists tools nothing registered provides`.
  An allowlist entry that matches no registered tool grants nothing, and a
  soul made only of those is granted nothing by its allowlist, so the tools
  its persona still refers to are not there to call; a model in that
  position tends to write the call out as text, result and all. `stratus logs` settles it either
  way — a real call is a `tool.called` line, and its absence means no tool
  ran. See [Tools](./tools.md#installing-a-plugin-grants-no-agent-anything).
- **A gated tool call was refused overnight** — that is the daemon's
  honest default. [Approvals](./approvals.md) covers asking a human in
  Slack instead.
- **An agent stops to say it is out of steps** — the task used every tool
  turn one message allows (`maxTurns`, default 40). Reply "continue" to
  carry on; give an agent that does long work its own budget with
  `agentMaxTurns`, or let it carry on by itself with `autoContinue`. The error
  **"Session exceeded the maximum of N provider turns"** means the model
  called a tool on the wrap-up call it was told not to, and is fixed the
  same way.
  See [how many turns one message may
  spend](./always-on.md#how-many-turns-one-message-may-spend).
- **"ran out of context part-way through its answer"** — different from
  the cap below, and not fixed by asking for less: the *conversation* is
  what no longer fits. A daemon narrows the history and retries rather
  than failing, so seeing this means one turn is too large on its own —
  see below.
- **"stopped at the … output cap before finishing"** — the model ran out
  of room mid-answer, so the reply was a fragment and was not delivered.
  The turn is failed rather than answered on purpose: a cut-off reply
  reads exactly like a complete one, which is worse than an error. Ask for
  a shorter answer, or change
  [`maxTokens`](../reference/config.md#how-long-an-answer-may-be). If the
  message says the cap itself was rejected, the model or proxy you named
  has a lower ceiling than the default — set `maxTokens` under it. On an
  OpenAI-compatible endpoint the cap is the endpoint's own default, so the
  fix is on that side.
- **A bridged MCP tool's output ends in `truncated by stratus`** — the
  server returned more than one result may put into the transcript, which
  every later turn of that conversation would then replay. The marker
  names the size the server sent; raise that server's `maxResultChars` if
  it is legitimately that large, or narrow the call. See
  [MCP](./mcp.md#the-posture).
- **An agent has forgotten the start of a long conversation** — see below.

## A conversation that outgrows the model

A session is durable and a Slack DM's top level is one session for the
life of the install (a thread inside the DM is its own session), so a busy
conversation's transcript grows without limit. Every turn
replays the whole thing to the model, and eventually it no longer fits.

When that happens the conversation **narrows rather than stopping**. The
request is refused for length, the daemon halves how much history it sends
and tries again until it fits, and it remembers the window it landed on so
the next turn does not pay for the discovery again. The agent is told, in
the request, that earlier messages are not being shown.

What this costs is real and worth knowing:

- **The agent cannot see the messages that fell out of the window.** It
  knows how many there were and nothing about them, so it will answer
  questions about the start of the conversation as though it had just
  joined. Summarizing what leaves is
  planned, not shipped.
- **Nothing is deleted.** The window bounds what is *sent*; the transcript
  on disk is whole, and `stratus logs` shows every trim as
  `session.context-trimmed`.
- **The window only ever narrows.** A conversation that trimmed once will
  trim again as it grows.

`stratus session rollover <id>` starts the same id over with an empty
transcript when you would rather begin again than keep narrowing — the old
conversation is archived, not lost.

One case this cannot rescue: a **single turn** too large for the model, for
example a tool result of several megabytes. There is no earlier history to
give up, so the turn fails saying exactly that. Cut what the call returns — `maxBytes` on
`fs.read`, `maxOutputBytes` on `shell.run`, see [Tools](./tools.md) — or
move that agent to a model with a bigger context window.
