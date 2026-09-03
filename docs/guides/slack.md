# Slack

Talk to your agents in Slack — **each agent as its own Slack app**, with its
own avatar, presence, and DMs. Threads are resumable conversations that
survive daemon restarts (a turn parked on an approval when the daemon died is re-asked afterwards and its reply still lands in the thread), and replies stream via message edits. Socket Mode
means no public ingress: a Mac Mini behind NAT is fine.

## Install the channel

```bash
npm install -g @stratusagent/channel-slack
```

The CLI ships **no** transport, so an install that never touches Slack never
carries the Slack SDKs (~9 MB). You rarely have to type this: connect an
agent in `stratus setup` → **Channels** and
[**Save & finish** offers the install](../start/setup.md#what-save--finish-offers),
because storing tokens is already the decision to use Slack.

If tokens are stored for an agent but the package isn't installed,
`stratus serve` says so and starts anyway, serving every other channel.

## Connect an agent

`stratus setup` → **Channels** walks each agent onto Slack: it prints the
app manifest with the agent's name already filled in, takes both tokens
without echoing them, verifies each against Slack, and stores them for the
daemon. Nothing to hand-edit.

The full app setup — creating the app from the manifest, scopes, Socket
Mode, and how the adapter behaves (mention-only in channels, free-form in
DMs, streaming edits, session keys) — is documented in the
[`@stratusagent/channel-slack` README](../../packages/channel-slack/README.md),
which is canonical for the Slack surface.

## Worth knowing

- **Tokens are gateway infrastructure secrets.** They live under
  `channels.slack.<agentId>` in `~/.stratus/credentials.json` and are never
  resolved through the agent-scoped credential allowlist — an agent must not
  be able to read the tokens of the transport carrying it.
- **Approval buttons** — with [`--approvals remote`](./approvals.md), a gated
  tool call parks the turn and asks in its thread with **Allow once** /
  **Always allow** / **Deny**. Clicks are authorized by *who clicked*, never
  by who can see the message.
- Nothing answers in Slack until the daemon runs — see
  [Always on](./always-on.md).
