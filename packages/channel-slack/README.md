# @stratusagent/channel-slack

Slack adapter for Stratus agents. **One Slack app per agent** — Slack has no way to give a single bot several identities with real avatars, presence, and DMs, so each agent gets its own app, and the adapter runs one Socket Mode connection per agent (no public ingress needed; Mac Minis behind NAT are fine).

- **Resumable conversations**: session keys are `slack:<agent>:<team>:<channel>:<thread_ts ?? ts>` (DMs: the DM channel id) — a thread is a conversation, it survives daemon restarts, and two agents sharing a thread keep fully separate sessions.
- **Streaming replies**: post a placeholder, edit as deltas arrive (throttled for `chat.update` limits), show `⚙ tool…` status lines, finalize with the full reply — split across messages when it outgrows one.
- **Mention-only in channels, free-form in DMs.** Inbound mentions of other users are humanized to `@Display Name` for the model; redeliveries are deduped so a slow turn never runs twice.
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

1. https://api.slack.com/apps → **Create New App → From a manifest** → paste `manifest/stratus-agent.manifest.json` with `NAME` replaced by the agent's name.
2. **Basic Information → App-Level Tokens** → generate a token with `connections:write` (that's the `appToken`, `xapp-…`).
3. **Install App** to the workspace → copy the **Bot User OAuth Token** (that's the `botToken`, `xoxb-…`).
4. Upload the agent's avatar under **Display Information**.
5. Add both tokens under `channels.slack.<agentId>` in `~/.stratus/credentials.json` and restart `stratus serve` — the log will show `slack: <agentId> connected`.
