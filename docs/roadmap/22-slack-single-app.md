# 22 — Slack single-app mode: the whole roster on one app

## Goal

A second identity mode in `@stratusagent/channel-slack`: one Slack app,
installed once, carrying every agent in the roster — for workspaces where an
app per agent is not something an administrator will approve.

## Why now

[02](./02-slack-channel.md) gave each agent its own Slack app, and that buys
the best identity available: a real avatar, real presence, real DMs, and
`@Ava` resolving to Ava. It is the right default and this step does not
replace it.

What it costs is the largest setup cost in the product, and the cost is
multiplied by roster size rather than paid once. A five-agent roster is five
Slack apps to create, five manifests to configure, five admin approvals in a
workspace that may not grant them, five token pairs to store, and five Socket
Mode connections for one daemon to hold. Plenty of organizations will approve
one app and not five, and for them the roster is currently unreachable rather
than merely inconvenient.

That is a channel-contract question, not a deployment workaround. What a single
Slack app can express about many agents *is* what a roster looks like to those
workspaces, and the answer has to live in the adapter — an integration that
solved it outside would be a second Slack implementation whose identity model
diverged from the first.

## Scope

**In:**

- **A second identity mode**, selected by configuration, where one app's token
  pair serves the whole roster. The existing app-per-agent mode is untouched
  and stays the default.
- **Per-agent presentation at whatever fidelity one app permits.** Per-message
  `username` and `icon_url` overrides (`chat:write.customize`) are the known
  floor; what else is available is the open question below and is settled
  against current Slack documentation before this is designed, not from how the
  per-agent path works today.
- **An addressing model that survives the reduced fidelity.** If `@Ava` cannot
  resolve to an agent under one app, something else has to route an inbound
  message to the right one — most likely a channel-per-agent convention, with
  an explicit rule for DMs and for a shared channel.
- **An honest capability difference, written down.** Both modes appear in
  [`docs/guides/slack.md`](../guides/slack.md) with what each gives up. An
  operator choosing single-app mode is choosing a trade and must be able to see
  it before installing.
- **Approval routing works in both modes**, including the fallback channel that
  [03](./03-permissions.md)'s config already supports.

**Out:**

- Removing or deprecating app-per-agent. It is better where it is available.
- Programmatic creation of Slack apps. Whatever an operator does once in
  Slack's UI is not this repository's business, and an install flow is not
  a channel adapter's job.
- Distribution-listing concerns. This step makes the adapter capable of running
  a roster on one app; who publishes an app and where is a separate decision.
- Any change to how channel tokens are held. They remain gateway
  infrastructure secrets under `channels.slack.*`, never reachable through the
  agent-scoped resolver. A single token pair serving several agents makes that
  invariant *more* load-bearing, not less.

## Design sketch

- One socket, one web client, and a router that resolves an inbound message to
  an agent before the session key is built — where today the adapter knows
  which agent it is because it is that agent's connection. The session key
  parts gain the agent from routing rather than from construction.
- Where the roster is bound to the token pair rather than the agent, the config
  shape has to say so. `channels.slack.<agentId>` is the current key; a mode
  where one entry serves many agents needs its own key rather than a special
  agent id, so that reading the config still answers "whose tokens are these"
  correctly.
- The identity of an outbound message becomes per-call rather than per-client,
  which the `OutboundConnection` contract may or may not already accommodate —
  worth checking early, because it is the difference between an adapter change
  and a `channels` change.
- Rate limits are now shared across the roster. Five agents on one app share
  one budget, and streaming edits are the heaviest consumer. Whatever pacing
  this needs is likely to be useful to [20](./20-channel-discord.md) too.
- `stop()` keeps its guarantee, and the documented drain gap does not get
  worse: one connection serving many agents means one snapshot covering all of
  them.

## Acceptance criteria

- Three agents are reachable in one workspace through one app, each replying
  under its own name and avatar.
- An inbound message routes to the intended agent, and a session started with
  one agent is never resumed by another.
- A gated call asks for approval and resumes on the answer, in this mode, with
  the permission engine unchanged.
- A schedule delivers outbound to the right destination as the right agent.
- Streaming replies from two agents at once stay within the app's rate limits.
- The app-per-agent mode's existing test suite passes unchanged.
- No agent can resolve the shared token pair.
- `docs/guides/slack.md` documents both modes and what single-app mode gives
  up, in the same PR.

## Open questions

- **How much per-agent identity can one app actually express?** This is the
  question the step turns on and it is not answered here on purpose. Per-message
  name and avatar overrides are reliable. Per-agent DMs, per-agent presence,
  and `@mention` resolving to an agent rather than to the app are the three
  that matter most and the three least likely to be available under one app.
  Slack's agent and assistant surfaces have changed recently and may cover more
  of this than the classic bot-user model did. **Establish this against current
  Slack documentation before designing anything else in this step** — if the
  answer is "name and avatar only," the addressing model carries the whole
  weight and the guide has a larger trade to describe.
- **Does the roster appear as one Slack app the workspace sees, or as one app
  per *deployment*?** These differ for anyone running two daemons against one
  workspace, and the session-key rules have to be right for both.
- **Is there a hybrid worth having** — one app for most agents and a dedicated
  app for the one or two that need real DMs? It composes in principle. It also
  doubles the number of identity paths to reason about, and should probably
  wait for somebody to ask for it.
