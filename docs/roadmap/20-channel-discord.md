# 20 — Discord channel: the second adapter

## Goal

`@stratusagent/channel-discord`: a second channel adapter with per-agent
identity, threads, and outbound addressing — and, in the process, the first
real evidence that `@stratusagent/channels` is a contract rather than a
description of Slack.

## Why now

`channels` was written as a contract and has exactly one implementation. Every
assumption it accidentally inherited from Slack is currently invisible, and it
will stay invisible until something with different mechanics tries to satisfy
it. [10](./10-proactive.md) already widened it once — the addressable outbound
seam — with, again, one implementation.

Discord is the right second adapter because it differs in the ways that matter
for the contract while staying close enough to be finishable: threads exist but
work differently, presence and identity are modelled differently, and there is
no Socket Mode equivalent — the gateway connection is the normal path rather
than the alternative to a public URL.

It is deliberately sequenced against [19](./19-registration-seams.md): built
here, registering through the seam once that lands, and moved out of this
repository once the contract has stopped moving.

## Scope

**In:**

- **Inbound**: messages in guild channels, threads, and DMs, mapped to sessions
  through `ChannelSessionKeyParts` so a conversation resumes.
- **Outbound**: post, edit for streaming deltas, and typing indicator, against
  `OutboundConnection`.
- **Addressable outbound** per 10's seam, so a schedule can deliver into a
  Discord destination.
- **Per-agent identity**, in whatever fidelity Discord actually offers — the
  point of the step is to find out and write it down, not to assume it matches
  Slack's app-per-agent model.
- **Approval routing**, so a gated call in `remote` mode asks in Discord the
  way it asks in Slack. The permission engine is channel-agnostic already; this
  is the second consumer that proves it.
- **A written account of every place the contract had to bend**, in the PR and
  then in `channels`. This is the deliverable that outlives the adapter.

**Out:**

- Voice, slash commands, and Discord-specific interaction surfaces. A second
  adapter's job is to test the contract, not to be the best Discord bot.
- Moving the package out of the monorepo. That is the follow-up, gated on 19
  and on the contract settling — see the roadmap's ground rules.
- Any change to how Slack behaves. If both adapters want something, it moves
  into `channels`; the Slack adapter's own semantics do not shift to make
  Discord easier.

## Design sketch

- Discord's token model is one bot token per application, and the identity
  question is therefore not the same one Slack answers. Whatever the answer,
  the tokens are **gateway infrastructure secrets** under the same rule as
  Slack's: they live in host-owned config, never resolved through the
  agent-scoped `CredentialResolver`, because an agent must not be able to read
  the tokens of the transport carrying it.
- Reconnection is the adapter's problem and it is a real one — a persistent
  gateway connection with resume semantics, backoff, and session invalidation.
  `plugin-mcp` already has a reconnect-with-backoff shape worth reading before
  inventing a second one.
- `stop()` must keep the guarantee the Slack adapter makes: it awaits the work
  in flight when it was called. The known gap is documented in `CLAUDE.md` and
  is not made worse here — the drain is a one-time snapshot, and a turn still
  finishing can emit an event the snapshot never saw.
- Message length limits, rate limits, and edit throttling differ from Slack's,
  and streaming deltas are where that bites. Whatever pacing this needs is a
  candidate for `channels` rather than a private trick.

## Acceptance criteria

- Two agents are reachable in one Discord guild, and each replies as itself.
- A thread conversation resumes its session across a daemon restart.
- A streaming reply edits in place without exceeding Discord's rate limits
  under a sustained turn.
- A gated tool call asks for approval in Discord and the turn resumes on the
  answer, using the permission engine unchanged.
- A schedule delivers into a Discord destination through 10's outbound seam.
- The gateway runs Slack and Discord adapters simultaneously, with one agent
  reachable on both, and a session started on one is not resumed by the other.
- No Discord token is resolvable by any agent, asserted rather than assumed.
- Every contract change this step required is documented in `channels`.

## Open questions

- **What is Discord's honest analogue of per-agent identity?** Webhooks give
  per-message name and avatar; a bot application gives one identity per token.
  Whether a five-agent roster is five applications, one application with
  per-message overrides, or something else is the first thing to establish, and
  the answer rhymes with [22](./22-slack-single-app.md) — both steps are asking
  what a single application can express about many agents.
- **Does the contract need a capability descriptor?** Once two adapters differ
  in what they support — threads, edits, presence, per-agent identity — the
  gateway needs to know what it is talking to. A capability object is the
  obvious answer and is exactly the sort of thing that should be discovered by
  the second implementation rather than designed by the first.
