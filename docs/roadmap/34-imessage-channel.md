# 34 — iMessage channel: text your agent

## Goal

`@stratusagent/channel-imessage`: an agent reachable by text message — from
a phone, with no app to install and no workspace to join. One channel kind,
`imessage`, with several ways to deliver it, chosen per agent:

- **`local`**, the default: Messages.app on the Mac the daemon runs on,
  read from its database and sent through AppleScript. No account with
  anyone, no secret to store.
- **`photon-local`**: the same Mac, through Photon's open-source kit.
- **`photon`** and **`sendblue`**: hosted lines, for a daemon that is not on
  a Mac, which also reach SMS.

## Why now

Slack reaches the people in one workspace. A text reaches anyone with a
phone, which is most of the people an always-on agent would be useful to
and none of the people who would set up a Slack app for it.

It is also the contract's second consumer, ahead of
[20](./20-channel-discord.md). iMessage has none of what Slack's adapter
quietly assumes — no placeholder to edit, no buttons, no workspace boundary
on who can write in — so it finds the places `@stratusagent/channels` is
still Slack-shaped sooner than Discord would, and those are fixed here,
under this repository's CI, before an adapter outside it depends on them.

## Scope

**Phase 0, in this repository (shipped):** the contract changes the adapter
needs, each with Slack as the existing consumer and unchanged by it.

- `OutboundConnection.edit` and `upload` are optional; a channel without
  `edit` posts the finished reply.
- Sender admission and trust — `isPrincipal`, `admitsSender`,
  `senderTrustFor` — live in `@stratusagent/channels`, one rule for every
  adapter. A channel anyone can message defaults to `admit: "principals"`.
- `GatewayLike.dispatch` takes an `idempotencyKey`. A redelivered message
  never runs twice, and a turn the daemon died inside is continued at the
  next start rather than failed, so delivery is at least once to the
  gateway and exactly once as a turn. The exception is an agent on a
  harness (`codex`, a Claude subscription), whose own tool loop may already
  have acted on the prompt; its turn is failed, as before.
- A channel may be bound by trusted config (its plugin block's `agents`)
  as well as by stored secrets; `stratus setup` shows either.
- `stratus channel set|list|remove` stores a plugin channel's secrets, and
  setup's Channels row lists every kind an enabled plugin declares.
- Approvers for a plugin channel live in its own config block. See
  [the plugin architecture](../architecture/plugins.md#registering-providers-channels-memory-stores-and-executors).

**The adapter, in its own repository:** inbound and outbound for one line
per agent, approvals by text reply with a per-request challenge (no
buttons), and the four delivery methods. It depends only on published
`@stratusagent/channels` and `@stratusagent/core`, bounded to the minor that
shipped Phase 0.

**Out:** one line carrying the whole roster, the same question as running
the whole roster on one Slack app; group conversations by default; and
anything that needs a native module on the default path.

## Acceptance criteria

- Slack behaves exactly as before Phase 0.
- A plugin channel's secrets are stored through the CLI and reach the
  channel through the host-owned path: the fixture channel starts under
  `stratus serve` from what `stratus channel set` wrote.
- A redelivered message with the same key starts no second turn, live or
  after a restart, and a keyed turn left running by a crash finishes once.
- The adapter refuses an approval answered over SMS, and three wrong
  challenge answers deny the request.

## Open questions

- **How far the turn and render lifecycle is shared.** Draining in
  `stop()`, the approval outcome texts, and finishing a reply after a
  restart through `sessionRouting` are inside `channel-slack`. They move
  into `@stratusagent/channels` only as far as the adapter would otherwise
  copy them.
- **Whether `approvals` grows a per-channel section.** Approvers in each
  plugin's own block need no contract change; a shared block waits for a
  reason one place has to see across channels.
