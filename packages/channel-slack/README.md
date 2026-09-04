# @stratusagent/channel-slack

Slack adapter for Stratus agents. **One Slack app per agent** — Slack has no way to give a single bot several identities with real avatars, presence, and DMs, so each agent gets its own app, and the adapter runs one Socket Mode connection per agent (no public ingress needed; Mac Minis behind NAT are fine).

- **Resumable conversations**: session keys are `slack:<agent>:<team>:<channel>:<thread_ts ?? ts>` (DMs: the DM channel id) — a thread is a conversation, it survives daemon restarts, and two agents sharing a thread keep fully separate sessions. A turn parked on a human when the daemon died is re-asked after the restart, and when it finishes its reply is posted into the thread as a fresh message — the placeholder it would have edited belonged to the old process.
- **Streaming replies**: post a placeholder, edit as deltas arrive (throttled for `chat.update` limits), show `⚙ tool…` status lines, finalize with the full reply — split across messages when it outgrows one.
- **Markdown is translated to Slack's mrkdwn** on the way out — `**bold**` to `*bold*`, `*italic*` to `_italic_`, `~~struck~~` to `~struck~`, `[text](https://…)` to `<https://…|text>`, and a `#` heading to a bold line, since mrkdwn has no headings. Code spans and fences are left exactly as written, an unclosed fence included, so a `**` inside a snippet stays part of the snippet — a run of N backticks opens code and only a run of exactly N closes it, which is what lets ``a span with a ` in it`` and a ````-fence holding a ```-fence work. One or two unmatched backticks are literal text, as they are in Markdown. Anything whose spelling already matches — lists, block quotes, inline code — is untouched. A marker still being streamed stays literal until its closing half arrives.
- **Mention-only in channels, free-form in DMs.** Inbound mentions of other users are humanized to `@Display Name` for the model; redeliveries are deduped so a slow turn never runs twice.
- **Approval buttons** for the gateway's `remote` permission mode: a gated tool call parks the turn and asks in its thread with **Allow once** / **Always allow** / **Deny**. See [Approving tool calls](#approving-tool-calls) — clicks are authorized by *who clicked*, never by who can see the message, and **Always allow** is offered only where the daemon would actually remember it.
- **Tokens are gateway infrastructure secrets**, stored in the `channels` namespace of `~/.stratus/credentials.json` — never in an agent's credential allowlist:

```json
{
  "channels": {
    "slack": {
      "ava": { "appToken": "xapp-…", "botToken": "xoxb-…" }
    }
  }
}
```

## Installing

This package is an **optional peer** of the CLI — `stratus` ships without any
transport, so installs that never use Slack do not carry the Slack SDKs
(~9 MB). Add it alongside the CLI to enable the channel:

```sh
npm install -g @stratusagent/channel-slack
```

`stratus serve` picks it up automatically for every roster agent with stored
Slack tokens. Without it, tokens are reported at startup with an install
hint and the daemon serves every other channel as usual.

## Setting up an agent's Slack app (~2 minutes)

**The easy way:** run `stratus setup` → **Channels**. It prints the manifest with
the agent's name already filled in, takes both tokens without echoing them,
verifies each against Slack, and stores them under the right agent id — no
editing `credentials.json` by hand.

The manual equivalent, if you prefer:

1. https://api.slack.com/apps → **Create New App → From a manifest** → paste `manifest/stratus-agent.manifest.json` with `NAME` replaced by the agent's name.
2. **Basic Information → App-Level Tokens** → generate a token with `connections:write` (that's the `appToken`, `xapp-…`).
3. **Install App** to the workspace → copy the **Bot User OAuth Token** (that's the `botToken`, `xoxb-…`).
4. Upload the agent's avatar under **Display Information**.
5. Add both tokens under `channels.slack.<agentId>` in `~/.stratus/credentials.json` and restart `stratus serve` — the log will show `slack: <agentId> connected`.

## Approving tool calls

When `stratus serve` runs with `approvals.mode: "remote"`, a gated tool call
parks the turn and the adapter asks here. The question goes to the thread the
turn is happening in; a turn with no Slack conversation of its own (scheduled
work, a delegate) asks in the configured `slackChannel`.

The request names the **site** for a call judged by one (`browser.act`),
because its arguments are a CSS selector and say nothing about where a click
lands — and that site is what **Always allow** widens.

**Always allow** is left off entirely where the daemon would remember
nothing: a `dangerous` tool, which asks every time whatever is answered, and
a browser action whose conversation has no page to grant. The prompt says so
instead, because a button that does exactly what **Allow once** does, under a
label promising a standing grant, is worse than no button. The resolved
message describes what the daemon did rather than which button was pressed —
`POST /approvals` accepts `always` whatever this channel rendered, so the
answer can arrive from somewhere else.

Who may answer is configured per agent, in `~/.stratus/config.json`:

```jsonc
{
  "approvals": {
    "mode": "remote",
    "slackChannel": "C07OPS",
    "agents": {
      "ava": { "slackApprovers": ["U01DYLAN", "U01OPS"] }
    }
  }
}
```

That block is only read from a config you chose — `--config`,
`STRATUS_CONFIG`, or the global `~/.stratus/config.json`. A project-local
`stratus.config.json` cannot appoint approvers, since it can be checked into
any repository.

**Clicks are authorized by actor, not by delivery.** Everyone in a thread can
see the request; only the ids listed for that agent can decide it. Anyone
else's click is refused with a notice only they see, and the request stays
open for someone who may actually answer — which matters most for **Always
allow**, since that widens what the agent may do for the rest of the session.
An agent with no approvers listed denies every request on arrival rather than
leaving it hanging — set `"slackApprovers": []` on an agent to exclude it
from a shared default list. The same goes for an agent whose Slack app is
configured here but failed to connect. An agent this adapter was never given
is left alone: a request is a broadcast, and refusing one another channel was
about to answer is not the adapter's call — `stratus serve` reports agents no
channel can ask for, at startup. Those automatic denials are recorded as
`undeliverable` rather than `decided`, so the log never shows a refusal
nobody made as one somebody did.

The message shows the tool's arguments as well as its name — approving
`shell.run` without seeing what it would run is not approval. Arguments are
escaped, so a model-written argument cannot mention or broadcast to the
workspace through the prompt itself, and long ones are truncated with a
notice saying so.

Requests are also denied, visibly, when they expire, when the turn is
cancelled, and when the daemon shuts down. Every ending the daemon is alive
for retracts the buttons, so a message does not keep offering a decision that
has nowhere to land.

A crash is the ending it cannot be alive for, and the record of what was
posted lives only in memory — so a new process cannot find its predecessor's
prompts to retract them. Those correct themselves on the next click: it
answers that the request is no longer pending and rewrites the message, since
the click is the one thing that carries the message's location back. A prompt
nobody clicks stays as it was until someone does.

**Interactivity must be enabled on the app** or Slack delivers no clicks at
all. The shipped manifest turns it on; an app created before this shipped
needs `settings.interactivity.is_enabled` set to `true` once, under **App
Manifest**. No request URL is needed — the clicks arrive over the same Socket
Mode connection.

## Speaking first: the outbound seam

The adapter also implements the channel contract's `resolveOutbound` — how a
scheduled turn's `message.send` reaches a channel, and how a schedule's
destination is validated at creation. The address is the agent **plus** a
conversation id (`C…`/`G…`/`D…`, never a name): each agent is its own Slack
app, possibly in its own workspace, so the id alone names nothing.

Validation is membership: the app must be able to see the conversation
(`conversations.info`) and be a member of it — `/invite` it where it should
report. A DM id passes on its own, because a `D…` conversation exists only
because someone opened it with the app; the adapter never opens new DMs, so
an agent cannot cold-message a workspace. This is what the
`channels:read` / `groups:read` / `mpim:read` scopes in the manifest are
for — an app created before this shipped needs them added under **OAuth &
Permissions** and reinstalled once, or every destination reads as invisible.
