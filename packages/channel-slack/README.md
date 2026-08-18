# @stratusagent/channel-slack

Slack adapter for Stratus agents. **One Slack app per agent** — Slack has no way to give a single bot several identities with real avatars, presence, and DMs, so each agent gets its own app, and the adapter runs one Socket Mode connection per agent (no public ingress needed; Mac Minis behind NAT are fine).

- **Resumable conversations**: session keys are `slack:<agent>:<team>:<channel>:<thread_ts ?? ts>` (DMs: the DM channel id) — a thread is a conversation, it survives daemon restarts, and two agents sharing a thread keep fully separate sessions.
- **Streaming replies**: post a placeholder, edit as deltas arrive (throttled for `chat.update` limits), show `⚙ tool…` status lines, finalize with the full reply — split across messages when it outgrows one.
- **Mention-only in channels, free-form in DMs.** Inbound mentions of other users are humanized to `@Display Name` for the model; redeliveries are deduped so a slow turn never runs twice.
- **Approval buttons** for the gateway's `remote` permission mode: a gated tool call parks the turn and asks in its thread with **Allow once** / **Always allow** / **Deny**. See [Approving tool calls](#approving-tool-calls) — clicks are authorized by *who clicked*, never by who can see the message.
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
leaving it hanging.

Requests are also denied, visibly, when they expire, when the turn is
cancelled, and when the daemon shuts down. Every ending retracts the buttons,
so a message never keeps offering a decision that has nowhere to land.

**Interactivity must be enabled on the app** or Slack delivers no clicks at
all. The shipped manifest turns it on; an app created before this shipped
needs `settings.interactivity.is_enabled` set to `true` once, under **App
Manifest**. No request URL is needed — the clicks arrive over the same Socket
Mode connection.
